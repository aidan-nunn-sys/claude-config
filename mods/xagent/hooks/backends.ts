// The command line for one dispatch. No shell: each element is one argv entry.
import type { DispatchInput } from '../types'

// opencode has no sandbox flag, so a run is only as read-only as its agent: only these deny edits.
export const OPENCODE_READONLY_AGENTS = ['factory-reviewer']

export function buildArgv(i: DispatchInput): string[] {
  if (i.backend === 'codex') {
    // `exec resume` takes no -s or -C, so the sandbox goes through -c and the directory through spawn's cwd.
    const argv = ['codex', 'exec', ...(i.resume ? ['resume'] : []), '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${i.mode === 'write' ? 'workspace-write' : 'read-only'}"`]
    if (i.model) argv.push('-m', i.model)
    if (i.effort) argv.push('-c', `model_reasoning_effort=${i.effort}`)
    if (i.network && i.mode === 'write') argv.push('-c', 'sandbox_workspace_write.network_access=true')
    if (i.schema) argv.push('--output-schema', i.schema)
    // `--` ends the options: a prompt starting with `-` (a pasted "- [ ] Step") is not a flag.
    if (i.resume) return [...argv, '--', i.resume, i.prompt]
    if (i.dir) argv.push('-C', i.dir)
    return [...argv, '--', i.prompt]
  }
  if (i.backend === 'opencode') {
    if (i.mode !== 'read-only') throw new Error('opencode runs read-only only')
    if (!i.agent) throw new Error('opencode read-only needs an agent with edits denied')
    if (!OPENCODE_READONLY_AGENTS.includes(i.agent)) throw new Error(`opencode agent ${i.agent} is not an allowed read-only agent`)
    // Never --auto: a run that needs approval fails rather than approving itself.
    // --flag=value, so a value starting with `-` cannot become a flag.
    const argv = ['opencode', 'run', '--format', 'json']
    if (i.model) argv.push(`--model=${i.model}`)
    if (i.effort) argv.push(`--variant=${i.effort}`)
    if (i.agent) argv.push(`--agent=${i.agent}`)
    if (i.dir) argv.push(`--dir=${i.dir}`)
    if (i.resume) argv.push(`--session=${i.resume}`)
    return [...argv, '--', i.prompt]
  }
  throw new Error(`unknown backend ${String(i.backend)}`)
}
