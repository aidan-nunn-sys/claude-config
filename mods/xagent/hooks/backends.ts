// The command line for one dispatch. No shell: each element is one argv entry.
import type { DispatchInput } from '../types'

const COPILOT_CREDIT_CAP = '30' // the CLI's minimum; one run cannot eat the month

export function buildArgv(i: DispatchInput): string[] {
  if (i.backend === 'codex') {
    // `exec resume` takes no -s or -C, so the sandbox goes through -c and the directory through spawn's cwd.
    const argv = ['codex', 'exec', ...(i.resume ? ['resume'] : []), '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${i.mode === 'write' ? 'workspace-write' : 'read-only'}"`]
    if (i.model) argv.push('-m', i.model)
    if (i.effort) argv.push('-c', `model_reasoning_effort=${i.effort}`)
    if (i.schema) argv.push('--output-schema', i.schema)
    if (i.ephemeral) argv.push('--ephemeral')
    if (i.resume) return [...argv, i.resume, i.prompt]
    if (i.dir) argv.push('-C', i.dir)
    return [...argv, i.prompt]
  }
  if (i.backend === 'copilot') {
    if (i.mode === 'read-only') throw new Error('copilot has no read-only mode')
    const argv = ['copilot', '-p', i.prompt, '--output-format', 'json', '--allow-all-tools']
    if (i.effort) argv.push('--reasoning-effort', i.effort)
    if (i.resume) argv.push('--resume', i.resume)
    return [...argv, '--max-ai-credits', COPILOT_CREDIT_CAP]
  }
  const argv = ['agy', '-p', i.prompt, '--output-format', 'stream-json', '--mode', i.mode === 'write' ? 'accept-edits' : 'plan']
  if (i.model) argv.push('--model', i.model)
  if (i.effort) argv.push('--effort', i.effort)
  if (i.schema) argv.push('--json-schema', i.schema)
  if (i.resume) argv.push('--conversation', i.resume)
  return argv
}
