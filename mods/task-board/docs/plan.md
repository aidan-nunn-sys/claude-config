# Task board: goals, subtasks, inbox, carry-over — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the task-board mod two-level (goals → subtasks), file asks through a Haiku-run inbox, and carry unfinished goals across sessions per directory with a 14-day archive.

**Architecture:** Pure board logic stays in `hooks/lib.ts` (nesting added); new pure modules `hooks/carry.ts` (carry-over/expiry/pull-in) and `hooks/filer.ts` (Haiku prompt + reply parsing); `hooks/register.tsx` wires hooks, `$.store` and the pane views.

**Tech Stack:** Claude Code mod API (`claude-code`, `claude-code/testing`), TSX against `$.ui.resolve`, `$.model.complete`, `$.store`.

**Spec:** `docs/spec.md` (same folder).

**Mod root:** `~/.claude/dev-mods/2291f4fe-c894-4e99-9f7e-d460435128e9/task-board` — all paths below are relative to it. Not a git repo: there are **no commit steps**; the checkpoint after each task is the full test run. Rollback copy: `/tmp/task-board-backup`.

## Global Constraints

- Two levels only: a subtask's `parentId` must name a card whose `parentId` is `null`.
- Haiku calls: `model: 'haiku'`, `effort: 'low'`, `timeoutMs: 10_000`; ask text cut to 1,000 chars; titles at most 60 chars.
- Carry-over store key: `board:<cwd>`; groups older than 14 days (`14 * 24 * 60 * 60_000` ms) move to archive at session start.
- The `prompt.submit` hook never changes `e`: it passes `next(e)` unchanged.
- Queued = `prompt.submit` with `e.turnId !== undefined`. Slash commands (text starting `/`) are never filed.
- Legacy cards in `$.state` may lack the new fields: read them with `?? null` / `?? ''`.

## Review Focus

1. Haiku replies with prose around the JSON, or a fenced code block → still parsed (test in Task 3).
2. Haiku names a subtask's id as `subtask_of` → falls back to a new top goal (test in Task 3).
3. A session that ends with only Done goals → nothing written to the store (test in Task 2).
4. Pulling in a goal whose title matches a live unfinished goal → both kept, not merged (test in Task 2).
5. Deleting a goal with subtasks → its subtasks go too, no orphans on the board (test in Task 1).

Run tests at any point: `claude plugin test .` (from the mod root). Baseline: 14 pass.

---

### Task 1: Nesting in the card model and lib

**Files:**
- Modify: `types/index.d.ts`
- Modify: `hooks/lib.ts`
- Test: `tests/nesting.test.ts` (create)

**Interfaces:**
- Produces: `Card` gains `parentId: string | null; sessionId: string; sessionLabel: string | null; carriedAt: number | null; filedBy: 'haiku' | null`.
- Produces: `addCard(cards, { title, note?, column?, source, ref?, parentId?, sessionId?, filedBy? }, at)` (dedupe only among cards with the same `parentId`).
- Produces: `goals(cards): Card[]`, `subtasksOf(cards, id): Card[]`, `progressOf(cards, id): { done: number; total: number }`.
- Produces: `currentGoal(cards, at, sessionId): { cards: Card[]; id: string }` — last top goal in Doing, else the top goal titled `Session` (created in Doing if missing).
- Produces: `makeGoal(cards, id): Card[]`, `moveUnder(cards, id, parentId): Card[]` (no-op if `parentId` is not a top goal, or `id` has subtasks).
- Changes: `removeCard` also removes the card's subtasks; `syncTodos` / `taskCreated` take a trailing `sessionId: string` and file new items under `currentGoal`.

- [ ] **Step 1: Write the failing tests** — `tests/nesting.test.ts`:

```ts
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
  // g1 has a subtask: it cannot become one
  expect(moveUnder(cards, g1.id, g2.card.id).find(c => c.id === g1.id)?.parentId).toBeNull()
  // a subtask is no parent
  expect(moveUnder(cards, g2.card.id, s.card.id).find(c => c.id === g2.card.id)?.parentId).toBeNull()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `claude plugin test .`
Expected: `nesting.test.ts` fails on missing exports (`currentGoal`, `goals`, …); the 14 existing tests still pass.

- [ ] **Step 3: Extend the type** — in `types/index.d.ts`, replace the `Card` type with:

```ts
export type Card = {
  id: string
  title: string
  /** More about it, when whoever added it said more; else empty. */
  note: string
  column: Column
  source: CardSource
  /** What ties a card to Claude's to-do list: the item's text (TodoWrite) or its task id (TaskCreate). */
  ref: string | null
  createdAt: number
  /** null for a top goal; else the id of the top goal it is a subtask of. */
  parentId: string | null
  /** The session the card was made in. */
  sessionId: string
  /** That session's label, once it ended. */
  sessionLabel: string | null
  /** When it went to Carried over; null on the live board. */
  carriedAt: number | null
  /** Haiku filed it from the inbox. */
  filedBy: 'haiku' | null
}
```

- [ ] **Step 4: Implement in `hooks/lib.ts`**

Replace `addCard` with:

```ts
export function addCard(
  cards: readonly Card[],
  fields: {
    title: string
    note?: string
    column?: Column
    source: CardSource
    ref?: string | null
    parentId?: string | null
    sessionId?: string
    filedBy?: 'haiku' | null
  },
  at: number,
): { cards: Card[]; card: Card } {
  const title = cleanTitle(fields.title)
  const parentId = fields.parentId ?? null
  const same = cards.find(
    card => (card.parentId ?? null) === parentId && card.title.toLowerCase() === title.toLowerCase() && card.column !== 'done',
  )
  if (same !== undefined) return { cards: [...cards], card: same }
  const card: Card = {
    id: newId(cards, at),
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
  }

  return { cards: trim([...cards, card]), card }
}
```

Replace `removeCard` with:

```ts
/** The board without card `id`, and without its subtasks. */
export function removeCard(cards: readonly Card[], id: string): Card[] {
  return cards.filter(card => card.id !== id && card.parentId !== id)
}
```

Add after `removeCard`:

```ts
export const SESSION_GOAL = 'Session'

/** The top goals, in board order. */
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

/** The goal new to-do items go under: the last top goal in Doing, else a Session goal (made in Doing if missing). */
export function currentGoal(cards: readonly Card[], at: number, sessionId: string): { cards: Card[]; id: string } {
  const doing = goals(cards).filter(card => card.column === 'doing')
  const last = doing[doing.length - 1]
  if (last !== undefined) return { cards: [...cards], id: last.id }
  const added = addCard(cards, { title: SESSION_GOAL, column: 'doing', source: 'claude', sessionId }, at)
  return { cards: added.cards, id: added.card.id }
}

/** A subtask made a top goal. */
export function makeGoal(cards: readonly Card[], id: string): Card[] {
  return cards.map(card => (card.id === id ? { ...card, parentId: null } : card))
}

/** Card `id` made a subtask of top goal `parentId`; refused (board unchanged) when that would make three levels. */
export function moveUnder(cards: readonly Card[], id: string, parentId: string): Card[] {
  const parent = cards.find(card => card.id === parentId)
  if (parent === undefined || (parent.parentId ?? null) !== null || id === parentId) return [...cards]
  if (subtasksOf(cards, id).length > 0) return [...cards]
  return cards.map(card => (card.id === id ? { ...card, parentId } : card))
}
```

Change `syncTodos` signature and body (keep its doc comment):

```ts
export function syncTodos(
  cards: readonly Card[],
  todos: ReadonlyArray<{ content: string; status: string }>,
  at: number,
  sessionId = '',
): Card[] {
  const kept = new Set(todos.map(todo => cleanTitle(todo.content)))
  let out = cards.filter(card => card.source !== 'todo' || card.ref === null || kept.has(card.ref) || card.ref.startsWith('task:'))
  for (const todo of todos) {
    const title = cleanTitle(todo.content)
    const column = STATUS_COLUMN[todo.status] ?? 'todo'
    const mine = out.find(card => card.source === 'todo' && card.ref === title)
    if (mine === undefined) {
      const goal = currentGoal(out, at, sessionId)
      out = addCard(goal.cards, { title, column, source: 'todo', ref: title, parentId: goal.id, sessionId }, at).cards
    } else if (mine.column !== column) {
      out = moveCard(out, mine.id, column)
    }
  }

  return out
}
```

Change `taskCreated`:

```ts
export function taskCreated(
  cards: readonly Card[],
  task: { id: string; subject: string; description?: string },
  at: number,
  sessionId = '',
): Card[] {
  const goal = currentGoal(cards, at, sessionId)
  return addCard(
    goal.cards,
    { title: task.subject, note: task.description ?? '', source: 'todo', ref: `task:${task.id}`, parentId: goal.id, sessionId },
    at,
  ).cards
}
```

- [ ] **Step 5: Run the suite**

Run: `claude plugin test .`
Expected: all of `nesting.test.ts` pass. Existing tests that assert to-do items appear as top-level cards will now fail because those items nest under `Session`; update each such assertion to look the card up anywhere in `cards` (not only top-level) and to expect a `Session` goal card in Doing. Re-run until everything passes.

---

### Task 2: Carry-over, expiry, pull-in

**Files:**
- Create: `hooks/carry.ts`
- Modify: `types/index.d.ts` (add `Group`, `Stash`)
- Test: `tests/carry.test.ts` (create)

**Interfaces:**
- Consumes: `Card`, `goals`, `subtasksOf` (Task 1).
- Produces: `type Group = { sessionId: string; label: string; isLabelled: boolean; endedAt: number; cards: Card[] }`, `type Stash = { carried: Group[]; archive: Group[] }`.
- Produces: `EMPTY_STASH: Stash`, `ARCHIVE_AFTER_MS`, `stashKey(cwd): string`, `readStash(value: unknown): Stash`.
- Produces: `carryOver(cards, { sessionId, label, endedAt }): Group | null`, `expire(stash, now): { stash: Stash; moved: number }`, `pullIn(stash, board, goalId): { stash: Stash; cards: Card[] }`, `fallbackLabel(cards, endedAt): string`, `daysLeft(group, now): number`.

Note: the session-end hook runs under a short time bound, so the group is saved with `fallbackLabel` and `isLabelled: false`; Haiku relabels it at the next session start (Task 4). This is a deliberate refinement of spec §2's "at session.end".

- [ ] **Step 1: Write the failing tests** — `tests/carry.test.ts`:

```ts
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
  const { cards } = board()
  const group = carryOver(cards, { sessionId: 's1', label: 'x', endedAt: AT })
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
  const out = expire(stash, AT + ARCHIVE_AFTER_MS + 1)
  expect(out).toMatchObject({ moved: 1, stash: { carried: [], archive: [group] } })
  expect(daysLeft(group, AT + 9 * 86_400_000)).toBe(5)
})

test('pull in brings a goal and its subtasks back; an emptied group goes', () => {
  const { cards, open } = board()
  const group = carryOver(cards, { sessionId: 's1', label: 'x', endedAt: AT })!
  const live = addCard([], { title: 'Write plan', source: 'claude', sessionId: 's2' }, AT).cards
  const out = pullIn({ carried: [group], archive: [] }, live, open.id)
  expect(out.stash.carried).toEqual([])
  expect(out.cards.filter(c => c.title === 'Write plan')).toHaveLength(2)
  const pulled = out.cards.find(c => c.id === open.id)!
  expect(pulled).toMatchObject({ column: 'todo', carriedAt: null, parentId: null })
  expect(out.cards.find(c => c.title === 'Task 1')?.parentId).toBe(open.id)
})

test('a stored value that is not a stash reads as empty; fallback label names the date and first goal', () => {
  expect(readStash(undefined)).toEqual(EMPTY_STASH)
  expect(readStash({ carried: 'x' })).toEqual(EMPTY_STASH)
  expect(fallbackLabel(board().cards, AT)).toBe('Oct 13 · Write plan')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `claude plugin test .` — Expected: `carry.test.ts` fails, cannot resolve `../hooks/carry`.

- [ ] **Step 3: Add types** — append to `types/index.d.ts` above `declare module`:

```ts
/** One ended session's unfinished goals, with their subtasks. */
export type Group = { sessionId: string; label: string; isLabelled: boolean; endedAt: number; cards: Card[] }
/** What a directory keeps across sessions. */
export type Stash = { carried: Group[]; archive: Group[] }
```

- [ ] **Step 4: Implement `hooks/carry.ts`**

```ts
import type { Card, Group, Stash } from '../types'
import { goals, subtasksOf } from './lib'

export const ARCHIVE_AFTER_MS = 14 * 24 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const EMPTY_STASH: Stash = { carried: [], archive: [] }

export const stashKey = (cwd: string) => `board:${cwd}`

/** What the store held, if it is a stash; else an empty one. */
export function readStash(value: unknown): Stash {
  const v = value as Partial<Stash> | null | undefined
  if (v === null || typeof v !== 'object' || !Array.isArray(v.carried) || !Array.isArray(v.archive)) return EMPTY_STASH
  return { carried: v.carried, archive: v.archive }
}

/** `Oct 13 · <first unfinished goal>`, the label until Haiku names the session. */
export function fallbackLabel(cards: readonly Card[], endedAt: number): string {
  const d = new Date(endedAt)
  const first = goals(cards).find(card => card.column !== 'done')
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${first === undefined ? '' : ` · ${first.title}`}`
}

/** The unfinished goals of an ending session, with their subtasks, as one group; null when there are none. */
export function carryOver(cards: readonly Card[], at: { sessionId: string; label: string; endedAt: number }): Group | null {
  const open = goals(cards).filter(card => card.column !== 'done')
  if (open.length === 0) return null
  const mark = (card: Card): Card => ({ ...card, carriedAt: at.endedAt, sessionLabel: at.label })
  return {
    sessionId: at.sessionId,
    label: at.label,
    isLabelled: false,
    endedAt: at.endedAt,
    cards: open.flatMap(goal => [mark(goal), ...subtasksOf(cards, goal.id).map(mark)]),
  }
}

/** Carried groups past 14 days moved to the archive; empty groups dropped. */
export function expire(stash: Stash, now: number): { stash: Stash; moved: number } {
  const live = stash.carried.filter(group => group.cards.length > 0)
  const old = live.filter(group => now - group.endedAt > ARCHIVE_AFTER_MS)
  return {
    stash: { carried: live.filter(group => !old.includes(group)), archive: [...stash.archive, ...old] },
    moved: old.length,
  }
}

export function daysLeft(group: Group, now: number): number {
  return Math.max(0, Math.ceil((group.endedAt + ARCHIVE_AFTER_MS - now) / DAY_MS))
}

/** Goal `goalId` and its subtasks taken from carried or archive onto the live board (goal in To do). */
export function pullIn(stash: Stash, board: readonly Card[], goalId: string): { stash: Stash; cards: Card[] } {
  const take = (groups: Group[]) => {
    let taken: Card[] = []
    const rest = groups
      .map(group => {
        const mine = group.cards.filter(card => card.id === goalId || card.parentId === goalId)
        if (mine.length === 0) return group
        taken = mine
        return { ...group, cards: group.cards.filter(card => !mine.includes(card)) }
      })
      .filter(group => group.cards.length > 0)
    return { rest, taken }
  }
  const fromCarried = take(stash.carried)
  const fromArchive = fromCarried.taken.length > 0 ? { rest: stash.archive, taken: [] as Card[] } : take(stash.archive)
  const taken = [...fromCarried.taken, ...fromArchive.taken].map(card => ({
    ...card,
    carriedAt: null,
    ...(card.id === goalId ? { column: 'todo' as const } : {}),
  }))
  // The pulled cards keep their ids; an id already on the live board is left as is (ids embed a timestamp, so clashes do not happen in practice).
  return { stash: { carried: fromCarried.rest, archive: fromArchive.rest }, cards: [...board, ...taken] }
}
```

- [ ] **Step 5: Run the suite** — `claude plugin test .` — Expected: all pass.

---

### Task 3: Haiku filer (pure)

**Files:**
- Create: `hooks/filer.ts`
- Test: `tests/filer.test.ts` (create)

**Interfaces:**
- Consumes: `Card`, `goals`, `addCard`, `cleanTitle` (Task 1).
- Produces: `FILER_SYSTEM: string`, `filerPrompt(ask, cards): string`, `type Filing = { kind: 'subtask'; parentId: string; title: string } | { kind: 'goal'; title: string }`, `parseFiling(text, cards): Filing | null`, `fallbackFiling(ask): Filing`, `applyFiling(cards, filing, { at, sessionId, byHaiku }): Card[]`, `labelPrompt(group): string`, `parseLabel(text): string | null`.

- [ ] **Step 1: Write the failing tests** — `tests/filer.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { applyFiling, fallbackFiling, filerPrompt, parseFiling, parseLabel } from '../hooks/filer'
import { addCard } from '../hooks/lib'

const AT = Date.parse('2026-10-13T10:00:00Z')

function board() {
  let { cards, card: goal } = addCard([], { title: 'Status bar', source: 'claude', column: 'doing' }, AT)
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
  expect(parseFiling(`{"subtask_of":"${goal.id}","title":"Hide esc hint"}`, cards)).toEqual({
    kind: 'subtask',
    parentId: goal.id,
    title: 'Hide esc hint',
  })
  expect(parseFiling('Sure:\n```json\n{"new_goal":"Plan the board"}\n```', cards)).toEqual({ kind: 'goal', title: 'Plan the board' })
})

test('unknown ids, subtask ids, bad JSON and empty titles are refused', () => {
  const { cards, sub } = board()
  expect(parseFiling('{"subtask_of":"nope","title":"x"}', cards)).toBeNull()
  expect(parseFiling(`{"subtask_of":"${sub.id}","title":"x"}`, cards)).toBeNull()
  expect(parseFiling('not json', cards)).toBeNull()
  expect(parseFiling('{"new_goal":"  "}', cards)).toBeNull()
})

test('titles are cut to 60; the fallback is the first line of the ask', () => {
  const { cards } = board()
  const long = parseFiling(`{"new_goal":"${'a'.repeat(80)}"}`, cards)
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
})
```

- [ ] **Step 2: Run to verify they fail** — `claude plugin test .` — Expected: cannot resolve `../hooks/filer`.

- [ ] **Step 3: Implement `hooks/filer.ts`**

```ts
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

/** Haiku's reply as a filing; null when it is not one the board can take. */
export function parseFiling(text: string, cards: readonly Card[]): Filing | null {
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (json === undefined) return null
  let value: { subtask_of?: unknown; title?: unknown; new_goal?: unknown }
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof value.new_goal === 'string' && value.new_goal.trim() !== '') return { kind: 'goal', title: short(value.new_goal) }
  if (typeof value.subtask_of === 'string' && typeof value.title === 'string' && value.title.trim() !== '') {
    const parent = goals(cards).find(card => card.id === value.subtask_of)
    if (parent === undefined) return null
    return { kind: 'subtask', parentId: parent.id, title: short(value.title) }
  }
  return null
}

export function fallbackFiling(ask: string): Filing {
  return { kind: 'goal', title: short(ask.split('\n').find(line => line.trim() !== '') ?? ask) }
}

export function applyFiling(cards: readonly Card[], filing: Filing, at: { at: number; sessionId: string; byHaiku: boolean }): Card[] {
  return addCard(
    cards,
    {
      title: filing.title,
      source: 'claude',
      column: 'todo',
      parentId: filing.kind === 'subtask' ? filing.parentId : null,
      sessionId: at.sessionId,
      filedBy: at.byHaiku ? 'haiku' : null,
    },
    at.at,
  ).cards
}

export const LABEL_SYSTEM = 'Name a work session from its goals in 3 to 6 words. Reply with the name only.'

export function labelPrompt(group: Group): string {
  return group.cards
    .filter(card => card.parentId === null)
    .map(card => `- ${card.title}`)
    .join('\n')
}

export function parseLabel(text: string): string | null {
  const label = text.trim().replace(/^["'`]+|["'`.]+$/g, '').trim()
  const words = label.split(/\s+/).filter(Boolean).length
  return words >= 3 && words <= 6 ? label.slice(0, 60) : null
}
```

- [ ] **Step 4: Run the suite** — `claude plugin test .` — Expected: all pass.

---

### Task 4: Hooks — inbox, queued prompts, carry-over lifecycle, tool actions

**Files:**
- Modify: `types/index.d.ts` (state: `inbox`, `view`, `stash`)
- Modify: `hooks/lib.ts` (tool schema/description, `add` with `parent`)
- Modify: `hooks/register.tsx`
- Test: `tests/hooks.test.ts` (create)

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces state: `inbox: { id: string; text: string }[]`, `view: View`, `stash: Stash` where `type View = { kind: 'top' } | { kind: 'goal'; id: string } | { kind: 'carried' } | { kind: 'archive' }`.
- Produces (register.tsx, module-level): `fileAsk($, text): Promise<void>`, `saveStash($, stash)`.

- [ ] **Step 1: Write the failing tests** — `tests/hooks.test.ts`:

```ts
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-13T10:00:00Z')
const TOOL = 'mcp__task-board__board'

type Fake = { asks: string[]; replies: string[]; statuses: string[] }

async function fake($: Engine, on: On, replies: string[] = []): Promise<Fake> {
  const state: Fake = { asks: [], replies, statuses: [] }
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('command.register', () => ({ value: { command: 'board' } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__task-board__${e.name}` } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({}) as never)
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/work/orbit' }))
  on('ui.status', ($, e) => {
    state.statuses.push(String(e.text ?? ''))
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('model.complete', ($, e) => {
    state.asks.push(String(e.prompt))
    const text = state.replies.shift()
    return { value: text === undefined ? { isAnswered: false, reason: 'api-error', status: 500, error: 'x' } : { isAnswered: true, text, usage: {} } } as never
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: {}, text: 'ok' }))
  await $.session.start({ cwd: '/work/orbit', surface: 'terminal', isInteractive: true })
  return state
}

const list = async ($: Engine) => String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)

test('a queued prompt is filed by Haiku; an idle one is not; the prompt passes unchanged', async ($, on) => {
  const f = await fake($, on, ['{"new_goal":"Hide the esc hint"}'])
  const idle = await $.prompt.submit({ text: 'just a question' } as never)
  const queued = await $.prompt.submit({ text: 'also hide the esc hint', turnId: 't1', wait: false } as never)
  expect(queued).toMatchObject({ text: 'also hide the esc hint' })
  expect(idle).toMatchObject({ text: 'just a question' })
  await $.clock.advance(10)
  expect(f.asks).toHaveLength(1)
  expect(await list($)).toContain('Hide the esc hint')
})

test('a failed Haiku call files the first line as a goal', async ($, on) => {
  await fake($, on, [])
  await $.prompt.submit({ text: 'Fix the bar\nit flickers', turnId: 't1', wait: false } as never)
  await $.clock.advance(10)
  expect(await list($)).toContain('Fix the bar')
})

test('the inbox tool action answers at once and files through Haiku', async ($, on) => {
  await fake($, on, ['{"new_goal":"Write the plan"}'])
  const r = await $.tool.call({ tool: TOOL, action: 'inbox', text: 'write the implementation plan' } as never)
  expect(String(r.text)).toBe('Sent to the inbox.')
  await $.clock.advance(10)
  expect(await list($)).toContain('Write the plan')
})

test('add with parent files a subtask under a top goal', async ($, on) => {
  await fake($, on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Goal', column: 'doing' } as never)
  const r = await $.tool.call({ tool: TOOL, action: 'add', title: 'Step', parent: 'Goal' } as never)
  expect(String(r.text)).toContain('under "Goal"')
})

test('unfinished goals carry over to the next session in the same directory', async ($, on) => {
  await fake($, on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Unfinished', column: 'doing' } as never)
  await $.session.end({ reason: 'exit' } as never)
  const stored = (await $.store.get('board:/work/orbit')) as { carried: { cards: { title: string }[] }[] }
  expect(stored.carried[0]?.cards.map(c => c.title)).toEqual(['Unfinished'])
})
```

- [ ] **Step 2: Run to verify they fail** — `claude plugin test .` — Expected: `hooks.test.ts` fails (no `inbox` action, no `parent`, nothing stored). If the test kit rejects any mocked event name above (`session.id`, `session.root`, `ui.status`, `model.complete`), look it up in `.claude-plugin/types/claude-code/index.d.ts` (`grep -n "'<name>'"`) and match the op's result shape; do not change what the test asserts.

- [ ] **Step 3: Extend state types** — in `types/index.d.ts` add above `declare module`:

```ts
export type View = { kind: 'top' } | { kind: 'goal'; id: string } | { kind: 'carried' } | { kind: 'archive' }
```

and inside `'task-board': { ... }` add:

```ts
      /** Asks waiting for Haiku to file them. */
      inbox: { id: string; text: string }[]
      /** Which board the pane shows. */
      view: View
      /** This directory's carried-over and archived goals, as last read or written. */
      stash: Stash
```

- [ ] **Step 4: Tool schema and `add` with parent** — in `hooks/lib.ts`:

Replace `BoardToolInput` with:

```ts
export type BoardToolInput = { action?: unknown; title?: unknown; note?: unknown; card?: unknown; column?: unknown; parent?: unknown; text?: unknown }
```

Replace `BOARD_TOOL_SCHEMA` with:

```ts
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
```

Replace `BOARD_TOOL_DESCRIPTION` with:

```ts
export const BOARD_TOOL_DESCRIPTION = [
  "The task board in the person's side pane: top goals (To do, Doing, Done), each with its own subtasks.",
  "When the person asks for real work (not a yes/no, a question or a one-word reply), call inbox with their ask: a small model files it as a goal or a subtask. Do not decide where it goes yourself.",
  'Messages the person queues while you work are filed by themselves: do not send them again.',
  'Your own to-do list goes under the goal in Doing by itself: do not add its items again.',
  'Actions: list (cards and ids, subtasks indented), add (title, optional note, column, parent), move (card, column), remove (card, with its subtasks), inbox (text).',
].join(' ')
```

In `boardText`, indent subtasks: replace the inner `...inColumn.map(...)` with:

```ts
...goals(inColumn).flatMap(card => [
  `- [${card.id}] ${card.title}`,
  ...subtasksOf(cards, card.id).map(sub => `    - [${sub.id}] ${sub.title} (${COLUMN_NAME[sub.column]})`),
]),
```

(Subtasks are listed under their goal whatever their own column; `inColumn` counts top goals: change its filter to `card => card.column === column && (card.parentId ?? null) === null`.)

In `runBoardTool`'s `add` case, before `const before = cards.length`, add:

```ts
      let parentId: string | null = null
      if (input.parent !== undefined) {
        if (typeof input.parent !== 'string') return fail('parent is a top goal id or title.')
        const parent = findCard(goals(cards), input.parent)
        if (parent === undefined) return fail(`No top goal "${input.parent}". Use list to see the goals.`)
        parentId = parent.id
      }
```

pass `parentId` in the `addCard` fields, and when `parentId !== null` make the success text `Added "${added.card.title}" under "${cards.find(c => c.id === parentId)!.title}" (${added.card.id}).`. Add a `case 'inbox': return fail('inbox is answered by the hook.')` (register.tsx answers it before `runBoardTool` runs) and update the default message to `'action is list, add, move, remove or inbox.'`.

- [ ] **Step 5: Wire the hooks in `hooks/register.tsx`**

Imports: add `currentGoal, goals, makeGoal, moveUnder, progressOf, subtasksOf` from `./lib`; `EMPTY_STASH, carryOver, expire, fallbackLabel, pullIn, readStash, stashKey` from `./carry`; `FILER_SYSTEM, LABEL_SYSTEM, applyFiling, fallbackFiling, filerPrompt, labelPrompt, parseFiling, parseLabel` from `./filer`; types `Stash, View` from `../types`.

Atoms (after `working`):

```ts
const inbox = atom({ plugin: 'task-board', key: 'inbox' } as const, [] as { id: string; text: string }[])
const view = atom({ plugin: 'task-board', key: 'view' } as const, { kind: 'top' } as View)
const stash = atom({ plugin: 'task-board', key: 'stash' } as const, EMPTY_STASH as Stash)
```

Module helpers (after `setCards`):

```ts
const HAIKU = { model: 'haiku', effort: 'low', timeoutMs: 10_000 } as const

async function sessionId($: EngineInterface): Promise<string> {
  return $.session.id().catch(() => '')
}

/** Shows the ask in the Inbox row, has Haiku file it, and falls back to a goal named by its first line. */
async function fileAsk($: EngineInterface, text: string): Promise<void> {
  const at = await $.clock.now()
  const id = `i${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  await update($, inbox, items => [...items, { id, text }])
  try {
    const board = await read($, cards)
    const reply = await $.model
      .complete({ ...HAIKU, system: FILER_SYSTEM, prompt: filerPrompt(text, board) })
      .catch(() => null)
    const now = await read($, cards)
    const filing = reply?.isAnswered ? parseFiling(reply.text, now) : null
    const sid = await sessionId($)
    await setCards($, current => applyFiling(current, filing ?? fallbackFiling(text), { at, sessionId: sid, byHaiku: filing !== null }), true)
  } finally {
    await update($, inbox, items => items.filter(item => item.id !== id))
  }
}

async function saveStash($: EngineInterface, next: Stash): Promise<void> {
  await update($, stash, () => next)
  await $.store.set(stashKey(await $.session.root()), next).catch(() => {})
}

/** Names unlabelled carried groups with Haiku, one call each; a failed call keeps the fallback label. */
async function relabel($: EngineInterface, current: Stash): Promise<void> {
  let changed = false
  const carried = await Promise.all(
    current.carried.map(async group => {
      if (group.isLabelled) return group
      const reply = await $.model.complete({ ...HAIKU, system: LABEL_SYSTEM, prompt: labelPrompt(group) }).catch(() => null)
      const label = reply?.isAnswered ? parseLabel(reply.text) : null
      if (label === null) return group
      changed = true
      return { ...group, label, isLabelled: true, cards: group.cards.map(card => ({ ...card, sessionLabel: label })) }
    }),
  )
  if (changed) await saveStash($, { ...current, carried })
}
```

In the `session.start` hook, after the tool registers and before `return next(e)`, replace `return next(e)` with:

```ts
    const result = await next(e)
    const root = await $.session.root()
    const stored = readStash(await $.store.get(stashKey(root)).catch(() => undefined))
    const { stash: fresh, moved } = expire(stored, await $.clock.now())
    await saveStash($, fresh)
    if (moved > 0) $.ui.status(`task-board: archived ${moved} old group${moved === 1 ? '' : 's'}`)
    void relabel($, fresh).catch(() => {})

    return result
```

Add a `session.end` hook:

```ts
  on('session.end', async ($, e, next) => {
    const board = await read($, cards)
    const endedAt = await $.clock.now()
    const group = carryOver(board, { sessionId: await sessionId($), label: fallbackLabel(board, endedAt), endedAt })
    if (group !== null) {
      const root = await $.session.root()
      const stored = readStash(await $.store.get(stashKey(root)).catch(() => undefined))
      await $.store.set(stashKey(root), { ...stored, carried: [...stored.carried, group] }).catch(() => {})
    }
    return next(e)
  })
```

Add a `prompt.submit` hook (reads only; passes `e` on unchanged):

```ts
  on('prompt.submit', async ($, e, next) => {
    if (e.turnId !== undefined && !e.text.trimStart().startsWith('/') && e.text.trim() !== '') void fileAsk($, e.text).catch(() => {})
    return next(e)
  })
```

In the `TodoWrite` hook pass the session id: `syncTodos(current, e.todos, at, sid)` with `const sid = await sessionId($)` before `setCards`; same for `taskCreated(..., at, sid)`.

In the board tool hook, before `runBoardTool`, add:

```ts
    if ((e as unknown as BoardToolInput).action === 'inbox') {
      const text = (e as unknown as BoardToolInput).text
      if (typeof text !== 'string' || text.trim() === '') return { result: 'inbox needs text.', text: 'inbox needs text.', isError: true as const }
      void fileAsk($, text).catch(() => {})
      return { result: 'Sent to the inbox.', text: 'Sent to the inbox.' }
    }
```

- [ ] **Step 6: Run the suite** — `claude plugin test .` — Expected: all pass. If `fileAsk` has not finished when a test reads the board, the test's `$.clock.advance(10)` should settle it; if the kit settles fire-and-forget work differently, replace the advance with `await $.clock.sleep(0)` in the test, not the code.

---

### Task 5: Pane — goal drill-down, carried over, archive, inbox row, corrections

**Files:**
- Modify: `hooks/register.tsx` (the `ui.render` Pane hook)
- Test: `tests/pane.test.ts` (create)

**Interfaces:**
- Consumes: atoms `view`, `inbox`, `stash`; `goals`, `subtasksOf`, `progressOf`, `makeGoal`, `moveUnder`, `pullIn`, `daysLeft`.

Design note: on the desktop/terminal the columns are a `Client` that sends `open` on click; clicking a card keeps opening its details. The details of a top goal gain **Subtasks ›** (switches to the goal view). This is how "Enter or click opens the goal" lands with the draggable columns.

- [ ] **Step 1: Write the failing tests** — `tests/pane.test.ts`. Reuse the `fake` helper from `tests/hooks.test.ts` by moving it to `tests/fake.ts` (export it) and importing it in both files. Mount on `vscode` (plain columns, as `task-board.test.ts` does) and loop `['terminal', 'desktop']` only for the views that do not draw columns:

```ts
import { expect, test } from 'claude-code/testing'

import { fake } from './fake'

const TOOL = 'mcp__task-board__board'
const PANE = (surface: 'vscode' | 'terminal' | 'desktop') =>
  ({
    plugin: 'task-board',
    component: 'Pane',
    requestId: 'task-board',
    surface,
    props: { title: 'Board', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  }) as const

test('a top goal shows its subtask count and opens into its own board', async ($, on) => {
  await fake($, on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Goal', column: 'doing' } as never)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Step A', parent: 'Goal' } as never)
  const ui = await $.ui.mount(PANE('vscode') as never)
  expect(await ui.find({ type: 'Text', text: /▸ 0\/1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Step A/ })).toBeUndefined()
  const open = (await ui.findAll({ type: 'Button' })).find(b => /Open/.test(String(b.label)))!
  await ui.press(open.key!)
  await ui.press('subtasks')
  expect(await ui.find({ type: 'Text', text: /Step A/ })).toBeDefined()
  await ui.press('back')
  expect(await ui.find({ type: 'Text', text: /Step A/ })).toBeUndefined()
  await ui.unmount()
})

test('carried over opens, lists groups and pulls a goal in', async ($, on) => {
  await fake($, on)
  await $.store.set('board:/work/orbit', {
    carried: [
      {
        sessionId: 's0',
        label: 'Old session work',
        isLabelled: true,
        endedAt: Date.parse('2026-10-12T10:00:00Z'),
        cards: [{ id: 'g0', title: 'Leftover', note: '', column: 'doing', source: 'claude', ref: null, createdAt: 0, parentId: null, sessionId: 's0', sessionLabel: 'Old session work', carriedAt: 1, filedBy: null }],
      },
    ],
    archive: [],
  })
  await $.session.start({ cwd: '/work/orbit', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(PANE(surface) as never)
    if (surface === 'terminal') {
      await ui.press('carried')
      expect(await ui.find({ type: 'Text', text: /Old session work/ })).toBeDefined()
      await ui.press('pull:g0')
      await ui.press('back')
    }
    expect(await ui.find({ type: 'Text', text: /Carried over/ })).toBeUndefined()
    await ui.unmount()
  }
  expect(String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)).toContain('Leftover')
})
```

- [ ] **Step 2: Run to verify they fail** — Expected: no `subtasks`/`back`/`carried`/`pull:g0` keys, no `▸ 0/1`.

- [ ] **Step 3: Implement the views** in the Pane `ui.render` hook:

1. Read `const where = await read($, view)`, `const pending = await read($, inbox)`, `const kept = await read($, stash)`.
2. **Card set per view:** `const shownCards = where.kind === 'goal' ? subtasksOf(board, where.id) : goals(board)`. Use `shownCards` everywhere the hook used `board` for columns, counts, the progress bar and `columnsProps` (the progress bar therefore counts top goals at the top level and subtasks inside a goal). If `where.kind === 'goal'` and the goal no longer exists, `await update($, view, () => ({ kind: 'top' }))` and draw the top level.
3. **Count on top cards:** in `cardView` and in `columnsProps.cards[].tag`, when `where.kind === 'top'` and `progressOf(board, card.id).total > 0`, append `` ` ▸ ${p.done}/${p.total}` `` to the tag; append ` ✧` when `card.filedBy === 'haiku'`.
4. **Header rows** (above the existing `header`):
   - At the top level, when `kept.carried.length > 0`: a row with `<Button key="carried" label={`↺ Carried over (${count}) ›`} plain onPress={() => void update($, view, () => ({ kind: 'carried' }))} />`, `count` = number of top goals across carried groups; and when `kept.archive.length > 0`, `<Button key="archive" label="▤ Archive" plain dimColor onPress={() => void update($, view, () => ({ kind: 'archive' }))} />`.
   - In the goal view: `<Button key="back" label="‹ Back" plain onPress={() => void update($, view, () => ({ kind: 'top' }))} />` then the goal's title bold and `done/total` dim.
   - When `pending.length > 0`, at every level: `<Text dimColor wrap="truncate-end">{`✉ Inbox: "${pending[0].text.slice(0, 40)}" …filing${pending.length > 1 ? ` (+${pending.length - 1})` : ''}`}</Text>`.
5. **Carried / archive views** (return early, instead of the columns): a `‹ Back` button (key `back`, to `top`), a title (`Carried over` / `Archive`), then per group a row `↺ <Mon D> · <label> (<n>)`, plus `· <daysLeft> days left` in the carried view (format the date as `fallbackLabel` does: reuse it with an empty board, `fallbackLabel([], group.endedAt)`), and under it each top goal of the group: title and `<Button key={`pull:${goal.id}`} label="Pull in" variant="secondary" onPress={() => void pull(goal.id)} />`.
   `pull` is a local async function: `const out = pullIn(await read($, stash), await read($, cards), id); await setCards($, () => out.cards, false); await saveStash($, out.stash)`. With nothing left in the view's list, draw `Text dimColor` `Nothing here.`
6. **Details corrections** (in `details(card)`): when `card.parentId === null` add `<Button key="subtasks" label="Subtasks ›" variant="secondary" onPress={() => void update($, view, () => ({ kind: 'goal', id: card.id })).then(() => select($, null))} />`. When `card.parentId !== null` add `<Button key="make-goal" label="Make goal" plain dimColor onPress={() => void setCards($, c => makeGoal(c, card.id), false)} />`. For **Move under…**, when the table has a `Select` (`'Select' in table`), add `<Select key="move-under" label="Move under" options={goals(board).filter(g => g.id !== card.id).map(g => ({ value: g.id, label: g.title }))} onChange={value => void setCards($, c => moveUnder(c, card.id, value), false)} />`; check `Select`'s prop names in `.claude-plugin/types/claude-code/index.d.ts` (`grep -n "Select: {" -A30`) and match them exactly.
7. **New card in a goal view:** in `saveComposer`, when the view is `goal`, pass `parentId: where.id` to `addCard`.
8. **Esc:** if the pane exposes an Escape/close event the hook already handles, make Esc in `goal`/`carried`/`archive` set `view` to `top` instead; if not, the `‹ Back` button is the way up (do not add a keybinding).

- [ ] **Step 4: Run the suite** — `claude plugin test .` — Expected: all pass, including the 14 original tests (update any that assert the progress text `N of M done` to count top goals only).

---

### Task 6: Validate, type-check, docs

**Files:**
- Modify: `README.md`, `.claude-plugin/plugin.json` (description, version `0.2.0`)
- Modify: `~/.claude/projects/-home-aidannunn-Work/memory/feedback-task-board-queue.md`

- [ ] **Step 1:** `claude plugin validate .` — Expected: no errors. Fix any `$.state` key not declared in `types/index.d.ts`.
- [ ] **Step 2:** `tsc -p .` — Expected: no errors.
- [ ] **Step 3:** `claude plugin test .` — Expected: all pass. Record the count.
- [ ] **Step 4:** `plugin.json` description: `"Two-level task board in a side pane: goals with their own To do / Doing / Done subtasks, a Haiku-filed inbox for your asks, and unfinished goals carried over per directory (14-day archive)"`, version `0.2.0`. Add a README section "Goals, inbox, carry-over" with three short paragraphs matching the spec.
- [ ] **Step 5:** Update the memory `feedback-task-board-queue.md` How-to-apply: queued messages are filed automatically; for other real asks call the board tool's `inbox` action with the ask text and do not decide placement; to-do items nest under the goal in Doing by themselves.
- [ ] **Step 6:** Tell the user to run `/reload-plugins` and `/board`, then check: drill into a goal and back; a queued message appears in the Inbox row and lands filed; `/clear` then `/board` shows Carried over.
