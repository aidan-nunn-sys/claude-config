// xagent: run Codex as a worker for a Claude Code session. dispatch runs one external agent.
import { atom, update } from 'claude-code'
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
    backend: { type: 'string', enum: ['codex', 'opencode'] },
    model: { type: 'string' },
    effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
    mode: { type: 'string', enum: ['read-only', 'write'] },
    prompt: { type: 'string' },
    dir: { type: 'string', description: 'working directory, absolute' },
    schema: { type: 'string', description: 'path to a JSON schema file; the full answer comes back as `answer`' },
    resume: { type: 'string', description: 'sessionId from an earlier dispatch, to continue it' },
    network: { type: 'boolean', description: 'codex write mode: allow the sandbox network access' },
    agent: { type: 'string', description: 'opencode: agent name to run as' },
    outputFile: { type: 'string', description: 'absolute path or ~, shaped <repo>/.factory/jobs/<job>/[round-N/]<name>.md: the whole answer is written here on success' },
    timeoutMs: { type: 'number' },
    override: { type: 'boolean', description: 'run on a backend at 90 % of its quota; only when the user said so' },
  },
  required: ['backend', 'mode', 'prompt'],
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000
const BACKSTOP_S = 5 // coreutils timeout sends TERM this long past the time limit, KILL 10 s later
const STOP_SLACK_MS = 2_000 // how long past that TERM a stop may take to be confirmed
// The headroom proxy wrapper exports these; inherited, they put copilot in BYOK mode and bill Claude, not the backend's own subscription login.
const PROXY_ENV = ['COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_TYPE', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN', 'COPILOT_MODEL', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL']
const COOLDOWN_MS = 30 * 60_000
const LIMIT_WORDS = /usage limit|rate limit|quota|exceeded|\b429\b/i
// `failed to run command`: coreutils timeout could not start the CLI (not installed, not on PATH).
const AUTH_WORDS = /not logged in|log in|unauthori[sz]ed|\b401\b|ENOENT|command not found|failed to run command/i
const RETRY_PROMPT = 'You were stopped at the time limit. Continue the same task from where you are, then give the final answer.'

export function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path
}

const OUTPUT_FILE = /^\/.+\/\.factory\/jobs\/[^/]+\/(round-\d+\/)?[^/]+\.md$/

export function validOutputFile(path: string): boolean {
  return OUTPUT_FILE.test(path) && !path.split('/').includes('..')
}

// The OS backstop, still argv: coreutils timeout ends the child (and what it started) a few
// seconds past the time limit, whether or not the engine's stream can interrupt a pending pull.
export function withBackstop(argv: string[], timeoutMs: number): string[] {
  return ['env', ...PROXY_ENV.flatMap(name => ['-u', name]), 'timeout', '--kill-after=10s', `${Math.ceil(timeoutMs / 1000) + BACKSTOP_S}s`, ...argv]
}

// How long after the time limit a stop may take to be confirmed: until just past the backstop's TERM.
export function stopGraceMs(timeoutMs: number): number {
  return Math.ceil(timeoutMs / 1000) * 1000 - timeoutMs + BACKSTOP_S * 1000 + STOP_SLACK_MS
}

// Ends the child through its stream (leaving the loop kills it) and says whether that is
// confirmed within the grace period: stop() resolved, or the pull already under way ended the
// stream (the child is gone) or failed. A pull that brings more output means it is still alive.
// A rejected or hanging stop() alone is not confirmed.
export async function stopStream(stop: () => Promise<unknown>, sleep: () => Promise<void>, pending?: Promise<IteratorResult<unknown, unknown>>): Promise<boolean> {
  const never = new Promise<boolean>(() => {})
  const ended = stop().then(() => true, () => false)
  const pulled = pending ? pending.then(step => (step.done ? true : never), () => true) : never
  return Promise.race([ended, pulled, sleep().then(() => false)])
}

async function mark($: EngineInterface, backend: string, q: ProviderQuota) {
  await update($, blocked, all => ({ ...all, [backend]: q }))
}

async function track($: EngineInterface, id: string, patch: Partial<XAgent>) {
  await update($, agents, list => list.map(a => (a.id === id ? { ...a, ...patch } : a)))
}

// One CLI run. `stopped` is false only when a child we had to stop was not confirmed gone.
async function runOnce($: EngineInterface, input: DispatchInput, argv: string[], id: string, signal?: AbortSignal): Promise<Parsed & { stopped: boolean }> {
  const out = feed(input.backend)
  let stderr = ''
  let failure: string | undefined
  let end: { code: number | null; signal: string | null } = { code: null, signal: null }
  let stopped = true
  let pulling = false
  const limit = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // spawn closes stdin from the start (no `input`): codex exec otherwise waits on it.
  const stream = $.process.spawn({ argv: withBackstop(argv, limit), cwd: input.dir })
  const stop = () => stream.return({ code: null, signal: null })
  const grace = () => $.clock.sleep(stopGraceMs(limit))
  // Wall clock, raced against each pull: a child that prints nothing must still stop.
  let ring: () => void = () => {}
  const expired = new Promise<'expired'>(resolve => (ring = () => resolve('expired')))
  const timer = $.clock.after(limit, () => ring())
  // The user interrupted (Esc): the engine kills the child; stop reading at once.
  const aborted = new Promise<'aborted'>(resolve => {
    if (signal?.aborted) resolve('aborted')
    else signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
  })
  try {
    while (true) {
      pulling = true
      // The pull is kept, not dropped: if the stream cannot be stopped while it is pending, its
      // end (the backstop killed the child) is what confirms the stop.
      const pull = stream.next()
      const step = await Promise.race([pull, expired, aborted])
      pulling = false
      if (step === 'aborted') {
        void stop().catch(() => {})
        void pull.catch(() => {}) // left unread: its end no longer matters
        failure = 'interrupted'
        break
      }
      if (step === 'expired') {
        stopped = await stopStream(stop, grace, pull)
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

export async function runDispatch($: EngineInterface, raw: DispatchInput, task: string, signal?: AbortSignal): Promise<DispatchResult> {
  const home = (await $.env.get('HOME')) ?? ''
  const input: DispatchInput = { ...raw, dir: raw.dir && expandHome(raw.dir, home), schema: raw.schema && expandHome(raw.schema, home), outputFile: raw.outputFile && expandHome(raw.outputFile, home) }
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
  // outputFile is written outside the host's permission checks: only a job's own .md under .factory.
  if (input.outputFile !== undefined && !validOutputFile(input.outputFile)) return refuse('outputFile must be <repo>/.factory/jobs/<job>/[round-N/]<name>.md, absolute, with no ..')
  // A writer may only start once its baseline is known: a lost baseline cannot be taken back after edits.
  const base = input.mode === 'write' ? await treeOf($, input.dir) : { tree: null }
  if (base.error) return refuse(`baseline snapshot failed: ${base.error}`, { treeError: base.error })
  const id = `x${startedAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const quotaLine = describeOne(input.backend, before, startedAt).split('\n')[0] ?? ''
  const one: XAgent = { id, backend: input.backend, model: input.model ?? 'default', effort: input.effort ?? 'default', task, status: 'running', startedAt, last: 'starting', quota: quotaLine }
  await update($, agents, list => [one, ...list].slice(0, 30))

  // From here the agent is listed as running: whatever happens below, it must not stay that way.
  let ended = false
  let thrown: unknown
  try {
    let attempts = 1
    let result: Parsed & { stopped: boolean } = await runOnce($, input, argv, id, signal)
    // One retry, owned here (the skill never retries): only once the first child is known to be
    // gone, and never after the user interrupted.
    if (result.error === 'timed out' && result.stopped && !signal?.aborted) {
      attempts = 2
      await track($, id, { last: 'timed out; retrying' })
      const again: DispatchInput = result.sessionId ? { ...input, resume: result.sessionId, prompt: RETRY_PROMPT } : input
      result = await runOnce($, again, buildArgv(again), id, signal)
    }
    // Interrupted: the engine has moved on and may refuse further calls; end the agent first and
    // skip the tree, diff and quota work.
    if (signal?.aborted) {
      await track($, id, { status: 'failed', endedAt: await $.clock.now().catch(() => startedAt), last: 'stopped: interrupted' })
      ended = true
      const { stopped: _, full: __, ...parsed } = result
      return { ...parsed, ok: false, error: 'interrupted', attempts, baseTree: base.tree, tree: null, filesChanged: null, quota: before }
    }

    const now = await $.clock.now()
    // An interrupt says nothing about the backend: leave its quota marks alone.
    if (!result.ok && !signal?.aborted) {
      const why = result.error ?? ''
      if (AUTH_WORDS.test(why)) await mark($, input.backend, { state: 'unavailable', reason: why.slice(0, 80) })
      // opencode is free-tier: its 429s and "exceeded" output-length errors must not block the one rerun.
      else if (input.backend !== 'opencode' && LIMIT_WORDS.test(why)) await mark($, input.backend, { state: 'cooldown', until: now + COOLDOWN_MS })
    }
    // The whole answer goes to the file, uncut. A failed run writes nothing. This comes after the quota marks: a write failure says nothing about the backend.
    let written: string | undefined
    if (result.ok && input.outputFile && result.full !== undefined) {
      try {
        await $.fs.write(input.outputFile, `${result.full}\n`)
        written = input.outputFile
      } catch (err) {
        result = { ...result, ok: false, error: `could not write outputFile: ${(err as Error).message}` }
      }
    }

    const after = base.tree ? await treeOf($, input.dir) : { tree: null }
    const diff = base.tree && after.tree && input.dir ? await changedFiles($, input.dir, base.tree, after.tree) : null
    const treeError = after.error ?? (diff && 'error' in diff ? diff.error : undefined)
    const quota = (await snapshot($))[input.backend]
    await track($, id, { status: result.ok ? 'done' : 'failed', endedAt: now, last: result.ok ? 'finished' : `stopped: ${result.error}` })
    ended = true
    const { stopped: _, full: __, ...parsed } = result
    return {
      ...parsed,
      ...(written ? { outputFile: written } : {}),
      attempts,
      baseTree: base.tree,
      tree: after.tree,
      filesChanged: diff && 'files' in diff ? diff.files : null,
      quota,
      ...(treeError ? { treeError } : {}),
    }
  } catch (err) {
    thrown = err
    throw err
  } finally {
    if (!ended) {
      const why = thrown instanceof Error ? thrown.message : signal?.aborted ? 'interrupted' : String(thrown ?? 'unknown')
      const at = await $.clock.now().catch(() => startedAt)
      await track($, id, { status: 'failed', endedAt: at, last: `stopped: ${why}` }).catch(() => {})
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.tool.register({ name: 'dispatch', description: 'Run one task on an external coding agent (codex or opencode). Returns a short summary, the files it changed and a sessionId for resume.', inputSchema: DISPATCH_SCHEMA }).catch(() => {})
    return r
  })

  // A gating hook answers even when something in it throws.
  on('tool.call', { tool: 'mcp__xagent__dispatch' }, async ($, e, next) => {
    const input: DispatchInput = e
    return runDispatch($, input, firstLine(input.prompt, 80), next.signal)
      .then(r => ({ result: JSON.stringify(r) }))
      .catch((err: Error) => ({ deny: `xagent dispatch failed: ${err.message}` }))
  })

  // The transcript row echoes the whole input, prompt included; draw the prompt's first line only.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== 'mcp__xagent__dispatch') return next(e)
    const input = (e.props.input ?? {}) as Record<string, unknown>
    const prompt = typeof input.prompt === 'string' ? firstLine(input.prompt, 80) : input.prompt
    return next({ ...e, props: { ...e.props, input: { ...input, prompt } } })
  })
}
