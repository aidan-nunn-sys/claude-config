import { expect, test } from 'claude-code/testing'
import { addCard } from '../hooks/lib'
import { carryOver, storedGoalKey } from '../hooks/carry'
import type { Stash } from '../types'
import { fake, NOW, TOOL } from './fake'
import type { Fake } from './fake'

const PANE = {
  plugin: 'task-board', component: 'Pane', requestId: 'task-board', surface: 'terminal',
  props: { title: 'Board', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

function group(title: string, at = NOW - 1) {
  const g = carryOver(addCard([], { title, source: 'you' }, at).cards,
    { sessionId: title, label: title, endedAt: at })!
  g.isLabelled = true
  return g
}

test('relabel finishing after session.end must not erase newly carried work', async ($, on) => {
  let f: Fake
  // Keep the ending dispatch open: the relabel races with persistence before
  // the host switches sessions, rather than relying on a post-clear callback.
  on('store.set', { key: 'board:/work/orbit' }, async ($, e, next) => {
    const result = await next(e)
    const value = e.value as Stash
    if (value.carried.some(g => g.cards.some(c => c.title === 'New unfinished'))) await f.clock.sleep(200)
    return result
  })
  f = await fake($, on)
  f.labelReplies.push('Name the old session')
  const old = group('Old goal')
  old.isLabelled = false
  f.store.set('board:/work/orbit', { carried: [old], archive: [] })
  f.delayMs = 100
  await $.session.start({ cwd: '/work/orbit', surface: 'terminal', isInteractive: true })
  await f.clock.settle()
  await $.tool.call({ tool: TOOL, action: 'add', title: 'New unfinished' } as never)
  const ending = $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await f.clock.settle()
  await f.clock.advance(100)
  await f.clock.advance(100)
  await ending
  const stored = f.store.get('board:/work/orbit') as Stash
  expect(stored.carried.flatMap(g => g.cards).some(c => c.title === 'New unfinished')).toBe(true)
})

test('Pull in must not overwrite a user edit made between read and commit', async ($, on) => {
  let f: Fake
  let pause = true
  on('state.set', { plugin: 'task-board', key: 'cards' }, async ($, e, next) => {
    if (pause && e.value.some(c => c.title === 'Leftover')) {
      pause = false
      await f.clock.sleep(100)
    }
    return next(e)
  })
  f = await fake($, on)
  const old = group('Leftover')
  f.store.set('board:/work/orbit', { carried: [old], archive: [] })
  await $.session.start({ cwd: '/work/orbit', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'carried' })
  const pulling = ui.press({ key: `pull:${storedGoalKey({ list: 'carried', sessionId: old.sessionId, endedAt: old.endedAt, id: old.cards[0]!.id })}` })
  await f.clock.settle()
  await $.tool.call({ tool: TOOL, action: 'add', title: 'User edit' } as never)
  await f.clock.advance(100)
  await pulling
  const listed = String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)
  expect(listed).toContain('User edit')
  expect(listed).toContain('Leftover')
  await ui.unmount()
})

test('overlapping Pull ins must keep both goals live and neither stored', async ($, on) => {
  let f: Fake
  let pause = true
  on('state.set', { plugin: 'task-board', key: 'cards' }, async ($, e, next) => {
    if (pause && e.value.some(c => c.title === 'A')) {
      pause = false
      await f.clock.sleep(100)
    }
    return next(e)
  })
  f = await fake($, on)
  const a = group('A', NOW - 2)
  const b = group('B', NOW - 1)
  f.store.set('board:/work/orbit', { carried: [a, b], archive: [] })
  await $.session.start({ cwd: '/work/orbit', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'carried' })
  const first = ui.press({ key: `pull:${storedGoalKey({ list: 'carried', sessionId: a.sessionId, endedAt: a.endedAt, id: a.cards[0]!.id })}` })
  await f.clock.settle()
  await ui.press({ key: `pull:${storedGoalKey({ list: 'carried', sessionId: b.sessionId, endedAt: b.endedAt, id: b.cards[0]!.id })}` })
  await f.clock.advance(100)
  await first
  const text = String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)
  expect(text).toContain('] A')
  expect(text).toContain('] B')
  expect(f.store.get('board:/work/orbit')).toMatchObject({ carried: [] })
  await ui.unmount()
})

test('archive Pull in must not select a colliding carried goal', async ($, on) => {
  const f = await fake($, on)
  const carried = group('Carried goal')
  const archived = group('Archived goal')
  expect(carried.cards[0]!.id).toBe(archived.cards[0]!.id)
  f.store.set('board:/work/orbit', { carried: [carried], archive: [archived] })
  await $.session.start({ cwd: '/work/orbit', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'archive' })
  await ui.press({ key: `pull:${storedGoalKey({ list: 'archive', sessionId: archived.sessionId, endedAt: archived.endedAt, id: archived.cards[0]!.id })}` })
  const text = String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)
  expect(text).toContain('Archived goal')
  expect(text).not.toContain('Carried goal')
  await ui.unmount()
})

test('Haiku must not attach to a goal the user completed during filing', async ($, on) => {
  const f = await fake($, on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Goal', column: 'doing' } as never)
  const text = String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)
  const id = text.match(/\[(c\w+)\] Goal/)![1]!
  f.replies.push(`{"subtask_of":"${id}","title":"New step"}`)
  f.delayMs = 100
  await $.tool.call({ tool: TOOL, action: 'inbox', text: 'Fallback work' } as never)
  await f.clock.settle()
  await $.tool.call({ tool: TOOL, action: 'move', card: id, column: 'done' } as never)
  await f.clock.advance(100)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1' } as never)
  const stored = f.store.get('board:/work/orbit') as Stash
  expect(stored.carried.flatMap(g => g.cards).some(c => c.title === 'Fallback work')).toBe(true)
})
