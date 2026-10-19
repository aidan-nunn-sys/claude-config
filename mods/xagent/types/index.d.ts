export type Backend = 'codex' | 'opencode'
export type Mode = 'read-only' | 'write'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type DispatchInput = {
  backend: Backend
  model?: string
  effort?: Effort
  mode: Mode
  prompt: string
  dir?: string
  schema?: string // path to a JSON schema file; the answer must parse as JSON
  resume?: string // session id from an earlier result
  network?: boolean // codex, write mode only: let the sandboxed run reach the network
  agent?: string // opencode: the agent to run as
  outputFile?: string // absolute path or ~: the whole answer is written here on success
  timeoutMs?: number
  override?: boolean // run even though the backend is at 90 % of a window: only when the user said so
}

// What one CLI run's output says.
export type Parsed = {
  ok: boolean
  summary: string // at most SUMMARY_CAP chars, for display
  full?: string // internal: the whole answer, never returned; register.ts writes it to outputFile
  answer?: string // with a schema: the whole answer, valid JSON
  sessionId: string | null
  error?: string
}

export type DispatchResult = Omit<Parsed, 'full'> & {
  outputFile?: string // where the whole answer was written
  attempts: number
  baseTree: string | null // git tree of `dir` before the run; null outside a repo or read-only
  tree: string | null // git tree after the run
  filesChanged: string[] | null // paths that differ between baseTree and tree
  treeError?: string // a git snapshot failed inside a repo (filesChanged is then null)
  quota: ProviderQuota // this backend's quota, read after the run
}

export type XAgent = {
  id: string
  backend: Backend
  model: string
  effort: string
  task: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  last: string
  quota: string // the backend's quota line when it started
}

export type Window = { usedPercent: number; windowMinutes: number; resetsAt: number | null } // resetsAt: epoch ms, null when unknown
export type ProviderQuota =
  | { state: 'unknown' }
  | { state: 'windows'; windows: Window[] }
  | { state: 'cooldown'; until: number }
  | { state: 'unavailable'; reason: string }
export type Snapshot = { claude: ProviderQuota; codex: ProviderQuota; opencode: ProviderQuota }

declare module 'claude-code' {
  interface PluginState {
    xagent: { agents: XAgent[]; blocked: Record<string, ProviderQuota> }
  }
  // Written by hand: the generated MCP types only know servers that were connected when they were made.
  interface McpToolInputs {
    mcp__xagent__dispatch: DispatchInput
  }
}
