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
| `schema` | optional JSON schema for the final answer |
| `resume` | optional session id to continue (fix loops) |
| `timeoutMs` | default 20 min |

Launches the CLI through `$.process.spawn` (argv, no shell), streams its JSON events into the agent
list, and returns `{ ok, summary, sessionId, filesChanged, quota }`. The full transcript stays in
the CLI's own session store; only the summary enters Claude's context.

| Backend | Command | Read-only | Effort flag | Structured answer | Quota signal |
|---|---|---|---|---|---|
| codex | `codex exec --json -m M -C dir` | `-s read-only` (write: `-s workspace-write`) | `-c model_reasoning_effort=E` | `--output-schema`, `-o` | `rate_limits` event: 5 h and weekly windows |
| copilot | `copilot -p … --output-format json --usage-output-file F` | no read-only mode: never used for plan review | `--reasoning-effort E` | parse final message | AI credits per run from `F`; `--max-ai-credits` cap |
| agy | `agy -p … --output-format stream-json --model M` | `--mode plan` (write: `--mode accept-edits`) | `--effort E` | `--json-schema` | none exposed: quota errors only |

Failures: a CLI that is not logged in or exits non-zero fails fast; the provider is marked
unavailable for the session (auth) or until the reset time it reports (quota; else a 30 min
cooldown). One retry on timeout, then the task goes to the user. No silent fallback to Opus.

**`route`**: pick models for one task.

- Runs `codex exec -m gpt-6-luna -c model_reasoning_effort=low -s read-only --ephemeral` with a
  routing schema. The router model is set in `routing.md`, so it can be swapped.
- Luna's input (kept small; no codebase access):
  - the task text and the files the plan lists for it
  - the orchestrator's current effort, read by the mod from the turn (not reported by Opus)
  - the quota snapshot (below)
  - `routing.md`
  - the user's standing instructions for this run
- Output: `{ complexity: trivial|standard|hard, implementer: {backend, model, effort},
  reviewer: {model, effort}, reviewDepth: spec|spec+quality|adversarial, why }`.
- The mod clamps the answer to the effort band (below). A schema failure or Luna being unavailable
  falls back to the defaults for the band. User instructions override the clamp.

**Quota snapshot**, taken before each `route`:

| Provider | Source |
|---|---|
| Claude | `$.session.usage()` rate-limit windows |
| Codex | last `rate_limits` event from any codex run (5 h and weekly) |
| Copilot | credits spent this month (summed from usage files) vs the 200-credit monthly allowance |
| Antigravity | available, or in cooldown until a time |

Each window is judged by pace: percent used vs percent of the window elapsed. Ahead of pace:
route away. Behind pace near reset: prefer it (quota that resets unused is wasted). A provider at
90 % of any window gets no new work unless the user says so; if all are, the task waits for the user.

**State and UI**: a list of external agents (id, backend, model, effort, task, status, elapsed,
last event, quota snapshot used). The local agent-radar and mission-control copies are patched to
read it, so external agents show in the band, `/radar` and `/mission` with a backend tag.
Hiding Claude Code's native subagent area is attempted through `ui.resolve`; if the element cannot
be identified, it stays and this is reported.

### 2. `skills/cross-model-dev` (skill)

Runs after `superpowers:writing-plans`, in place of `subagent-driven-development`.

1. **Plan review.** `dispatch` codex, Sol, read-only, effort `high` (raised with orchestrator
   effort), schema `{ verdict, blocking[], nits[] }`, prompt: find what will break, what is
   missing, what is wrong in order. Opus revises and re-submits until `blocking` is empty;
   after 3 rounds it goes to the user.
2. **Show the run.** Print each task with its `route` pick in a table. The user can change any of it.
3. **Per task.**
   1. `route` (skipped when the user already fixed the pick).
   2. `dispatch` the implementer in `write` mode.
   3. Review: Sonnet or Haiku through the native Agent tool with the pick's effort, given the
      diff, the task text and the review depth. Hard tasks at xhigh/max orchestrator effort also
      get a second, read-only Sol review.
   4. Findings go back to the same implementer with `resume`. Two rounds of disagreement go to the user.
   5. Mark the task done on `/board`.
4. **Finish** through `superpowers:finishing-a-development-branch`.

### 3. `skills/cross-model-dev/routing.md` (user-edited)

- Router model and effort (default `gpt-6-luna`, `low`).
- Per-model relative quota weight, input and output separately. Copilot multipliers are filled in
  from `~/.copilot/session-store.db` (`assistant_usage_events.multiplier`) where seen.
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

- Unit tests for the mod with fake CLIs: argv per backend and mode, JSON event parsing, quota
  extraction, pace math, the clamp, cooldowns, timeout and retry.
- Patched agent-radar test: an external agent appears, updates and finishes.
- One end-to-end run on a throwaway repo: a three-task plan through plan review, routing, all
  three backends, review and one resume loop.

## Out of scope for this version

- Enforcement hooks (blocking Opus edits during a run, gating on plan review).
- Live Antigravity quota (Google's internal endpoint; revisit if the CLI exposes it).
- Running external agents in separate worktrees in parallel.
