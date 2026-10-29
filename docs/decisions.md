# Decisions

Choices made after something broke, with what to do so it doesn't happen again.

## 2026-10-29: rulebook `add_rule` takes `tool_name`, not `tool`

**Problem.** A tool call's envelope already has a `tool` field holding the called
tool's own name. When `add_rule` also took a `tool` argument, the envelope's value
won, so every rule Claude added was stored with `"tool": "mcp__rulebook__add_rule"`.
Those rules never matched a real call. Four of six live rules (confirm before
commit/push, explicit gh owner, both brace rules) were silently off.

**Decision.** The schema field is `tool_name`; the handler stores it as the rule's
`tool`. A test adds a rule and checks that the rule then blocks a real call.

**Next time.** A mod tool's arguments must never use a name the call envelope
already uses (`tool`, `tool_use_id`, ...). After adding a rule, check
`jq -r '.rules[].tool' ~/.claude/rulebook.json` shows the intended tool, and
`/rules reload` so the running session uses the change.

**Known side effect.** `java-braces-edit/write` now fire on every Edit/Write,
not only Java files; a prose line like "for example (see below)" gets denied.
Narrow the `tool`/pattern if it gets in the way.

## 2026-10-29: Claude Code runs the fullscreen renderer

**Problem.** In the classic renderer, headroom's launch banner stayed above the
session, and typing while scrolled up snapped the view to the bottom. Claude also
switches fullscreen off by itself (`fullscreenAutoDisabled` in `~/.claude.json`)
after two "failed starts", and closing the terminal window counts as one. After
that, `"tui": "fullscreen"` in settings is ignored.

**Decision.** `settings.json` has `"tui": "fullscreen"`, and the Omarchy launcher
(omarchy-config, `omarchy-agent-headroom`) passes `CLAUDE_CODE_NO_FLICKER=1`,
which bypasses the auto-disable check.

**Next time.** If the banner or snap-to-bottom comes back, check
`fullscreenAutoDisabled` in `~/.claude.json` and that the launcher still sets the
env var. `/tui default` switches back to the classic renderer.

## 2026-10-29: headroom without Serena; restart the proxy, don't rewrap

**Problem.** A hang plus "Connection refused" looked like a headroom crash. The
proxy was in fact serving fine; `headroom unwrap` stopped it. Rewrapping then
re-registered Serena (headroom's default code memory), which died on a broken
`~/.serena/serena_config.yml`.

**Decision.** `HEADROOM_CODE_MEMORY=none` system-wide (omarchy-config,
`environment.d/headroom.conf`), so no wrap registers Serena. headroom updated to
0.42.0. Details in omarchy-config `DECISIONS.md`.

**Next time.** Check `curl -s 127.0.0.1:8787/readyz`. If it's down, run
`systemctl --user restart headroom-default`; never unwrap and rewrap.
