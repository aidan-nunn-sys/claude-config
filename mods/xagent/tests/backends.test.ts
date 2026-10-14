import { expect, test } from 'claude-code/testing'

import { buildArgv } from '../hooks/backends'

test('codex read-only with schema', () => {
  expect(buildArgv({ backend: 'codex', model: 'gpt-6.1-sol', effort: 'high', mode: 'read-only', prompt: 'review', dir: '/r', schema: '/s.json' })).toEqual([
    'codex', 'exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '--output-schema', '/s.json', '-C', '/r', 'review',
  ])
})

test('codex write', () => {
  expect(buildArgv({ backend: 'codex', mode: 'write', prompt: 'do', dir: '/r' })).toEqual([
    'codex', 'exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-C', '/r', 'do',
  ])
})

test('codex resume keeps model, effort, sandbox and schema, and drops -C', () => {
  expect(buildArgv({ backend: 'codex', model: 'gpt-6.1-sol', effort: 'high', mode: 'read-only', prompt: 'round 2', schema: '/s.json', resume: 'abc', dir: '/r' })).toEqual([
    'codex', 'exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '--output-schema', '/s.json', 'abc', 'round 2',
  ])
})

test('codex ephemeral router call', () => {
  expect(buildArgv({ backend: 'codex', model: 'gpt-6-luna', effort: 'low', mode: 'read-only', prompt: 'route', ephemeral: true })).toContain('--ephemeral')
})

test('copilot never sends a model, and caps credits', () => {
  expect(buildArgv({ backend: 'copilot', model: 'gpt-6.1-sol', effort: 'low', mode: 'write', prompt: 'do', dir: '/r' })).toEqual([
    'copilot', '-p', 'do', '--output-format', 'json', '--allow-all-tools', '--reasoning-effort', 'low', '--max-ai-credits', '30',
  ])
})

test('copilot read-only is refused', () => {
  expect(() => buildArgv({ backend: 'copilot', mode: 'read-only', prompt: 'x' })).toThrow('copilot has no read-only mode')
})

test('agy plan mode with model, effort and resume', () => {
  expect(buildArgv({ backend: 'agy', model: 'gemini-3.8-flash-low', effort: 'low', mode: 'read-only', prompt: 'look', resume: 'c1' })).toEqual([
    'agy', '-p', 'look', '--output-format', 'stream-json', '--mode', 'plan', '--model', 'gemini-3.8-flash-low', '--effort', 'low', '--conversation', 'c1',
  ])
})
