// Handoff: /handoff [what comes next] writes a handoff document for a fresh session.
// The file goes to ~/.claude/handoffs, never into the repo, so it cannot be committed by accident.
import type { EngineInterface, Register } from 'claude-code'

const MODEL = 'sonnet'
const MAX_MESSAGES = 80
const MAX_TEXT = 1500

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({
      name: 'handoff',
      description: 'Write a handoff document so a fresh session can pick this work up',
      argumentHint: '[what the next session should do]',
    }).catch(() => {}) // a name Claude Code already has is refused: start anyway
    return r
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const cwd = await $.session.cwd()
    const messages = (await $.session.messages()).slice(-MAX_MESSAGES)
    if (messages.length === 0) return { text: 'Nothing to hand off yet: the session has no messages.' }

    const [status, log] = await Promise.all([
      git($, cwd, ['status', '--short', '--branch']),
      git($, cwd, ['log', '-8', '--oneline']),
    ])
    const r = await $.model.complete({
      model: MODEL,
      maxTokens: 2500,
      system: SYSTEM,
      prompt: [
        `Working directory: ${cwd}`,
        `<git-status>\n${status}\n</git-status>`,
        `<git-log>\n${log}\n</git-log>`,
        `<transcript>\n${transcript(messages)}\n</transcript>`,
        e.args.trim() !== '' ? `The person says the next session should: ${e.args.trim()}` : '',
        'Write the handoff document for the transcript above now: the markdown only, not a reply to it.',
      ].filter(Boolean).join('\n\n'),
    })
    if (!r.isAnswered) return { text: `Could not write a handoff (${r.reason}). Try again.` }

    const home = (await $.env.get('HOME')) ?? ''
    const path = `${home}/.claude/handoffs/${slug(cwd)}-${stamp()}.md`
    await $.fs.write(path, `${r.text.trim()}\n`)
    return {
      text: [
        `Handoff written: ${path}`,
        `Start the next session with: Read ${path} and continue from it.`,
      ].join('\n'),
    }
  })
}

const SYSTEM =
  'You write a handoff document so a fresh coding session, with no memory of this one, can continue the work. ' +
  'Plain words, no em dashes. Markdown with these sections, leaving out one that is empty: ' +
  '"Goal", "State" (done, in progress, branch and uncommitted files), "Decisions" (each with its reason), ' +
  '"Open items" (blocked, waiting on the person, unverified), "Next steps" (ordered, concrete, with file paths), ' +
  '"Gotchas" (things that went wrong or must not be repeated). ' +
  'Use only what the transcript and git state show: never invent a file, command or result. ' +
  'Mention no AI model or assistant by name.'

function transcript(messages: { role: string; text: string }[]): string {
  return messages
    .filter(m => m.text.trim() !== '')
    .map(m => `[${m.role === 'user' ? 'person' : 'assistant'}] ${m.text.slice(0, MAX_TEXT)}`)
    .join('\n')
}

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string> {
  const r = await $.process.run(['git', ...args], { cwd }).catch(() => undefined)
  return r !== undefined && r.exitCode === 0 ? r.stdout.trim() || '(empty)' : '(not a git repository)'
}

// The directory's last two parts, safe in a file name.
export function slug(cwd: string): string {
  const s = cwd.split('/').filter(Boolean).slice(-2).join('-').replace(/[^A-Za-z0-9._-]/g, '-')
  return s === '' ? 'session' : s
}

export function stamp(d = new Date()): string {
  return d.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
}
