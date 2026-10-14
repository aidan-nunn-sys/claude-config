#!/usr/bin/env bash
# Copies this machine's current Claude Code settings back into the repo.
# Mods and skills are symlinked, so they need no capture. Review `git diff` after.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"

python3 - "$REPO" <<'EOF'
import json, os, sys
repo = sys.argv[1]
home = os.path.expanduser('~')
def write(path, data):
    with open(path, 'w') as f:
        f.write(json.dumps(data, indent=2, ensure_ascii=False).replace(home, '${HOME}') + '\n')

s = json.load(open(f'{home}/.claude/settings.json'))
plugins = {k: s.pop(k, {}) for k in ('extraKnownMarketplaces', 'enabledPlugins')}
s.get('env', {}).pop('CLAUDE_CODE_PLUGIN_DIRS', None)  # install.sh rebuilds it from mods/
if not s.get('env'):
    s.pop('env', None)
s.pop('hooks', None)  # herdr-managed
write(f'{repo}/settings/settings.json', s)
write(f'{repo}/plugins/plugins.json', plugins)

# MCP servers with env/header values blanked: secrets never enter the repo.
servers = json.load(open(f'{home}/.claude.json')).get('mcpServers', {})
for spec in servers.values():
    for sect in ('env', 'headers'):
        if sect in spec:
            spec[sect] = {k: '<SET-ME>' for k in spec[sect]}
write(f'{repo}/settings/mcp.json', {'mcpServers': servers})
EOF

cp "$HOME/.claude/rulebook.json" "$REPO/settings/rulebook.json"
echo "captured; review with: git -C '$REPO' diff"
