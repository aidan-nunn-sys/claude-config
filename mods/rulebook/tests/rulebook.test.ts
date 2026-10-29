import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { checkRule, firstMatch } from '../hooks/register'
import type { Rule } from '../types'

const START = { cwd: '/home/me/Work', surface: 'terminal', isInteractive: true } as const
const RULES_FILE = '/home/me/.claude/rulebook.json'

function world(on: On, answer = 'Allow') {
  const files = new Map<string, string>()
  const ran: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { name: 'rules' } }) as never)
  on('tool.register', () => ({ value: { tool: 'mcp__rulebook__add_rule' } }) as never)
  mock.env(on, { HOME: '/home/me' })
  mock.clock(on, { now: Date.UTC(2026, 9, 12) })
  on('fs.exists', (_, e) => ({ value: files.has((e as { path: string }).path) }) as never)
  on('fs.read', (_, e) => ({ value: files.get((e as { path: string }).path) ?? '' }) as never)
  on('fs.write', (_, e) => {
    const { path, text } = e as { path: string; text: string }
    files.set(path, text)
    return { value: undefined } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('tool.call', (_, e) => {
    if (e.tool === 'AskUserQuestion') {
      const q = (e as unknown as { questions: { question: string }[] }).questions[0]?.question ?? ''
      return { result: { questions: [], answers: { [q]: answer } }, text: answer } as never
    }
    ran.push(String((e as { command?: unknown }).command))
    return { result: 'ok', text: 'ok' } as never
  })
  return { files, ran }
}

test('seeds the rulebook file on first start', async ($, on) => {
  const { files } = world(on)
  await $.session.start(START)
  expect(JSON.parse(files.get(RULES_FILE) ?? '{}').rules).toHaveLength(3)
})

test('denies checkout -b with a start point and AI attribution', async ($, on) => {
  const { ran } = world(on)
  await $.session.start(START)
  const branch = await $.tool.call({ tool: 'Bash', command: 'git checkout -b feature/x origin/development' } as never)
  expect(branch).toMatchObject({ deny: expect.stringContaining('simple-branch-commands') })
  const commit = await $.tool.call({ tool: 'Bash', command: 'git commit -m "fix\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>"' } as never)
  expect(commit).toMatchObject({ deny: expect.stringContaining('no-ai-attribution') })
  expect(ran).toEqual([])
})

test('a plain branch switch runs untouched', async ($, on) => {
  const { ran } = world(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'git checkout feature/x' } as never)
  expect(ran).toEqual(['git checkout feature/x'])
})

test('commits ask first and run only on Allow', async ($, on) => {
  const { ran } = world(on, 'Deny')
  await $.session.start(START)
  const r = await $.tool.call({ tool: 'Bash', command: 'git commit -m "Refs #12"' } as never)
  expect(r).toMatchObject({ deny: expect.stringContaining('did not allow') })
  expect(ran).toEqual([])
})

test('Claude can add a rule, and it is enforced', async ($, on) => {
  const { files, ran } = world(on)
  await $.session.start(START)
  await $.tool.call({
    tool: 'mcp__rulebook__add_rule',
    id: 'no-mvnw-clean',
    tool_name: '^Bash$',
    field: 'command',
    pattern: 'mvnw\\s+clean',
    action: 'deny',
    message: 'Do not run mvnw clean.',
  } as never)
  expect(files.get(RULES_FILE)).toContain('no-mvnw-clean')
  const r = await $.tool.call({ tool: 'Bash', command: './mvnw clean test' } as never)
  expect(r).toMatchObject({ deny: expect.stringContaining('no-mvnw-clean') })
  expect(ran).toEqual([])
})

const RULES: Rule[] = [
  { id: 'a', tool: '^Bash$', field: 'command', pattern: 'rm -rf /', action: 'deny', message: 'no', added: '' },
]

test('firstMatch reads one field of one tool', () => {
  expect(firstMatch(RULES, 'Bash', { command: 'sudo rm -rf /' })?.id).toBe('a')
  expect(firstMatch(RULES, 'Write', { command: 'rm -rf /' })).toBeUndefined()
})

test('checkRule refuses catch-all and broken patterns', () => {
  const base = { id: 'x', tool: '^Bash$', field: 'command', action: 'deny' as const, message: 'm' }
  expect(typeof checkRule({ ...base, pattern: '.*' }, [], 'd')).toBe('string')
  expect(typeof checkRule({ ...base, pattern: '(' }, [], 'd')).toBe('string')
  expect(typeof checkRule({ ...base, pattern: 'mvnw clean' }, [], 'd')).toBe('object')
})

test('a commit runs once the user allows it', async ($, on) => {
  const { ran } = world(on, 'Allow')
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "Refs #12"' } as never)
  expect(ran).toEqual(['git commit -m "Refs #12"'])
})
