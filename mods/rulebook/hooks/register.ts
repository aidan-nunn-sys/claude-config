// Rulebook: hard rules on tool calls, read from ~/.claude/rulebook.json.
// Claude adds one through mcp__rulebook__add_rule when the user corrects it or states a
// lasting rule; /rules lists them and /rules remove <id> takes one out.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Rule } from '../types'

const TOOL = 'add_rule'
const ALLOW = 'Allow'

const SEED: Rule[] = [
  {
    id: 'no-ai-attribution',
    tool: '^Bash$',
    field: 'command',
    pattern: 'Co-Authored-By:.*(claude|anthropic)|generated with \\[?claude code|claude\\.ai/code|noreply@anthropic\\.com',
    flags: 'i',
    action: 'deny',
    message: 'No AI attribution in commits or PRs: drop the Co-Authored-By, "Generated with Claude Code" and session-link lines.',
    added: '2026-10-12',
  },
  {
    id: 'simple-branch-commands',
    tool: '^Bash$',
    field: 'command',
    pattern: '\\bgit\\s+(checkout\\s+-[bB]|switch\\s+(-c|-C|--create))\\s+\\S+\\s+[^\\s;&|]+',
    action: 'deny',
    message: 'Make the branch with `git branch <name> <start>` and then `git checkout <name>`: checkout -b with a start point once set an upstream that pushed to development.',
    added: '2026-10-12',
  },
  {
    id: 'confirm-commit-push',
    tool: '^Bash$',
    field: 'command',
    pattern: '\\bgit\\s+(commit|push)\\b',
    action: 'confirm',
    message: 'Commits and pushes need a clear yes from the user.',
    added: '2026-10-12',
  },
]

const rules = atom({ plugin: 'rulebook', key: 'rules' } as const, [] as Rule[])

const TOOL_DESCRIPTION =
  "Add a hard rule to the user's rulebook, enforced on every later tool call in every session. " +
  'Call it when the user corrects how you acted or states a lasting rule about commands, git, files or tools ' +
  '("never X", "always ask before Y", "don\'t touch Z"), in addition to saving a memory. ' +
  'Make the pattern as narrow as the rule: a JavaScript regex on one input field of the tool. ' +
  'Use action "confirm" when the user wants to be asked first, "deny" when the thing should never happen.'

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'short-kebab-case name' },
    tool: { type: 'string', description: 'regex on the tool name, e.g. ^Bash$ or ^(Edit|Write)$' },
    field: { type: 'string', description: 'input field to match: command, file_path, content, ... or * for all input' },
    pattern: { type: 'string', description: 'JavaScript regex source' },
    flags: { type: 'string', description: 'regex flags, e.g. i' },
    action: { type: 'string', enum: ['deny', 'confirm'] },
    message: { type: 'string', description: 'what Claude is told when the rule fires, with what to do instead' },
    why: { type: 'string', description: 'what the user said that led to it' },
  },
  required: ['id', 'tool', 'field', 'pattern', 'action', 'message'],
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await load($).catch(() => {})
    await $.command.register({ name: 'rules', description: 'List the rulebook, or /rules remove <id>' }).catch(() => {})
    await $.tool.register({ name: TOOL, description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA }).catch(() => {})
    return result
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const list = await read($, rules).catch(() => [] as Rule[])
    const text =
      "# Rulebook\nThe user's hard rules are enforced on tool calls by the rulebook mod. " +
      `When the user corrects you or states a lasting rule about how to act, call mcp__rulebook__${TOOL} as well as saving a memory.\n` +
      list.map(r => `- ${r.id} (${r.action}): ${r.message}`).join('\n')
    return { ...result, sections: [...result.sections, { id: 'rulebook', text, scope: 'session' }] }
  })

  on('tool.call', { tool: `mcp__rulebook__${TOOL}` }, async ($, e) => {
    const added = await addRule($, inputOf(e) as Partial<Rule>)
    return typeof added === 'string' ? { deny: added } : { result: `Added rule ${added.id}.`, text: `Added rule ${added.id}: ${added.message}` }
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === `mcp__rulebook__${TOOL}`) return next(e)
    const list = await read($, rules).catch(() => [] as Rule[])
    const hit = firstMatch(list, e.tool, inputOf(e))
    if (!hit) return next(e)
    if (hit.action === 'deny') return { deny: `rulebook (${hit.id}): ${hit.message}` }
    const answer = await $.ui
      .ask(`Rulebook: ${hit.message} Claude wants to run ${preview(e)} Allow it?`, [ALLOW, 'Deny'])
      .catch(() => 'Deny')
    if (answer !== ALLOW) return { deny: `rulebook (${hit.id}): the user did not allow this. ${hit.message}` }
    return next(e)
  })

  on('command.run', { command: 'rules' }, async ($, e) => {
    const [verb, id] = e.args.trim().split(/\s+/)
    if (verb === 'remove' && id) {
      const before = await read($, rules)
      if (!before.some(r => r.id === id)) return { text: `No rule named ${id}.` }
      await save($, before.filter(r => r.id !== id))
      return { text: `Removed ${id}.` }
    }
    if (verb === 'reload') await load($)
    const list = await read($, rules)
    return { text: [`📏 ${list.length} rules in ${await rulesPath($)}`, ...list.map(r => `• ${r.id} [${r.action}] ${r.message}`), '/rules remove <id> · /rules reload'].join('\n') }
  })
}

// The call's input fields as the hook sees them (the envelope carries them at its top level).
function inputOf(e: object): Record<string, unknown> {
  return e as Record<string, unknown>
}

function preview(e: object) {
  const command = (e as { command?: unknown }).command
  return typeof command === 'string' ? `\`${command.slice(0, 200)}\`.` : 'this tool call.'
}

export function firstMatch(list: Rule[], tool: string, input: Record<string, unknown>): Rule | undefined {
  return list.find(r => {
    try {
      if (!new RegExp(r.tool).test(tool)) return false
      const text = r.field === '*' ? JSON.stringify(input) : String(input[r.field] ?? '')
      return text !== '' && new RegExp(r.pattern, r.flags).test(text)
    } catch {
      return false // a broken pattern never blocks
    }
  })
}

// A rule as Claude asked for it, or why it was refused.
export function checkRule(input: Partial<Rule>, existing: Rule[], today: string): Rule | string {
  const { id, tool, field, pattern, flags, action, message, why } = input
  if (!id || !tool || !field || !pattern || !message) return 'id, tool, field, pattern and message are required.'
  if (action !== 'deny' && action !== 'confirm') return 'action must be deny or confirm.'
  if (existing.some(r => r.id === id)) return `A rule named ${id} already exists.`
  try {
    new RegExp(tool)
    const re = new RegExp(pattern, flags)
    if (re.test('') || re.test(' ')) return 'That pattern matches everything; make it narrower.'
  } catch (err) {
    return `Bad regex: ${String(err)}`
  }
  return { id, tool, field, pattern, ...(flags ? { flags } : {}), action, message, ...(why ? { why } : {}), added: today }
}

async function addRule($: EngineInterface, input: Partial<Rule>): Promise<Rule | string> {
  // Re-read the file first: an empty in-memory list (a reload that skipped session.start) would overwrite it.
  await load($)
  const list = await read($, rules)
  const today = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const rule = checkRule(input, list, today)
  if (typeof rule === 'string') return rule
  await save($, [...list, rule])
  $.ui.toast(`📏 New rule: ${rule.message}`)
  return rule
}

async function rulesPath($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  return `${home}/.claude/rulebook.json`
}

async function load($: EngineInterface) {
  const path = await rulesPath($)
  if (!(await $.fs.exists(path))) {
    await save($, SEED)
    return
  }
  const parsed = JSON.parse(await $.fs.read(path)) as { rules?: Rule[] }
  await update($, rules, () => parsed.rules ?? [])
}

async function save($: EngineInterface, list: Rule[]) {
  await update($, rules, () => list)
  await $.fs.write(await rulesPath($), `${JSON.stringify({ rules: list }, null, 2)}\n`)
}
