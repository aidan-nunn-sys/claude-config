import { describe, expect, mock, test } from 'claude-code/testing'

import { label, lines } from '../hooks/tree'
import { cap } from '../hooks/register'

const PANE = { component: 'Pane', requestId: 'mission-control', props: { title: 'Mission Control', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } }
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } }

// Stands for the engine beneath the mod.
function engine(on: any) {
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  mock.clock(on)
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'ag1' }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'band below' }))
}

describe('mission-control', () => {
  test('the cap keeps main, the agents and the newest calls', () => {
    const many = [
      { id: 'main', parent: null, kind: 'main' as const, label: 'main', family: 'main', status: 'running' as const, start: 0 },
      { id: 'ag', parent: 'main', kind: 'agent' as const, label: 'a', family: 'agent', status: 'running' as const, start: 0 },
      ...Array.from({ length: 400 }, (_, i) => ({ id: `t${i}`, parent: 'main', kind: 'tool' as const, label: 'x', family: 'bash', status: 'done' as const, start: i })),
    ]
    const kept = cap(many)
    expect(kept).toHaveLength(300)
    expect(kept[0]?.id).toBe('main')
    expect(kept.some(n => n.id === 'ag')).toBe(true)
    expect(kept.at(-1)?.id).toBe('t399') // the newest calls stay
    const crowd = Array.from({ length: 310 }, (_, i) => ({ id: `a${i}`, parent: 'main', kind: 'agent' as const, label: 'a', family: 'agent', status: 'done' as const, start: i }))
    expect(cap([...crowd, ...many.slice(2)]).filter(n => n.kind === 'tool')).toHaveLength(0) // no room left: no tool calls
  })

  test('a background agent still running keeps its open calls when main ends', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    await $.agent.spawn({ prompt: 'p', description: 'long runner' } as any) // agent ag1, background
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any) // main ends, ag1 runs on
    const pane = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    expect(await pane.find({ type: 'Text', text: /1 agents \(1 running\)/ })).toBeDefined() // still running
    await pane.unmount()
  })

  test('labels tool calls by family', () => {
    expect(label({ tool: 'Bash', description: 'Run tests' })).toEqual({ label: 'Run tests', family: 'bash' })
    expect(label({ tool: 'mcp__playwright__browser_click' })).toEqual({ label: 'click', family: 'browser' })
    expect(label({ tool: 'mcp__claude_ai_Slack__slack_send_message' })).toEqual({ label: 'slack_send_message', family: 'mcp:Slack' })
  })

  test('the who tree nests agents and folds runs of one tool family', () => {
    const at = 10_000
    const ls = lines(
      [
        { id: 'main', parent: null, kind: 'main', label: 'main · fix login', family: 'main', status: 'running', start: 0 },
        { id: 'a', parent: 'main', kind: 'agent', label: 'test login flow', family: 'agent', status: 'running', start: 1000 },
        { id: 't1', parent: 'a', kind: 'tool', label: 'navigate', family: 'browser', status: 'done', start: 1000, end: 2000 },
        { id: 't2', parent: 'a', kind: 'tool', label: 'click', family: 'browser', status: 'running', start: 2000 },
        { id: 't3', parent: 'main', kind: 'tool', label: 'npm test', family: 'bash', status: 'failed', start: 3000, end: 4000 },
      ],
      at,
    )
    expect(ls.map(l => l.prefix + l.text)).toEqual([
      '◆ main · fix login  10s',
      '├─ ● test login flow  9.0s · 2 tools',
      '│  └─ ◎ browser: navigate → click  ×2  9.0s',
      '└─ $ bash: npm test  1.0s',
    ])
    expect(ls[2]?.status).toBe('running')
    expect(ls[3]?.status).toBe('failed')
  })

  test('a turn fills the tree and the band sums it up', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' } as any)
    await $.agent.spawn({ prompt: 'check it', description: 'test login flow' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/pages/login.tsx' } as any)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/auth/session.ts', old_string: 'a', new_string: 'b' } as any)

    const band = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /1\/1 agents · 2 tools/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /band below/ })).toBeDefined()
    await band.unmount()

    const r = await $.command.run({ command: 'mission', args: '' } as any)
    expect(r.text).toMatch(/1 agents · 2 tool calls/)
    const pane = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    expect(await pane.find({ type: 'Text', text: /◆ main · fix the login bug/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /● test login flow/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /✎ edit: auth\/session\.ts/ })).toBeDefined()

    // Claude Code's own bookkeeping is not a tool call in the tree.
    await $.tool.call({ tool: 'SubagentHandback', summary: 'done' } as any)
    expect(await pane.find({ type: 'Text', text: /SubagentHandback/ })).toBeUndefined()
    await pane.unmount()
  })

  // xagent's atom as the engine answers it: $.state.get resolves { value, version }.
  function xagentAgents(on: any, list: any[]) {
    let version = 1
    on('state.get', (_$: any, e: any, next: any) => (e.plugin === 'xagent' && e.key === 'agents' ? { value: { value: list, version } } : next(e)))
    return { bump: () => version++ }
  }
  const ext = (patch: object) => ({ id: 'x1', backend: 'codex', model: 'gpt-6.1-sol', effort: 'medium', task: 'Task 3: parser', status: 'running', startedAt: Date.now() - 5_000, last: 'running npm test', quota: '', ...patch })

  test('a running external agent is a leaf under main, with what it is doing', async ($, on) => {
    engine(on)
    xagentAgents(on, [ext({})])
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    const pane = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    expect(await pane.find({ type: 'Text', text: /\[codex\] Task 3: parser/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /running npm test/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /1 agents \(1 running\)/ })).toBeDefined()
    await pane.unmount()
  })

  test('the same external agent, done, shows as finished', async ($, on) => {
    engine(on)
    const list = [ext({})]
    const { bump } = xagentAgents(on, list)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    list[0] = ext({ status: 'done', endedAt: Date.now(), last: 'finished' })
    bump()
    const pane = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    expect(await pane.find({ type: 'Text', text: /\[codex\] Task 3: parser/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /1 agents \(0 running\)/ })).toBeDefined()
    await pane.unmount()
  })
})
