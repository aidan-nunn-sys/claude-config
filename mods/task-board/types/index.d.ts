export type Column = 'todo' | 'doing' | 'done'

/** Who put a card on the board: you, Claude's to-do list, an approved plan, or Claude through the board tool. */
export type CardSource = 'you' | 'todo' | 'plan' | 'claude'

export type Card = {
  id: string
  /** Lifetime identity: an id can be reused after deletion, but this cannot. */
  incarnation?: string
  title: string
  /** More about it, when whoever added it said more; else empty. */
  note: string
  column: Column
  source: CardSource
  /** What ties a card to Claude's to-do list: the item's text (TodoWrite) or its task id (TaskCreate). */
  ref: string | null
  createdAt: number
  /** null for a top goal; otherwise its top goal's id. */
  parentId: string | null
  sessionId: string
  sessionLabel: string | null
  carriedAt: number | null
  filedBy: 'haiku' | null
  /** Stable request identity, independent of its shortened display title. */
  inboxId?: string
  /** Stored-goal transfer identity, retained until persistence acknowledges the pull. */
  pulledFrom?: string
}

/** One ended session's unfinished goals and subtasks. */
export type Group = { sessionId: string; label: string; isLabelled: boolean; endedAt: number; cards: Card[] }
export type Stash = { carried: Group[]; archive: Group[] }
export type View = { kind: 'top' } | { kind: 'goal'; id: string } | { kind: 'carried' } | { kind: 'archive' }
export type InboxItem = { id: string; text: string; sessionId?: string; createdAt?: number }

declare module 'claude-code' {
  interface PluginState {
    'task-board': {
      /** The session's cards, in the order they were added. */
      cards: Card[]
      /** The card whose details are open under the board. */
      selected: string | null
      /** The card being written: a new one (id null) or one being edited; null when the composer is closed. */
      composer: { id: string | null; title: string; note: string; hasNote: boolean } | null
      /** The card handed to Claude with Work on it, until Claude's turn on it ends. */
      working: string | null
      inbox: InboxItem[]
      view: View
      stash: Stash
      /** Latest successful background Haiku name for this live session. */
      sessionLabel: string | null
    }
  }
}
