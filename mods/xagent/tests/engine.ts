// Stands for the engine beneath the mod. Every test gets a clock at NOW, a store, HOME,
// and a process.run that answers like a directory outside git unless `run` says otherwise.
import { mock } from 'claude-code/testing'

export const NOW = Date.UTC(2026, 9, 14, 12)
export const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as any

export type Run = { exitCode: number; stdout: string; stderr: string }

export function engine(on: any, opts: { run?: (argv: string[], env: Record<string, string> | undefined) => Run | undefined; files?: Record<string, string>; writeError?: string } = {}) {
  const tools: string[] = []
  const runs: { argv: string[]; cwd?: string; env?: Record<string, string> }[] = []
  // The test Engine has no $.state: xagent's atoms are seen through the writes that pass by.
  const state: Record<string, any> = {}
  on('state.set', { plugin: 'xagent' }, async (_$: any, e: any, next: any) => {
    const r = await next(e)
    if (r.value?.isSet) state[e.key] = e.value
    return r
  })
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  const files = opts.files ?? {}
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('tool.register', (_$: any, e: any) => (tools.push(e.name), { value: { tool: `mcp__xagent__${e.name}` } }))
  on('command.register', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in files }))
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$: any, e: any) => (opts.writeError ? (() => { throw new Error(opts.writeError) })() : (files[e.path] = e.content ?? e.text ?? ''), { value: undefined }))
  on('process.run', (_$: any, e: any) => {
    // $.process.run(argv, init) arrives as { argv, init }: cwd and env sit under init.
    runs.push({ argv: [...e.argv], cwd: e.init?.cwd, env: e.init?.env })
    return { value: opts.run?.([...e.argv], e.init?.env) ?? { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } }
  })
  return { tools, runs, clock, state }
}
