import { atom, read, update } from 'claude-code'
import type { EngineInterface, Next, PaneCloseInput, Register } from 'claude-code'

import type { Card, Column, InboxItem, Stash, View } from '../types'
import {
  BOARD_TOOL_DESCRIPTION,
  BOARD_TOOL_SCHEMA,
  COLUMNS,
  COLUMN_NAME,
  DONE_SHOWN,
  addCard,
  currentGoal,
  editCard,
  goals,
  makeGoal,
  moveCard,
  moveUnder,
  neighbour,
  planSteps,
  progressOf,
  removeCard,
  runBoardTool,
  sourceName,
  subtasksOf,
  syncTodos,
  taskCreated,
  taskUpdated,
  workPrompt,
} from './lib'
import type { BoardToolInput } from './lib'
import { columnsHeightFor } from './columns'
import type { ColumnsMessage, ColumnsProps } from './columns'
import { EMPTY_STASH, carryOver, daysLeft, expire, fallbackLabel, pullIn, readStash, stashKey, storedGoalKey } from './carry'
import type { StoredGoal } from './carry'
import { FILER_SYSTEM, LABEL_SYSTEM, applyFiling, fallbackFiling, filerPrompt, labelPrompt, parseFiling, parseLabel } from './filer'
import { labelsChanged, runningLabels, startLabels, stopLabels } from './labels'

const PANE = 'task-board'
const TITLE = 'Board'
const TOOL = 'board'
// Theme colors follow the light or dark scheme by themselves; the green is one that reads on both.
const ACCENT = 'claude'
const GREEN = '#2da44e'
/** Each column's dot. */
const DOT: Record<Column, { color?: string }> = { todo: {}, doing: { color: ACCENT }, done: { color: GREEN } }
/** The mark in a card's footer: who put it there (✦ Claude, ◆ a plan); the card's details say it in words. */
const TAG: Record<Card['source'], string> = { you: '', todo: '✦', claude: '✦', plan: '◆' }
/** Rows above the columns (the progress row and the blank under it) and below them (the pane's last blank). */
const HEADER_ROWS = 3
/** Cells in the progress bar. */
const BAR = 12

const cards = atom({ plugin: 'task-board', key: 'cards' } as const, [])
const selected = atom({ plugin: 'task-board', key: 'selected' } as const, null)
const composer = atom({ plugin: 'task-board', key: 'composer' } as const, null)
const working = atom({ plugin: 'task-board', key: 'working' } as const, null)
const inbox = atom({ plugin: 'task-board', key: 'inbox' } as const, [] as InboxItem[])
const view = atom({ plugin: 'task-board', key: 'view' } as const, { kind: 'top' } as View)
const stash = atom({ plugin: 'task-board', key: 'stash' } as const, EMPTY_STASH as Stash)
const sessionLabel = atom({ plugin: 'task-board', key: 'sessionLabel' } as const, null)

/** The board's full tool name, as Claude calls it: `mcp__task-board__board`, else what registering answered. */
let toolName = `mcp__task-board__${TOOL}`

/** Writes against the latest board and clears UI state invalidated by the mutation. */
async function setCards($: EngineInterface, next: (current: Card[]) => Card[], isClaude: boolean): Promise<void> {
  // Evaluate against the atom's current value so simultaneous filings do not overwrite each other.
  await update($, cards, current => next(current))
  const board = await read($, cards)
  let where = await read($, view)
  const goalId = where.kind === 'goal' ? where.id : null
  if (goalId !== null && !goals(board).some(card => card.id === goalId)) {
    await update($, view, (current): View => current.kind === 'goal' && !goals(board).some(card => card.id === current.id) ? { kind: 'top' } : current)
    await update($, selected, () => null)
    await update($, composer, () => null)
    where = await read($, view)
  }
  const visible = where.kind === 'goal' ? subtasksOf(board, where.id) : where.kind === 'top' ? goals(board) : []
  const openId = await read($, selected)
  if (openId !== null && !visible.some(card => card.id === openId)) await update($, selected, current => current === openId ? null : current)
  const draft = await read($, composer)
  if (draft?.id != null && !visible.some(card => card.id === draft.id)) await update($, composer, current => current?.id === draft.id ? null : current)
  // Opens only on /board (local change: the upstream mod opened the pane on Claude's first cards).
}

const HAIKU = { model: 'haiku', effort: 'low', timeoutMs: 10_000 } as const

async function sessionId($: EngineInterface): Promise<string> {
  return $.session.id().catch(() => '')
}

/** A queue per registration; failures do not poison subsequent mutations. */
function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T,>(run: () => Promise<T>): Promise<T> => {
    const result = tail.then(run)
    tail = result.catch(() => {})
    return result
  }
}

type Serial = ReturnType<typeof serialQueue>
type InboxActions = { serial: Serial; running: Set<string> }

async function resumeAsk($: EngineInterface, item: InboxItem, actions: InboxActions): Promise<void> {
  if (actions.running.has(item.id)) return
  actions.running.add(item.id)
  try {
    const at = item.createdAt ?? await $.clock.now()
    const sid = item.sessionId ?? await sessionId($)
    if (!(await read($, inbox)).some(pending => pending.id === item.id)) return
    const board = await read($, cards)
    const reply = await $.model.complete({ ...HAIKU, system: FILER_SYSTEM, prompt: filerPrompt(item.text, board) }).catch(() => null)
    await actions.serial(async () => {
      // session.end may already have consumed this item as a fallback goal.
      if (!(await read($, inbox)).some(pending => pending.id === item.id)) return
      await setCards($, current => {
        let filing = reply?.isAnswered ? parseFiling(reply.text, current) : null
        if (filing?.kind === 'subtask') {
          const parentId = filing.parentId
          const original = board.find(card => card.id === parentId)
          const live = current.find(card => card.id === parentId)
          // Validate both the reply's id and the lifetime that Haiku saw.
          if (original === undefined || live === undefined || original.incarnation !== live.incarnation
            || (original.incarnation === undefined && (original.createdAt !== live.createdAt || original.sessionId !== live.sessionId || original.title !== live.title))) filing = null
        }
        return applyFiling(current, filing ?? fallbackFiling(item.text), { at, sessionId: sid, byHaiku: filing !== null, inboxId: item.id })
      }, true)
      await update($, inbox, items => items.filter(pending => pending.id !== item.id))
    })
  } finally {
    actions.running.delete(item.id)
  }
}

async function fileAsk($: EngineInterface, text: string, actions: InboxActions): Promise<void> {
  const at = await $.clock.now()
  const item = { id: `i${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, createdAt: at }
  await actions.serial(() => update($, inbox, items => [...items, item]))
  void resumeAsk($, item, actions).catch(() => {})
}

async function recoverInbox($: EngineInterface, actions: InboxActions): Promise<void> {
  for (const item of await read($, inbox)) void resumeAsk($, item, actions).catch(() => {})
}

async function endingBoard($: EngineInterface, sid: string, at: number, actions: InboxActions): Promise<Card[]> {
  return actions.serial(async () => {
    const pending = await read($, inbox)
    // No model wait: carry every pending ask as a first-line, 60-character top goal.
    await setCards($, current => pending.reduce((board, item) => applyFiling(board, fallbackFiling(item.text), {
      at: item.createdAt ?? at, sessionId: item.sessionId ?? sid, byHaiku: false, inboxId: item.id,
    }), current), true)
    await update($, inbox, items => items.filter(item => !pending.some(taken => taken.id === item.id)))
    return read($, cards)
  })
}

async function mutateStash($: EngineInterface, next: (current: Stash) => Promise<Stash>, serial: Serial): Promise<Stash> {
  return serial(async () => {
    const key = stashKey(await $.session.root())
    // Storage is authoritative; compute each operation only after its predecessor committed.
    const latest = readStash(await $.store.get(key))
    const fresh = await next(latest)
    if (fresh !== latest) await $.store.set(key, fresh)
    await update($, stash, () => fresh)
    return fresh
  })
}

async function relabel($: EngineInterface, current: Stash, serial: Serial): Promise<void> {
  for (const group of [...current.carried, ...current.archive]) {
    if (group.isLabelled) continue
    const reply = await $.model.complete({ ...HAIKU, system: LABEL_SYSTEM, prompt: labelPrompt(group) }).catch(() => null)
    const label = reply?.isAnswered ? parseLabel(reply.text) : null
    if (label === null) continue
    const name = (groups: Stash['carried']) => groups.map(g => g.sessionId === group.sessionId && g.endedAt === group.endedAt
      ? { ...g, label, isLabelled: true, cards: g.cards.map(card => ({ ...card, sessionLabel: label })) } : g)
    await mutateStash($, async latest => ({ carried: name(latest.carried), archive: name(latest.archive) }), serial)
  }
}

async function loadStash($: EngineInterface, serial: Serial): Promise<void> {
  let moved = 0
  const fresh = await mutateStash($, async latest => {
    const expired = expire(latest, await $.clock.now())
    moved = expired.moved
    return expired.stash
  }, serial)
  if (moved > 0) $.ui.status(`task-board: archived ${moved} old group${moved === 1 ? '' : 's'}`)
  void relabel($, fresh, serial).catch(() => {})
}

/** Opens the composer: empty for a new card, or holding `card` to edit it. */
async function compose($: EngineInterface, card: Card | null): Promise<void> {
  await update($, composer, () =>
    card === null
      ? { id: null, title: '', note: '', hasNote: false }
      : { id: card.id, title: card.title, note: card.note, hasNote: false },
  )
  await $.ui.focus({ requestId: PANE, key: 'title' }).catch(() => undefined)
}

/** Swaps the Title field for the Description field, and moves the cursor into it. */
async function showNote($: EngineInterface): Promise<void> {
  await update($, composer, current => (current === null ? current : { ...current, hasNote: true }))
  await $.ui.focus({ requestId: PANE, key: 'note' }).catch(() => undefined)
}

/** Back to the Title field. */
async function showTitle($: EngineInterface): Promise<void> {
  await update($, composer, current => (current === null ? current : { ...current, hasNote: false }))
  await $.ui.focus({ requestId: PANE, key: 'title' }).catch(() => undefined)
}

async function typeIn($: EngineInterface, field: 'title' | 'note', text: string): Promise<void> {
  await update($, composer, current => (current === null ? current : { ...current, [field]: text }))
}

/** Saves what the composer holds: a new card in To do, or the edited card; then closes it. */
async function saveComposer($: EngineInterface): Promise<void> {
  const draft = await read($, composer)
  if (draft === null) return
  if (draft.title.trim() === '') {
    $.ui.toast('Give the card a title.')
    await $.ui.focus({ requestId: PANE, key: 'title' }).catch(() => undefined)
    return
  }
  const at = await $.clock.now()
  const id = draft.id
  const where = await read($, view)
  const sid = await sessionId($)
  await setCards(
    $,
    current =>
      id === null
        ? addCard(current, { title: draft.title, note: draft.note, source: 'you', parentId: where.kind === 'goal' ? where.id : null, sessionId: sid }, at).cards
        : editCard(current, id, { title: draft.title, note: draft.note }),
    false,
  )
  await update($, composer, () => null)
}

async function select($: EngineInterface, id: string | null): Promise<void> {
  await update($, selected, current => (current === id ? null : id))
}

async function move($: EngineInterface, id: string, column: Column): Promise<void> {
  await setCards($, current => moveCard(current, id, column), false)
}

async function remove($: EngineInterface, id: string): Promise<void> {
  await setCards($, current => removeCard(current, id), false)
  if ((await read($, selected)) === id) await update($, selected, () => null)
}

/**
 * Hands Claude a card: the card moves to Doing and Claude gets a prompt to
 * work on it. Claude Code holds a prompt a mod sends until Claude is idle, so
 * a toast says when it waits.
 */
async function workOn($: EngineInterface, card: Card): Promise<void> {
  if ((await read($, working)) === card.id) {
    $.ui.toast('Claude already has this card.')
    return
  }
  await update($, working, () => card.id)
  await move($, card.id, 'doing')
  let isStarted = false
  const submitted = $.prompt.submit({ text: workPrompt(card) }).then(
    result => {
      isStarted = result.drop === undefined
    },
    () => {
      isStarted = false
    },
  )
  let isSettled = false
  void submitted.then(() => {
    isSettled = true
  })
  await Promise.race([submitted, $.clock.sleep(500)])
  if (!isSettled) $.ui.toast('Queued: Claude starts on this card once it finishes the current task.', { timeoutMs: 8_000 })
  await submitted
  if (!isStarted && (await read($, working)) === card.id) {
    await update($, working, () => null)
    $.ui.toast('The card was not handed to Claude.')
  }
}

/** Person closes navigate up; plugin closes always continue to the engine. */
export async function closePane($: EngineInterface, e: PaneCloseInput, next: Next<'ui.close'>) {
  if (e.id !== PANE || e.origin.kind !== 'person') return next(e)
  const where = await read($, view)
  if (where.kind === 'carried' || where.kind === 'archive') {
    await update($, selected, () => null)
    await update($, composer, () => null)
    await update($, view, (): View => ({ kind: 'top' }))
    return { value: undefined }
  }
  if ((await read($, composer)) !== null) {
    await update($, composer, () => null)
    return { value: undefined }
  }
  if ((await read($, selected)) !== null) {
    await update($, selected, () => null)
    return { value: undefined }
  }
  if (where.kind !== 'top') {
    await update($, view, (): View => ({ kind: 'top' }))
    return { value: undefined }
  }
  return next(e)
}

export const register: Register = on => {
  const stashSerial = serialQueue()
  const filing: InboxActions = { serial: serialQueue(), running: new Set() }
  const labels = runningLabels()
  on('state.set', { plugin: 'task-board', key: 'cards' }, async ($, e, next) => {
    const result = await next(e)
    if (result.value?.isSet) await labelsChanged($, labels).catch(() => {})
    return result
  })
  on('session.start', async ($, e, next) => {
    startLabels(labels)
    await $.command.register({ name: 'board', description: "Show the session's task board: To do, Doing and Done", immediate: true }).catch(() => {}) // the built-in /tasks refuses the old name
    const registered = await $.tool.register({ name: TOOL, description: BOARD_TOOL_DESCRIPTION, inputSchema: BOARD_TOOL_SCHEMA })
    toolName = registered.tool

    const result = await next(e)
    await loadStash($, stashSerial)
    await recoverInbox($, filing)
    await labelsChanged($, labels, true).catch(() => {})
    return result
  })

  on('session.end', async ($, e, next) => {
    // Neither draining the inbox nor a pending trailing label can start a model call at end.
    stopLabels(labels, e.sessionId)
    const endedAt = await $.clock.now()
    await mutateStash($, async latest => {
      const board = await endingBoard($, e.sessionId, endedAt, filing)
      // A live-first pull can have an unacknowledged store write. Remove those
      // sources in the same persisted mutation that carries the live board.
      const transfers = new Set(board.flatMap(card => card.pulledFrom === undefined ? [] : [card.pulledFrom]))
      const acknowledge = (groups: Stash['carried'], list: StoredGoal['list']) => groups.map(group => {
        const taken = new Set(goals(group.cards).filter(card => transfers.has(storedGoalKey({ list, sessionId: group.sessionId, endedAt: group.endedAt, id: card.id }))).map(card => card.id))
        return { ...group, cards: group.cards.filter(card => !taken.has(card.id) && !taken.has(card.parentId ?? '')) }
      }).filter(group => group.cards.length > 0)
      const acknowledged = { carried: acknowledge(latest.carried, 'carried'), archive: acknowledge(latest.archive, 'archive') }
      const label = await read($, sessionLabel)
      const group = carryOver(board, { sessionId: e.sessionId, label: label ?? fallbackLabel(board, endedAt), endedAt })
      if (group !== null) group.isLabelled = label !== null
      return group === null && transfers.size === 0 ? latest : { ...acknowledged, carried: [...acknowledged.carried, ...(group === null ? [] : [group])] }
    }, stashSerial)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.turnId !== undefined && !e.text.trimStart().startsWith('/') && e.text.trim() !== '') await fileAsk($, e.text, filing).catch(() => {})
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    // Run again to close.
    if ((await $.ui.panes()).some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: 'Board closed.' }
    }
    // /clear changes session id without emitting session.start; /board reloads the directory stash.
    await loadStash($, stashSerial)
    await $.ui.open({ id: PANE, title: TITLE, closeOnEscape: true })

    return { text: 'Board opened.' }
  })

  on('ui.close', closePane)

  // Claude's to-do list, in either of the tools it keeps it with.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const at = await $.clock.now()
      const sid = await sessionId($)
      await setCards($, current => syncTodos(current, e.todos, at, sid), true)
    }

    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const task = (ran.result as { task?: { id?: unknown } } | undefined)?.task
    if (ran.deny === undefined && ran.isError !== true && typeof task?.id === 'string') {
      const at = await $.clock.now()
      const id = task.id
      const sid = await sessionId($)
      await setCards($, current => taskCreated(current, { id, subject: e.subject, description: e.description }, at, sid), true)
    }

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const sid = await sessionId($)
      await setCards(
        $,
        current =>
          taskUpdated(current, {
            taskId: e.taskId,
            ...(e.status === undefined ? {} : { status: e.status }),
            ...(e.subject === undefined ? {} : { subject: e.subject }),
            ...(e.description === undefined ? {} : { description: e.description }),
          }, sid),
        true,
      )
    }

    return ran
  })

  // Concrete approved-plan steps belong to the active goal, else Session.
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    const plan = (ran.result as { plan?: unknown } | undefined)?.plan
    if (ran.deny === undefined && ran.isError !== true && typeof plan === 'string') {
      const at = await $.clock.now()
      const sid = await sessionId($)
      await setCards(
        $,
        current => {
          const steps = planSteps(plan)
          if (steps.length === 0) return current
          const goal = currentGoal(current, at, sid)
          return steps.reduce((board, step) => addCard(board, { title: step, source: 'plan', parentId: goal.id, sessionId: sid }, at).cards, goal.cards)
        },
        true,
      )
    }

    return ran
  })

  // The board tool Claude calls: answered here, never passed on.
  on('tool.call', async ($, e, next) => {
    if (e.tool !== toolName) return next(e)
    const input = e as unknown as BoardToolInput
    if (input.action === 'inbox') {
      const text = input.text
      if (typeof text !== 'string' || text.trim() === '') return { result: 'inbox needs text.', text: 'inbox needs text.', isError: true as const }
      if (text.trimStart().startsWith('/')) return { result: 'Slash commands are not inbox asks.', text: 'Slash commands are not inbox asks.', isError: true as const }
      await fileAsk($, text, filing)
      return { result: 'Sent to the inbox.', text: 'Sent to the inbox.' }
    }
    const at = await $.clock.now()
    const sid = await sessionId($)
    let outcome = runBoardTool(await read($, cards), input, at, sid)
    await setCards($, current => {
      outcome = runBoardTool(current, input, at, sid)
      return outcome.cards
    }, true)

    // A registered tool's result is text: what Claude reads back.
    return outcome.isError === true
      ? { result: outcome.text, text: outcome.text, isError: true as const }
      : { result: outcome.text, text: outcome.text }
  })

  // The draggable columns: a card dropped on another column, or clicked to open it.
  on('ui.message', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const data = e.data as Partial<ColumnsMessage> | null
    const id = typeof data?.id === 'string' ? data.id : null
    if (id === null || !(await read($, cards)).some(card => card.id === id)) return {}
    if (data?.type === 'open') await select($, id)
    if (data?.type === 'details') await update($, selected, () => id)
    if (data?.type === 'enter') {
      const card = (await read($, cards)).find(card => card.id === id)!
      if ((card.parentId ?? null) === null) {
        await update($, selected, () => null)
        await update($, composer, () => null)
        await update($, view, (): View => ({ kind: 'goal', id }))
      } else await update($, selected, () => id)
    }
    if (data?.type === 'move' && typeof data.column === 'number') {
      const column = COLUMNS[data.column]
      if (column !== undefined) await move($, id, column)
    }

    return {}
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // The turn Work on it started has ended: the card is Claude's no longer.
    if (e.agentId === undefined && (await read($, working)) !== null) await update($, working, () => null)

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    const Input = 'Input' in table ? table.Input : undefined
    const Select = 'Select' in table ? table.Select : undefined
    // The desktop app and the terminal draw a Client; VS Code's table lists one but draws none.
    const Client = (e.surface === 'desktop' || e.surface === 'terminal') && 'Client' in table ? table.Client : undefined
    const board = await read($, cards)
    let where = await read($, view)
    const pending = await read($, inbox)
    const kept = await read($, stash)
    const goal = where.kind === 'goal' ? goals(board).find(card => card.id === (where as { id: string }).id) : undefined
    if (where.kind === 'goal' && goal === undefined) {
      where = { kind: 'top' }
    }
    const back = async () => {
      await update($, selected, () => null)
      await update($, composer, () => null)
      await update($, view, () => ({ kind: 'top' }))
    }
    const inboxRow = pending.length === 0 ? null : (
      <Text dimColor wrap="truncate-end">{`✉ Inbox: "${pending[0]!.text.slice(0, 40)}" …filing${pending.length > 1 ? ` (+${pending.length - 1})` : ''}`}</Text>
    )
    if (where.kind === 'carried' || where.kind === 'archive') {
      const groups = where.kind === 'carried' ? kept.carried : kept.archive
      const now = await $.clock.now()
      const list = where.kind
      const pull = async (target: StoredGoal) => {
        await mutateStash($, async latest => {
          let fresh = latest
          await setCards($, current => {
            const out = pullIn(latest, current, target)
            fresh = out.stash
            return out.cards
          }, false)
          return fresh
        }, stashSerial)
      }
      return (
        <Box flexDirection="column" paddingBottom={1} rowGap={1}>
          <Box flexDirection="row" columnGap={1}>
            <Button key="back" label="‹ Back" plain onPress={() => void back()} />
            <Text bold>{where.kind === 'carried' ? 'Carried over' : 'Archive'}</Text>
          </Box>
          {inboxRow}
          {groups.map(group => (
            <Box key={`group:${group.sessionId}:${group.endedAt}`} flexDirection="column" rowGap={1}>
              <Text dimColor>{`↺ ${fallbackLabel([], group.endedAt)} · ${group.label} (${goals(group.cards).length})${where.kind === 'carried' ? ` · ${daysLeft(group, now)} days left` : ''}`}</Text>
              {goals(group.cards).map(card => (
                <Box key={`stored:${storedGoalKey({ list, sessionId: group.sessionId, endedAt: group.endedAt, id: card.id })}`} flexDirection="row" justifyContent="space-between" columnGap={1}>
                  <Text wrap="wrap">{card.title}</Text>
                  <Button key={`pull:${storedGoalKey({ list, sessionId: group.sessionId, endedAt: group.endedAt, id: card.id })}`} label="Pull in" variant="secondary" onPress={() => void pull({ list, sessionId: group.sessionId, endedAt: group.endedAt, id: card.id }).catch(() => { $.ui.toast('Pull in persistence failed; the live transfer will be retried at session end.') })} />
                </Box>
              ))}
            </Box>
          ))}
          {groups.length === 0 && <Text dimColor>Nothing here.</Text>}
        </Box>
      )
    }
    const shownCards = where.kind === 'goal' ? subtasksOf(board, where.id) : goals(board)
    const goalProgress = goal === undefined ? null : progressOf(board, goal.id)
    const navigation = where.kind === 'goal' && goal !== undefined ? (
      <Box flexDirection="row" columnGap={1}>
        <Button key="back" label="‹ Back" plain onPress={() => void back()} />
        <Text bold wrap="truncate-end">{goal.title}</Text>
        <Text dimColor>{`${goalProgress!.done}/${goalProgress!.total}`}</Text>
      </Box>
    ) : (
      <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
        {kept.carried.length > 0 && <Button key="carried" label={`↺ Carried over (${kept.carried.reduce((n, group) => n + goals(group.cards).length, 0)}) ›`} plain onPress={() => void update($, view, () => ({ kind: 'carried' }))} />}
        {kept.archive.length > 0 && <Button key="archive" label="▤ Archive" plain dimColor onPress={() => void update($, view, () => ({ kind: 'archive' }))} />}
        <Button key="reload" label="↻ Reload" plain dimColor onPress={() => void loadStash($, stashSerial)} />
      </Box>
    )
    const openId = await read($, selected)
    const writing = await read($, composer)
    const saveLabel = writing?.id == null ? 'Add card' : 'Save'
    const busy = await read($, working)
    const open = shownCards.find(card => card.id === openId)
    const cardTag = (card: Card, includeNote = true) => {
      const p = progressOf(board, card.id)
      return `${card.id === busy ? '◐' : TAG[card.source]}${includeNote && card.note !== '' ? ' ≡' : ''}${where.kind === 'top' ? ` ▸ ${p.done}/${p.total}` : ''}${card.filedBy === 'haiku' ? ' ✧' : ''}`.trim()
    }

    const cardView = (card: Card) => {
      const isOpen = card.id === openId
      const isBusy = card.id === busy
      const isDone = card.column === 'done'
      const next = neighbour(card.column, 1)
      const tag = cardTag(card, false)
      return (
        <Box
          key={`card:${card.id}`}
          flexDirection="column"
          borderStyle="round"
          {...(isOpen || isBusy ? { borderColor: ACCENT } : { borderDimColor: true })}
          hover={{ borderColor: ACCENT }}
          paddingX={1}
        >
          <Text wrap="wrap" dimColor={isDone}>
            {isDone ? `✓ ${card.title}` : card.title}
          </Text>
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Box flexDirection="row" columnGap={1}>
              <Text {...(isBusy ? { color: ACCENT } : { dimColor: true })} wrap="truncate-end">{tag}</Text>
              {card.note !== '' && <Text dimColor>≡</Text>}
            </Box>
            <Box flexDirection="row" columnGap={1}>
              <Button key={`open:${card.id}`} label={isOpen ? 'Close' : 'Open'} plain dimColor onPress={() => void select($, card.id)} />
              {next !== null && (
                <Button key={`next:${card.id}`} label="›" plain dimColor onPress={() => void move($, card.id, next)} />
              )}
            </Box>
          </Box>
        </Box>
      )
    }

    // The cards as the draggable columns draw them, column by column, Done's latest first.
    const shownIn = (column: Column) => {
      const inColumn = shownCards.filter(card => card.column === column)
      return column === 'done' ? inColumn.slice(-DONE_SHOWN).reverse() : inColumn
    }
    const columnsProps: ColumnsProps = {
      view: where.kind === 'goal' ? `goal:${where.id}` : where.kind,
      cards: COLUMNS.flatMap((column, index) =>
        shownIn(column).map(card => ({
          id: card.id,
          title: card.title,
          column: index,
          tag: cardTag(card),
          isDone: column === 'done',
          isOpen: card.id === openId,
          isBusy: card.id === busy,
        })),
      ),
      names: COLUMNS.map(column => COLUMN_NAME[column]),
      counts: COLUMNS.map(column => shownCards.filter(card => card.column === column).length),
      dots: COLUMNS.map(column => DOT[column].color ?? null),
    }

    // The columns fill the pane below the header, so a card can be dragged anywhere under them; with a
    // card's details or the composer open, they keep their own height and those sit right under them.
    const contentRows = columnsHeightFor(columnsProps.cards, e.props.bodyColumns)
    const fillRows = e.props.scroll.bodyRows - HEADER_ROWS - (navigation === null ? 0 : 1) - (inboxRow === null ? 0 : 1)
    const columnsHeight = open !== undefined || writing !== null ? contentRows : Math.max(contentRows, fillRows)

    const columnView = (column: Column) => {
      const inColumn = shownCards.filter(card => card.column === column)
      // Done keeps the latest few: the column that only grows.
      const shown = column === 'done' ? inColumn.slice(-DONE_SHOWN).reverse() : inColumn
      return (
        <Box key={`column:${column}`} flexDirection="column" width="33%" flexShrink={1} rowGap={1}>
          <Box flexDirection="row" columnGap={1}>
            <Text {...DOT[column]} dimColor={DOT[column].color === undefined}>
              ●
            </Text>
            <Text bold>{COLUMN_NAME[column]}</Text>
            <Text dimColor>{String(inColumn.length)}</Text>
          </Box>
          {shown.map(cardView)}
          {shown.length === 0 && (
            <Box borderStyle="round" borderDimColor paddingX={1}>
              <Text dimColor>No cards</Text>
            </Box>
          )}
          {inColumn.length > shown.length && <Text dimColor>{`+${inColumn.length - shown.length} earlier`}</Text>}
        </Box>
      )
    }

    // How far along the board is: the done cards of all.
    const doneCount = shownCards.filter(card => card.column === 'done').length
    const filled = shownCards.length === 0 ? 0 : Math.round((doneCount / shownCards.length) * BAR)
    const newCard =
      Input === undefined || writing !== null ? null : (
        <Button key="new" label="+ New card" variant="secondary" onPress={() => void compose($, null)} />
      )
    const progress = (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Box flexDirection="row">
          {filled > 0 && <Text color={GREEN}>{'■'.repeat(filled)}</Text>}
          {filled < BAR && <Text dimColor>{'□'.repeat(BAR - filled)}</Text>}
        </Box>
        <Text dimColor>{`${doneCount} of ${shownCards.length} done`}</Text>
      </Box>
    )
    const header = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1} marginBottom={1}>
        {shownCards.length === 0 ? <Text bold>{where.kind === 'goal' ? 'No subtasks yet' : 'Nothing on the board yet'}</Text> : progress}
        {newCard}
      </Box>
    )

    const details = (card: Card) => {
      const left = neighbour(card.column, -1)
      const right = neighbour(card.column, 1)
      const parents = subtasksOf(board, card.id).length === 0 ? goals(board).filter(g => g.id !== card.id) : []
      return (
        <Box key={`details:${card.id}`} flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginTop={1}>
          <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
            <Box flexDirection="row" columnGap={1} flexShrink={1}>
              <Text {...DOT[card.column]} dimColor={DOT[card.column].color === undefined}>
                ●
              </Text>
              <Text bold wrap="wrap">
                {card.title}
              </Text>
            </Box>
            <Button key="close" label="✕" plain dimColor onPress={() => void select($, null)} />
          </Box>
          <Text dimColor>{`${COLUMN_NAME[card.column]} · ${sourceName(card.source)}`}</Text>
          {card.note !== '' && (
            <Box marginTop={1}>
              <Text wrap="wrap">{card.note}</Text>
            </Box>
          )}
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1} marginBottom={1}>
            {(card.parentId ?? null) === null ? (
               <Button key="subtasks" label="Subtasks ›" variant="secondary" onPress={() => void update($, view, (): View => ({ kind: 'goal', id: card.id })).then(() => select($, null))} />
            ) : (
              <Button key="make-goal" label="Make goal" plain dimColor onPress={() => void setCards($, c => makeGoal(c, card.id), false)} />
            )}
            {Select !== undefined && parents.length > 0 && (
              <Select key="move-under" label="Move under…" options={parents.map(g => ({ value: g.id, label: g.title }))} {...(card.parentId == null ? {} : { value: card.parentId })} onSelect={value => void setCards($, c => moveUnder(c, card.id, value), false)} />
            )}
            {card.column !== 'done' && (
              <Button
                key="work"
                label={card.id === busy ? 'Claude is on it' : '▶ Work on it'}
                variant="secondary"
                onPress={() => void workOn($, card)}
              />
            )}
            {left !== null && (
              <Button key="left" label={`‹ ${COLUMN_NAME[left]}`} variant="secondary" onPress={() => void move($, card.id, left)} />
            )}
            {right !== null && (
              <Button key="right" label={`${COLUMN_NAME[right]} ›`} variant="secondary" onPress={() => void move($, card.id, right)} />
            )}
            <Button key="edit" label="Edit" plain dimColor onPress={() => void compose($, card)} />
            <Button key="delete" label="Delete" plain dimColor onPress={() => void remove($, card.id)} />
          </Box>
        </Box>
      )
    }

    return (
      // A focus ring at the content's top or bottom edge is cut off: keep a line below the last element.
      <Box flexDirection="column" paddingBottom={1}>
        {navigation}
        {inboxRow}
        {shownCards.length === 0 ? (
          <Box flexDirection="column">
            {header}
            <Text dimColor wrap="wrap">
              Add a card with New card. Claude's to-do list and the plans you approve show up here by themselves, and Claude can add
              cards when you ask it to put something on the board.
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {header}
            {Client !== undefined ? (
              // Dragging needs the pointer, which only a Client hears: it draws the columns itself.
              <Client key="columns" module="./columns.tsx" props={columnsProps} width="100%" height={columnsHeight} />
            ) : (
              <Box flexDirection="row" columnGap={1}>
                {COLUMNS.map(columnView)}
              </Box>
            )}
          </Box>
        )}
        {writing !== null && Input !== undefined && (
          <Box
            key="composer"
            flexDirection="column"
            borderStyle="round"
            borderColor={ACCENT}
            paddingX={1}
            paddingY={1}
            rowGap={1}
            marginTop={1}
          >
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold>{writing.id === null ? 'New card' : 'Edit card'}</Text>
              <Button key="cancel-x" label="✕" plain dimColor onPress={() => void update($, composer, () => null)} />
            </Box>
            {/* One field at a time: each field's Enter label is drawn as a button, always. */}
            {!writing.hasNote ? (
              <Box flexDirection="column" rowGap={1}>
                <Input
                  key="title"
                  label="Title"
                  placeholder="What needs doing"
                  value={writing.title}
                  submitLabel={saveLabel}
                  autoFocus
                  onInput={text => void typeIn($, 'title', text)}
                  onSubmit={text => void typeIn($, 'title', text).then(() => saveComposer($))}
                />
                <Box>
                  <Button
                    key="add-note"
                    label={writing.note === '' ? '+ Description' : 'Edit description'}
                    plain
                    dimColor
                    onPress={() => void showNote($)}
                  />
                </Box>
              </Box>
            ) : (
              <Box flexDirection="column" rowGap={1}>
                <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
                  <Text bold wrap="wrap">
                    {writing.title === '' ? 'Untitled' : writing.title}
                  </Text>
                  <Button key="back-title" label="‹ Title" plain dimColor onPress={() => void showTitle($)} />
                </Box>
                <Input
                  key="note"
                  label="Description"
                  placeholder="Why, where, what done means"
                  value={writing.note}
                  submitLabel={saveLabel}
                  autoFocus
                  onInput={text => void typeIn($, 'note', text)}
                  onSubmit={text => void typeIn($, 'note', text).then(() => saveComposer($))}
                />
              </Box>
            )}
          </Box>
        )}
        {open !== undefined && details(open)}
      </Box>
    )
  })
}
