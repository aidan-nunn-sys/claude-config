export type RadarAgent = {
  id: string
  description: string
  type: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  tools: number
  last: string
}

declare module 'claude-code' {
  interface PluginState {
    'agent-radar': { agents: RadarAgent[]; selected: string | null; now: number }
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
