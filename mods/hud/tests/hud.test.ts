import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { activityFor, cells, clock, duration, pose, toContext } from '../hooks/register'

const START = { cwd: '/home/me/Work', surface: 'terminal', isInteractive: true } as const

function hint(text: string, isWorking = false) {
  return { component: 'PromptHint' as const, props: { isDraft: false, isWorking, hint: text } }
}

function answerSession(on: On, rateLimits: unknown[] = []) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.usage', () => ({ value: { startedAt: 0, context: { breakdown: BREAKDOWN }, rateLimits } }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
  return clock
}

const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 20_000, color: 'x', kind: 'used' },
    { name: 'Messages', tokens: 30_000, color: 'x', kind: 'used' },
    { name: 'Free space', tokens: 150_000, color: 'x', kind: 'free' },
  ],
  totalTokens: 50_000,
  rawMaxTokens: 200_000,
  percentage: 25,
  isAutoCompactEnabled: true,
}

test('mascot frames all have one width', () => {
  for (const name of ['idle', 'writing', 'editing', 'thinking', 'sad', 'sleeping'] as const) {
    for (let f = 0; f < 6; f++) expect(pose(name, f)).toHaveLength(10)
  }
})

test('tools map to mascot activities', () => {
  expect(activityFor('Edit')).toBe('editing')
  expect(activityFor('Bash')).toBe('running')
  expect(activityFor('Grep')).toBe('reading')
  expect(activityFor('Agent')).toBe('agent')
})

test('context bar fills its share and pads the rest', () => {
  const c = toContext(BREAKDOWN)
  expect(c.percent).toBe(25)
  const bar = cells(c.slices, c.window, 10)
  expect(bar.map(x => x.text).join('')).toHaveLength(10)
  expect(bar.at(-1)?.kind).toBe('free')
})

test('context bar is proportional: small slices get no cell of their own', () => {
  const slices = [
    { tokens: 2_000, kind: 'used', color: 'a' },
    { tokens: 3_000, kind: 'used', color: 'b' },
    { tokens: 45_000, kind: 'used', color: 'c' },
  ]
  const bar = cells(slices as any, 200_000, 20)
  expect(bar.filter(x => x.kind === 'used').map(x => x.text).join('')).toHaveLength(5)
  expect(bar.find(x => x.color === 'a')).toBeUndefined()
})

test('clock formats minutes and seconds', () => {
  expect(clock(25 * 60_000)).toBe('25:00')
  expect(clock(61_500)).toBe('1:02')
})

test('swaps "auto mode on" for arrows and drops the cycle, interrupt and queue hints', async ($, on) => {
  answerSession(on)
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'hud', surface, ...hint('⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · press up to edit queued messages · ctrl+t for todos', true) })
    expect(await ui.find({ type: 'Text', text: /auto mode|shift\+tab|esc to interrupt|queued/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /⏵⏵/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ctrl\+t for todos/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /25%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /🍅/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the mascot writes while Claude streams text, thinks on thinking, and sleeps when idle', async ($, on) => {
  const clock = answerSession(on)
  on('turn.step', async function* (_$, e) {
    yield { kind: 'thinking', index: 0, text: 'hmm' } as never
    yield { kind: 'text', index: 1, text: 'hello' } as never
    return { turnId: e.turnId, index: e.index, answer: 'hello', toolUses: [], stopReason: null, usage: null } as never
  })
  await $.session.start(START)
  const face = async (working = true) => {
    const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...hint('? for shortcuts', working) })
    const t = await ui.find({ type: 'Text', text: /\(/ })
    await ui.unmount()
    return JSON.stringify(t)
  }
  expect(await face()).toMatch(/•ᴗ•|·_·|•_•/) // a pose on screen before Claude answers
  await clock.advance(2_000)
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'x', messageCount: 1 } as never)
  while (!(await stream.next()).done);
  await clock.advance(2_000)
  expect(await face()).toMatch(/-ᴗ-/) // the blink into the new pose
  await clock.advance(400)
  expect(await face()).toMatch(/✎/)

  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 } as never)
  await clock.advance(4 * 60_000)
  expect(await face(false)).toMatch(/-ᴗ-/) // the blink before it dozes off
  await clock.advance(400)
  expect(await face(false)).toMatch(/-ᴗ-\)z/)
})

test('a change of pose goes through a blink', async ($, on) => {
  const clock = answerSession(on)
  await $.session.start(START)
  const first = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...hint('? for shortcuts') })
  await first.unmount()
  await clock.advance(2_000)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never).catch(() => {})
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...hint('? for shortcuts', true) })
  expect(await ui.find({ type: 'Text', text: /\(-ᴗ-\)/ })).toBeDefined()
})

test('shows the 5-hour session limit and time to reset', async ($, on) => {
  const resetsAt = new Date(1_000_000 + (2 * 60 + 13) * 60_000).toISOString()
  answerSession(on, [
    { kind: 'seven_day', percentUsed: 12 },
    { kind: 'five_hour', percentUsed: 41.4, resetsAt },
  ])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...hint('? for shortcuts') })
  expect(await ui.find({ type: 'Text', text: /⧗ 41%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2h13m/ })).toBeDefined()
  await ui.unmount()
})

test('duration reads hours and minutes', () => {
  expect(duration(13 * 60_000)).toBe('13m')
  expect(duration((2 * 60 + 5) * 60_000)).toBe('2h05m')
  expect(duration(-1)).toBe('0m')
})
