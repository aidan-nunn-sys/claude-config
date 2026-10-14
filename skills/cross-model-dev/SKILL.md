---
name: cross-model-dev
description: Use when executing an implementation plan with external models doing the work - plan reviewed adversarially by GPT-6.1 Sol, each task routed by quota and complexity to Codex, Antigravity or Copilot, reviewed by Sonnet or Haiku. Use instead of subagent-driven-development when the xagent mod's tools (mcp__xagent__dispatch, mcp__xagent__route) are available.
---

# Cross-model development

You orchestrate. External agents implement; native Sonnet/Haiku subagents review. The user's
instructions about models or effort always win over routing: apply them and say so. Keep the
user's standing instructions for this run in hand; they go into every route, implementer and
reviewer prompt.

## 1. Adversarial plan review

Dispatch with:
- `backend: codex`, `model: gpt-6.1-sol`
- `effort: high`, or `xhigh` if your effort is xhigh or max
- `mode: read-only`, `dir: <repo>`
- `schema: ~/.claude/skills/cross-model-dev/plan-review-schema.json`

Prompt: the plan path and the spec path, then: "Attack this plan. Find what will break, what is
missing from the spec, wrong task order, interfaces that do not match between tasks, and tests
that would pass on broken code. Blocking = would make the result wrong or unbuildable."

If dispatch refuses because codex is at 90 %, show the user the error and ask; don't switch
reviewers on your own. Read `answer`, which is the whole JSON; `summary` may be cut. Revise the plan for every blocking
item, and say which items you reject and why. Then dispatch again with `resume: <sessionId>`.
Stop when `blocking` is empty. After 3 rounds, show the user the remaining items and ask.

## 2. Show the run

Call `route` for each task, passing the task text, the files from the plan and the user's
instructions. Show one table with these columns:
- task
- complexity
- implementer (backend/model/effort)
- reviewer (model/effort)
- review depth
- why

Include the first result's quota snapshot and effort. Show any `wait`. Wait for the user's go or
changes. A pick the user changes is **fixed**: it is
never re-routed.

## 3. Each task, in order

1. **Pick.**
   - If the pick has `wait` set, don't start the task: show the user `wait` and ask whether to
     wait for the reset or allow the provider anyway. Only if they allow it, route again with
     `override: true`, and pass `override: true` on every dispatch for that task too (implementer,
     fix rounds, second Sol review): dispatch refuses a provider at 90 % on its own.
   - Task 1 uses its pick from step 2.
   - Every later task that isn't fixed: call `route` again just before it starts, so it sees
     the quota now. Say the new pick in one line if it changed.
2. **Implement.**
   - Dispatch with the pick's backend/model/effort, `mode: write`, `dir: <repo>`.
   - Prompt: the full task text from the plan, the plan's Global Constraints, the user's
     standing instructions, and "Commit nothing. Run the task's tests. End with: files changed,
     tests run and their result."
   - Keep this first result's `baseTree` as the task's **base**.
   - If `ok` is false, dispatch has already retried a timeout once (`attempts`). Don't retry:
     tell the user the error and stop.
   - If `treeError` is set, or `baseTree` or `tree` is null, the change can't be reviewed:
     tell the user and stop. Don't review against a guessed base.
3. **Review.**
   - Use the Agent tool with `model: <reviewer.model>`, `effort: <reviewer.effort>` and
     `description: "Review <task name>"`. This skill is the instruction that sets the effort.
   - Prompt: the task text, the standing instructions, the review depth, and "See the change
     with `git -C <repo> diff <base> <tree>` (new files included). Report findings with
     file:line, or say it is good."
   - Depth:
     - `spec`: does it do what the task says.
     - `spec+quality`: also code quality and tests.
     - `adversarial`: also try to break it.
   - If `secondSolReview` is set, also dispatch a read-only Sol review with the same diff
     command.
   - If that dispatch is refused because codex is at 90 %, the task waits: tell the user, don't
     skip the review or swap in another reviewer, and set `override` only if they allow it.
4. **Fix.**
   - Dispatch the same backend again with `resume: <sessionId>` and the findings.
   - Review again against `<base>` and the new result's `tree`.
   - If implementer and reviewer disagree twice, show the user both sides.
5. **Done.**
   - Show the user `filesChanged` and the reviewer's verdict.
   - Commit only with their yes.
   - Move the task's card to Done on `/board`.

## 4. Finish

Use superpowers:finishing-a-development-branch.

## Never

- Implement a task yourself because a backend failed. Ask the user.
- Send Copilot read-only work or a model name.
- Retry a failed dispatch yourself.
- Skip a required second Sol review, or replace it with another reviewer.
- Pass `override: true` unless the user allowed a provider at 90 % for this run.
- Paste whole transcripts into your context; the summary is enough.
