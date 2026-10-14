import { expect, test } from 'claude-code/testing'
import { applyFiling, fallbackFiling, filerPrompt, parseFiling, parseLabel } from '../hooks/filer'
import { addCard } from '../hooks/lib'

const AT = Date.parse('2026-10-13T10:00:00Z')
function board() {
  const { cards, card: goal } = addCard([], { title: 'Status bar', source: 'claude', column: 'doing' }, AT)
  const sub = addCard(cards, { title: 'Add limit', source: 'todo', parentId: goal.id }, AT)
  return { cards: sub.cards, goal, sub: sub.card }
}

test('the prompt names the goal in Doing and the open goals, and cuts the ask', () => {
  const { cards, goal } = board()
  const p = filerPrompt('x'.repeat(2_000), cards)
  expect(p).toContain(`[${goal.id}] Status bar (doing)`)
  expect(p).not.toContain('x'.repeat(1_001))
})

test('parses a subtask, a new goal, and JSON wrapped in prose or fences', () => {
  const { cards, goal } = board()
  expect(parseFiling(`{"subtask_of":"${goal.id}","title":"Hide esc hint"}`, cards)).toEqual({ kind: 'subtask', parentId: goal.id, title: 'Hide esc hint' })
  expect(parseFiling('Sure:\n```json\n{"new_goal":"Plan the board"}\n```', cards)).toEqual({ kind: 'goal', title: 'Plan the board' })
})

test('unknown ids, subtask ids, bad JSON and empty titles are refused', () => {
  const { cards, sub } = board()
  expect(parseFiling('{"subtask_of":"nope","title":"x"}', cards)).toBeNull()
  expect(parseFiling(`{"subtask_of":"${sub.id}","title":"x"}`, cards)).toBeNull()
  expect(parseFiling('not json', cards)).toBeNull()
  expect(parseFiling('{"new_goal":"  "}', cards)).toBeNull()
  expect(parseFiling('{bad json}', cards)).toBeNull()
})

test('titles are cut to 60; the fallback is the first line of the ask', () => {
  const long = parseFiling(`{"new_goal":"${'a'.repeat(80)}"}`, board().cards)
  expect(long?.title.length).toBe(60)
  expect(fallbackFiling('Fix the thing\nmore detail')).toEqual({ kind: 'goal', title: 'Fix the thing' })
})

test('applying a filing adds a Haiku-marked card in To do', () => {
  const { cards, goal } = board()
  const out = applyFiling(cards, { kind: 'subtask', parentId: goal.id, title: 'Hide esc' }, { at: AT, sessionId: 's1', byHaiku: true })
  expect(out.find(c => c.title === 'Hide esc')).toMatchObject({ parentId: goal.id, column: 'todo', filedBy: 'haiku' })
})

test('a label is 3 to 6 words, else refused', () => {
  expect(parseLabel('"Status bar and task board"')).toBe('Status bar and task board')
  expect(parseLabel('ok')).toBeNull()
  expect(parseLabel('one two three four five six seven')).toBeNull()
})
