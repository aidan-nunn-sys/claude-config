// Mission Control: /mission opens a pane showing the current turn's main agent, its
// subagents and every tool call they make, live. A band line sums it up while Claude works.
// (Upstream's code-map view, with its Haiku diff summaries and headless Chrome, is stripped.)
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MissionNode, XAgent } from '../types'
import { label, lines, summary } from './tree'

const PANE = 'mission-control'
const MAX_NODES = 300
const BAND_AFTER_MS = 30_000 // the band stays this long after a turn ends
// Tools that are Claude Code's own bookkeeping, not work: kept out of the tree.
const INTERNAL = new Set(['SubagentHandback', 'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'])

// Held by the host, so a hot reload keeps the picture.
const nodes = atom({ plugin: 'mission-control', key: 'nodes' } as const, [] as MissionNode[])
const turn = atom({ plugin: 'mission-control', key: 'turn' } as const, 0)
const now = atom({ plugin: 'mission-control', key: 'now' } as const, 0)

// xagent's external agents (Codex, Copilot, Antigravity), read-only: leaves under main.
const external = atom({ plugin: 'xagent', key: 'agents' } as const, [] as XAgent[])

// The tree's nodes plus xagent's agents. With no main node yet they stand at the root.
async function everyone($: EngineInterface): Promise<MissionNode[]> {
  const own = await read($, nodes)
  const parent = own.some(n => n.id === 'main') ? 'main' : null
  const ext = (await read($, external).catch(() => [] as XAgent[])).map(x => ({
    id: `xagent-${x.id}`, parent, kind: 'agent' as const, label: `[${x.backend}] ${x.task}`, family: 'agent', status: x.status, start: x.startedAt, end: x.endedAt, detail: x.last,
  }))
  return [...own, ...ext]
}

// Under the cap, the oldest tool calls go first; main and the agents always stay.
export function cap(list: MissionNode[]) {
  if (list.length <= MAX_NODES) return list
  const tools = list.filter(n => n.kind === 'tool')
  const room = Math.max(0, MAX_NODES - (list.length - tools.length))
  const keep = new Set(room === 0 ? [] : tools.slice(-room))
  return list.filter(n => n.kind !== 'tool' || keep.has(n))
}

// The first `max` characters, cut at a word.
function words(text: string, max: number) {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.lastIndexOf(' ', max)
  return `${t.slice(0, cut > max * 0.5 ? cut : max)}…`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'mission', description: 'Open the live map of agents and tool calls' }).catch(() => {})
    $.clock.every(1000, () => {
      void (async () => {
        const busy = (await everyone($)).some(n => n.status === 'running')
        if (busy) await update($, now, () => Date.now())
      })().catch(() => {})
    })
    return r
  })

  on('turn.start', async ($, e, next) => {
    const t = (await read($, turn)) + 1
    await update($, turn, () => t)
    const main: MissionNode = { id: 'main', parent: null, kind: 'main', label: `main · ${words(e.text, 50)}`, family: 'main', status: 'running', start: Date.now() }
    // A background agent still running from the last turn carries over, with its open calls.
    await update($, nodes, list => {
      const agents = list.filter(n => n.kind === 'agent' && n.status === 'running').map(a => ({ ...a, parent: 'main' }))
      const ids = new Set(agents.map(a => a.id))
      const open = list.filter(n => n.kind === 'tool' && n.status === 'running' && ids.has(n.parent ?? ''))
      return [main, ...agents, ...open]
    })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const id = r.agentId
      const agent: MissionNode = { id, parent: e.parentAgentId ?? 'main', kind: 'agent', label: e.description || e.subagentType, family: 'agent', status: 'running', start: Date.now() }
      await update($, nodes, list => cap([...list, agent]))
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Agent') return next(e) // its subagent shows up through agent.spawn
    if (INTERNAL.has(e.tool)) return next(e) // bookkeeping, not work a person would follow
    const args = e as unknown as Record<string, unknown>
    const { label: text, family } = label(args)
    const id = e.tool_use_id
    await update($, nodes, list => {
      // A call from an agent this tree does not know hangs off main rather than nowhere.
      const parent = e.agentId && list.some(n => n.id === e.agentId) ? e.agentId : 'main'
      return cap([...list, { id, parent, kind: 'tool', label: text, family, status: 'running', start: Date.now() }])
    })

    let failed = true
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
      failed = r.deny !== undefined || r.isError === true
    } finally {
      await update($, nodes, list => list.map(n => (n.id === id ? { ...n, status: failed ? 'failed' : 'done', end: Date.now() } : n)))
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const id = e.agentId ?? 'main'
    const failed = e.reason === 'error' || e.reason === 'aborted'
    const isMain = !e.agentId
    // The main turn ending closes everything it left marked running, so the clock can rest.
    await update($, nodes, list => {
      // Only main's own leftovers: a background agent still running keeps its open calls.
      const live = new Set(list.filter(n => n.kind === 'agent' && n.status === 'running' && n.id !== id).map(n => n.id))
      const close = (n: MissionNode) => n.id === id || (isMain && n.kind === 'tool' && !live.has(n.parent ?? ''))
      return list.map(n => (close(n) && n.status === 'running' ? { ...n, status: failed ? 'failed' : 'done', end: Date.now() } : n))
    })
    return r
  })

  on('command.run', { command: 'mission' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Mission Control', focus: true })
    const s = summary(await everyone($))
    return { text: `Mission Control: ${s.agents} agents · ${s.tools} tool calls · q: close` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, now) // subscribes the pane to the clock
    const rows = Math.max(6, (e.props.scroll?.bodyRows ?? 30) - 3)
    const head = (
      <Box flexDirection="row" gap={1}>
        <Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )

    const at = Date.now()
    const all = await everyone($)
    const ls = lines(all, at)
    const s = summary(all)
    return (
      <Box flexDirection="column">
        {head}
        <Text dimColor>{`${s.agents} agents (${s.running} running) · ${s.tools} tool calls${s.failed ? ` · ${s.failed} failed` : ''}`}</Text>
        {ls.length === 0 && <Text dimColor>Nothing yet. Start a task and watch it fill in.</Text>}
        {ls.slice(-rows + 1).map(l => (
          <Text wrap="truncate-end">
            <Text dimColor>{l.prefix}</Text>
            <Text color={l.status === 'running' ? 'yellow' : l.status === 'failed' ? 'red' : l.node.kind === 'tool' ? undefined : 'green'} bold={l.node.kind !== 'tool'} dimColor={l.status === 'done' && l.node.kind === 'tool'}>
              {l.text}
            </Text>
          </Text>
        ))}
      </Box>
    )
  })

  // The band: one summary line while Claude works, and for a short while after.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    const list = await everyone($)
    const main = list.find(n => n.kind === 'main')
    const s = summary(list)
    const isRecent = main !== undefined && (main.status === 'running' || Date.now() - (main.end ?? 0) < BAND_AFTER_MS)
    if (e.props.hasSurvey || !isRecent || s.tools + s.agents === 0) return rest
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color="blue" bold>{' ◈ mission: '}</Text>
          <Text>{`${s.agents ? `${s.running}/${s.agents} agents · ` : ''}${s.tools} tools${s.failed ? ` · ${s.failed} failed` : ''}`}</Text>
          <Text dimColor>{'  ·  /mission'}</Text>
        </Text>
        {rest}
      </Box>
    )
  })
}
