import { expect, test } from 'claude-code/testing'

import { clamp, DEFAULT_CONFIG, defaults, parsePick, readConfig, ROUTE_SCHEMA } from '../hooks/routing'
import { engine, NOW, START } from './engine'

const C = DEFAULT_CONFIG
const OPEN = { claude: { state: 'unknown' }, codex: { state: 'unknown' }, copilot: { state: 'unknown' }, agy: { state: 'unknown' } } as const

test('defaults: Sol implements, Sonnet reviews, Haiku for trivial at low effort', () => {
  expect(defaults('high', C)).toMatchObject({ implementer: { backend: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }, reviewer: { model: 'sonnet', effort: 'medium' } })
  expect(defaults('low', C, 'trivial').reviewer).toEqual({ model: 'haiku', effort: 'low' })
})

test('clamp raises a pick below the band floor and lowers one above the ceiling', () => {
  const low = { ...defaults('high', C), implementer: { backend: 'codex' as const, model: 'gpt-6.1-sol', effort: 'low' as const }, reviewer: { model: 'haiku' as const, effort: 'low' as const } }
  expect(clamp(low, 'high', OPEN as any, NOW, C)).toMatchObject({ implementer: { effort: 'medium' }, reviewer: { model: 'sonnet', effort: 'medium' } })
  const high = { ...defaults('low', C), implementer: { backend: 'codex' as const, model: 'gpt-6.1-sol', effort: 'max' as const } }
  expect(clamp(high, 'low', OPEN as any, NOW, C).implementer.effort).toBe('medium')
})

test('xhigh + hard adds a second Sol review', () => {
  const p = clamp({ ...defaults('xhigh', C), complexity: 'hard' }, 'xhigh', OPEN as any, NOW, C)
  expect(p.secondSolReview).toBe(true)
  expect(p.wait).toBe(null)
})

const AT95 = { state: 'windows', windows: [{ usedPercent: 95, windowMinutes: 300, resetsAt: NOW + 60_000 }] }
const DOWN = { state: 'unavailable', reason: 'x' }

test('a blocked implementer backend moves to the next open one; copilot gets no model', () => {
  const snap = { ...OPEN, codex: AT95, agy: DOWN }
  const p = clamp(defaults('medium', C), 'medium', snap as any, NOW, C)
  expect(p.implementer).toMatchObject({ backend: 'copilot', model: 'auto' })
  expect(p.why).toContain('codex blocked')
  expect(p.wait).toBe(null)
})

test('the 90 % rule: no open implementer, or Claude for the reviewer, means wait', () => {
  const none = clamp(defaults('medium', C), 'medium', { ...OPEN, codex: AT95, agy: DOWN, copilot: AT95 } as any, NOW, C)
  expect(none.wait).toContain('codex, agy, copilot')
  const claude = clamp(defaults('medium', C), 'medium', { ...OPEN, claude: AT95 } as any, NOW, C)
  expect(claude.wait).toContain('claude')
  // the user's override keeps the pick and runs anyway
  const kept = clamp(defaults('medium', C), 'medium', { ...OPEN, claude: AT95, codex: AT95 } as any, NOW, C, true)
  expect(kept).toMatchObject({ wait: null, implementer: { backend: 'codex' } })
  expect(kept.why).toContain('user override')
})

test('a required second Sol review with codex blocked makes the task wait', () => {
  const p = clamp({ ...defaults('xhigh', C), complexity: 'hard', implementer: { backend: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' } }, 'xhigh', { ...OPEN, codex: AT95 } as any, NOW, C)
  expect(p.secondSolReview).toBe(true)
  expect(p.wait).toContain('codex is at 90 %: the second Sol review cannot run')
})

test('bad router output falls back to defaults', () => {
  const { why, ...rest } = parsePick('not json at all', 'medium', C)
  const { why: _, ...expected } = defaults('medium', C)
  expect(rest).toEqual(expected)
  expect(why).toContain('router output unusable')
})

test('a bogus backend falls back, not crashes', () => {
  const bad = { complexity: 'standard', implementer: { backend: 'bogus', model: 'm', effort: 'low' }, reviewer: { model: 'sonnet', effort: 'low' }, reviewDepth: 'spec', why: 'x' }
  expect(parsePick(JSON.stringify(bad), 'medium', C).why).toContain('router output unusable')
  expect(parsePick(JSON.stringify({ ...bad, implementer: { backend: 'codex', model: '', effort: 'low' } }), 'medium', C).why).toContain('router output unusable')
  expect(parsePick(JSON.stringify({ ...bad, implementer: { backend: 'codex', model: 'm', effort: 'low' }, reviewDepth: 'deep' }), 'medium', C).why).toContain('router output unusable')
  expect(() => clamp(parsePick(JSON.stringify(bad), 'medium', C), 'medium', OPEN as any, NOW, C)).not.toThrow()
})

test('routing.md: the json block is config; a broken block falls back with a note', () => {
  const md = '# Routing\n\n```json\n{ "router": { "backend": "codex", "model": "gpt-6-mini", "effort": "low" }, "bands": { "medium": { "impl": ["high", "high"], "review": ["low", "medium"], "haiku": true } } }\n```\nprose'
  const { config, note } = readConfig(md)
  expect(note).toBe(null)
  expect(config.router.model).toBe('gpt-6-mini')
  expect(defaults('medium', config).implementer.effort).toBe('high') // the edited band changes the pick
  expect(config.bands.high).toEqual(C.bands.high) // bands not listed keep their defaults
  expect(readConfig('```json\n{ nope\n```').note).toContain('routing.md config invalid')
  expect(readConfig('```json\n{ "bands": { "low": { "impl": ["low", "huge"], "review": ["low", "low"], "haiku": true } } }\n```').note).toContain('routing.md config invalid')
  expect(readConfig('```json\n{ "bands": { "high": { "impl": ["high", "low"], "review": ["high", "low"], "haiku": false } } }\n```').note).toContain('routing.md config invalid') // reversed range
  expect(readConfig('```json\n{ "router": { "backend": "copilot", "model": "auto", "effort": "low" } }\n```').note).toContain('routing.md config invalid') // copilot cannot run read-only
  expect(readConfig('no block').note).toBe(null)
})

const LUNA = (pick: object) => ({ stream: 'stdout' as const, text: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(pick) } })}\n` })
const MAX_PICK = { complexity: 'standard', implementer: { backend: 'codex', model: 'gpt-6.1-sol', effort: 'max' }, reviewer: { model: 'haiku', effort: 'low' }, reviewDepth: 'spec', why: 'small' }

test('route asks the router read-only in an empty dir and clamps the answer', async ($, on) => {
  engine(on)
  const seen: any[] = []
  on('process.spawn', async function* (_$: any, e: any) {
    seen.push(e)
    yield LUNA(MAX_PICK)
    return { value: { code: 0, signal: null } }
  })
  await $.session.start(START)
  const r: any = await $.tool.call({ tool: 'mcp__xagent__route', task: 'Add a flag' } as any)
  const { pick, effort } = JSON.parse(r.result)
  expect(seen[0].argv).toEqual(expect.arrayContaining(['-m', 'gpt-6-luna', 'sandbox_mode="read-only"', '--ephemeral', '-C', '/home/u/.cache/xagent/router']))
  expect(effort).toBe('medium')
  expect(pick.implementer.effort).toBe('medium') // max clamped to the medium band's ceiling
  expect(pick.why).toBe('small')
})

test('route follows an edited routing.md: router model and band', async ($, on) => {
  const md = '```json\n{ "router": { "backend": "codex", "model": "gpt-6-mini", "effort": "low" }, "bands": { "medium": { "impl": ["low", "low"], "review": ["low", "low"], "haiku": true } } }\n```'
  engine(on, { files: { '/home/u/.claude/skills/cross-model-dev/routing.md': md } })
  const seen: any[] = []
  on('process.spawn', async function* (_$: any, e: any) {
    seen.push(e)
    yield LUNA(MAX_PICK)
    return { value: { code: 0, signal: null } }
  })
  await $.session.start(START)
  const { pick } = JSON.parse(((await $.tool.call({ tool: 'mcp__xagent__route', task: 'Add a flag' } as any)) as any).result)
  expect(seen[0].argv).toEqual(expect.arrayContaining(['-m', 'gpt-6-mini']))
  expect(pick.implementer.effort).toBe('low')
})

test('the orchestrator effort comes from its own turn.step, not a subagent', async ($, on) => {
  engine(on)
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as never
  })
  on('process.spawn', async function* () {
    yield LUNA(MAX_PICK)
    return { value: { code: 0, signal: null } }
  })
  await $.session.start(START)
  for (const step of [{ effort: 'xhigh' }, { effort: 'low', agentId: 'sub-1' }]) {
    const s = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1, ...step } as never)
    while (!(await s.next()).done);
  }
  const { effort, pick } = JSON.parse(((await $.tool.call({ tool: 'mcp__xagent__route', task: 'x' } as any)) as any).result)
  expect(effort).toBe('xhigh')
  expect(pick.implementer.effort).toBe('xhigh') // max clamped to the xhigh band's ceiling
})

test('every enum in the route schema says its type (strict structured output wants one)', () => {
  const untyped: string[] = []
  const walk = (node: any, path: string) => {
    if (!node || typeof node !== 'object') return
    if ('enum' in node && node.type !== 'string') untyped.push(path)
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`)
  }
  walk(ROUTE_SCHEMA, '$')
  expect(untyped).toEqual([])
})
