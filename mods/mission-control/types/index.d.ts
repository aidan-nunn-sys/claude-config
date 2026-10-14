// One box in the "who" tree: the main loop, a subagent, or one tool call.
export type MissionNode = {
  id: string
  parent: string | null
  kind: 'main' | 'agent' | 'tool'
  label: string
  family: string // for tools: 'bash', 'edit', 'read', 'browser', 'mcp:<server>', ...
  status: 'running' | 'done' | 'failed'
  start: number
  end?: number
  detail?: string // what an external agent is doing now (xagent's `last`)
}

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      nodes: MissionNode[]
      turn: number
      now: number
    }
    xagent: { agents: XAgent[] }
  }
}

// xagent's agents, as xagent writes them (mods/xagent/types: XAgent). Read-only here.
export type XAgent = {
  id: string
  backend: 'codex' | 'copilot' | 'agy'
  model: string
  effort: string
  task: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  last: string
  quota: string
}
