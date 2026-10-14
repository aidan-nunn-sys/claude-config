import { describe, expect, test } from 'claude-code/testing'

import { describe as label, elapsed, isShown } from '../hooks/register'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } }
const PANE = { component: 'Pane', requestId: 'agent-radar', props: { title: 'Agent Radar', isFocused: true, bodyColumns: 100, placement: 'dock' } }

// Stands for the engine beneath the mod.
function engine(on: any) {
  const toasts: string[] = []
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'a1' }))
  on('agent.list', () => ({ value: [] }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'band below' }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'Run the sweep', toolUses: [] }, { role: 'assistant', text: 'Sweep is at trial 12 of 40.', toolUses: [] }] }))
  return { toasts }
}

describe('agent-radar', () => {
  test('helpers', () => {
    expect(elapsed({ startedAt: 0, endedAt: 252_000 })).toBe('4m 12s')
    expect(elapsed({ startedAt: 0, endedAt: 9_000 })).toBe('9s')
    expect(label({ tool: 'mcp__plugin_playwright_playwright__browser_click' })).toBe('browser: click')
    const done = (ago: number) => ({ id: 'x', description: 'd', type: 't', status: 'done' as const, startedAt: 0, endedAt: Date.now() - ago, tools: 0, last: '' })
    expect(isShown(done(5_000))).toBe(true)
    expect([done(600_000)].filter(a => isShown(a))).toEqual([]) // gone after 30 s
  })

  test('a spawned agent shows in the pane, opens to its messages, and toasts when done', async ($, on) => {
    const { toasts } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.agent.spawn({ prompt: 'run it', description: 'sweep runner' } as any)

    const band = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: / ● sweep runner/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /band below/ })).toBeDefined()

    const r = await $.command.run({ command: 'radar', args: '' } as any)
    expect(r.text).toBe('1 running, 0 finished')

    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /1 running · 0 finished/ })).toBeDefined()
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined()

    await ui.press({ key: 'agent-a1' })
    expect(await ui.find({ type: 'Text', text: /Sweep is at trial 12 of 40/ })).toBeDefined()
    await ui.press({ key: 'back' })

    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, agentId: 'a1' } as any)
    expect(toasts[0]).toMatch(/^✓ sweep runner done \(\d+s · 0 tools\)$/)
    expect(await ui.find({ type: 'Text', text: /0 running · 1 finished/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: / ✓ sweep runner/ })).toBeDefined() // still shown for 30 s
    await ui.unmount()
    await band.unmount()
  })

  // xagent's atom as the engine answers it: $.state.get resolves { value, version }.
  function xagentAgents(on: any, list: any[]) {
    let version = 1
    on('state.get', (_$: any, e: any, next: any) => (e.plugin === 'xagent' && e.key === 'agents' ? { value: { value: list, version } } : next(e)))
    return { bump: () => version++ }
  }
  const ext = (patch: object) => ({ id: 'x1', backend: 'codex', model: 'gpt-6.1-sol', effort: 'medium', task: 'Task 3: parser', status: 'running', startedAt: Date.now() - 5_000, last: 'running npm test', quota: '', ...patch })

  test('an external agent appears in the band and pane, updates, finishes, and leaves the band', async ($, on) => {
    engine(on)
    const list = [ext({})]
    const { bump } = xagentAgents(on, list)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

    const band = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /\[codex\] Task 3: parser/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /running npm test/ })).toBeDefined()
    await band.unmount()

    list[0] = ext({ last: 'editing files' })
    bump()
    const band2 = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', ...BAND } as any)
    expect(await band2.find({ type: 'Text', text: /editing files/ })).toBeDefined()
    await band2.unmount()

    list[0] = ext({ status: 'done', endedAt: Date.now(), last: 'finished' })
    bump()
    const band3 = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', ...BAND } as any)
    expect(await band3.find({ type: 'Text', text: / ✓ \[codex\] Task 3: parser/ })).toBeDefined()
    await band3.unmount()

    list[0] = ext({ status: 'done', startedAt: Date.now() - 120_000, endedAt: Date.now() - 60_000, last: 'finished' })
    bump()
    const band4 = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', ...BAND } as any)
    expect(await band4.find({ type: 'Text', text: /\[codex\]/ })).toBeUndefined() // past the 30 s band window
    await band4.unmount()
    const pane = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', ...PANE } as any)
    expect(await pane.find({ key: 'agent-x1' })).toBeDefined() // history keeps it: pane rows are Buttons keyed agent-<id>
    await pane.unmount()
  })

  test('a failed external agent shows its error', async ($, on) => {
    engine(on)
    xagentAgents(on, [ext({ status: 'failed', endedAt: Date.now(), last: 'stopped: timed out' })])
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const band = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /stopped: timed out/ })).toBeDefined()
    await band.unmount()
  })
})
