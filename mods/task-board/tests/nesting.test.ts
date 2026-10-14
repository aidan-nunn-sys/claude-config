import { expect, test } from 'claude-code/testing'
import { addCard, currentGoal, goals, makeGoal, moveUnder, progressOf, removeCard, subtasksOf, syncTodos } from '../hooks/lib'

const AT = Date.parse('2026-10-13T10:00:00Z')

test('a subtask sits under a top goal and counts toward its progress', () => {
  let { cards, card: goal } = addCard([], { title: 'Write spec', source: 'claude', column: 'doing' }, AT)
  cards = addCard(cards, { title: 'Draft §1', source: 'claude', parentId: goal.id }, AT).cards
  cards = addCard(cards, { title: 'Draft §2', source: 'claude', parentId: goal.id, column: 'done' }, AT).cards
  expect(goals(cards).map(c => c.title)).toEqual(['Write spec'])
  expect(subtasksOf(cards, goal.id)).toHaveLength(2)
  expect(progressOf(cards, goal.id)).toEqual({ done: 1, total: 2 })
})

test('the same title under different goals is two cards', () => {
  let { cards, card: a } = addCard([], { title: 'A', source: 'you' }, AT)
  const b = addCard(cards, { title: 'B', source: 'you' }, AT)
  cards = b.cards
  cards = addCard(cards, { title: 'Test it', source: 'claude', parentId: a.id }, AT).cards
  cards = addCard(cards, { title: 'Test it', source: 'claude', parentId: b.card.id }, AT).cards
  expect(cards.filter(c => c.title === 'Test it')).toHaveLength(2)
})

test('to-do items go under the goal in Doing, else under a Session goal', () => {
  const first = currentGoal([], AT, 's1')
  expect(first.cards[0]).toMatchObject({ title: 'Session', column: 'doing', parentId: null })
  let { cards, card: goal } = addCard([], { title: 'Implement', source: 'claude', column: 'doing' }, AT)
  cards = syncTodos(cards, [{ content: 'Step one', status: 'pending' }], AT, 's1')
  expect(cards.find(c => c.title === 'Step one')?.parentId).toBe(goal.id)
  expect(currentGoal(first.cards, AT, 's1').cards).toHaveLength(1)
})

test('removing a goal removes its subtasks', () => {
  let { cards, card: goal } = addCard([], { title: 'G', source: 'you' }, AT)
  cards = addCard(cards, { title: 'S', source: 'you', parentId: goal.id }, AT).cards
  expect(removeCard(cards, goal.id)).toEqual([])
})

test('make goal and move under keep two levels', () => {
  let { cards, card: g1 } = addCard([], { title: 'G1', source: 'you' }, AT)
  const g2 = addCard(cards, { title: 'G2', source: 'you' }, AT)
  cards = g2.cards
  const s = addCard(cards, { title: 'S', source: 'you', parentId: g1.id }, AT)
  cards = s.cards
  expect(makeGoal(cards, s.card.id).find(c => c.id === s.card.id)?.parentId).toBeNull()
  expect(moveUnder(cards, s.card.id, g2.card.id).find(c => c.id === s.card.id)?.parentId).toBe(g2.card.id)
  expect(moveUnder(cards, g1.id, g2.card.id).find(c => c.id === g1.id)?.parentId).toBeNull()
  expect(moveUnder(cards, g2.card.id, s.card.id).find(c => c.id === g2.card.id)?.parentId).toBeNull()
  expect(addCard(cards, { title: 'Third level', source: 'you', parentId: s.card.id }, AT).card.parentId).toBeNull()
})
