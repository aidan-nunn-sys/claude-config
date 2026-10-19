// What xagent reads from the host: git trees of a working directory, and each provider's quota.
import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ProviderQuota, Snapshot } from '../types'
import { claudeFromUsage, codexFromRollout, merge } from './quota'

const blocked = atom({ plugin: 'xagent', key: 'blocked' } as const, {} as Record<string, ProviderQuota>)

export type Tree = { tree: string | null; error?: string }

async function home($: EngineInterface) {
  return (await $.env.get('HOME')) ?? ''
}

const lastErr = (stderr: string) => stderr.trim().split('\n').slice(-1)[0] ?? ''

// The working tree, untracked files included, as a git tree object. A scratch index keeps the
// user's own index untouched. `tree: null` with no error: not a git repo.
export async function treeOf($: EngineInterface, dir?: string): Promise<Tree> {
  if (!dir) return { tree: null }
  const inside = await $.process.run(['git', '-C', dir, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 10_000 }).catch(() => null)
  if (!inside || inside.exitCode !== 0) return { tree: null }
  const scratch = `${await home($)}/.cache/xagent`
  const index = `${scratch}/index-${await $.clock.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    const made = await $.process.run(['mkdir', '-p', scratch], { timeoutMs: 5_000 })
    if (made.exitCode !== 0) return { tree: null, error: `mkdir ${scratch}: ${lastErr(made.stderr)}` }
    const git = (args: string[]) => $.process.run(['git', '-C', dir, ...args], { env: { GIT_INDEX_FILE: index }, timeoutMs: 60_000 })
    if ((await git(['read-tree', 'HEAD'])).exitCode !== 0) {
      const empty = await git(['read-tree', '--empty']) // a repo with no commits yet
      if (empty.exitCode !== 0) return { tree: null, error: `git read-tree: ${lastErr(empty.stderr)}` }
    }
    const added = await git(['add', '-A'])
    if (added.exitCode !== 0) return { tree: null, error: `git add: ${lastErr(added.stderr)}` }
    const tree = await git(['write-tree'])
    if (tree.exitCode !== 0 || !tree.stdout.trim()) return { tree: null, error: `git write-tree: ${lastErr(tree.stderr)}` }
    return { tree: tree.stdout.trim() }
  } catch (err) {
    return { tree: null, error: (err as Error).message }
  } finally {
    await $.process.run(['rm', '-f', index], { timeoutMs: 5_000 }).catch(() => null)
  }
}

// NUL-separated names, so paths with spaces or non-ASCII come back as they are.
export async function changedFiles($: EngineInterface, dir: string, a: string, b: string): Promise<{ files: string[] } | { error: string }> {
  const r = await $.process.run(['git', '-C', dir, 'diff', '--name-only', '-z', a, b], { timeoutMs: 30_000 }).catch(() => null)
  if (!r || r.exitCode !== 0) return { error: `git diff: ${lastErr(r?.stderr ?? 'did not run')}` }
  if (r.isStdoutTruncated) return { error: 'git diff: file list too long' }
  return { files: r.stdout.split('\0').filter(Boolean) }
}

// The rollout written most recently (a resumed old session counts), read from its end: the first
// rate_limits sample found is the newest. Up to three files, for one with no sample yet.
async function codexQuota($: EngineInterface) {
  const sessions = `${await home($)}/.codex/sessions`
  const found = await $.process.run(['find', sessions, '-name', 'rollout-*.jsonl', '-mtime', '-8', '-printf', '%T@ %p\\n'], { timeoutMs: 10_000 }).catch(() => null)
  if (!found || found.exitCode !== 0) return codexFromRollout('')
  const newest = found.stdout
    .split('\n')
    .map(l => /^(\S+) (.+)$/.exec(l))
    .flatMap(m => (m?.[1] && m[2] ? [{ at: Number(m[1]), path: m[2] }] : []))
    .sort((x, y) => y.at - x.at)
    .slice(0, 3)
  for (const f of newest) {
    // tac puts the end first; process.run keeps the first 4 MB, so that is the file's last 4 MB.
    const r = await $.process.run(['tac', f.path], { timeoutMs: 10_000 }).catch(() => null)
    if (!r || r.exitCode !== 0) continue
    const q = codexFromRollout(r.stdout.split('\n').reverse().join('\n'))
    if (q.state !== 'unknown') return q
  }
  return codexFromRollout('')
}

export async function snapshot($: EngineInterface): Promise<Snapshot> {
  const now = await $.clock.now()
  const marks = await read($, blocked)
  const usage = await $.session.usage().catch(() => null)
  return {
    claude: claudeFromUsage(usage?.rateLimits ?? []),
    codex: merge(marks.codex, await codexQuota($), now),
    opencode: merge(marks.opencode, { state: 'unknown' }, now),
  }
}
