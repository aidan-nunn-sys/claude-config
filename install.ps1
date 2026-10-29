# Sets up Claude Code on this Windows machine from the repo. Safe to run again.
# Windows counterpart of install.sh: needs no Python, and links with junctions (no admin needed).
$ErrorActionPreference = 'Stop'

$Repo   = $PSScriptRoot
$Claude = Join-Path $HOME '.claude'
$HomeFwd = $HOME -replace '\\', '/'
New-Item -ItemType Directory -Force (Join-Path $Claude 'skills') | Out-Null

# Links each file in $Src into $Dest. If $Dest does not exist, the whole folder becomes a
# junction so edits and new files land live. Otherwise each file gets a symlink (Developer
# Mode) or a hard link, which goes stale when git rewrites the file: re-run after pulling.
function Link-Folder($Src, $Dest, $Label) {
  $files = Get-ChildItem $Src -Filter *.md -File
  if (-not (Test-Path $Dest)) {
    New-Item -ItemType Directory -Force (Split-Path $Dest) | Out-Null
    New-Item -ItemType Junction -Path $Dest -Target $Src | Out-Null
  } elseif ((Get-Item $Dest).LinkType -ne 'Junction') {
    foreach ($f in $files) {
      $link = Join-Path $Dest $f.Name
      if (Test-Path $link) { Remove-Item $link -Force }
      try { New-Item -ItemType SymbolicLink -Path $link -Target $f.FullName | Out-Null }
      catch { New-Item -ItemType HardLink -Path $link -Target $f.FullName | Out-Null }
    }
  }
  foreach ($f in $files) { "${Label}: $($f.BaseName)" }
}

# Skills: junction each one into ~/.claude/skills.
foreach ($s in Get-ChildItem (Join-Path $Repo 'skills') -Directory) {
  $dest = Join-Path $Claude "skills\$($s.Name)"
  if (Test-Path $dest) {
    if ((Get-Item $dest).Target -notcontains $s.FullName) { "skill: $($s.Name) SKIPPED (~/.claude/skills/$($s.Name) is not this repo's)"; continue }
  } else {
    New-Item -ItemType Junction -Path $dest -Target $s.FullName | Out-Null
  }
  "skill: $($s.Name)"
}

# Agents: Claude subagents and opencode agents.
Link-Folder (Join-Path $Repo 'agents') (Join-Path $Claude 'agents') 'agent'
Link-Folder (Join-Path $Repo 'opencode\agent') (Join-Path $HOME '.config\opencode\agent') 'opencode agent'

# Rulebook: copy only if this machine has none, so local rules are not overwritten.
if (-not (Test-Path (Join-Path $Claude 'rulebook.json'))) {
  Copy-Item (Join-Path $Repo 'settings\rulebook.json') (Join-Path $Claude 'rulebook.json')
  'rulebook: installed'
} else {
  'rulebook: kept existing (diff with settings/rulebook.json)'
}

function Read-Json($Path) {
  (Get-Content $Path -Raw -Encoding UTF8).Replace('${HOME}', $HomeFwd) | ConvertFrom-Json
}
function Write-Json($Path, $Data) {
  $text = ($Data | ConvertTo-Json -Depth 100) + "`n"
  [IO.File]::WriteAllText($Path, $text, (New-Object Text.UTF8Encoding $false))
}
# Deep-merges $B into $A: nested objects merge, everything else is replaced.
function Merge-Json($A, $B) {
  foreach ($p in $B.PSObject.Properties) {
    $cur = $A.PSObject.Properties[$p.Name]
    if ($cur -and $cur.Value -is [PSCustomObject] -and $p.Value -is [PSCustomObject]) {
      Merge-Json $cur.Value $p.Value
    } else {
      $A | Add-Member -NotePropertyName $p.Name -NotePropertyValue $p.Value -Force
    }
  }
}

# settings.json: merge the template in, point CLAUDE_CODE_PLUGIN_DIRS at mods/ (';'-separated
# on Windows), and register the marketplaces and enabled plugins. Hooks and other local keys stay.
$settings = Join-Path $Claude 'settings.json'
if (Test-Path $settings) {
  Copy-Item $settings "$settings.bak-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
  $cur = Read-Json $settings
} else {
  $cur = [PSCustomObject]@{}
}
Merge-Json $cur (Read-Json (Join-Path $Repo 'settings\settings.json'))
Merge-Json $cur (Read-Json (Join-Path $Repo 'plugins\plugins.json'))
$mods = Get-ChildItem (Join-Path $Repo 'mods') -Directory | Sort-Object Name
if (-not $cur.PSObject.Properties['env']) { $cur | Add-Member -NotePropertyName env -NotePropertyValue ([PSCustomObject]@{}) }
$cur.env | Add-Member -NotePropertyName CLAUDE_CODE_PLUGIN_DIRS -NotePropertyValue (($mods | ForEach-Object FullName) -join ';') -Force
Write-Json $settings $cur
'settings: merged; mods: ' + ($mods.Name -join ', ')

# MCP servers: add the ones this machine lacks to ~/.claude.json. A stdio server whose command
# is not on this machine is skipped (headroom's path is a Linux one).
$claudeJson = Join-Path $HOME '.claude.json'
$cur = if (Test-Path $claudeJson) { Read-Json $claudeJson } else { [PSCustomObject]@{} }
if (-not $cur.PSObject.Properties['mcpServers']) { $cur | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([PSCustomObject]@{}) }
$added = $false
foreach ($s in (Read-Json (Join-Path $Repo 'settings\mcp.json')).mcpServers.PSObject.Properties) {
  if ($cur.mcpServers.PSObject.Properties[$s.Name]) { continue }
  if ($s.Value.command -and -not (Get-Command $s.Value.command -ErrorAction SilentlyContinue)) {
    "mcp: $($s.Name) SKIPPED ($($s.Value.command) not found)"; continue
  }
  $cur.mcpServers | Add-Member -NotePropertyName $s.Name -NotePropertyValue $s.Value
  $added = $true
  "mcp: added $($s.Name)" + $(if (($s.Value | ConvertTo-Json -Depth 10) -match '<SET-ME>') { ' (fill in <SET-ME> values)' })
}
if ($added) { Write-Json $claudeJson $cur }

# Marketplace plugins: settings now lists them; installing fetches them.
$claudeExe = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claudeExe) { $claudeExe = Get-Command (Join-Path $HOME '.local\bin\claude.exe') -ErrorAction SilentlyContinue }
if ($claudeExe) {
  foreach ($p in (Read-Json (Join-Path $Repo 'plugins\plugins.json')).enabledPlugins.PSObject.Properties | Where-Object Value) {
    & $claudeExe.Source plugin install $p.Name *> $null
    if ($LASTEXITCODE -eq 0) { "plugin: $($p.Name)" } else { "plugin: $($p.Name) FAILED (install from /plugin)" }
  }
}

''
'Manual steps (see README): mise pin for optimaizr, MCP <SET-ME> values, restart Claude Code.'
