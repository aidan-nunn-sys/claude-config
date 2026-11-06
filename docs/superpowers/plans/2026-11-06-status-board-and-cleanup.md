# Status board and cleanup: implementation plan

> For agentic workers: run with superpowers:executing-plans (native, owner chose it on 2026-11-06). Steps use `- [ ]` checkboxes.

Goal: create `~/Work/status/` as the single place for work status, move status out of memory, then remove the stale files, worktrees and repo-doc errors listed in the spec.

Approach: shell and git work run in order. Each task ends with a check command whose output proves it. Repo doc changes go out as one PR per repo.

Spec: `docs/specs/2026-11-06-status-board-and-cleanup-design.md` (this repo). Read it with this plan; the spec holds the item lists, and this plan does not repeat them.

## Global constraints

- Several sessions run at once. Never stash, reset or `git clean` a shared checkout. Stage by path.
- Before removing any worktree, folder or container:
  - `git status --porcelain --ignored`, and look for `.superpowers/` and `.factory/` folders.
  - Unpushed commits.
  - In-use check: no `/proc/*/cwd` inside it, and no file changed in the last 24 h.
  - Skip and log on any hit.
- No AI attribution in commits, branches or PR bodies. Grep for claude/co-authored/generated with/anthropic before every push.
- PRs go to `dev` in the three ReplaceNC repos and to `main` in claude-config. The owner merges.
- Do not edit migration SQL. Do not touch line 3 of the ERP `CLAUDE.md` or the boaterstop line in `ReplaceNCWeb/frontend/AGENTS.md`.
- Docs follow memory `writing-rules`.
- Subagents run on Sonnet or Haiku.
- Edit memory and board files with small in-place edits. Re-list the folder before any rebuild.
- Leave alone: the 3D-print folders, `vision-page-reading`, and the 5 active worktrees.

## Review focus

- Re-check every owed item copied from memory with `gh`/`git` while you move it. If you can't check it, keep it tagged `unverified`. Never drop it silently.
- Read `MEMORY.md` again right before each edit, because other sessions write to it.

---

### Task 1: Board scaffold and rules

Files: create `~/Work/status/BOARD.md`, `~/Work/status/cleanup-2026-11.md`, and the folders `done/` and `ledgers/`. Modify `~/.claude/CLAUDE.md` and memory `MEMORY.md`.

- [ ] Create the layout from spec Part 1. `BOARD.md` gets a one-line header explaining the line format. Its first entry is `cleanup-2026-11`.
- [ ] Write `cleanup-2026-11.md` in the page shape: what the work is, a plan listing Tasks 1–11, links (spec, plan, PR #4), Owed, Log. Log the owner answers from 2026-11-06.
- [ ] Add a "Status board" section to `~/.claude/CLAUDE.md` with spec rules 1–5, plus "delete a page's ledger folder when the page moves to `done/`". Keep it to about 12 lines.
- [ ] Add one line under `# Rules` in `MEMORY.md`: `- [Status board](~/Work/status/BOARD.md): work status and owed items live there, never in memory`.
- [ ] Check: `ls ~/Work/status` shows BOARD.md, cleanup-2026-11.md, done, ledgers. `grep -c "Status board" ~/.claude/CLAUDE.md` prints 1.

### Task 2: Memory status to board pages

Files: create `~/Work/status/<slug>.md` and `done/<slug>.md`. Delete memory files and their index lines.

- [ ] `ls` the memory folder and diff the result against the spec's Step 1 lists. Treat new files the same way: rule or status, using the test "true after it ships?"
- [ ] For each of the 22 PARTLY-DONE files:
  - Write a page with its owed items, each re-checked: PR state with `gh pr view`, release with `git merge-base --is-ancestor <sha> origin/main` in that repo, and existence of the worktree, branch or container.
  - Tag owner and prod items `unverified` unless memory gives a dated result.
  - Split `erp-open-followups` across feature pages, and drop items that v2.0.0 shipped.
- [ ] Write the 5 in-flight pages (bulk-payments, pricing-autopilot, numeral-pre-sept-backfill, godaddy-m365, fact-extraction-paused). Add the one-line rule memory "fact extraction stays paused until owner says so".
- [ ] Put the 3 finished files in `done/`. Keep "never enter real cards or charge on prod" as a rule memory if no rule covers it.
- [ ] Any page whose Owed list is empty after the re-check, and holds no owner or prod item, goes straight to `done/`. Pages that do hold such items stay open.
- [ ] Delete each moved memory file. Remove its index line with an in-place edit.
- [ ] Add every open page to `BOARD.md`.
- [ ] Check: every `MEMORY.md` link resolves (`grep -o '([^)]*\.md)' MEMORY.md | tr -d '()' | while read f; do [ -e "$f" ] || echo MISSING $f; done` run in the memory folder prints nothing). Every non-done page has a `BOARD.md` line.

### Task 3: Fix remaining memory and the archive

- [ ] Apply spec Step 2 edits:
  - `erp-e2e-needs-ci`: rewrite.
  - The two node_modules files: check `ls <live worktree>/node_modules | head` first, then merge them into one.
  - `stripe-build-review-pipeline`: delete it, after moving the Opus-fallback line into `subagents-use-sonnet-haiku`.
  - `assistant-model-eval`, `ups-ship-to-attention-926-3547`, `evdi-kernel7-patch`, `erp-shared-worktree-wip`: fix as the spec says.
  - Remove "releases frozen" everywhere (`grep -ril "frozen" memory/`).
- [ ] Archive:
  - Move the release-pipeline and extraction-eval `.full` copies next to their live files, and link them.
  - Move the two website `.full` copies to `ledgers/<slug>/`.
  - Grep the other 98 for owed or todo words and place any hits on pages.
  - Delete `archive/`.
- [ ] Re-list the folder and regroup `MEMORY.md` in place. Use the headings Rules, Environment, ERP working knowledge, Infra. Point the archive line at `~/Work/status/done/`.
- [ ] Check:
  - The link check from Task 2 prints nothing.
  - `grep -ril frozen` on the memory folder prints nothing.
  - `ls memory | wc -l` matches the index line count plus MEMORY.md.

### Task 4: Worktrees and checkouts

- [ ] For each of the 14 merged worktrees in spec Step 3:
  - Run the global pre-removal checks.
  - Move any ledger or job folder to `~/Work/status/ledgers/<slug>/` and link it from the page.
  - `git worktree remove <path>`. Use `--force` only for `ReplaceNCWeb-cardform`'s `test-results/`.
- [ ] For the 7 unpushed worktrees, run the pre-removal checks, then:
  - `sku-global-availability`: commit the 8 modified files as "WIP snapshot".
  - `extraction-eval`: drop the two `.tmp.ts` files.
  - Push each one with commits ahead to `archive/<worktree-name>` (`git push origin HEAD:refs/heads/archive/<name>`). Skip the push for `stripe-spec-failure-modes`.
  - Remove the worktree, and note the archive branch on its page.
- [ ] Check the contents of `replacenc-erp/.worktrees/price-intel-popover`, then delete it.
- [ ] Run `git worktree prune` in all 3 repos. Delete the local branches of removed worktrees with `git branch -D` only when their PR is merged or an archive branch exists.
- [ ] Main checkouts:
  - ERP: if it is clean and on `fix/726-3828-receiving-conditions`, `git checkout dev && git pull --ff-only`. Otherwise stop and ask.
  - Medusa: `git log preserve/main-before-sync-20261002 --not origin/main origin/dev --oneline`. If that prints anything, push the branch. Then `git checkout dev && git pull --ff-only`.
  - Web: `git pull --ff-only`.
- [ ] Test DB containers: run `docker ps -a --format '{{.Names}}'`. For each container named after a removed worktree whose page doesn't need it, run `docker rm -f <name>`.
- [ ] Check: `git worktree list` in each repo shows only the main checkout, the 5 active worktrees and `vision-page-reading`.

### Task 5: `~/Work` folders

- [ ] Grep `archive/`, `.task-archives/` and the done `progress/` subfolders for owed items. Place any hits on pages.
- [ ] Delete the spec Step 4 list: `capture-extension-dev`, `cpi-c20`, `brand-assets`, the mockup and audit folders, `outputs`, `tries`, `archive`, `.task-archives`, `.aws`, `.codex`, `~/Work/.git`, the 10 finished `progress/` subfolders, and the loose 6869 and `oc-*` files. Run the in-use check first.
- [ ] Link `progress/bulk-payments`, `manual-facts-review` and `numeral-backfill` from their pages.
- [ ] Check: `ls -A ~/Work` shows only the keep list from spec Step 4, plus `status`.

### Task 6: `~/.claude`

- [ ] Decode each `projects/` folder name to a path. Delete the folder only when the path does not exist and the folder has no `memory/` with files.
- [ ] Delete `backups/pre-claude-config-2026-10-14`.
- [ ] Check: re-run the decode. Zero dead folders remain. `du -sh ~/.claude` is lower by about 120 MB.

### Task 7: ERP docs PR

Run in a new worktree off `origin/dev`: `replacenc-erp/.worktrees/docs-cleanup`, branch `docs/agent-docs-cleanup`.

- [ ] Make the edits listed in spec Step 6 for replacenc-erp. Notes:
  - Line 149: run `git grep -n -i "taxonomy" origin/dev -- src | grep -i -E "publish|pause"`. If no publish gate shows, delete the line and `BUSINESS-RULES.md:70`.
  - Factory: the section moves to `docs/runbooks/factory.md`.
  - `docs/superpowers` plans: delete the ones for shipped work, then update every reference that `git grep -n "docs/superpowers/.*plans/"` finds outside `prisma/migrations`.
  - The 72 broken `docs/decisions` links: fix them with a sed that adds `/archive/` when the target exists there.
- [ ] Check:
  - Every `docs/superpowers` path in the repo outside migrations resolves (a link-check loop over `git grep -o` hits).
  - `npm run changes:check` passes, or a `.changes/` note is added if the check requires one.
  - `wc -c CLAUDE.md` is lower than 32971.
- [ ] Commit, grep for attribution, push, and open a PR to `dev`. Wait for CI to go green. Check the known flakes in memory before acting on a red run.

### Task 8: my-medusa-store docs PR

Worktree `~/Work/.worktrees/medusa-docs-cleanup`, branch `docs/claude-md-refresh`, off `origin/dev`.

- [ ] Make the spec Step 6 my-medusa-store edits. Re-read `package.json`, the `.github/workflows/*`, `medusa-config.ts` and `src/subscribers/` as you edit. The audit counts are a guide only.
- [ ] Check: every path and script named in `CLAUDE.md` exists (`git ls-files`, `jq .scripts package.json`).
- [ ] Commit, grep for attribution, push, PR to `dev`, CI green.

### Task 9: ReplaceNCWeb docs PR

Worktree `~/Work/ReplaceNCWeb/.worktrees/docs-cleanup`, branch `docs/agent-docs-cleanup`, off `origin/dev`.

- [ ] Make the spec Step 6 ReplaceNCWeb edits, using `git mv` for the archive moves.
- [ ] Check: `git grep -n "medusa-context/CLAUDE"` prints nothing. Moved files leave no broken relative links (`git grep -n "](.*docs/"` spot check).
- [ ] Commit, grep for attribution, push, PR to `dev`, CI green.

### Task 10: Skill edits (after PR #4 merges)

- [ ] Wait for `gh pr view 4 -R aidan-nunn-sys/claude-config --json state` to return MERGED. Then run `git branch skills/status-board origin/main && git checkout skills/status-board`.
- [ ] `skills/build-pipeline/SKILL.md`:
  - The plan stage creates or updates the board page.
  - The PR, dev E2E and cleanup stages copy owed items to the page.
  - Cleanup moves the page to `done/` when Owed is empty and deletes the ledger.
- [ ] `skills/factory/SKILL.md` and `subcommands.md`: job start creates a page that links `.factory/jobs/<job-id>`, and `/factory cleanup` moves it to `done/` when nothing is owed.
- [ ] Commit, push, PR to `main`. Also push `docs/status-board-design` and open its PR, or fold it into this one.

### Task 11: Final check and report

- [ ] Re-run the checks from Tasks 2–6.
- [ ] Update `cleanup-2026-11.md` with skipped items, PR links and before/after disk numbers (`du -sh ~/Work ~/.claude`).
- [ ] Move it to `done/` once the PRs merge and nothing is owed.
- [ ] Report to the owner: PR links, items skipped and why, disk freed.
