export type Slice = { color: string; tokens: number; kind: 'used' | 'free' | 'buffer' }
export type Context = { percent: number; tokens: number; window: number; slices: Slice[] }
export type Activity = 'idle' | 'thinking' | 'writing' | 'editing' | 'running' | 'reading' | 'agent'
export type Mood = { kind: 'sad' | 'happy'; until: number }
export type CacheTtl = '5m' | '1h'
export type Limit = { percent: number; resetsAt: number | null }

declare module 'claude-code' {
  interface PluginState {
    hud: {
      context: Context | null
      lastRequestAt: number | null
      ttl: CacheTtl
      activity: Activity
      mood: Mood | null
      limit: Limit | null
    }
  }
}
