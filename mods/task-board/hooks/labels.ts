import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Card } from '../types'
import { goals } from './lib'
import { LABEL_SYSTEM, labelPrompt, parseLabel } from './filer'

const sessionLabel = atom({ plugin: 'task-board', key: 'sessionLabel' } as const, null)
const cards = atom({ plugin: 'task-board', key: 'cards' } as const, [] as Card[])
const WINDOW = 3 * 60_000

type Labels = {
  sid: string | null; titles: string; lastCall: number | null; due: number | null
  epoch: number; request: number; stopped: boolean; waiting: boolean; tail: Promise<unknown>
}

export function runningLabels(): Labels {
  return { sid: null, titles: '[]', lastCall: null, due: null, epoch: 0, request: 0, stopped: false, waiting: false, tail: Promise.resolve() }
}

function reset(labels: Labels): void {
  labels.epoch++
  labels.titles = '[]'
  labels.lastCall = null
  labels.due = null
  labels.waiting = false
  labels.stopped = false
}

export function startLabels(labels: Labels): void {
  if (labels.stopped) { reset(labels); labels.sid = null }
}

export function stopLabels(labels: Labels, sessionId: string): void {
  labels.sid ??= sessionId
  labels.stopped = true
  labels.due = null
  labels.epoch++
}

async function call($: EngineInterface, labels: Labels, board: Card[], at: number): Promise<void> {
  if (labels.stopped) return
  labels.lastCall = at
  labels.due = null
  const generation = labels.epoch
  const sequence = ++labels.request
  const session = labels.sid
  const reply = await $.model.complete({ model: 'haiku', effort: 'low', timeoutMs: 10_000,
    system: LABEL_SYSTEM, prompt: labelPrompt({ cards: board }) }).catch(() => null)
  const label = reply?.isAnswered ? parseLabel(reply.text) : null
  if (label === null || labels.stopped || generation !== labels.epoch || sequence !== labels.request || await $.session.id() !== session) return
  await update($, sessionLabel, current => labels.stopped || generation !== labels.epoch || sequence !== labels.request ? current : label)
}

/** One sleeper tracks a movable deadline; engine-clock waits are deterministic in tests. */
async function wait($: EngineInterface, labels: Labels): Promise<void> {
  if (labels.waiting) return
  labels.waiting = true
  const generation = labels.epoch
  try {
    while (!labels.stopped && generation === labels.epoch && labels.due !== null) {
      await $.clock.sleep(Math.max(0, labels.due - await $.clock.now()))
      if (labels.stopped || generation !== labels.epoch || labels.due === null) return
      const now = await $.clock.now()
      if (now < labels.due) continue
      const board = await read($, cards)
      if (labels.stopped || generation !== labels.epoch) return
      if (goals(board).length > 0) void call($, labels, board, now).catch(() => {})
      else labels.due = null
    }
  } finally {
    if (generation === labels.epoch) labels.waiting = false
  }
}

/** Leading call plus one trailing call after three quiet minutes. */
export function labelsChanged($: EngineInterface, labels: Labels, restored = false): Promise<void> {
  // Observe committed state in order, including simultaneous filings and Pull ins.
  const changed = labels.tail.then(async () => {
    const session = await $.session.id()
    // End may create the very first goal while draining the inbox. A missing
    // sid is not a new session and must never re-enable calls during that drain.
    if (labels.stopped && (labels.sid === null || labels.sid === session)) return
    if (labels.sid !== session) { reset(labels); labels.sid = session }
    if (labels.stopped) return
    const board = await read($, cards)
    const next = JSON.stringify([...new Set(goals(board).map(card => card.title))].sort())
    if (next === labels.titles) return
    labels.titles = next
    const now = await $.clock.now()
    if (next === '[]') { labels.due = null; return }
    if (restored && labels.lastCall === null) {
      // A reload lost the in-memory timer. Resume conservatively after a
      // quiet window, including when an older successful label was restored.
      labels.lastCall = now
      labels.due = now + WINDOW
      void wait($, labels).catch(() => {})
    } else if (labels.lastCall === null || now - labels.lastCall >= WINDOW) {
      void call($, labels, board, now).catch(() => {})
    } else {
      labels.due = now + WINDOW
      void wait($, labels).catch(() => {})
    }
  })
  labels.tail = changed.catch(() => {})
  return changed
}
