import { expect, test } from 'claude-code/testing'
import { ARCHIVE_AFTER_MS, EMPTY_STASH, carryOver, daysLeft, expire, fallbackLabel, pullIn, readStash } from '../hooks/carry'
import { addCard } from '../hooks/lib'

const AT = Date.parse('2026-10-13T10:00:00Z')
function board() {
  let { cards, card: open } = addCard([], { title: 'Write plan', source: 'claude', column: 'doing', sessionId: 's1' }, AT)
  cards = addCard(cards, { title: 'Task 1', source: 'todo', parentId: open.id, column: 'done', sessionId: 's1' }, AT).cards
  cards = addCard(cards, { title: 'Ship hud', source: 'claude', column: 'done', sessionId: 's1' }, AT).cards
  return { cards, open }
}

test('only unfinished goals carry over, with their subtasks', () => {
  const group = carryOver(board().cards, { sessionId: 's1', label: 'x', endedAt: AT })
  expect(group?.cards.map(c => c.title)).toEqual(['Write plan', 'Task 1'])
  expect(group?.cards.every(c => c.carriedAt === AT && c.sessionLabel === 'x')).toBe(true)
})

test('a session with only Done goals carries nothing', () => {
  const cards = addCard([], { title: 'Done thing', source: 'you', column: 'done' }, AT).cards
  expect(carryOver(cards, { sessionId: 's1', label: 'x', endedAt: AT })).toBeNull()
})

test('groups older than 14 days move to the archive', () => {
  const group = carryOver(board().cards, { sessionId: 's1', label: 'x', endedAt: AT })!
  const stash = { carried: [group], archive: [] }
  expect(expire(stash, AT + ARCHIVE_AFTER_MS - 1).moved).toBe(0)
  expect(expire(stash, AT + ARCHIVE_AFTER_MS).moved).toBe(0)
  expect(expire(stash, AT + ARCHIVE_AFTER_MS + 1)).toMatchObject({ moved: 1, stash: { carried: [], archive: [group] } })
  expect(daysLeft(group, AT + 9 * 86_400_000)).toBe(5)
  const empty = { ...group, cards: [] }
  expect(expire({ carried: [empty], archive: [empty] }, AT).stash).toEqual(EMPTY_STASH)
})

test('pull in brings a goal and its subtasks back; an emptied group goes', () => {
  const { cards, open } = board()
  const group = carryOver(cards, { sessionId: 's1', label: 'x', endedAt: AT })!
  const live = addCard([], { title: 'Write plan', source: 'claude', sessionId: 's2' }, AT + 1).cards
  const out = pullIn({ carried: [group], archive: [] }, live, open.id)
  expect(out.stash.carried).toEqual([])
  expect(out.cards.filter(c => c.title === 'Write plan')).toHaveLength(2)
  expect(out.cards.find(c => c.id === open.id)).toMatchObject({ column: 'todo', carriedAt: null, parentId: null })
  expect(out.cards.find(c => c.title === 'Task 1')).toMatchObject({ parentId: open.id, column: 'done', carriedAt: null })
  const archived = pullIn({ carried: [], archive: [group] }, [], open.id)
  expect(archived.stash.archive).toEqual([])
  expect(archived.cards).toHaveLength(2)
  expect(pullIn({ carried: [group], archive: [] }, [], group.cards[1]!.id).cards).toEqual([])
  const collision = pullIn({ carried: [group], archive: [] }, addCard([], { title: 'Write plan', source: 'you' }, AT).cards, open.id)
  expect(new Set(collision.cards.map(c => c.id)).size).toBe(collision.cards.length)
  expect(collision.cards.filter(c => c.title === 'Write plan')).toHaveLength(2)
  const pulledGoal = collision.cards.find(c => c.sessionId === 's1' && c.parentId === null)!
  expect(collision.cards.find(c => c.title === 'Task 1')?.parentId).toBe(pulledGoal.id)
})

test('a stored value that is not a stash reads as empty; fallback label names the date and first goal', () => {
  expect(readStash(undefined)).toEqual(EMPTY_STASH)
  expect(readStash({ carried: 'x' })).toEqual(EMPTY_STASH)
  expect(fallbackLabel(board().cards, AT)).toBe('Oct 13 · Write plan')
})
