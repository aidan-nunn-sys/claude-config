import { expect, test } from 'claude-code/testing'

import { buildArgv, OPENCODE_READONLY_AGENTS } from '../hooks/backends'

test('codex read-only with schema', () => {
  expect(buildArgv({ backend: 'codex', model: 'gpt-6.1-sol', effort: 'high', mode: 'read-only', prompt: 'review', dir: '/r', schema: '/s.json' })).toEqual([
    'codex', 'exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '--output-schema', '/s.json', '-C', '/r', '--', 'review',
  ])
})

test('codex write', () => {
  expect(buildArgv({ backend: 'codex', mode: 'write', prompt: 'do', dir: '/r' })).toEqual([
    'codex', 'exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-C', '/r', '--', 'do',
  ])
})

test('codex resume keeps model, effort, sandbox and schema, and drops -C', () => {
  expect(buildArgv({ backend: 'codex', model: 'gpt-6.1-sol', effort: 'high', mode: 'read-only', prompt: 'round 2', schema: '/s.json', resume: 'abc', dir: '/r' })).toEqual([
    'codex', 'exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '--output-schema', '/s.json', '--', 'abc', 'round 2',
  ])
})

test('codex: a prompt starting with - comes after --, so it is not read as a flag', () => {
  expect(buildArgv({ backend: 'codex', mode: 'write', prompt: '- [ ] Step 1' }).slice(-2)).toEqual(['--', '- [ ] Step 1'])
  expect(buildArgv({ backend: 'codex', mode: 'write', prompt: '-', resume: 'abc' }).slice(-3)).toEqual(['--', 'abc', '-'])
})

test('opencode read-only', () => {
  expect(buildArgv({ backend: 'opencode', model: 'opencode/deepseek-v4.1-flash-free', effort: 'max', mode: 'read-only', agent: 'factory-reviewer', prompt: 'review', dir: '/w' })).toEqual([
    'opencode', 'run', '--format', 'json', '--model=opencode/deepseek-v4.1-flash-free', '--variant=max', '--agent=factory-reviewer', '--dir=/w', '--', 'review',
  ])
})

test('opencode resume', () => {
  const argv = buildArgv({ backend: 'opencode', mode: 'read-only', agent: 'factory-reviewer', resume: 'ses_1', prompt: 'p' })
  expect(argv.slice(-3)).toEqual(['--session=ses_1', '--', 'p'])
})

test('opencode never auto-approves', () => {
  expect(buildArgv({ backend: 'opencode', mode: 'read-only', agent: 'factory-reviewer', prompt: 'p' })).not.toContain('--auto')
})

test('opencode refuses write mode', () => {
  expect(() => buildArgv({ backend: 'opencode', mode: 'write', agent: 'factory-reviewer', prompt: 'p' })).toThrow('opencode runs read-only only')
})

test('opencode read-only without an agent is refused', () => {
  expect(() => buildArgv({ backend: 'opencode', mode: 'read-only', prompt: 'p' })).toThrow('opencode read-only needs an agent with edits denied')
})

test('opencode agent must be on the read-only allowlist', () => {
  expect(OPENCODE_READONLY_AGENTS).toEqual(['factory-reviewer'])
  expect(() => buildArgv({ backend: 'opencode', mode: 'read-only', agent: 'build', prompt: 'p' })).toThrow('opencode agent build is not an allowed read-only agent')
})

test('opencode: a value starting with - stays a value', () => {
  const argv = buildArgv({ backend: 'opencode', mode: 'read-only', agent: 'factory-reviewer', model: '-x', dir: '-z', prompt: 'p' })
  expect(argv).toContain('--model=-x')
  expect(argv).toContain('--dir=-z')
})

test('codex write with network', () => {
  const argv = buildArgv({ backend: 'codex', mode: 'write', network: true, prompt: 'do', dir: '/r' })
  expect(argv.join(' ')).toContain('-c sandbox_workspace_write.network_access=true')
})

test('network is ignored in read-only', () => {
  expect(buildArgv({ backend: 'codex', mode: 'read-only', network: true, prompt: 'do', dir: '/r' }).join(' ')).not.toContain('network_access')
})
