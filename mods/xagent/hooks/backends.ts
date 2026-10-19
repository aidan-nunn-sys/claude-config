// The command line for one dispatch. No shell: each element is one argv entry.
import type { DispatchInput } from '../types'

export function buildArgv(i: DispatchInput): string[] {
  if (i.backend === 'codex') {
    // `exec resume` takes no -s or -C, so the sandbox goes through -c and the directory through spawn's cwd.
    const argv = ['codex', 'exec', ...(i.resume ? ['resume'] : []), '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${i.mode === 'write' ? 'workspace-write' : 'read-only'}"`]
    if (i.model) argv.push('-m', i.model)
    if (i.effort) argv.push('-c', `model_reasoning_effort=${i.effort}`)
    if (i.schema) argv.push('--output-schema', i.schema)
    // `--` ends the options: a prompt starting with `-` (a pasted "- [ ] Step") is not a flag.
    if (i.resume) return [...argv, '--', i.resume, i.prompt]
    if (i.dir) argv.push('-C', i.dir)
    return [...argv, '--', i.prompt]
  }
  throw new Error(`unknown backend ${String(i.backend)}`)
}
