# task-board

A two-level To do / Doing / Done board in a side pane: goals, subtasks, a Haiku-filed inbox, and unfinished work carried over per directory.

<img src="docs/board.png" alt="The Board pane: a progress bar, To do, Doing and Done columns of cards marked as Claude's or from a plan, and a New card button" width="380">

<sub>The screenshot shows made-up cards.</sub>

- **Claude's to-do list:** the list Claude keeps while it works becomes subtasks, which move to Doing and Done as Claude goes. `/board` opens the pane.
- **Approved plans:** when you approve a plan, its steps (its numbered items, else its bullets or step headings) go to To do.
- **A board tool for Claude:** Claude sends real asks to `inbox` for Haiku to file, and can list, add, move and remove cards. `add` accepts a top goal's id or exact title as `parent` to add a subtask.
- **Your own cards:** **+ New card** opens a composer on the title; Enter or **Add card** adds the card to To do. **+ Description** swaps the title field for a description field (the title stays above it, **‹ Title** goes back), whose Enter or **Add card** adds it too. ✕ cancels.
- **A card's details:** **Open** shows its full text, where it came from, and buttons to move it a column left or right, **Edit** (its title and description), **▶ Work on it** (hands it to Claude and moves it to Doing; Claude Code holds the prompt until Claude finishes what it is doing) and **Delete**.

- **Drag and drop:** in the desktop app and the terminal, press a card and drag it onto another column: a white copy of it follows the pointer, the card stays dimmed where it was, and the column under the pointer shows **Drop here**. A click (press and release without moving) opens the card. The columns fill the pane, so there is room to drag below the cards. In VS Code and the mobile app, which cannot draw this, each card has **Open** and **›** (move it a column on) instead.
- **Keys (desktop and terminal):** click into the columns to give them the keyboard. Arrow keys move the highlighted card: left/right across columns, up/down within a column. **Space** opens details; **Enter** opens a goal's subtask board, or a subtask's details. **Esc** (or the pane's close mark) goes up one level: details → goal board → top board; Carried over and Archive return to the top board. At the top with no details or composer open, it closes the pane. Running `/board` again closes it directly.

✦ marks Claude's cards, ◆ a plan's, ≡ one with a description, and ✧ a Haiku filing. `/board` opens the pane at any time. Done shows its latest five cards; a live board keeps at most 80, dropping the oldest done ones first. Removing a goal removes its subtasks too.

Claude's to-do list is the truth for its own cards: when Claude updates the list, its cards follow, even ones you moved. Cards you or the board tool added are yours to move.

## Goals, inbox, carry-over

Top cards are goals or phases; each has its own To do / Doing / Done subtask board. The main progress bar counts goals, and `▸ done/total` on a goal counts its subtasks. Open a goal's details and choose **Subtasks ›** to drill in, then **‹ Back** to return. Claude's TodoWrite and TaskCreate items attach to the last goal in Doing, or to a reusable **Session** goal created on demand. **+ New card** inside a goal adds a subtask; **Make goal** and **Move under…** correct placement while keeping at most two levels.

Messages queued while Claude works are filed automatically (except slash commands). For other real asks, Claude calls the board tool's `inbox` action with the ask text; Haiku decides whether to add a goal or a subtask. The Inbox row shows the ask while filing, and successful filings carry ✧. If Haiku fails, times out, or returns an invalid filing, the ask's first line becomes a new To do goal.

When a session ends, unfinished goals and all their subtasks are saved per working directory; Done goals are dropped. **Carried over** groups them by the session they came from and shows the days left before archive. Groups older than 14 days move to **Archive** at session start (or when `/board` reloads after `/clear`). **Pull in** moves a goal and its subtasks from either list to the live board: the goal starts in To do, subtask columns are kept, and empty groups disappear.

**Session labels:** when the set of top-goal titles changes, background Haiku (low effort, 10-second timeout) names the session in 3–6 words. The first change calls immediately; rapid changes are debounced to at most one call per three minutes, with one trailing call after three quiet minutes using the latest goals. The latest successful label stays in session state; failures keep the previous label. Session end makes no model call and saves that label immediately. If there is no label yet, it saves `<Mon D> · <first goal title>` and Haiku relabels the group at the next session start in that directory.

## Install

```
/plugin marketplace add MarcoCarnevali/claude-code-mods
/plugin install task-board@marco-mods
/reload-plugins
```
