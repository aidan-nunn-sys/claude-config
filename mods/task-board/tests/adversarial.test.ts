import { expect, test } from 'claude-code/testing'
import { addCard, goals, makeGoal, moveCard, syncTodos, taskCreated, taskUpdated } from '../hooks/lib'
import { carryOver, pullIn } from '../hooks/carry'
import { applyFiling, parseFiling } from '../hooks/filer'
import { fake, NOW, TOOL } from './fake'
import type { Stash } from '../types'

const PANE = <S extends 'vscode' | 'terminal' | 'desktop'>(surface: S) => ({
  plugin: 'task-board', component: 'Pane', requestId: 'task-board', surface,
  props: { title: 'Board', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}) as const

test('new-session TodoWrite must preserve pulled unfinished work', () => {
  const old = syncTodos([], [{ content: 'Old unfinished step', status: 'pending' }], NOW, 'old')
  const group = carryOver(old, { sessionId: 'old', label: 'Old work', endedAt: NOW })!
  const live = pullIn({ carried: [group], archive: [] }, [], group.cards[0]!.id).cards
  const updated = syncTodos(live, [{ content: 'New session step', status: 'pending' }], NOW + 1, 'new')
  expect(updated.some(c => c.title === 'Old unfinished step')).toBe(true)
})

test('new TaskUpdate id must not update a pulled old-session task', () => {
  const old = taskCreated([], { id: '1', subject: 'Old task' }, NOW, 'old')
  const group = carryOver(old, { sessionId: 'old', label: 'Old work', endedAt: NOW })!
  let live = pullIn({ carried: [group], archive: [] }, [], group.cards[0]!.id).cards
  live = taskCreated(live, { id: '1', subject: 'New task' }, NOW + 1, 'new')
  live = taskUpdated(live, { taskId: '1', status: 'completed' }, 'new')
  expect(live.find(c => c.title === 'Old task')?.column).toBe('todo')
  expect(live.find(c => c.title === 'New task')?.column).toBe('done')
})

test('syncTodos removing a promoted todo goal must not orphan children', () => {
  let cards = syncTodos([], [{ content: 'Promoted goal', status: 'pending' }], NOW, 's1')
  const id = cards.find(c => c.title === 'Promoted goal')!.id
  cards = makeGoal(cards, id)
  cards = addCard(cards, { title: 'Child', source: 'you', parentId: id }, NOW).cards
  cards = syncTodos(cards, [], NOW, 's1')
  expect(cards.every(c => c.parentId === null || goals(cards).some(g => g.id === c.parentId))).toBe(true)
})

test('Haiku cannot file unfinished work into a Done goal', () => {
  const done = addCard([], { title: 'Finished', source: 'you', column: 'done' }, NOW)
  expect(parseFiling(JSON.stringify({ subtask_of: done.card.id, title: 'New work' }), done.cards)).toBeNull()
})

test('strict filing rejects mutually exclusive and extra fields', () => {
  expect(parseFiling('{"new_goal":"Injected goal","subtask_of":"unknown","title":"Other","extra":true}', [])).toBeNull()
})

test('filing a repeated truncated ask must not silently discard work', () => {
  const title = 'Implement ' + 'x'.repeat(50)
  let cards = applyFiling([], { kind: 'goal', title }, { at: NOW, sessionId: 's1', byHaiku: true })
  cards = moveCard(cards, cards[0]!.id, 'doing')
  cards = applyFiling(cards, { kind: 'goal', title }, { at: NOW + 1, sessionId: 's1', byHaiku: true })
  expect(cards).toHaveLength(2)
  expect(cards[1]?.column).toBe('todo')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface} deleted drill-down goal recovers without a render fault`, async ($, on) => {
    await fake($, on)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'Goal' } as never)
    const text = String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)
    const id = text.match(/\[(c\w+)\] Goal/)![1]!
    const ui = await $.ui.mount(PANE(surface))
    await ui.post({ type: 'open', id })
    await ui.press({ key: 'subtasks' })
    await $.tool.call({ tool: TOOL, action: 'remove', card: id } as never)
    expect(await ui.find({ type: 'Text', text: 'Nothing on the board yet' })).toBeDefined()
    await ui.unmount()
  })
}

test('session.end preserves an ask whose Haiku filing is still pending', async ($, on) => {
  const f = await fake($, on, ['{"new_goal":"Pending work"}'])
  f.delayMs = 100
  await $.tool.call({ tool: TOOL, action: 'inbox', text: 'Pending work' } as never)
  await f.clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  const beforeReply = f.store.get('board:/work/orbit') as Stash
  expect(beforeReply.carried.flatMap(g => g.cards).filter(c => c.title === 'Pending work')).toHaveLength(1)
  await f.clock.advance(100)
  const stored = f.store.get('board:/work/orbit') as { carried: { cards: { title: string }[] }[] }
  expect(stored.carried.flatMap(g => g.cards).some(c => c.title === 'Pending work')).toBe(true)
  const listed = String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)
  expect([...listed.matchAll(/\] Pending work/g)]).toHaveLength(1)
})

test('approved plan concrete steps nest under the active goal', async ($, on) => {
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({
    result: { plan: '1. Write tests\n2. Implement feature', isAgent: false }, text: 'Approved',
  }))
  await fake($, on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Implement project', column: 'doing' } as never)
  await $.tool.call({ tool: 'ExitPlanMode' } as never)
  const listed = String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)
  expect(listed).toMatch(/    - \[c\w+\] Write tests \(To do\)/)
  expect(listed).toContain('To do (0)')
})

test('deleting a goal during filing must not resurrect it or lose the new card', async ($, on) => {
  const f = await fake($, on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Goal', column: 'doing' } as never)
  const text = String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)
  const id = text.match(/\[(c\w+)\] Goal/)![1]!
  f.replies.push(`{"subtask_of":"${id}","title":"New step"}`)
  f.delayMs = 100
  await $.tool.call({ tool: TOOL, action: 'inbox', text: 'Fallback work' } as never)
  await f.clock.settle()
  await $.tool.call({ tool: TOOL, action: 'remove', card: id } as never)
  await f.clock.advance(100)
  const listed = String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)
  expect(listed).toContain('Fallback work')
  expect(listed).not.toContain('] Goal')
})

test('a second TaskCreate with the same subject remains independently updateable', () => {
  let cards = taskCreated([], { id: '1', subject: 'Run tests' }, NOW, 's1')
  cards = taskCreated(cards, { id: '2', subject: 'Run tests' }, NOW, 's1')
  expect(cards.filter(c => c.source === 'todo')).toHaveLength(2)
  cards = taskUpdated(cards, { taskId: '2', status: 'completed' }, 's1')
  expect(cards.find(c => c.ref === 'task:2')?.column).toBe('done')
})

test('a goal with no subtasks still shows its required 0/0 count', async ($, on) => {
  await fake($, on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Empty goal' } as never)
  const ui = await $.ui.mount(PANE('vscode'))
  expect(await ui.find({ type: 'Text', text: /▸ 0\/0/ })).toBeDefined()
  await ui.unmount()
})

test('TodoWrite matches equal text only within the owning session', () => {
  const old = syncTodos([], [{ content: 'Run tests', status: 'pending' }], NOW, 'old')
  const live = syncTodos(old, [{ content: 'Run tests', status: 'completed' }], NOW + 1, 'new')
  expect(live.find(c => c.source === 'todo' && c.sessionId === 'old')?.column).toBe('todo')
  expect(live.find(c => c.source === 'todo' && c.sessionId === 'new')?.column).toBe('done')
})

test('TaskUpdate deletion preserves another session with the same task id', () => {
  let cards = taskCreated([], { id: '1', subject: 'Old task' }, NOW, 'old')
  cards = taskCreated(cards, { id: '1', subject: 'New task' }, NOW + 1, 'new')
  cards = taskUpdated(cards, { taskId: '1', status: 'deleted' }, 'new')
  expect(cards.some(c => c.title === 'Old task')).toBe(true)
  expect(cards.some(c => c.title === 'New task')).toBe(false)
})

test('session.end falls back immediately for every pending ask and ignores late Haiku titles', async ($, on) => {
  const f = await fake($, on, ['{"new_goal":"Late model title A"}', '{"new_goal":"Late model title B"}'])
  f.delayMs = 1_000
  const firstLine = 'Implement ' + 'x'.repeat(70)
  await $.tool.call({ tool: TOOL, action: 'inbox', text: firstLine + '\nMore detail' } as never)
  await $.tool.call({ tool: TOOL, action: 'inbox', text: firstLine + '\nDifferent ask' } as never)
  await f.clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  const stored = f.store.get('board:/work/orbit') as Stash
  expect(stored.carried.flatMap(g => g.cards)).toHaveLength(2)
  expect(stored.carried[0]!.cards.every(c => c.title === firstLine.slice(0, 60) && c.parentId === null && c.filedBy === null)).toBe(true)
  await f.clock.advance(1_000)
  const listed = String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)
  expect(listed).toContain('To do (2)')
  expect(listed).not.toContain('Late model title')
})

test('session.start resumes inbox state preserved by a hot reload', async ($, on) => {
  on('state.get', { plugin: 'task-board', key: 'inbox' }, async ($, e, next) => {
    const held = await next(e)
    if (held.deny !== undefined) return held
    return held.value.value === undefined ? { value: { ...held.value, value: [{ id: 'saved-ask', text: 'Recover this ask', sessionId: 's1', createdAt: NOW }] } } : held
  })
  const f = await fake($, on, ['{"new_goal":"Recovered work"}'])
  await f.clock.settle()
  const listed = String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)
  expect(listed).toContain('Recovered work')
  expect(f.requests).toHaveLength(1)
  const ui = await $.ui.mount(PANE('vscode'))
  expect(await ui.find({ type: 'Text', text: /✉ Inbox:/ })).toBeUndefined()
  await ui.unmount()
})

test('filing recovery uses inbox identity rather than the display title', () => {
  let cards = applyFiling([], { kind: 'goal', title: 'Fallback' }, { at: NOW, sessionId: 's1', byHaiku: false, inboxId: 'ask-1' })
  cards = applyFiling(cards, { kind: 'goal', title: 'Haiku retitle' }, { at: NOW + 1, sessionId: 's1', byHaiku: true, inboxId: 'ask-1' })
  expect(cards).toHaveLength(1)
  expect(cards[0]!.title).toBe('Fallback')
})

test('filing rejects extra fields on either otherwise-valid alternative', () => {
  const goal = addCard([], { title: 'Goal', source: 'you' }, NOW)
  expect(parseFiling('{"new_goal":"Injected","extra":true}', goal.cards)).toBeNull()
  expect(parseFiling(JSON.stringify({ subtask_of: goal.card.id, title: 'Injected', extra: true }), goal.cards)).toBeNull()
})

test('retrying a pull after a live write acknowledges the source without duplicates', () => {
  const old = carryOver(addCard([], { title: 'Leftover', source: 'you' }, NOW).cards, { sessionId: 'old', label: 'Old work', endedAt: NOW })!
  const stored = { carried: [old], archive: [] }
  const target = { list: 'carried' as const, sessionId: 'old', endedAt: NOW, id: old.cards[0]!.id }
  const live = pullIn(stored, [], target).cards
  // Keep the pre-transfer store, as if persistence failed after the live write.
  const retried = pullIn(stored, live, target)
  expect(retried.cards).toHaveLength(1)
  expect(retried.stash.carried).toEqual([])
})
