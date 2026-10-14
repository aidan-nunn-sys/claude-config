import type { Card, Group, Stash } from '../types'
import { goals, newId, subtasksOf } from './lib'

export const ARCHIVE_AFTER_MS = 14 * 24 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const EMPTY_STASH: Stash = { carried: [], archive: [] }
export const stashKey = (cwd: string) => `board:${cwd}`

export function readStash(value: unknown): Stash {
  const v = value as Partial<Stash> | null | undefined
  if (v === null || typeof v !== 'object' || !Array.isArray(v.carried) || !Array.isArray(v.archive)) return { carried: [], archive: [] }
  return { carried: v.carried, archive: v.archive }
}

export function fallbackLabel(cards: readonly Card[], endedAt: number): string {
  const d = new Date(endedAt)
  const first = goals(cards).find(card => card.column !== 'done')
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${first === undefined ? '' : ` · ${first.title}`}`
}

export function carryOver(cards: readonly Card[], at: { sessionId: string; label: string; endedAt: number }): Group | null {
  const open = goals(cards).filter(card => card.column !== 'done')
  if (open.length === 0) return null
  const mark = (card: Card): Card => ({ ...card, parentId: card.parentId ?? null, sessionId: card.sessionId ?? '', carriedAt: at.endedAt, sessionLabel: at.label })
  return {
    sessionId: at.sessionId,
    label: at.label,
    isLabelled: false,
    endedAt: at.endedAt,
    cards: open.flatMap(goal => [mark(goal), ...subtasksOf(cards, goal.id).map(mark)]),
  }
}

/** Expire strictly after 14 days, dropping empty groups from both lists. */
export function expire(stash: Stash, now: number): { stash: Stash; moved: number } {
  const live = stash.carried.filter(group => group.cards.length > 0)
  const old = live.filter(group => now - group.endedAt > ARCHIVE_AFTER_MS)
  return { stash: { carried: live.filter(group => !old.includes(group)), archive: [...stash.archive.filter(group => group.cards.length > 0), ...old] }, moved: old.length }
}

export function daysLeft(group: Group, now: number): number {
  return Math.max(0, Math.ceil((group.endedAt + ARCHIVE_AFTER_MS - now) / DAY_MS))
}

export type StoredGoal = { list: 'carried' | 'archive'; sessionId: string; endedAt: number; id: string }
export const storedGoalKey = (goal: StoredGoal): string => JSON.stringify([goal.list, goal.sessionId, goal.endedAt, goal.id])

/** Move one goal and its children; UI callers identify the list and group too. */
export function pullIn(stash: Stash, board: readonly Card[], target: string | StoredGoal): { stash: Stash; cards: Card[] } {
  const goalId = typeof target === 'string' ? target : target.id
  let taken: Card[] = []
  let transferKey = ''
  const take = (groups: Group[], list: StoredGoal['list']) => groups.map(group => {
    if (typeof target !== 'string' && (target.list !== list || target.sessionId !== group.sessionId || target.endedAt !== group.endedAt)) return group
    if (taken.length > 0 || !goals(group.cards).some(card => card.id === goalId)) return group
    transferKey = storedGoalKey({ list, sessionId: group.sessionId, endedAt: group.endedAt, id: goalId })
    taken = group.cards.filter(card => card.id === goalId || card.parentId === goalId)
    return { ...group, cards: group.cards.filter(card => !taken.includes(card)) }
  }).filter(group => group.cards.length > 0)
  const carried = take(stash.carried, 'carried')
  const archive = take(stash.archive, 'archive')
  // A failed persistence can leave the source stored after the live write succeeded.
  // Retrying acknowledges that transfer instead of adding a second copy.
  if (board.some(card => card.pulledFrom === transferKey)) return { stash: { carried, archive }, cards: [...board] }
  // Retain stored ids normally; remap incoming collisions and their parent links.
  const ids = new Map<string, string>()
  const reserved = [...board, ...taken]
  for (const card of taken) {
    if (!board.some(live => live.id === card.id)) continue
    const id = newId(reserved, card.createdAt)
    ids.set(card.id, id)
    reserved.push({ ...card, id })
  }
  const pulled = taken.map(card => ({
    ...card,
    id: ids.get(card.id) ?? card.id,
    parentId: card.id === goalId ? null : ids.get(card.parentId ?? '') ?? card.parentId ?? null,
    carriedAt: null,
    ...(card.id === goalId ? { column: 'todo' as const, pulledFrom: transferKey } : {}),
  }))
  return { stash: { carried, archive }, cards: [...board, ...pulled] }
}
