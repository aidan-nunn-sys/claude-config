# Task board: goals, subtasks, inbox, carry-over — design

Date: 2026-10-13. Status: approved in brainstorming, awaiting spec review.
Backup of the pre-change mod: `/tmp/task-board-backup`.

## Goal

Turn the flat To do / Doing / Done board into a two-level board the user can glance at to see where the work stands:

- **Top cards are goals/phases** ("Research X", "Write the spec", "Implement"), the overall picture.
- **Subtasks are the concrete steps** inside one goal (Claude's to-do items, a superpowers plan's tasks).
- **Asks are filed by Haiku, not the main model.** The main model only decides whether an ask deserves a card.
- **Nothing unfinished is lost between sessions:** it carries over, grouped by the session it came from.

Out of scope: the built-in `/tasks` and `/subtask` commands (untouched); more than two levels; sharing boards between directories.

## 1. Data and storage

`Card` (types/index.d.ts) keeps its fields and adds:

| Field | Meaning |
|---|---|
| `parentId: string \| null` | `null` = top goal; else the goal's id. Max two levels: a subtask's parent must be a top goal. |
| `sessionId: string` | The session the card was made in. |
| `sessionLabel: string \| null` | That session's label, set when it ends. |
| `carriedAt: number \| null` | When the card entered Carried over; `null` on the live board. |
| `filedBy: 'haiku' \| null` | Shows the `✧` mark. |

Storage:

- **Live board:** session `$.state` (`cards`), as today.
- **Per directory:** `$.store` key `board:<cwd>` holding `{ carried: Group[], archive: Group[] }`, where `Group = { sessionId, label, endedAt, cards: Card[] }` (goals with their subtasks).
- **`session.end`:** every top goal not in Done, with all its subtasks, becomes one `Group` appended to `carried`, labelled (§2). Done goals are dropped. A session whose live board has no unfinished goals writes nothing.
- **`session.start`:** groups whose `endedAt` is more than 14 days old move from `carried` to `archive`; if any moved, `$.ui.status` says `task-board: archived N old groups`. Empty groups are removed.
- **Pull in:** moves a goal and its subtasks from `carried` or `archive` onto the live board, goal in To do, subtask columns kept, `carriedAt = null`. The group shrinks; an empty group is removed.

Subtask attachment:

- TodoWrite / TaskCreate items attach to the top goal in Doing. With none in Doing, they attach to a goal titled `Session` created on demand (and reused).
- The `board` tool's `add` gains optional `parent` (card id or exact title of a top goal).

## 2. Inbox and Haiku filing

Two ways in, one filer:

1. **Queued prompts, automatic:** a `prompt.submit` hook, only when `e.turnId` is present (submitted while a turn runs). The hook reads `e.text` and passes `e` on unchanged; the model's prompt is never altered.
2. **Other asks, by the main model:** the `board` tool gets action `inbox` with `text` (the ask). The main model's only job is the yes/no: call it for real work, not for "yes", "commit it" or questions. The tool answers at once (`Sent to the inbox.`) and filing happens after.

Filing (`filer.ts`):

1. An inbox item appears at once in the Inbox row: `✉ Inbox: "<first 40 chars>" …filing`.
2. `$.model.complete({ model: 'haiku', effort: 'low', prompt, timeoutMs: 10_000 })` with: the ask (cut to 1,000 chars), the goal in Doing (id + title), the other open top goals (id + title). It must answer strict JSON, either `{"subtask_of":"<id>","title":"..."}` or `{"new_goal":"..."}`, title an imperative of at most 60 chars.
3. The card is filed: a subtask into its goal's To do; a new goal into top-level To do. `filedBy = 'haiku'`.
4. **Fallback** (API error, timeout, unparsable JSON, unknown id, a subtask_of naming a subtask): a new top goal titled with the ask's first line, cut to 60 chars, `filedBy = null`.

Corrections: dragging between columns as today; the card's details gain **Make goal** (subtask → top goal) and **Move under…** (a Select of top goals).

Session label (revised 2026-10-13): a running label kept in session state. Whenever the set of top-goal titles changes, a background Haiku low-effort call (debounced: at most one call per 3 minutes, plus one trailing call after the last change) answers a 3–6 word label. `session.end` makes no model call: it saves the latest label with the group. With no label yet, the group gets `<Mon D> · <first goal title>` and is relabelled at the next `session.start` in that folder.

## 3. Pane

Views: `top` (default), `goal:<id>`, `carried`, `archive`. `‹ Back` goes up one level.

Keys (revised 2026-10-13), while the pane has the keyboard (after a click into it): arrow keys move a highlight between cards (left/right across columns, up/down within one); **Space** opens the highlighted card's details; **Enter** on a top goal opens its subtask board (on a subtask: details). A click still opens details; the details of a top goal keep **Subtasks ›**.

Esc: the pane opens with `closeOnEscape`; a `ui.close` hook with origin `person` refuses the close and goes up one level instead (details → goal view → top; carried/archive → top). At `top` with no details open the close goes through. The close mark shares origin `person`, so inside a goal it also goes up one level.

```
 Board                       ████████····  4/6
 ↺ Carried over (5)  ›               ▤ Archive
 ✉ Inbox: "also hide the esc hint" …filing
  To do            Doing              Done
  ◆ Write spec     ◆ Brainstorm board ◆ Status bar
    ▸ 0/0            ▸ 3/5 ✧            ▸ 4/4
```

- The progress bar counts top goals only. The Carried over row shows only when `carried` is non-empty; Archive only when `archive` is non-empty; Inbox only while filing.
- Top cards show `▸ done/total` of their subtasks. Enter or a click opens the goal view: the same three columns over its subtasks, header `‹ Back  <goal>  done/total`.
- Carried over lists groups (`↺ <date> · <label> (n)`, `· N days left` until archive), each goal with a **Pull in** button. Archive is the same list, read-only but for Pull in.
- Existing keys, buttons and the drag columns work the same at both levels.

## 4. Files

- `hooks/lib.ts`: pure board functions; add nesting, `attachTodo`, `pullIn`, `carryOver`, `expire`.
- `hooks/filer.ts` (new): Haiku prompt building, reply parsing, fallback, session label.
- `hooks/store.ts` (new): reading/writing `board:<cwd>`.
- `hooks/register.tsx`: hooks and pane drawing; the view state added to `$.state` (`view`) and declared in `types/index.d.ts`.
- `hooks/columns.tsx`: unchanged unless the goal view needs a header prop.

## 5. Testing

`claude plugin test` on the mod:

- Unit: nesting rules (two levels max), `attachTodo` to Doing / to `Session`, `carryOver` (only unfinished goals, subtasks kept), `expire` at 14 days, `pullIn` from carried and archive, Haiku reply parsing and every fallback case.
- Hooks, with `$.model.complete` mocked: a queued `prompt.submit` reaches the inbox and is filed; an idle prompt is not; the `inbox` tool action is filed; a failed Haiku call falls back; the prompt text passes through unchanged.
- UI on `terminal` and `desktop`: drill into a goal and back; Carried over view and Pull in; Inbox row while filing.
- The existing task-board tests still pass.
