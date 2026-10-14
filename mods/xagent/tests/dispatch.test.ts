import { expect, test } from 'claude-code/testing'

import { expandHome, stopGraceMs, stopStream, withBackstop } from '../hooks/register'
import { engine, NOW, START } from './engine'
import type { Run } from './engine'

const call = ($: any, input: object) => $.tool.call({ tool: 'mcp__xagent__dispatch', ...input } as any)
const resultOf = (r: any) => JSON.parse(r.result)
const ok = (stdout = ''): Run => ({ exitCode: 0, stdout, stderr: '' })
const say = (text: string) => ({ stream: 'stdout' as const, text: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n` })

function child(on: any, out: string[], code = 0, signal: string | null = null) {
  const seen: any[] = []
  on('process.spawn', async function* (_$: any, e: any) {
    seen.push(e)
    for (const text of out) yield { stream: 'stdout' as const, text: text + '\n' }
    return { value: { code, signal } }
  })
  return seen
}

// A git repo whose working tree changes between the two snapshots; `log` keeps the order of setup steps.
function gitRepo(log: string[], fail?: string) {
  let trees = 0
  return (argv: string[]): Run | undefined => {
    if (argv[0] === 'mkdir') return log.push('mkdir'), ok()
    if (argv[0] === 'rm') return ok()
    if (argv[0] !== 'git') return undefined
    if (fail && argv.includes(fail)) return { exitCode: 1, stdout: '', stderr: `fatal: ${fail} failed` }
    if (argv.includes('rev-parse')) return ok('true\n')
    if (argv.includes('read-tree')) return log.push('read-tree'), ok()
    if (argv.includes('write-tree')) return ok(`tree-${++trees}\n`)
    if (argv.includes('diff')) return ok('calc.py\0new test.py\0')
    return ok()
  }
}

test('runs codex in a repo: summary, session, files changed, tracked agent', async ($, on) => {
  const log: string[] = []
  const { runs, state } = engine(on, { run: gitRepo(log) })
  const seen = child(on, ['{"type":"thread.started","thread_id":"t-9"}', '{"type":"item.completed","item":{"type":"agent_message","text":"all green"}}'])
  await $.session.start(START)
  const r = resultOf(await call($, { backend: 'codex', mode: 'write', prompt: 'do task 2\nmore', dir: '/repo' }))
  expect(r).toMatchObject({ ok: true, summary: 'all green', sessionId: 't-9', attempts: 1, baseTree: 'tree-1', tree: 'tree-2', filesChanged: ['calc.py', 'new test.py'], quota: { state: 'unknown' } })
  expect(r.treeError).toBeUndefined()
  // the CLI runs under coreutils timeout: 20 min default + 5 s, then KILL 10 s later
  expect(seen[0].argv).toEqual(['timeout', '--kill-after=10s', '1205s', 'codex', 'exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-C', '/repo', '--', 'do task 2\nmore'])
  expect(seen[0].cwd).toBe('/repo')
  expect(log.slice(0, 2)).toEqual(['mkdir', 'read-tree']) // the scratch index's folder exists first
  // the user's index is never touched: every git call that stages goes through a scratch index
  const staging = runs.filter(x => x.argv.includes('add') || x.argv.includes('read-tree'))
  expect(staging.length).toBeGreaterThan(0)
  for (const run of staging) expect(run.env?.GIT_INDEX_FILE ?? '').toMatch(/^\/home\/u\/\.cache\/xagent\/index-/)
  expect(runs.some(x => x.argv.includes('diff') && x.argv.includes('-z'))).toBe(true)
  expect(state.agents).toMatchObject([{ backend: 'codex', status: 'done', task: 'do task 2', startedAt: NOW }])
})

test('outside a repo, trees and filesChanged are null with no error', async ($, on) => {
  engine(on)
  child(on, ['{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'])
  await $.session.start(START)
  const r = resultOf(await call($, { backend: 'codex', mode: 'write', prompt: 'p', dir: '/tmp/x' }))
  expect(r).toMatchObject({ ok: true, baseTree: null, tree: null, filesChanged: null })
  expect(r.treeError).toBeUndefined()
})

test('a failed baseline snapshot in a repo stops the run before the writer starts', async ($, on) => {
  engine(on, { run: gitRepo([], 'add') })
  const seen = child(on, ['{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'])
  await $.session.start(START)
  expect(resultOf(await call($, { backend: 'codex', mode: 'write', prompt: 'p', dir: '/repo' }))).toMatchObject({ ok: false, attempts: 0, baseTree: null, filesChanged: null, treeError: expect.stringContaining('add failed') })
  expect(seen).toEqual([])
})

test('a failed diff after the run is reported, not passed off as no repo', async ($, on) => {
  engine(on, { run: gitRepo([], 'diff') })
  child(on, ['{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'])
  await $.session.start(START)
  expect(resultOf(await call($, { backend: 'codex', mode: 'write', prompt: 'p', dir: '/repo' }))).toMatchObject({ ok: true, baseTree: 'tree-1', tree: 'tree-2', filesChanged: null, treeError: expect.stringContaining('diff failed') })
})

test('a backend at 90 % is refused unless the user overrides', async ($, on) => {
  const at95 = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 95, window_minutes: 300, resets_at: NOW / 1000 + 3600 } } } })
  engine(on, {
    run: argv => {
      if (argv[0] === 'find') return ok('1792000000.5 /home/u/.codex/sessions/2026/10/14/rollout-a.jsonl\n')
      if (argv[0] === 'tac') return ok(`${at95}\n`)
      return undefined
    },
  })
  const seen = child(on, ['{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'])
  await $.session.start(START)
  expect(resultOf(await call($, { backend: 'codex', mode: 'write', prompt: 'p' }))).toMatchObject({ ok: false, attempts: 0, error: expect.stringContaining('codex is at 90 %') })
  expect(seen).toEqual([])
  expect(resultOf(await call($, { backend: 'codex', mode: 'write', prompt: 'p', override: true }))).toMatchObject({ ok: true })
})

test('~/ in dir and schema is expanded', async ($, on) => {
  engine(on)
  const seen = child(on, ['{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}'])
  await $.session.start(START)
  await call($, { backend: 'codex', mode: 'read-only', prompt: 'p', dir: '~/repo', schema: '~/.claude/s.json' })
  expect(seen[0].argv).toEqual(expect.arrayContaining(['--output-schema', '/home/u/.claude/s.json', '-C', '/home/u/repo']))
  expect(expandHome('/abs', '/home/u')).toBe('/abs')
})

test('a schema answer comes back whole as `answer`', async ($, on) => {
  engine(on)
  const long = JSON.stringify({ verdict: 'revise', blocking: ['x'.repeat(6000)], nits: [] })
  child(on, [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: long } })])
  await $.session.start(START)
  const r = resultOf(await call($, { backend: 'codex', mode: 'read-only', prompt: 'review', schema: '/s.json' }))
  expect(r.ok).toBe(true)
  expect(r.answer).toBe(long)
})

test('an answer followed by a failed exit or a signal is a failure that keeps the summary', async ($, on) => {
  engine(on)
  let end: { code: number | null; signal: string | null } = { code: 1, signal: null }
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"type":"thread.started","thread_id":"t-2"}\n' }
    yield say('half done')
    return { value: end }
  })
  await $.session.start(START)
  expect(resultOf(await call($, { backend: 'codex', mode: 'write', prompt: 'p' }))).toMatchObject({ ok: false, summary: 'half done', sessionId: 't-2', error: 'exited with code 1' })
  end = { code: null, signal: 'SIGTERM' }
  expect(resultOf(await call($, { backend: 'codex', mode: 'write', prompt: 'p' }))).toMatchObject({ ok: false, summary: 'half done', error: 'killed by SIGTERM' })
})

test('a logged-out CLI (stderr, exit 1) is marked unavailable', async ($, on) => {
  const { state } = engine(on)
  on('process.spawn', async function* () {
    yield { stream: 'stderr' as const, text: 'Error: Not logged in. Run `codex login`.\n' }
    return { value: { code: 1, signal: null } }
  })
  await $.session.start(START)
  expect(resultOf(await call($, { backend: 'codex', mode: 'write', prompt: 'p' }))).toMatchObject({ ok: false, error: expect.stringContaining('Not logged in'), quota: { state: 'unavailable' } })
  expect(state.blocked).toMatchObject({ codex: { state: 'unavailable' } })
})

test('spawn failure marks the backend unavailable', async ($, on) => {
  const { state } = engine(on)
  on('process.spawn', async function* () {
    return { deny: 'spawn agy ENOENT' } // how the engine reports a child that cannot start
  })
  await $.session.start(START)
  expect(resultOf(await call($, { backend: 'agy', mode: 'write', prompt: 'p' }))).toMatchObject({ ok: false, error: expect.stringContaining('ENOENT') })
  expect(state.blocked).toMatchObject({ agy: { state: 'unavailable' } })
})

test('a usage-limit failure cools the backend down for 30 minutes, then live data is back', async ($, on) => {
  const { clock } = engine(on)
  let limited = true
  on('process.spawn', async function* () {
    if (limited) {
      yield { stream: 'stdout' as const, text: '{"type":"turn.failed","error":{"message":"You have hit your usage limit"}}\n' }
      return { value: { code: 1, signal: null } }
    }
    yield say('ok')
    return { value: { code: 0, signal: null } }
  })
  await $.session.start(START)
  expect(resultOf(await call($, { backend: 'codex', mode: 'write', prompt: 'p' })).quota).toEqual({ state: 'cooldown', until: NOW + 30 * 60_000 })
  await clock.advance(31 * 60_000)
  limited = false
  expect(resultOf(await call($, { backend: 'codex', mode: 'write', prompt: 'p' })).quota).toEqual({ state: 'unknown' })
})

test('codex quota comes from the most recently written rollout, read from its end', async ($, on) => {
  const sample = (p: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: p, window_minutes: 300, resets_at: NOW / 1000 + 3600 } } } })
  engine(on, {
    run: argv => {
      // an older session resumed today: its file is newer by mtime than today's newest name
      if (argv[0] === 'find') return ok('1792000000.5 /home/u/.codex/sessions/2026/10/14/rollout-2026-10-14T11-00-00-new.jsonl\n1792000900.1 /home/u/.codex/sessions/2026/10/01/rollout-2026-10-01T09-00-00-old.jsonl\n')
      if (argv[0] === 'tac' && argv[1]?.endsWith('old.jsonl')) return ok(`{"type":"turn"}\n${sample(77)}\n${sample(20)}\n`) // newest line first
      if (argv[0] === 'tac') return ok(`${sample(5)}\n`)
      return undefined
    },
  })
  child(on, ['{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'])
  await $.session.start(START)
  expect(resultOf(await call($, { backend: 'codex', mode: 'write', prompt: 'p' })).quota).toMatchObject({ state: 'windows', windows: [{ usedPercent: 77 }] })
})

test('a truly silent child is stopped and retried once, even if the stream cannot interrupt its pull', async ($, on) => {
  const { clock } = engine(on)
  let started = 0
  let stopped = 0
  const seen: string[][] = []
  on('process.spawn', async function* (_$: any, e: any) {
    started++
    seen.push([...e.argv])
    try {
      // Prints nothing and ignores the stream's stop, like a CLI blocked on a hung call.
      // Only the OS ends it: coreutils timeout, when the argv carries the backstop.
      if (e.argv[0] !== 'timeout') await new Promise(() => {})
      await clock.sleep(Number(e.argv[2].slice(0, -1)) * 1000)
      return { value: { code: 124, signal: null } }
    } finally {
      stopped++
    }
  })
  await $.session.start(START)
  const pending = call($, { backend: 'codex', mode: 'write', prompt: 'p', timeoutMs: 10_000 })
  await clock.settle() // let the dispatch reach its timer before time moves
  let done = false
  void pending.then(() => (done = true))
  for (let i = 0; i < 40 && !done; i++) await clock.advance(1_000)
  expect(resultOf(await pending)).toMatchObject({ ok: false, error: 'timed out', attempts: 2 })
  expect([started, stopped]).toEqual([2, 2])
  expect(seen[0]?.slice(0, 4)).toEqual(['timeout', '--kill-after=10s', '15s', 'codex'])
})

test('a child that will not stop is reported, not retried', async ($, on) => {
  const { clock } = engine(on)
  let started = 0
  on('process.spawn', async function* () {
    started++
    await new Promise(() => {}) // never writes, never exits, cannot be returned
  })
  await $.session.start(START)
  const pending = call($, { backend: 'codex', mode: 'write', prompt: 'p', timeoutMs: 10_000 })
  await clock.settle()
  await clock.advance(10_000)
  await clock.settle()
  await clock.advance(7_000) // the grace: past the backstop's TERM (5 s) plus 2 s
  expect(resultOf(await pending)).toMatchObject({ ok: false, error: 'timed out (child may still be running)', attempts: 1 })
  expect(started).toBe(1)
})

test('stopStream: a rejected or hanging stop is not a confirmed stop', async () => {
  const never = () => new Promise<void>(() => {})
  const now = () => Promise.resolve()
  expect(await stopStream(() => Promise.resolve(), never)).toBe(true)
  expect(await stopStream(() => Promise.reject(new Error('kill failed')), never)).toBe(false)
  expect(await stopStream(() => new Promise(() => {}), now)).toBe(false)
})

test('stopStream: the pending pull ending the stream confirms a stop that hangs; more output does not', async () => {
  const hang = () => new Promise<void>(() => {})
  const never = () => new Promise<void>(() => {})
  const now = () => Promise.resolve()
  expect(await stopStream(hang, never, Promise.resolve({ done: true, value: { code: 124, signal: null } }))).toBe(true)
  expect(await stopStream(hang, never, Promise.reject(new Error('gone')))).toBe(true)
  expect(await stopStream(hang, now, Promise.resolve({ done: false, value: { stream: 'stdout', text: 'x' } }))).toBe(false)
})

test('the backstop: coreutils timeout 5 s past the limit (rounded up), and a grace that outlasts it', () => {
  expect(withBackstop(['codex', 'exec', '--', '-x'], 1_500)).toEqual(['timeout', '--kill-after=10s', '7s', 'codex', 'exec', '--', '-x'])
  expect(stopGraceMs(10_000)).toBe(7_000)
  expect(stopGraceMs(1_500)).toBe(7_500) // TERM at 7 s after spawn = 5.5 s after the limit
})

test('a CLI that is not installed (coreutils timeout cannot run it) is marked unavailable', async ($, on) => {
  const { state } = engine(on)
  on('process.spawn', async function* () {
    yield { stream: 'stderr' as const, text: 'timeout: failed to run command \u2018codex\u2019: No such file or directory\n' }
    return { value: { code: 127, signal: null } }
  })
  await $.session.start(START)
  expect(resultOf(await call($, { backend: 'codex', mode: 'write', prompt: 'p' }))).toMatchObject({ ok: false, error: expect.stringContaining('failed to run command') })
  expect(state.blocked).toMatchObject({ codex: { state: 'unavailable' } })
})

test('a dispatch that throws after the agent is listed ends it as failed, not running', async ($, on) => {
  const { state } = engine(on)
  child(on, ['{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'])
  // The quota read after the run fails: the first read of the marks (before the run) works.
  let reads = 0
  on('state.get', { plugin: 'xagent' }, async (_$: any, e: any, next: any) => {
    if (e.key === 'blocked' && ++reads === 2) return { deny: 'state store gone' }
    return next(e)
  })
  await $.session.start(START)
  const r: any = await call($, { backend: 'codex', mode: 'write', prompt: 'p' })
  expect(r.deny).toContain('xagent dispatch failed')
  expect(state.agents).toMatchObject([{ status: 'failed', endedAt: NOW, last: expect.stringContaining('stopped:') }])
})

test('a timeout after a session id resumes it', async ($, on) => {
  const { clock } = engine(on)
  const seen: string[][] = []
  on('process.spawn', async function* (_$: any, e: any) {
    seen.push(e.argv)
    if (seen.length === 1) {
      yield { stream: 'stdout' as const, text: '{"type":"thread.started","thread_id":"t-5"}\n' }
      while (true) {
        await clock.sleep(1_000)
        yield { stream: 'stderr' as const, text: '.' }
      }
    }
    yield say('finished')
    return { value: { code: 0, signal: null } }
  })
  await $.session.start(START)
  const pending = call($, { backend: 'codex', mode: 'write', prompt: 'p', timeoutMs: 10_000 })
  await clock.settle()
  for (let i = 0; i < 15; i++) await clock.advance(1_000)
  expect(resultOf(await pending)).toMatchObject({ ok: true, summary: 'finished', attempts: 2 })
  expect(seen[1]).toEqual(expect.arrayContaining(['resume', 't-5']))
})

test('copilot read-only is refused before spawning', async ($, on) => {
  engine(on)
  const seen = child(on, [])
  await $.session.start(START)
  expect(resultOf(await call($, { backend: 'copilot', mode: 'read-only', prompt: 'p' }))).toMatchObject({ ok: false, error: 'copilot has no read-only mode', attempts: 0 })
  expect(seen).toEqual([])
})
