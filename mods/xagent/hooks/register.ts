// xagent: run Codex, Copilot and Antigravity as workers for a Claude Code session.
//   dispatch runs one external agent; route picks models for a task by quota and complexity.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DispatchInput, DispatchResult, Parsed, ProviderQuota, XAgent } from '../types'
import { buildArgv } from './backends'
import { changedFiles, snapshot, treeOf } from './io'
import { feed, firstLine, parse, sessionIdIn } from './parse'
import { describeOne, isBlocked } from './quota'

const agents = atom({ plugin: 'xagent', key: 'agents' } as const, [] as XAgent[])
const blocked = atom({ plugin: 'xagent', key: 'blocked' } as const, {} as Record<string, ProviderQuota>)

const DISPATCH_SCHEMA = {
  type: 'object',
  properties: {
    backend: { type: 'string', enum: ['codex', 'copilot', 'agy'] },
    model: { type: 'string' },
    effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
    mode: { type: 'string', enum: ['read-only', 'write'] },
    prompt: { type: 'string' },
    dir: { type: 'string', description: 'working directory, absolute' },
    schema: { type: 'string', description: 'path to a JSON schema file; the full answer comes back as `answer`' },
    resume: { type: 'string', description: 'sessionId from an earlier dispatch, to continue it' },
    timeoutMs: { type: 'number' },
    override: { type: 'boolean', description: 'run on a backend at 90 % of its quota; only when the user said so' },
  },
  required: ['backend', 'mode', 'prompt'],
}

const ROUTE_SCHEMA_IN = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'the task text from the plan' },
    files: { type: 'array', items: { type: 'string' } },
    instructions: { type: 'string', description: "the user's standing instructions for this run" },
    override: { type: 'boolean', description: 'the user allows providers at 90 % of their quota' },
  },
  required: ['task'],
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000
const STOP_GRACE_MS = 5_000 // how long a stopped child gets to end before we stop waiting
const COOLDOWN_MS = 30 * 60_000
const LIMIT_WORDS = /usage limit|rate limit|quota|exceeded|\b429\b/i
const AUTH_WORDS = /not logged in|log in|unauthori[sz]ed|\b401\b|ENOENT|command not found/i
const RETRY_PROMPT = 'You were stopped at the time limit. Continue the same task from where you are, then give the final answer.'

export function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path
}

// Ends the child through its stream (leaving the loop kills it) and says whether that is
// confirmed: stop() resolved within the grace period. A rejected or hanging stop() is not.
export async function stopStream(stop: () => Promise<unknown>, sleep: () => Promise<void>): Promise<boolean> {
  const ended = stop().then(() => true, () => false)
  return Promise.race([ended, sleep().then(() => false)])
}

async function mark($: EngineInterface, backend: string, q: ProviderQuota) {
  await update($, blocked, all => ({ ...all, [backend]: q }))
}

async function track($: EngineInterface, id: string, patch: Partial<XAgent>) {
  await update($, agents, list => list.map(a => (a.id === id ? { ...a, ...patch } : a)))
}

// One CLI run. `stopped` is false only when a child we had to stop was not confirmed gone.
async function runOnce($: EngineInterface, input: DispatchInput, argv: string[], id: string): Promise<Parsed & { stopped: boolean }> {
  const out = feed(input.backend)
  let stderr = ''
  let failure: string | undefined
  let end: { code: number | null; signal: string | null } = { code: null, signal: null }
  let stopped = true
  let pulling = false
  // spawn closes stdin from the start (no `input`): codex exec otherwise waits on it.
  const stream = $.process.spawn({ argv, cwd: input.dir })
  const stop = () => stream.return({ code: null, signal: null })
  const grace = () => $.clock.sleep(STOP_GRACE_MS)
  // Wall clock, raced against each pull: a child that prints nothing must still stop.
  let ring: () => void = () => {}
  const expired = new Promise<'expired'>(resolve => (ring = () => resolve('expired')))
  const timer = $.clock.after(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => ring())
  try {
    while (true) {
      pulling = true
      const step = await Promise.race([stream.next(), expired])
      pulling = false
      if (step === 'expired') {
        stopped = await stopStream(stop, grace)
        failure = stopped ? 'timed out' : 'timed out (child may still be running)'
        break
      }
      if (step.done) {
        end = step.value ?? end
        break
      }
      const piece = step.value
      if (piece.stream === 'stderr') {
        stderr = (stderr + piece.text).slice(-2000)
        continue
      }
      const status = out.push(piece.text)
      if (status) await track($, id, { last: status })
    }
  } catch (err) {
    failure ??= (err as Error).message
    // A failed pull means the child never started or already ended. A failure in our own code
    // between pulls leaves it running, so stop it.
    if (!pulling) stopped = await stopStream(stop, grace)
  } finally {
    timer.cancel()
  }
  const stdout = out.text()
  const sessionId = sessionIdIn(input.backend, stdout)
  if (failure) return { ok: false, summary: '', sessionId, error: failure, stopped }
  const result = parse(input.backend, stdout, Boolean(input.schema))
  const why = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)
  // The CLI's own error (a usage limit, say) says more than stderr or the exit code.
  const said = !result.ok && result.error !== 'no answer in output' ? result.error : undefined
  // An answer only counts from a child that ended cleanly.
  if (end.signal) return { ...result, ok: false, error: said ?? `killed by ${end.signal}`, stopped }
  if (end.code !== 0) return { ...result, ok: false, error: said ?? (!result.ok && why ? why : `exited with code ${end.code}`), stopped }
  if (!result.ok && result.error === 'no answer in output' && why) return { ...result, error: why, stopped }
  return { ...result, stopped }
}

export async function runDispatch($: EngineInterface, raw: DispatchInput, task: string): Promise<DispatchResult> {
  const home = (await $.env.get('HOME')) ?? ''
  const input: DispatchInput = { ...raw, dir: raw.dir && expandHome(raw.dir, home), schema: raw.schema && expandHome(raw.schema, home) }
  let argv: string[]
  try {
    argv = buildArgv(input)
  } catch (err) {
    const q = (await snapshot($))[input.backend]
    return { ok: false, summary: '', sessionId: null, error: (err as Error).message, attempts: 0, baseTree: null, tree: null, filesChanged: null, quota: q }
  }
  const startedAt = await $.clock.now()
  const before = (await snapshot($))[input.backend]
  const refuse = (error: string, extra: Partial<DispatchResult> = {}): DispatchResult => ({ ok: false, summary: '', sessionId: null, error, attempts: 0, baseTree: null, tree: null, filesChanged: null, quota: before, ...extra })
  // The 90 % rule: no new work for a provider that close to a limit, unless the user said so.
  if (!input.override && isBlocked(before, startedAt)) return refuse(`${input.backend} is at 90 % of a quota window: ask the user, or pass override if they allow it`)
  // A writer may only start once its baseline is known: a lost baseline cannot be taken back after edits.
  const base = input.mode === 'write' ? await treeOf($, input.dir) : { tree: null }
  if (base.error) return refuse(`baseline snapshot failed: ${base.error}`, { treeError: base.error })
  const id = `x${startedAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const quotaLine = describeOne(input.backend, before, startedAt).split('\n')[0] ?? ''
  const one: XAgent = { id, backend: input.backend, model: input.model ?? 'default', effort: input.effort ?? 'default', task, status: 'running', startedAt, last: 'starting', quota: quotaLine }
  await update($, agents, list => [one, ...list].slice(0, 30))

  let attempts = 1
  let result = await runOnce($, input, argv, id)
  // One retry, owned here (the skill never retries): only once the first child is known to be gone.
  if (result.error === 'timed out' && result.stopped) {
    attempts = 2
    await track($, id, { last: 'timed out; retrying' })
    const again: DispatchInput = result.sessionId ? { ...input, resume: result.sessionId, prompt: RETRY_PROMPT } : input
    result = await runOnce($, again, buildArgv(again), id)
  }

  const now = await $.clock.now()
  if (!result.ok) {
    const why = result.error ?? ''
    if (AUTH_WORDS.test(why)) await mark($, input.backend, { state: 'unavailable', reason: why.slice(0, 80) })
    else if (LIMIT_WORDS.test(why)) await mark($, input.backend, { state: 'cooldown', until: now + COOLDOWN_MS })
  }
  const after = base.tree ? await treeOf($, input.dir) : { tree: null }
  const diff = base.tree && after.tree && input.dir ? await changedFiles($, input.dir, base.tree, after.tree) : null
  const treeError = after.error ?? (diff && 'error' in diff ? diff.error : undefined)
  const quota = (await snapshot($))[input.backend]
  await track($, id, { status: result.ok ? 'done' : 'failed', endedAt: now, last: result.ok ? 'finished' : `stopped: ${result.error}` })
  const { stopped: _, ...parsed } = result
  return {
    ...parsed,
    attempts,
    baseTree: base.tree,
    tree: after.tree,
    filesChanged: diff && 'files' in diff ? diff.files : null,
    quota,
    ...(treeError ? { treeError } : {}),
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.tool.register({ name: 'dispatch', description: 'Run one task on an external coding agent (codex, copilot, agy). Returns a short summary, the files it changed and a sessionId for resume.', inputSchema: DISPATCH_SCHEMA }).catch(() => {})
    await $.tool.register({ name: 'route', description: 'Pick implementer and reviewer models and efforts for one plan task, from quota, complexity and the current effort.', inputSchema: ROUTE_SCHEMA_IN }).catch(() => {})
    return r
  })

  // A gating hook answers even when something in it throws.
  on('tool.call', { tool: 'mcp__xagent__dispatch' }, async ($, e) => {
    const input: DispatchInput = e
    return runDispatch($, input, firstLine(input.prompt, 80))
      .then(r => ({ result: JSON.stringify(r) }))
      .catch((err: Error) => ({ deny: `xagent dispatch failed: ${err.message}` }))
  })
}
