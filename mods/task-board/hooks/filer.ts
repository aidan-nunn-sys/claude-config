import type { Card, Group } from '../types'
import { addCard, cleanTitle, goals } from './lib'

const ASK_MAX = 1_000
const TITLE_MAX = 60
export type Filing = { kind: 'subtask'; parentId: string; title: string } | { kind: 'goal'; title: string }

export const FILER_SYSTEM = [
  "You file a user's request onto a two-level task board: top goals, each with subtasks.",
  'If the request is a step of an existing goal (usually the one in doing), file it under that goal; otherwise make it a new goal.',
  'Reply with JSON only, one of:',
  '{"subtask_of":"<goal id>","title":"<short imperative>"}',
  '{"new_goal":"<short imperative>"}',
  `Titles: imperative, at most ${TITLE_MAX} characters.`,
].join('\n')

const short = (text: string) => cleanTitle(text).slice(0, TITLE_MAX)

export function filerPrompt(ask: string, cards: readonly Card[]): string {
  const open = goals(cards).filter(card => card.column !== 'done')
  const lines = open.map(card => `[${card.id}] ${card.title} (${card.column})`)
  return [`Request:\n${ask.slice(0, ASK_MAX)}`, '', 'Open goals:', ...(lines.length === 0 ? ['(none)'] : lines)].join('\n')
}

/** Accept a JSON object even when wrapped in prose or a code fence. */
export function parseFiling(text: string, cards: readonly Card[]): Filing | null {
  // A reply that is an array (bare or fenced) is not a filing object.
  if (/^\s*(```\w*\s*)?\[/.test(text)) return null
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (json === undefined) return null
  let value: Record<string, unknown>
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length === 1 && typeof value.new_goal === 'string' && value.new_goal.trim() !== '') return { kind: 'goal', title: short(value.new_goal) }
  if (keys.length === 2 && typeof value.subtask_of === 'string' && typeof value.title === 'string' && value.title.trim() !== '') {
    const parent = goals(cards).find(card => card.id === value.subtask_of && card.column !== 'done')
    if (parent === undefined) return null
    return { kind: 'subtask', parentId: parent.id, title: short(value.title) }
  }
  return null
}

export function fallbackFiling(ask: string): Filing {
  return { kind: 'goal', title: short(ask.split('\n').find(line => line.trim() !== '') ?? ask) }
}

export function applyFiling(cards: readonly Card[], filing: Filing, at: { at: number; sessionId: string; byHaiku: boolean; inboxId?: string }): Card[] {
  return addCard(cards, {
    title: filing.title,
    source: 'claude',
    column: 'todo',
    parentId: filing.kind === 'subtask' ? filing.parentId : null,
    sessionId: at.sessionId,
    filedBy: at.byHaiku ? 'haiku' : null,
    ...(at.inboxId === undefined ? {} : { inboxId: at.inboxId }),
    distinct: true,
  }, at.at).cards
}

export const LABEL_SYSTEM = 'Name a work session from its goals in 3 to 6 words. Reply with the name only.'

export function labelPrompt(group: Pick<Group, 'cards'>): string {
  return goals(group.cards).map(card => `- ${card.title}`).join('\n')
}

export function parseLabel(text: string): string | null {
  const label = text.trim().replace(/^["'`]+|["'`.]+$/g, '').trim().replace(/\s+/g, ' ')
  const words = label.split(/\s+/).filter(Boolean).length
  return words >= 3 && words <= 6 ? label : null
}
