# claude-config

My Claude Code setup: mods, plugins, skills and settings, so a new machine is one clone away.

## New machine

```sh
git clone git@github-personal:aidan-nunn-sys/claude-config.git ~/Work/personal/claude-config
~/Work/personal/claude-config/install.sh
```

Then:

- Fill in any `<SET-ME>` values `install.sh` reports in `~/.claude.json` (MCP secrets are never committed).
- optimaizr CLI (audited 0.11.0; re-audit before bumping), in `~/.config/mise/config.toml`:
  `"npm:optimaizr" = { version = "0.11.0", allow_low_downloads = true }`
- agent-browser (used by the factory's UX and UI reviewers), in `~/.config/mise/config.toml`:
  `"npm:agent-browser" = "latest"`
- Restart Claude Code.

## After changing settings

Mods and skills are symlinked from this repo, so edits land here directly. Settings changed
through Claude Code live in `~/.claude`; run `./capture.sh` and review `git diff` to bring them back.

## Layout

| Path | What |
|---|---|
| `mods/` | Mods loaded through `CLAUDE_CODE_PLUGIN_DIRS` (built by `install.sh` from this folder) |
| `plugins/plugins.json` | Marketplaces and which marketplace plugins are enabled |
| `skills/` | Personal skills, symlinked into `~/.claude/skills` |
| `agents/` | Claude subagents (`spec-writer`, `approver`), symlinked into `~/.claude/agents` |
| `opencode/agent/` | opencode agents (`factory-reviewer`), symlinked into `~/.config/opencode/agent` |
| `settings/settings.json` | `~/.claude/settings.json` minus plugin dirs, plugins and hooks; `${HOME}` for paths |
| `settings/mcp.json` | User MCP servers, secrets blanked |
| `settings/rulebook.json` | Generic example rules (copied only when the machine has none; not captured) |
| `docs/decisions.md` | Fixes made after breakages, and how to prevent them |
| `docs/specs/` | Design specs |

## Factory

`skills/factory` runs a spec, build, review, approve, PR loop for one job at a time, in
replacenc-erp, ReplaceNCWeb and my-medusa-store. PRs go to `dev`; the owner merges.
Design: `docs/specs/2026-10-19-factory-design.md`.

Commands: `/factory <feature>`, `/factory next`, `/factory approve <job-id>`,
`/factory rework <job-id> <note>`, `/factory retry <job-id>`, `/factory cleanup`.

| Role | Model | Where |
|---|---|---|
| spec-writer | Opus | `agents/spec-writer.md` |
| builder | Codex gpt-6.1-sol, effort high | xagent `dispatch` |
| reviewers (security, UX, UI, code) | opencode deepseek-v4.1-flash-free, variant max | xagent `dispatch` with the `factory-reviewer` agent |
| approver | Opus | `agents/approver.md` |

Each repo's CLAUDE.md or AGENTS.md needs a `## Factory` section; `/factory` refuses to start
without it. Its labels:

- `Setup`: fresh-checkout setup for a worktree.
- `Env links`: git-ignored env files to symlink from the main checkout.
- `Review DB`: the database reviewers may use.
- `Dev server`: how to start the dev server on a given port.
- `Sign-in`: how reviewers sign in to the running app.
- `Validate`: test, type-check, build and lint commands.
- `Post-merge hosts`: where post-merge steps run, for `/factory cleanup`.

## Mods

| Mod | Source | Local changes |
|---|---|---|
| hud | own | prompt hint, context weather bar, cache countdown, kaomoji mascot |
| rulebook | own | hard rules in `~/.claude/rulebook.json`, `/rules`, `mcp__rulebook__add_rule` |
| xagent | own | `dispatch` for Codex and opencode |
| handoff | own | `/handoff [next]` writes a handoff doc to `~/.claude/handoffs/` |
| tps | own | tokens per second in the status line, `/tps` for per-model averages |
| agent-radar | hamzafer/claude-code-mods @ 87f108479bbf | `/radar` runs mid-turn (`immediate`) and toggles closed; shows xagent's external agents |
| mission-control | hamzafer/claude-code-mods @ 87f108479bbf | shows xagent's external agents; code-map view (Haiku diff summaries, headless Chrome) stripped |
| blast-radius | hamzafer/claude-code-mods @ 87f108479bbf | 60 s auto-cancel |
| review-watch | hamzafer/claude-code-mods @ 87f108479bbf | none |
| where-am-i | hamzafer/claude-code-mods @ 87f108479bbf | shows only "next" |
| secret-box | ray-amjad/claude-code-mods @ 467b20300d8e | none |

Upstream commits are the repos' HEAD on 2026-10-14, when this repo was made; installs were
from around then. Read upstream changes before pulling them in.

## Not in this repo

- `~/.claude/.credentials.json` and MCP secrets.
- Managed by other tools: omarchy skills (`diagnose-crash`, `omarchy`, symlinks into
  `/usr/share/omarchy`), `themes/omarchy.json`, the herdr `SessionStart` hook.
- Per-machine state: memory, history, sessions, plans.
- `.claude-plugin/types/` in each mod: SDK types Claude Code writes itself.
- Hiding Claude Code's native subagent area: the mod API exposes no component for it (checked 2026-10-14; Spinner props are word, message, suffix, mode).
