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
| `settings/settings.json` | `~/.claude/settings.json` minus plugin dirs, plugins and hooks; `${HOME}` for paths |
| `settings/mcp.json` | User MCP servers, secrets blanked |
| `settings/rulebook.json` | Rulebook mod's hard rules (copied only when the machine has none) |
| `docs/specs/` | Design specs |

## Mods

| Mod | Source | Local changes |
|---|---|---|
| hud | own | prompt hint, context weather bar, cache countdown, kaomoji mascot |
| rulebook | own | hard rules in `~/.claude/rulebook.json`, `/rules`, `mcp__rulebook__add_rule` |
| xagent | own | dispatch/route tools for Codex, Copilot, Antigravity |
| agent-radar | hamzafer/claude-code-mods @ 87f108479bbf | `/radar` runs mid-turn (`immediate`) and toggles closed; shows xagent's external agents |
| blast-radius | hamzafer/claude-code-mods @ 87f108479bbf | 60 s auto-cancel |
| review-watch | hamzafer/claude-code-mods @ 87f108479bbf | none |
| where-am-i | hamzafer/claude-code-mods @ 87f108479bbf | shows only "next" |
| secret-box | ray-amjad/claude-code-mods @ 467b20300d8e | none |
| task-board | MarcoCarnevali/claude-code-mods @ a3e528dd00ce | `/board` (not `/tasks`), no auto-open, mid-turn + toggle |

Upstream commits are the repos' HEAD on 2026-10-14, when this repo was made; installs were
from around then. Read upstream changes before pulling them in.

## Not in this repo

- `~/.claude/.credentials.json` and MCP secrets.
- Managed by other tools: omarchy skills (`diagnose-crash`, `omarchy`, symlinks into
  `/usr/share/omarchy`), `themes/omarchy.json`, the herdr `SessionStart` hook.
- Per-machine state: memory, history, sessions, plans.
- `.claude-plugin/types/` in each mod: SDK types Claude Code writes itself.
