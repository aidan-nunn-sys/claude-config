#!/usr/bin/env bash
# Sets up Claude Code on this machine from the repo. Safe to run again.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="$HOME/.claude"
mkdir -p "$CLAUDE/skills"

# Skills: symlink each one into ~/.claude/skills.
for s in "$REPO"/skills/*/; do
  [ -d "$s" ] || continue
  name="$(basename "$s")"
  ln -sfn "${s%/}" "$CLAUDE/skills/$name"
  echo "skill: $name"
done

# Rulebook: copy only if this machine has none, so local rules are not overwritten.
if [ ! -e "$CLAUDE/rulebook.json" ]; then
  cp "$REPO/settings/rulebook.json" "$CLAUDE/rulebook.json"
  echo "rulebook: installed"
else
  echo "rulebook: kept existing (diff with settings/rulebook.json)"
fi

# settings.json: merge the template in, point CLAUDE_CODE_PLUGIN_DIRS at mods/,
# and register the marketplaces and enabled plugins. Hooks and other local keys stay.
[ -e "$CLAUDE/settings.json" ] && cp "$CLAUDE/settings.json" "$CLAUDE/settings.json.bak-$(date +%s)"
python3 - "$REPO" "$CLAUDE/settings.json" <<'EOF'
import json, os, sys
repo, path = sys.argv[1], sys.argv[2]
home = os.path.expanduser('~')
def load(p):
    with open(p) as f:
        return json.loads(f.read().replace('${HOME}', home))
cur = load(path) if os.path.exists(path) else {}
def merge(a, b):
    for k, v in b.items():
        a[k] = merge(a.get(k, {}), v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
    return a
merge(cur, load(f'{repo}/settings/settings.json'))
merge(cur, load(f'{repo}/plugins/plugins.json'))
mods = sorted(d for d in os.listdir(f'{repo}/mods') if os.path.isdir(f'{repo}/mods/{d}'))
cur.setdefault('env', {})['CLAUDE_CODE_PLUGIN_DIRS'] = ':'.join(f'{repo}/mods/{m}' for m in mods)
with open(path, 'w') as f:
    json.dump(cur, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('settings: merged; mods:', ', '.join(mods))
EOF

# MCP servers: add the ones this machine lacks to ~/.claude.json.
python3 - "$REPO" <<'EOF'
import json, os, sys
home = os.path.expanduser('~')
path = f'{home}/.claude.json'
cur = json.load(open(path)) if os.path.exists(path) else {}
want = json.loads(open(f'{sys.argv[1]}/settings/mcp.json').read().replace('${HOME}', home))['mcpServers']
servers = cur.setdefault('mcpServers', {})
for name, spec in want.items():
    if name in servers:
        continue
    servers[name] = spec
    print(f'mcp: added {name}' + (' (fill in <SET-ME> values)' if '<SET-ME>' in json.dumps(spec) else ''))
json.dump(cur, open(path, 'w'), indent=2)
EOF

# Marketplace plugins: settings now lists them; installing fetches them.
if command -v claude >/dev/null; then
  python3 -c "import json;[print(k) for k,v in json.load(open('$REPO/plugins/plugins.json'))['enabledPlugins'].items() if v]" |
    while read -r p; do claude plugin install "$p" >/dev/null 2>&1 && echo "plugin: $p" || echo "plugin: $p FAILED (install from /plugin)"; done
fi

echo
echo "Manual steps (see README): mise pin for optimaizr, MCP <SET-ME> values, restart Claude Code."
