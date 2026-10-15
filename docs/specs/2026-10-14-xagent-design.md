# xagent: cross-model development from a Claude Code session

Status: draft for review, 2026-10-14

## Goal

Run plan-driven development where Claude Code (Opus) orchestrates and other providers do much of
the work, chosen per task by quota and complexity, so tokens are not spent where they need not be.

- Implementation plans get an adversarial review from GPT-6.1 Sol before any task starts.
- Each task's implementer and reviewer (model and effort) are picked per task.
- Defaults: Sol implements (output-heavy work, cheaper output); Sonnet reviews (input-heavy work);
  Haiku reviews trivial tasks. The user's instructions always win; none of this is enforced by hooks.
- External agents appear in `/radar` and mission-control like native subagents, with no proxy model.

## Constraints

- No API keys anywhere. Every provider runs on a subscription login:
  Claude (Claude Code), Codex (ChatGPT login), Copilot (Student plan), Antigravity (student plan).
- "Cost" means quota pressure, not dollars.
- Orchestrator is always a Claude Code session.

## Components

### 1. `mods/xagent` (mod)

Registers two tools and holds the state other mods read.

**`dispatch`**: run one external agent.

| Input | Meaning |
|---|---|
| `backend` | `codex`, `copilot` or `agy` |
| `model`, `effort` | passed to the CLI |
| `mode` | `read-only` or `write` |
| `prompt`, `dir` | task text and working directory |
| `schema` | optional JSON schema; the whole answer comes back as `answer` and must parse |
| `resume` | optional session id to continue (fix loops) |
| `timeoutMs` | default 20 min |
| `override` | run on a backend at 90 % of a window; set only when the user allows it |

Launches the CLI through `$.process.spawn` (argv, no shell, stdin closed — `codex exec` otherwise
waits on it), with a wall-clock timeout that also stops a silent child, streams its JSON events
into the agent list, and returns `{ ok, summary, answer, sessionId, attempts, baseTree, tree,
filesChanged, quota }`:

- `summary` is capped at 4 000 chars; with a schema, `answer` is the whole answer (up to
  200 000 chars) and must parse as JSON, else the run fails.
- `baseTree` / `tree`: the working tree (untracked files included) as git tree objects before and
  after a write run, taken through a scratch index (`GIT_INDEX_FILE`) so the user's index is
  untouched; `filesChanged` is the diff between them. All null outside a git repo. Inside one, a
  failed first snapshot stops the run before the writer starts (a lost baseline can't be rebuilt
  after edits); a later snapshot or diff failure is reported as `treeError`, and the skill does not
  review that task.
- Stdout is read as it streams: lines are put back together across chunks, and only the lines the
  result needs are kept (bounded), so long command output never piles up.
- An answer counts only from a child that exited 0 with no signal. `~/` in `dir` and `schema` is
  expanded, since nothing runs through a shell.
- `quota`: that backend's quota read after the run.
- A backend at 90 % of a window is refused before spawning unless `override` is set.

The full transcript stays in the CLI's own session store; only the summary enters Claude's context.

| Backend | Command | Read-only | Effort flag | Structured answer | Quota signal |
|---|---|---|---|---|---|
| codex | `codex exec --json -m M -C dir` (resume: `codex exec resume … <id>`, no `-s`/`-C`) | `-c sandbox_mode="read-only"` (write: `workspace-write`) | `-c model_reasoning_effort=E` | `--output-schema` | latest `rate_limits` in the most recently written `~/.codex/sessions/…/rollout-*.jsonl` (by mtime; not in `--json` output): 5 h and weekly windows |
| copilot | `copilot -p … --output-format json --allow-all-tools` | no read-only mode: never used for plan review | `--reasoning-effort E` | parse final message | `total_nano_aiu` summed this UTC month in `~/.copilot/session-store.db` (/ 1e9 = credits, to verify); `--max-ai-credits` cap |
| agy | `agy -p … --output-format stream-json --model M` | `--mode plan` (write: `--mode accept-edits --sandbox --dangerously-skip-permissions`; headless agy denies shell commands otherwise) | `--effort E` | `--json-schema` | none exposed: quota errors only |

Failures: a CLI that is not logged in or exits non-zero fails fast; the provider is marked
unavailable for the session (auth) or put in a 30 min cooldown (quota). On timeout the tool stops
the child, and only once it is confirmed gone retries once (resuming the session if one was seen,
else starting again); it reports `attempts`. The skill never retries. A child that will not stop
is reported, not retried. Then the task goes to the user. No silent fallback to Opus.

**`route`**: pick models for one task.

- Runs `codex exec -m gpt-6-luna -c model_reasoning_effort=low` read-only with `--ephemeral` and a
  routing schema, in an empty directory (`~/.cache/xagent/router`). The orchestrator's effort is
  recorded from `turn.step` (main loop), since `tool.call` does not carry it. The router model and
  effort come from `routing.md`'s config block, so they can be swapped; only codex or agy can be the
  router, since it runs read-only.
- Luna's input (kept small; no repository: it gets only the text below. Codex's read-only sandbox
  can still read files by absolute path; that is accepted):
  - the task text and the files the plan lists for it
  - the orchestrator's current effort, read by the mod from the turn (not reported by Opus)
  - the quota snapshot (below)
  - `routing.md`
  - the user's standing instructions for this run
- Output: `{ complexity: trivial|standard|hard, implementer: {backend, model, effort},
  reviewer: {model, effort}, reviewDepth: spec|spec+quality|adversarial, secondSolReview, wait,
  why }`. `wait` set means the task must not start: no implementer is free, Claude (the
  reviewer) is at 90 %, or a required second Sol review can't run because codex is. The skill asks the user, and routes again with `override` only if they
  allow it.
- The mod checks every field and enum of the answer, then clamps it to the effort band (below).
  A bad answer or Luna being unavailable falls back to the defaults for the band, and `why` says
  so. User instructions override the clamp.

**Quota snapshot**, taken before each `route`:

| Provider | Source |
|---|---|
| Claude | `$.session.usage()` rate-limit windows |
| Codex | latest `rate_limits` in the most recently written codex rollout file, read from its end (5 h and weekly) |
| Copilot | `total_nano_aiu` this UTC month from `~/.copilot/session-store.db` (read-only) vs the 200-credit allowance. Counts this machine's CLI use, interactive included; not VS Code or web |
| Antigravity | available, or in cooldown until a time |

Each window is judged by pace: percent used vs percent of the window elapsed. Ahead of pace:
route away. Behind pace near reset: prefer it (quota that resets unused is wasted). A provider at
90 % of any window gets no new work unless the user says so; if all are, the task waits for the user.
`route` applies this to the implementer, the Claude reviewer and the second Sol review (the task
waits rather than drop it); `dispatch` enforces it at launch.
A window whose reset time has passed no longer counts; a window with no reset time has no pace; an
expired cooldown gives way to the live reading.

**State and UI**: a list of external agents (id, backend, model, effort, task, status, elapsed,
last event, quota snapshot used). The local agent-radar and mission-control copies are patched to
read it, so external agents show in the band, `/radar` and `/mission` with a backend tag.
Hiding Claude Code's native subagent area: the mod API's render components do not include it;
`Spinner` is probed, and if it carries no agent rows the area stays and this is reported.

### 2. `skills/cross-model-dev` (skill)

Runs after `superpowers:writing-plans`, in place of `subagent-driven-development`.

1. **Plan review.** `dispatch` codex, Sol, read-only, effort `high` (raised with orchestrator
   effort), schema `{ verdict, blocking[], nits[] }`, prompt: find what will break, what is
   missing, what is wrong in order. Opus revises and re-submits until `blocking` is empty;
   after 3 rounds it goes to the user.
2. **Show the run.** Print each task with its `route` pick in a table. The user can change any of
   it; a changed pick is fixed.
3. **Per task.**
   1. `route` again just before the task, so it sees current quota (skipped for the first task
      and for fixed picks).
   2. `dispatch` the implementer in `write` mode.
   3. Review: Sonnet or Haiku through the native Agent tool, given `git diff <baseTree> <tree>`
      (new files included), the task text, the user's standing instructions and the review depth.
      The skill passes the reviewer's effort in the Agent tool's `effort` field (set when
      instructions ask for a level; this skill is that instruction). Hard tasks at xhigh/max
      orchestrator effort also get a second, read-only Sol review.
   4. Findings go back to the same implementer with `resume`. Two rounds of disagreement go to the user.
   5. Mark the task done on `/board`.
4. **Finish** through `superpowers:finishing-a-development-branch`.

### 3. `skills/cross-model-dev/routing.md` (user-edited)

- A fenced `json` block is executable config: router backend/model/effort (default `gpt-6-luna`,
  `low`) and the effort bands. An invalid block falls back to the defaults, noted in `why`.
  Everything else in the file is advisory text passed to the router.
- Per-model relative quota weight, input and output separately (advisory).
- Copilot monthly allowance: 200 AI credits (Student plan). The Student plan allows auto model
  selection only, so `model` is not sent for copilot.
- Antigravity models (`agy models`): Gemini 3.8 Flash low/medium/high, Claude Sonnet 4.6,
  Claude Opus 4.6, GPT-OSS 120B. Its Claude models spend Google quota, not Claude quota.
- Effort bands:

| Orchestrator effort | Implementer effort | Reviewer |
|---|---|---|
| low, medium | low to medium | Haiku or Sonnet, low to medium |
| high | medium to high | Sonnet, medium or above |
| xhigh, max | high to xhigh | Sonnet high; hard tasks add a Sol review |

Complexity picks the spot inside the band; quota breaks ties toward the cheapest pick that meets
the band's floor.

## Defaults when routing.md says nothing

| Role | Default |
|---|---|
| Plan review | codex, gpt-6.1-sol, high |
| Implementer | codex, gpt-6.1-sol, by band |
| Reviewer | Sonnet 5.5 (Haiku 5.5 for trivial), by band |
| Router | codex, gpt-6-luna, low |

## Testing

- Unit tests for the mod with fake CLIs and a mocked clock: argv per backend and mode, JSON event
  parsing, structured answers, quota extraction, pace math and stale windows, the clamp and
  router-answer validation, routing.md config, the 90 % rule and override, cooldowns,
  timeout/kill/retry, chunked output, file changes and a lost baseline. Every task also passes
  `tsc --noEmit`.
- Patched agent-radar and mission-control tests: an external agent appears, updates, finishes or
  fails, and leaves the band (staying in the pane's history).
- One end-to-end run on a throwaway repo: a three-task plan through plan review, routing, all
  three backends, review and one resume loop.

## Out of scope for this version

- Enforcement hooks (blocking Opus edits during a run, gating on plan review).
- Live Antigravity quota (Google's internal endpoint; revisit if the CLI exposes it).
- Running external agents in separate worktrees in parallel.
