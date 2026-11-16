---
name: tidy
description: One-off cleanup of ~/Downloads, the Inboxes and stray files in ~/Personal and ~/School. Scans, proposes a table of moves, and applies them only after Aidan's yes.
disable-model-invocation: true
---

# Tidy

Sort loose files into the folder skeleton. Nothing moves until Aidan says yes.

## The skeleton

Both `~/Personal` and `~/School` have `Inbox/`, `Code/`, `Documents/` and `Archive/`.

- `~/Personal/Code/<repo>`: personal repos. `~/Personal/Documents/` has `Finance/` (with `Receipts/`), `Career/`, `School/` and `Misc/`. Add a subfolder only when three or more files would share it.
- `~/School/Code/<course>/`: one folder per course (repos, `Slides/`, `Homework/`, `Practice Exam/` and so on). `~/School/Documents/`: school paperwork that isn't course material.
- `Archive/`: finished courses (`School/Archive/<course>-<term>`) and dead projects. Archive rather than delete.
- `~/Downloads` is per machine and doesn't sync. It's a landing spot and should end up empty.

Roots may hold only: `CLAUDE.md`, `IDEAS.md`, `MACHINES-BACKLOG*.md`, `mise.toml`, dotfiles and the four skeleton folders. `Code/` roots hold only repo and course folders.

## 1. Scan

List, don't open, unless the name doesn't tell you where a file goes:

- `~/Downloads`, `~/Personal/Inbox`, `~/School/Inbox`
- files in the roots of `~/Personal`, `~/School`, `~/Personal/Code`, `~/School/Code` and each course folder
- `HANDOFF*`, `*-drafts/`, `*-plan.md`, `*-log.md` older than 14 days, anywhere outside a repo's tracked files
- `find ~/Personal ~/School -name '*.sync-conflict-*'`

Skip build output (`node_modules`, `.venv`, `target`) and anything tracked by git.

## 2. Propose

One numbered table: `# | file | action | destination | reason`. Actions: `move`, `archive`, `delete`, `flag`.

- **Secrets** (recovery codes, `client_secret*`, `*.key`, VPN configs, anything with "token", "password" or "2FA" in the name): never open them and never move them into a synced folder. Action `flag`: tell Aidan to put them in his password manager, then delete them.
- **Installers and archives** (`*.tar.gz`, `*.zip`, AppImages, eclipse/eddie installers) older than 14 days: `delete`.
- **Course files**: match the course code or topic to `~/School/Code/<course>/` and the subfolder its siblings use.
- **Stale session files** (handoffs, plans, drafts whose work the backlog shows as done): `archive` to the nearest `Archive/`, or `delete` if superseded.
- **Sync conflicts**: show whether they differ from the original. Never pick a side yourself.
- If unsure, say so in the reason and propose `Inbox/`.

End with counts per action and ask: "Apply all, or tell me which rows to change."

## 3. Apply

Only after a yes. Accept edits like "all but 3 and 7" or "5 goes to csc474".

- Deletions inside `~/Personal` or `~/School` sync to the other machine. Move them to `~/cleanup-hold-YYYY-MM-DD/` first, and tell Aidan he can empty it after a week.
- Use `mv -n` so nothing gets overwritten. Report collisions.
- Before moving a file or folder, grep memory (`~/Personal/.claude-shared/memory`), the backlogs and `CLAUDE.md` files for its path, and update any reference in the same step.
- Finish with what moved where, what's in the hold dir, and any flagged secrets still waiting on Aidan.
