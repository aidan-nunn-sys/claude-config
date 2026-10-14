import { describe, expect, test } from 'claude-code/testing'

import { slug, stamp } from '../hooks/register'

const reply = '## Goal\nShip the handoff mod'

function engine(on: any, written: Record<string, string>) {
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: {} }))
  on('session.cwd', () => ({ value: '/work/my-app' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main', stderr: '' } }))
  on('env.get', () => ({ value: '/home/me' }))
  on('model.complete', () => ({ value: { isAnswered: true, text: reply, usage: { input_tokens: 1, output_tokens: 1 } } }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'build a handoff mod', toolUses: [] }] }))
  on('fs.write', (_: any, e: any) => { written[e.path] = e.text; return { value: undefined } })
}

describe('handoff', () => {
  test('writes the document under ~/.claude/handoffs', async ($: any, on: any) => {
    const written: Record<string, string> = {}
    engine(on, written)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/my-app' })
    const r = await $.command.run({ command: 'handoff', args: 'review it' })
    const [path] = Object.keys(written)
    expect(path).toMatch(/^\/home\/me\/\.claude\/handoffs\/work-my-app-\d{8}-\d{4}\.md$/)
    expect(written[path]).toContain('Ship the handoff mod')
    expect(r.text).toContain(path)
  })

  test('names files by directory and time', () => {
    expect(slug('/work/my app')).toBe('work-my-app')
    expect(slug('/')).toBe('session')
    expect(stamp(new Date('2026-10-14T09:05:00Z'))).toBe('20261014-0905')
  })
})
