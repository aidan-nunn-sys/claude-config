import { expect, test } from 'claude-code/testing'

import { buildArgv } from '../hooks/backends'

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
