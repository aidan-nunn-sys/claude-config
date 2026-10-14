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
}

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      nodes: MissionNode[]
      turn: number
      now: number
    }
  }
}
