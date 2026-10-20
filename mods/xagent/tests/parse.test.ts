import { expect, test } from 'claude-code/testing'

import { feed, firstLine, KEEP_CAP, lastLine, parse, sessionIdIn, STRUCTURED_CAP, SUMMARY_CAP } from '../hooks/parse'

const CODEX = [
  '{"type":"thread.started","thread_id":"t-1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done: added tests"}}',
  '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
].join('\n')

const codexSays = (text: string) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })

test('codex: last agent message and thread id', () => {
  expect(parse('codex', CODEX, false)).toEqual({ ok: true, summary: 'done: added tests', full: 'done: added tests', sessionId: 't-1' })
})

test('codex: turn.failed is an error', () => {
  const r = parse('codex', '{"type":"thread.started","thread_id":"t"}\n{"type":"turn.failed","error":{"message":"usage limit reached"}}', false)
  expect(r).toMatchObject({ ok: false, error: 'usage limit reached', sessionId: 't' })
})

test('non-JSON lines are skipped; no answer is a failure', () => {
  expect(parse('codex', 'warning: something\n', false)).toMatchObject({ ok: false, error: 'no answer in output' })
})

test('summary is capped', () => {
  expect(parse('codex', codexSays('x'.repeat(10_000)), false).summary.length).toBe(SUMMARY_CAP)
})

test('a long structured answer is kept whole', () => {
  const long = JSON.stringify({ verdict: 'revise', blocking: Array.from({ length: 200 }, (_, i) => `item ${i} `.repeat(5)), nits: [] })
  expect(long.length).toBeGreaterThan(SUMMARY_CAP)
  const r = parse('codex', codexSays(long), true)
  expect(r.ok).toBe(true)
  expect(r.answer).toBe(long)
  expect(JSON.parse(r.answer ?? '')).toMatchObject({ verdict: 'revise' })
  expect(r.summary.length).toBe(SUMMARY_CAP)
})

test('a structured answer that is not JSON fails', () => {
  expect(parse('codex', codexSays('sure! {"verdict":'), true)).toMatchObject({ ok: false, error: 'answer is not valid JSON' })
  expect(parse('codex', codexSays(`"${'x'.repeat(STRUCTURED_CAP)}"`), true)).toMatchObject({ ok: false, error: 'answer too long' })
})

test('lastLine gives a short radar status; firstLine and sessionIdIn', () => {
  expect(lastLine('codex', '{"type":"item.started","item":{"type":"command_execution","command":"npm test"}}')).toBe('running npm test')
  expect(lastLine('codex', 'not json')).toBe(null)
  expect(firstLine('Task 3: parser\nmore', 80)).toBe('Task 3: parser')
  expect(firstLine('', 80)).toBe('')
  expect(sessionIdIn('codex', '{"type":"thread.started","thread_id":"t-5"}\n')).toBe('t-5')
})

test('feed: an event split across chunks still counts; command output is not kept', () => {
  const f = feed('codex')
  const started = '{"type":"item.started","item":{"type":"command_execution","command":"npm test"}}\n'
  expect(f.push(started.slice(0, 20))).toBe(null)
  expect(f.push(started.slice(20))).toBe('running npm test')
  f.push(`${JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', aggregated_output: 'x'.repeat(50_000) } })}\n`)
  f.push('{"type":"thread.started","thread_id":"t-3"}\n')
  f.push(codexSays('done')) // the last line has no newline
  const text = f.text()
  expect(text.length).toBeLessThan(1_000)
  expect(parse('codex', text, false)).toEqual({ ok: true, summary: 'done', full: 'done', sessionId: 't-3' })
})

test('feed: what is kept stays within KEEP_CAP and keeps the session line', () => {
  const f = feed('codex')
  f.push('{"type":"thread.started","thread_id":"t-1"}\n')
  for (let i = 0; i < 10; i++) f.push(`${codexSays('y'.repeat(100_000))}\n`)
  const text = f.text()
  expect(text.length).toBeLessThanOrEqual(KEEP_CAP)
  expect(sessionIdIn('codex', text)).toBe('t-1')
  expect(parse('codex', text, false).ok).toBe(true)
})

const OC = [
  '{"type":"step_start","sessionID":"ses_A","part":{"type":"step-start"}}',
  '{"type":"text","sessionID":"ses_A","part":{"type":"text","text":"VERDICT: PASS\\n\\n## Findings\\nNone."}}',
  '{"type":"step_finish","sessionID":"ses_A","part":{"type":"step-finish","reason":"stop"}}',
].join('\n')

test('opencode answer is the last text part', () => {
  const r = parse('opencode', OC, false)
  expect(r.ok).toBe(true)
  expect(r.summary.startsWith('VERDICT: PASS')).toBe(true)
})

test('opencode session id', () => {
  expect(sessionIdIn('opencode', OC)).toBe('ses_A')
})

test('opencode multi-step keeps the final step\'s text', () => {
  const two = [
    '{"type":"step_start","sessionID":"ses_A"}',
    '{"type":"text","sessionID":"ses_A","part":{"type":"text","text":"first"}}',
    '{"type":"step_finish","sessionID":"ses_A"}',
    '{"type":"step_start","sessionID":"ses_A"}',
    '{"type":"text","sessionID":"ses_A","part":{"type":"text","text":"final"}}',
    '{"type":"step_finish","sessionID":"ses_A"}',
  ].join('\n')
  expect(parse('opencode', two, false)).toMatchObject({ ok: true, summary: 'final' })
})

test('opencode error event', () => {
  const r = parse('opencode', '{"type":"error","sessionID":"ses_A","error":{"data":{"message":"rate limited"}}}', false)
  expect(r).toMatchObject({ ok: false, error: 'rate limited' })
  expect(parse('opencode', '{"type":"error","error":{"message":"boom"}}', false).error).toBe('boom')
  expect(parse('opencode', '{"type":"error"}', false).error).toBe('opencode failed')
})

test('opencode no text', () => {
  expect(parse('opencode', '{"type":"step_start","sessionID":"ses_A"}', false)).toMatchObject({ ok: false, error: 'no answer in output' })
})

test('opencode feed keeps text, error and the first event only', () => {
  const f = feed('opencode')
  f.push(`${OC}\n{"type":"tool_use","part":{"tool":"read"}}\n`)
  expect(f.text().split('\n').length).toBe(2)
})
