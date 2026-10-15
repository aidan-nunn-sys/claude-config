import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Stash } from '../types'
import { addCard, CARD_LIMIT, syncTodos } from '../hooks/lib'
import { carryOver, storedGoalKey } from '../hooks/carry'
import { parseFiling, parseLabel } from '../hooks/filer'
import { closeInput, fake, NOW, TOOL } from './fake'

const WINDOW = 180_000
const PANE = <S extends 'terminal' | 'desktop'>(surface: S) => ({
  plugin: 'task-board', component: 'Pane', requestId: 'task-board', surface,
  props: { title: 'Board', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}) as const
const list = async ($: { tool: { call: Function } }) => String((await $.tool.call({ tool: TOOL, action: 'list' })).text)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`R2 ${surface}: Esc after reparenting the open subtask goes up, not through phantom details`, async ($, on) => {
    const f = await fake($, on)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'A' } as never)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'B' } as never)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'Step', parent: 'A' } as never)
    const text = await list($)
    const a = text.match(/\[(c\w+)\] A/)![1]!
    const b = text.match(/\[(c\w+)\] B/)![1]!
    const sub = text.match(/\[(c\w+)\] Step/)![1]!
    const ui = await $.ui.mount(PANE(surface))
    await ui.post({ type: 'enter', id: a })
    await ui.post({ type: 'details', id: sub })
    await ui.select({ key: 'move-under', value: b })
    expect(await ui.find({ key: 'make-goal' })).toBeUndefined()
    // Pure close decision from the captured state. Unlike the existing tests,
    // do not pretend that closeInput redraws the actual mounted pane.
    await closeInput(f, 'person')
    expect(f.paneState.view).toEqual({ kind: 'top' })
    await ui.unmount()
  })

  test(`R2 ${surface}: deleting a pressed card must not disable the keyboard for remaining cards`, async ($, on) => {
    await fake($, on)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'Delete me' } as never)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'Keep me' } as never)
    const ui = await $.ui.mount(PANE(surface))
    await ui.resize({ columns: 80, rows: 40, in: 'columns' })
    await ui.pointer({ type: 'down', x: 3, y: 2, button: 'left' })
    await $.tool.call({ tool: TOOL, action: 'remove', card: 'Delete me' } as never)
    // Pointer leaves before the drag threshold; release happens outside the pane.
    await ui.pointer({ type: 'leave', x: -1, y: -1, button: 'left' })
    await ui.key({ key: ' ' })
    expect(await ui.find({ key: 'subtasks' })).toBeDefined()
    await ui.unmount()
  })

  test(`R2 ${surface}: the existing Esc helper must actually navigate the mounted pane`, async ($, on) => {
    const f = await fake($, on)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'Goal' } as never)
    const ui = await $.ui.mount(PANE(surface))
    await ui.key({ key: 'return' })
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await closeInput(f, 'person')
    expect(f.paneState.view).toEqual({ kind: 'top' })
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    await ui.unmount()
  })
}

test('R2 reload must resume a pending label for restored live goals without another card write', async ($, on) => {
  const restored = addCard([], { title: 'Recently pulled goal', source: 'you', sessionId: 's1' }, NOW).cards
  on('state.get', { plugin: 'task-board', key: 'cards' }, async ($, e, next) => {
    const result = await next(e)
    return result.deny !== undefined ? result : { value: { ...result.value, value: result.value.value ?? restored } }
  })
  const f = await fake($, on)
  f.labelReplies.push('Name recently pulled work')
  await f.clock.advance(WINDOW * 2)
  expect(f.labelRequests).toHaveLength(1)
})

test('R2 reload after Pull in must not permanently save the pre-pull label as current', async ($, on) => {
  const restored = addCard([], { title: 'Recently pulled goal', source: 'you', sessionId: 's1' }, NOW).cards
  on('state.get', { plugin: 'task-board', key: 'cards' }, async ($, e, next) => {
    const result = await next(e)
    return result.deny !== undefined ? result : { value: { ...result.value, value: result.value.value ?? restored } }
  })
  on('state.get', { plugin: 'task-board', key: 'sessionLabel' }, async ($, e, next) => {
    const result = await next(e)
    return result.deny !== undefined ? result : { value: { ...result.value, value: result.value.value ?? 'Old unrelated session work' } }
  })
  const f = await fake($, on)
  f.labelReplies.push('Name recently pulled work')
  await f.clock.advance(WINDOW * 2)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  expect((f.store.get('board:/work/orbit') as Stash).carried[0]).toMatchObject({ label: 'Name recently pulled work', isLabelled: true })
})

test('R2 a parsed label must still have 3 to 6 words after normalization', () => {
  const label = parseLabel('x'.repeat(61) + ' more work')!
  expect(label.split(/\s+/).length).toBeGreaterThanOrEqual(3)
})

test('R2 a JSON array is not either allowed filing object', () => {
  expect(parseFiling('[{"new_goal":"Wrong container"}]', [])).toBeNull()
})

test('R2 slash commands sent through the other inbox entry point must not be filed', async ($, on) => {
  const f = await fake($, on, ['{"new_goal":"Clear the board"}'])
  await $.tool.call({ tool: TOOL, action: 'inbox', text: ' /clear' } as never)
  await f.clock.settle()
  expect(f.requests).toHaveLength(0)
  expect(await list($)).toBe('The board is empty.')
})

test('R2 end must carry an accepted inbox ask even while its session.id lookup is pending', async ($, on) => {
  let f!: Awaited<ReturnType<typeof fake>>
  let pause = false
  // Replace just the fixture's session.id sink, preserving all real mod hooks.
  const delayedOn = ((event: string, ...args: unknown[]) => {
    if (event === 'session.id') return on('session.id', async () => {
      if (pause) { pause = false; await f.clock.sleep(100) }
      return { value: 's1' }
    })
    return (on as Function)(event, ...args)
  }) as On
  f = await fake($, delayedOn, ['{"new_goal":"Late filing"}'])
  pause = true
  const result = await $.tool.call({ tool: TOOL, action: 'inbox', text: 'Accepted unfinished ask' } as never)
  expect(result.text).toBe('Sent to the inbox.')
  await f.clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await f.clock.advance(100)
  const stored = f.store.get('board:/work/orbit') as Stash
  expect(stored.carried.flatMap(g => g.cards).some(c => c.title === 'Accepted unfinished ask' || c.title === 'Late filing')).toBe(true)
})

test('R2 card limit must not clear an entire active goal while adding one more subtask', () => {
  let { cards, card: goal } = addCard([], { title: 'Active goal', column: 'doing', source: 'you' }, NOW)
  for (let n = 0; n < CARD_LIMIT - 1; n++) cards = addCard(cards, { title: `Step ${n}`, source: 'you', parentId: goal.id }, NOW).cards
  const result = addCard(cards, { title: 'Newest step', source: 'you', parentId: goal.id }, NOW)
  expect(result.cards.some(c => c.id === goal.id)).toBe(true)
  expect(result.cards.some(c => c.id === result.card.id)).toBe(true)
})

test('R2 Haiku reply to deleted goal must not attach to an unrelated replacement with a reused id', async ($, on) => {
  const f = await fake($, on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Old goal' } as never)
  const old = (await list($)).match(/\[(c\w+)\] Old goal/)![1]!
  f.replies.push(JSON.stringify({ subtask_of: old, title: 'Old goal step' }))
  f.delayMs = 100
  await $.tool.call({ tool: TOOL, action: 'inbox', text: 'Fallback new work' } as never)
  await f.clock.settle()
  await $.tool.call({ tool: TOOL, action: 'remove', card: old } as never)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Unrelated replacement' } as never)
  await f.clock.advance(100)
  expect(await list($)).toContain('Fallback new work')
  expect(await list($)).not.toContain('Old goal step')
})

test('R2 TodoWrite must keep independently described items whose display titles truncate identically', () => {
  const prefix = 'x'.repeat(170)
  const cards = syncTodos([], [{ content: prefix + ' frontend', status: 'pending' }, { content: prefix + ' backend', status: 'completed' }], NOW, 's1')
  expect(cards.filter(c => c.source === 'todo')).toHaveLength(2)
})

test('R2 failed pull persistence followed by end must not resurrect both the source and a carried copy', async ($, on) => {
  let fail = false
  on('store.set', { key: 'board:/work/orbit' }, ($, e, next) => {
    if (fail) { fail = false; return { deny: 'one transient write failure' } }
    return next(e)
  })
  const f = await fake($, on)
  const group = carryOver(addCard([], { title: 'Original unfinished goal', source: 'you' }, NOW - 1).cards,
    { sessionId: 'old', label: 'Original old session', endedAt: NOW - 1 })!
  group.isLabelled = true
  f.store.set('board:/work/orbit', { carried: [group], archive: [] })
  await $.session.start({ cwd: '/work/orbit', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'carried' })
  fail = true
  await ui.press({ key: `pull:${storedGoalKey({ list: 'carried', sessionId: 'old', endedAt: NOW - 1, id: group.cards[0]!.id })}` })
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  const stored = f.store.get('board:/work/orbit') as Stash
  expect(stored.carried.flatMap(g => g.cards).filter(c => c.title === 'Original unfinished goal')).toHaveLength(1)
  await ui.unmount()
})

test('a filing wrapped in prose with brackets still parses', () => {
  expect(parseFiling('Filed [ok]: {"new_goal":"Fix login"}', [])).toEqual({ kind: 'goal', title: 'Fix login' })
  expect(parseFiling('```json\n[{"new_goal":"x"}]\n```', [])).toBeNull()
})
