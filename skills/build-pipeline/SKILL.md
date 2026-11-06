---
name: build-pipeline
description: Owner's standard build workflow after a design doc is approved — write the plan, adversarial plan review, subagent build with cross-model per-task review, adversarial final review, PR to green, then a dev end-to-end test loop after the owner merges. Use when the owner says "run the build pipeline", "lets do it" on an approved design, or names this workflow.
---

# Build pipeline

The owner set this workflow on 2026-10-29 (Settings regroup). Earlier builds used the same shape with other models (Stripe, manual facts). Run the stages in order. Log every stage start, result and ruling in the ledger's `progress.md` so a restarted session can resume.

## Roles (defaults)

The owner may name different models for a run. Their words win over this table; record the roles used at the top of `progress.md`.

| Seat | Default | How |
|---|---|---|
| Plan writer | you | `superpowers:writing-plans` |
| Plan review | `openai/gpt-6-astra --variant xhigh`, 1 round | opencode via `run-oc.sh` |
| Per-task implementer | `openai/gpt-6-sol --variant high` | opencode via `run-oc.sh` |
| Per-task reviewer | Sonnet 5.5 | Agent tool, `model: sonnet`, adversarial |
| Final whole-diff review | `openai/gpt-6-astra --variant high`, up to 2 rounds | opencode via `run-oc.sh` |

Before every Astra or Sol stage, probe the model with a one-line `opencode run -m <model> "reply ok"`. If it fails twice, stop and tell the owner. Never swap in another model on your own.

## Stage 1: plan

1. Work in a worktree off `origin/dev` (`superpowers:using-git-worktrees`), never the shared main checkout.
2. Write the plan with `superpowers:writing-plans` into `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`. Do the retired-behaviour audit at plan time: grep `e2e/` and `src/__tests__/` for tests that pin what the change retires.
3. Create the ledger at `<worktree>/.superpowers/sdd/YYYY-MM-DD-<topic>/` with `progress.md`, `global-constraints.md` (repo rules every task obeys) and `implementer-common.md` (worktree path, branch, git rules, checks, private test DB). Copy `run-oc.sh` from this skill's directory and set its variables.

## Stage 2: plan review (1 round)

1. Write `plan-review.md`: an adversarial prompt that tells the reviewer to stay read-only and gives it the plan, the spec and the code it must check. Ask for findings ranked Critical / Important / Minor, with file and line.
2. Run it on Astra xhigh. Save the output as `plan-review-result.md`.
3. Fold the findings into the plan. Log a rulings table in `progress.md` (finding, accept/modify/reject, why, cost if wrong). Commit the plan. No second round.

## Stage 3: build (`superpowers:subagent-driven-development`)

For each task:

1. Write `task-N-brief.md` (the plan task, verbatim) and `task-N-dispatch.md` (read implementer-common, global-constraints, the brief; write `task-N-report.md`; commit). Record the base SHA in `task-N-base`.
2. Run the implementer: `run-oc.sh openai/gpt-6-sol high <worktree> task-N-dispatch`.
3. Review with a Sonnet subagent. Give it the brief, the report and the diff `base..HEAD`, and tell it to be adversarial, stay read-only and spawn no subagents. Save its output as `task-N-review.md`.
4. Send findings back to Sol in the same session (`task-N-fix1.md`, resume with the session id) until the reviewer passes. Log each round.

## Stage 4: final review (max 2 rounds)

1. Build the whole-branch diff (`origin/dev...HEAD`). Run an adversarial review on Astra high against the spec and plan.
2. Fold the findings through Sol tasks, or fix them yourself when small. Re-run lint, type-check and the touched unit tests.
3. Round 2 only if round 1 had findings. Stop when Astra reports none or after round 2, and log what was left open.

## Stage 5: PR

1. Push the branch and open a PR to `dev`. Follow the global no-AI-attribution rule: grep the commits and PR body for claude, co-authored, generated with and anthropic before pushing. Add a `.changes/` note if users would notice.
2. Wait for CI to go green. For red runs, check the known flakes in memory first (heap OOM, CRM email identity, card digest, audit gate). Fix real failures and push.
3. Tell the owner it is green. The owner merges; never merge yourself.

## Stage 6: dev end-to-end test (after the owner merges)

1. Wait for Deploy Dev to finish, then run any post-merge steps yourself (migrations, backfills, permission sync). Never `migrate dev`.
2. Test on dev in the browser (`claude-in-chrome`), covering every main path in the design plus the edge cases you can foresee: permission-limited users, old links and redirects, empty and error states, concurrent edits, and anything the reviews flagged. Dev is a sandbox; saves there need no per-action OK. Write the checklist and results into `progress.md`.
3. If something breaks: fix it on a new branch, PR it, wait for green, tell the owner, and wait for the merge. Then rerun the full end-to-end checklist, not only the fixed item. Loop until a full pass is clean.
4. Report the final pass to the owner, then clean up worktrees, private DB containers and the mockup server.

## Operating rules

- One heavy check at a time (the machine has 2–4 GB free): type-check alone, vitest on touched files with `--maxWorkers=1`, eslint on changed files.
- Private `_test` Postgres container for any DB test. Never the shared dev DB or prod.
- Stop your own processes by PID or task id, never `pkill -f`.
- If a job is killed for memory, restart it lighter yourself and resume from `progress.md`.
