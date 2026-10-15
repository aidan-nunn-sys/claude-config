import type { Card, CardSource, Column } from '../types'

export const COLUMNS: readonly Column[] = ['todo', 'doing', 'done']

export const COLUMN_NAME: Record<Column, string> = { todo: 'To do', doing: 'Doing', done: 'Done' }

/** How many Done cards the column shows; the rest are counted. */
export const DONE_SHOWN = 5

/** The most cards a board keeps: the oldest Done ones go first. */
export const CARD_LIMIT = 80

const SOURCE_NAME: Record<CardSource, string> = {
  you: 'Added by you',
  todo: "From Claude's to-do list",
  plan: 'From the approved plan',
  claude: 'Added by Claude',
}

export function sourceName(source: CardSource): string {
  return SOURCE_NAME[source]
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** A card's title as it is kept: one line, trimmed, at most 160 characters. */
export function cleanTitle(text: string): string {
  return clip(text.replace(/\s+/g, ' ').trim(), 160)
}

/** A new card's id, unique within the board. */
export function newId(cards: readonly Card[], at: number): string {
  let n = cards.length
  let id = `c${at.toString(36)}${n.toString(36)}`
  while (cards.some(card => card.id === id)) {
    n += 1
    id = `c${at.toString(36)}${n.toString(36)}`
  }

  return id
}

/** The board with a card added at the end of `column`, and the card; a card already there by that title is kept as is. */
export function addCard(
  cards: readonly Card[],
  fields: { title: string; note?: string; column?: Column; source: CardSource; ref?: string | null; parentId?: string | null; sessionId?: string; filedBy?: 'haiku' | null; inboxId?: string; distinct?: boolean },
  at: number,
): { cards: Card[]; card: Card } {
  const title = cleanTitle(fields.title)
  // Invalid parents become top goals rather than introducing orphans or a third level.
  const parentId = fields.parentId != null && goals(cards).some(card => card.id === fields.parentId) ? fields.parentId : null
  const same = cards.find(card => fields.inboxId !== undefined
    ? card.inboxId === fields.inboxId
    : fields.source === 'todo' && fields.ref != null
      ? card.source === 'todo' && card.ref === fields.ref && (card.sessionId ?? '') === (fields.sessionId ?? '')
      : !fields.distinct && (card.parentId ?? null) === parentId && card.title.toLowerCase() === title.toLowerCase() && card.column !== 'done')
  if (same !== undefined) return { cards: [...cards], card: same }
  const card: Card = {
    id: newId(cards, at),
    incarnation: Math.random().toString(36).slice(2),
    title,
    note: clip((fields.note ?? '').trim(), 1_000),
    column: fields.column ?? 'todo',
    source: fields.source,
    ref: fields.ref ?? null,
    createdAt: at,
    parentId,
    sessionId: fields.sessionId ?? '',
    sessionLabel: null,
    carriedAt: null,
    filedBy: fields.filedBy ?? null,
    ...(fields.inboxId === undefined ? {} : { inboxId: fields.inboxId }),
  }

  return { cards: trim([...cards, card], card.id), card }
}

/** At most `CARD_LIMIT` cards: the oldest Done ones go first. */
function trim(cards: Card[], addedId: string): Card[] {
  const out = [...cards]
  // Keep the incoming card, its parent, and every active goal. Evicting
  // any of those goals would also silently delete protected work below it.
  const protectedIds = new Set(out.filter(card => card.id === addedId || ((card.parentId ?? null) === null && card.column === 'doing')).map(card => card.id))
  const parent = out.find(card => card.id === addedId)?.parentId
  if (parent != null) protectedIds.add(parent)
  while (out.length > CARD_LIMIT) {
    let at = out.findIndex(card => !protectedIds.has(card.id) && card.column === 'done')
    if (at === -1) at = out.findIndex(card => !protectedIds.has(card.id))
    // All remaining cards are protected; preservation takes priority over the cap.
    if (at === -1) break
    const removed = out[at]!
    out.splice(at, 1)
    // Evict a goal's children too: limiting the board must not leave orphans.
    for (let n = out.length - 1; n >= 0; n -= 1) if (out[n]?.parentId === removed.id) out.splice(n, 1)
  }

  return out
}

/** The board with card `id` in `column`, moved to the end of it. */
export function moveCard(cards: readonly Card[], id: string, column: Column): Card[] {
  const card = cards.find(one => one.id === id)
  if (card === undefined || card.column === column) return [...cards]

  return [...cards.filter(one => one.id !== id), { ...card, column }]
}

/** The board with card `id` retitled and its description replaced. */
export function editCard(cards: readonly Card[], id: string, fields: { title: string; note: string }): Card[] {
  return cards.map(card => (card.id === id ? { ...card, title: cleanTitle(fields.title), note: clip(fields.note.trim(), 1_000) } : card))
}

export function removeCard(cards: readonly Card[], id: string): Card[] {
  return cards.filter(card => card.id !== id && card.parentId !== id)
}

export const SESSION_GOAL = 'Session'

/** The top goals, including cards made before nesting was added. */
export function goals(cards: readonly Card[]): Card[] {
  return cards.filter(card => (card.parentId ?? null) === null)
}

export function subtasksOf(cards: readonly Card[], id: string): Card[] {
  return cards.filter(card => card.parentId === id)
}

export function progressOf(cards: readonly Card[], id: string): { done: number; total: number } {
  const subs = subtasksOf(cards, id)
  return { done: subs.filter(card => card.column === 'done').length, total: subs.length }
}

/** Last goal in Doing, otherwise a reusable Session goal. */
export function currentGoal(cards: readonly Card[], at: number, sessionId: string): { cards: Card[]; id: string } {
  const doing = goals(cards).filter(card => card.column === 'doing')
  const last = doing[doing.length - 1]
  if (last !== undefined) return { cards: [...cards], id: last.id }
  const existing = goals(cards).find(card => card.title === SESSION_GOAL)
  if (existing !== undefined) return { cards: moveCard(cards, existing.id, 'doing'), id: existing.id }
  const added = addCard(cards, { title: SESSION_GOAL, column: 'doing', source: 'claude', sessionId }, at)
  return { cards: added.cards, id: added.card.id }
}

export function makeGoal(cards: readonly Card[], id: string): Card[] {
  return cards.map(card => (card.id === id ? { ...card, parentId: null } : card))
}

/** Refuse parents or children that would introduce a third level. */
export function moveUnder(cards: readonly Card[], id: string, parentId: string): Card[] {
  const parent = cards.find(card => card.id === parentId)
  if (parent === undefined || (parent.parentId ?? null) !== null || id === parentId || subtasksOf(cards, id).length > 0) return [...cards]
  return cards.map(card => (card.id === id ? { ...card, parentId } : card))
}

/** The column left or right of `column`, if any. */
export function neighbour(column: Column, step: -1 | 1): Column | null {
  return COLUMNS[COLUMNS.indexOf(column) + step] ?? null
}

const STATUS_COLUMN: Record<string, Column> = { pending: 'todo', in_progress: 'doing', completed: 'done' }

/**
 * The board after Claude wrote its to-do list (TodoWrite): each item a card
 * in the column its status says, matched to the card it made before by its
 * text; the cards of items it dropped go. Claude's list is the truth for its
 * own cards.
 */
export function syncTodos(
  cards: readonly Card[],
  todos: ReadonlyArray<{ content: string; status: string }>,
  at: number,
  sessionId = '',
): Card[] {
  const kept = new Set(todos.map(todo => todo.content))
  let out = [...cards]
  for (const card of cards) {
    if (card.source === 'todo' && (card.sessionId ?? '') === sessionId && card.ref !== null && !kept.has(card.ref) && !card.ref.startsWith('task:')) {
      out = removeCard(out, card.id)
    }
  }
  for (const todo of todos) {
    const title = cleanTitle(todo.content)
    const column = STATUS_COLUMN[todo.status] ?? 'todo'
    const mine = out.find(card => card.source === 'todo' && (card.sessionId ?? '') === sessionId && card.ref === todo.content)
    if (mine === undefined) {
      const goal = currentGoal(out, at, sessionId)
      out = addCard(goal.cards, { title, column, source: 'todo', ref: todo.content, parentId: goal.id, sessionId }, at).cards
    } else if (mine.column !== column) {
      out = moveCard(out, mine.id, column)
    }
  }

  return out
}

/** The board after Claude created a task in its to-do list (TaskCreate). */
export function taskCreated(cards: readonly Card[], task: { id: string; subject: string; description?: string }, at: number, sessionId = ''): Card[] {
  const goal = currentGoal(cards, at, sessionId)
  return addCard(goal.cards, { title: task.subject, note: task.description ?? '', source: 'todo', ref: `task:${task.id}`, parentId: goal.id, sessionId }, at).cards
}

/** The board after Claude updated a task in its to-do list (TaskUpdate): its status, title or note; deleted, it goes. */
export function taskUpdated(
  cards: readonly Card[],
  update: { taskId: string; status?: string; subject?: string; description?: string },
  sessionId = '',
): Card[] {
  const card = cards.find(one => one.source === 'todo' && (one.sessionId ?? '') === sessionId && one.ref === `task:${update.taskId}`)
  if (card === undefined) return [...cards]
  if (update.status === 'deleted') return removeCard(cards, card.id)
  const changed: Card = {
    ...card,
    ...(update.subject === undefined ? {} : { title: cleanTitle(update.subject) }),
    ...(update.description === undefined ? {} : { note: clip(update.description.trim(), 1_000) }),
  }
  const column = update.status === undefined ? card.column : (STATUS_COLUMN[update.status] ?? card.column)
  const replaced = cards.map(one => (one.id === card.id ? changed : one))

  return column === card.column ? replaced : moveCard(replaced, card.id, column)
}

/** Markdown as plain text: emphasis, code marks and links reduced to their words. */
function plainText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[:：]\s*$/, '')
    .trim()
}

// Headings that frame a plan rather than name a step in it.
const FRAMING = /^(context|overview|summary|background|goal|goals|plan|approach|verification|testing|test plan|risks|notes|open questions|files|critical files)\b/i

/**
 * The steps of an approved plan, as cards: its numbered items, else its
 * top-level bullets, else its section headings (not the ones that frame it,
 * such as Context or Verification). At most 20.
 */
export function planSteps(plan: string): string[] {
  const lines = plan.split('\n')
  const pick = (pattern: RegExp) =>
    lines
      .map(line => line.match(pattern)?.[1])
      .filter((step): step is string => step !== undefined)
      .map(plainText)
      .filter(step => step !== '')
  const numbered = pick(/^ {0,3}\d+[.)]\s+(.+)$/)
  const bullets = pick(/^[-*+]\s+(?:\[[ xX]\]\s+)?(.+)$/)
  const headings = pick(/^#{2,4}\s+(?:(?:step|phase)\s*\d+\s*[:.\-–]\s*)?(.+)$/i).filter(step => !FRAMING.test(step))
  const steps = numbered.length >= 2 ? numbered : bullets.length >= 2 ? bullets : headings

  return steps.slice(0, 20).map(cleanTitle)
}

/** What Work on it sends Claude. */
export function workPrompt(card: Card): string {
  return [`Work on this card from the task board: "${card.title}"`, ...(card.note === '' ? [] : ['', card.note])].join('\n')
}

/** The board as text, for the board tool's `list`: each column, each card with its id. */
export function boardText(cards: readonly Card[]): string {
  if (cards.length === 0) return 'The board is empty.'

  return COLUMNS.map(column => {
    const inColumn = goals(cards).filter(card => card.column === column)
    return [`${COLUMN_NAME[column]} (${inColumn.length})`, ...inColumn.flatMap(card => [
      `- [${card.id}] ${card.title}`,
      ...subtasksOf(cards, card.id).map(sub => `    - [${sub.id}] ${sub.title} (${COLUMN_NAME[sub.column]})`),
    ])].join('\n')
  }).join('\n\n')
}

/** What the board tool takes, as the model sends it: checked here, never trusted. */
export type BoardToolInput = { action?: unknown; title?: unknown; note?: unknown; card?: unknown; column?: unknown; parent?: unknown; text?: unknown }

export const BOARD_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list', 'add', 'move', 'remove', 'inbox'], description: 'What to do.' },
    title: { type: 'string', description: 'add: the card, a short imperative ("Add an offline banner").' },
    note: { type: 'string', description: 'add: optional detail: why, where, what done means.' },
    card: { type: 'string', description: 'move, remove: the card id from list, or its exact title.' },
    column: { type: 'string', enum: ['todo', 'doing', 'done'], description: 'add (default todo), move: the column.' },
    parent: { type: 'string', description: 'add: optional top goal (id or exact title) to put the card under as a subtask.' },
    text: { type: 'string', description: "inbox: the person's ask, as they said it." },
  },
  required: ['action'],
} as const

export const BOARD_TOOL_DESCRIPTION = [
  "The task board in the person's side pane: top goals (To do, Doing, Done), each with its own subtasks.",
  "When the person asks for real work (not a yes/no, a question or a one-word reply), call inbox with their ask: a small model files it as a goal or a subtask. Do not decide where it goes yourself.",
  'Messages the person queues while you work are filed by themselves: do not send them again.',
  'Your own to-do list goes under the goal in Doing by itself: do not add its items again.',
  'Actions: list (cards and ids, subtasks indented), add (title, optional note, column, parent), move (card, column), remove (card, with its subtasks), inbox (text).',
].join(' ')

const isColumn = (value: unknown): value is Column => value === 'todo' || value === 'doing' || value === 'done'

/** Finds a card by its id, else by its title (exact, ignoring case). */
function findCard(cards: readonly Card[], key: string): Card | undefined {
  const wanted = key.trim().toLowerCase()

  return cards.find(card => card.id === key.trim()) ?? cards.find(card => card.title.toLowerCase() === wanted)
}

/** Runs one board tool call: the board after it, and what the model reads back. */
export function runBoardTool(
  cards: readonly Card[],
  input: BoardToolInput,
  at: number,
  sessionId = '',
): { cards: Card[]; text: string; isError?: true } {
  const fail = (text: string) => ({ cards: [...cards], text, isError: true as const })
  switch (input.action) {
    case 'list':
      return { cards: [...cards], text: boardText(cards) }
    case 'add': {
      if (typeof input.title !== 'string' || input.title.trim() === '') return fail('add needs a title.')
      if (input.column !== undefined && !isColumn(input.column)) return fail('column is todo, doing or done.')
      let parentId: string | null = null
      if (input.parent !== undefined) {
        if (typeof input.parent !== 'string') return fail('parent is a top goal id or title.')
        const parent = findCard(goals(cards), input.parent)
        if (parent === undefined) return fail(`No top goal "${input.parent}". Use list to see the goals.`)
        parentId = parent.id
      }
      const before = cards.length
      const added = addCard(
        cards,
        { title: input.title, note: typeof input.note === 'string' ? input.note : '', column: input.column ?? 'todo', source: 'claude', parentId, sessionId },
        at,
      )
      return {
        cards: added.cards,
        text:
          added.cards.length === before
            ? `"${added.card.title}" is already on the board (${COLUMN_NAME[added.card.column]}, ${added.card.id}).`
            : parentId !== null ? `Added "${added.card.title}" under "${cards.find(c => c.id === parentId)!.title}" (${added.card.id}).`
            : `Added "${added.card.title}" to ${COLUMN_NAME[added.card.column]} (${added.card.id}).`,
      }
    }
    case 'move': {
      if (typeof input.card !== 'string') return fail('move needs a card: its id or title.')
      if (!isColumn(input.column)) return fail('move needs a column: todo, doing or done.')
      const card = findCard(cards, input.card)
      if (card === undefined) return fail(`No card "${input.card}". Use list to see the cards and their ids.`)
      return { cards: moveCard(cards, card.id, input.column), text: `Moved "${card.title}" to ${COLUMN_NAME[input.column]}.` }
    }
    case 'remove': {
      if (typeof input.card !== 'string') return fail('remove needs a card: its id or title.')
      const card = findCard(cards, input.card)
      if (card === undefined) return fail(`No card "${input.card}". Use list to see the cards and their ids.`)
      return { cards: removeCard(cards, card.id), text: `Removed "${card.title}".` }
    }
    case 'inbox':
      return fail('inbox is answered by the hook.')
    default:
      return fail('action is list, add, move, remove or inbox.')
  }
}
