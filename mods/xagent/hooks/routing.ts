// The routing policy: orchestrator effort sets a band, complexity picks inside it, quota breaks
// ties. The router model proposes; clamp() keeps the proposal inside the band. routing.md's
// json block can change the router and the bands; its prose only informs the router.
import type { Backend, Effort, Snapshot } from '../types'
import { isBlocked } from './quota'

export type Pick = {
  complexity: 'trivial' | 'standard' | 'hard'
  implementer: { backend: Backend; model: string; effort: Effort }
  reviewer: { model: 'sonnet' | 'haiku'; effort: Effort }
  reviewDepth: 'spec' | 'spec+quality' | 'adversarial'
  secondSolReview: boolean
  wait: string | null // set: the task must not start; the skill asks the user
  why: string
}

export type Band = { impl: [Effort, Effort]; review: [Effort, Effort]; haiku: boolean }
export type RoutingConfig = { router: { backend: Backend; model: string; effort: Effort }; bands: Record<Effort, Band> }

const ORDER: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const BACKENDS: Backend[] = ['codex', 'copilot', 'agy']
const ROUTERS: Backend[] = ['codex', 'agy'] // the router runs read-only; copilot has no read-only mode
const COMPLEXITY: Pick['complexity'][] = ['trivial', 'standard', 'hard']
const DEPTHS: Pick['reviewDepth'][] = ['spec', 'spec+quality', 'adversarial']
const REVIEWERS: Pick['reviewer']['model'][] = ['sonnet', 'haiku']

const isEffort = (x: unknown): x is Effort => ORDER.includes(x as Effort)
const rank = (e: string) => Math.max(0, ORDER.indexOf(e as Effort))
const within = (e: Effort, [lo, hi]: [Effort, Effort]): Effort => ORDER[Math.min(Math.max(rank(e), rank(lo)), rank(hi))] ?? lo

const LOW: Band = { impl: ['low', 'medium'], review: ['low', 'medium'], haiku: true }
const HIGH: Band = { impl: ['medium', 'high'], review: ['medium', 'max'], haiku: false }
const TOP: Band = { impl: ['high', 'xhigh'], review: ['high', 'max'], haiku: false }

export const DEFAULT_CONFIG: RoutingConfig = {
  router: { backend: 'codex', model: 'gpt-6-luna', effort: 'low' },
  bands: { low: LOW, medium: LOW, high: HIGH, xhigh: TOP, max: TOP },
}

// A [low, high] effort range, low first.
function isRange(r: unknown): r is [Effort, Effort] {
  return Array.isArray(r) && r.length === 2 && isEffort(r[0]) && isEffort(r[1]) && rank(r[0]) <= rank(r[1])
}

function isBand(b: any): b is Band {
  return b && isRange(b.impl) && isRange(b.review) && typeof b.haiku === 'boolean'
}

export function readConfig(markdown: string): { config: RoutingConfig; note: string | null } {
  const block = /```json\n([\s\S]*?)\n```/.exec(markdown)?.[1]
  if (!block) return { config: DEFAULT_CONFIG, note: null }
  try {
    const j = JSON.parse(block)
    const router = j.router ?? DEFAULT_CONFIG.router
    if (!ROUTERS.includes(router.backend) || typeof router.model !== 'string' || !router.model || !isEffort(router.effort)) throw new Error('router')
    const bands = { ...DEFAULT_CONFIG.bands }
    for (const [k, b] of Object.entries(j.bands ?? {})) {
      if (!isEffort(k) || !isBand(b)) throw new Error(`band ${k}`)
      bands[k] = b
    }
    return { config: { router, bands }, note: null }
  } catch (err) {
    return { config: DEFAULT_CONFIG, note: `routing.md config invalid (${(err as Error).message}); defaults` }
  }
}

export function bandFor(orchestrator: string, c: RoutingConfig): Band {
  return c.bands[isEffort(orchestrator) ? orchestrator : 'medium']
}

// Fallback implementers when the preferred backend is blocked, in order.
const FALLBACK: { backend: Backend; model: string }[] = [
  { backend: 'codex', model: 'gpt-6.1-sol' },
  { backend: 'agy', model: 'gemini-3.8-flash-high' },
  { backend: 'copilot', model: 'auto' },
]

export function defaults(orchestrator: string, c: RoutingConfig, complexity: Pick['complexity'] = 'standard'): Pick {
  const b = bandFor(orchestrator, c)
  return {
    complexity,
    implementer: { backend: 'codex', model: 'gpt-6.1-sol', effort: complexity === 'hard' ? b.impl[1] : b.impl[0] },
    reviewer: { model: b.haiku && complexity === 'trivial' ? 'haiku' : 'sonnet', effort: b.review[0] },
    reviewDepth: complexity === 'trivial' ? 'spec' : complexity === 'hard' ? 'adversarial' : 'spec+quality',
    secondSolReview: false,
    wait: null,
    why: 'defaults',
  }
}

// Keeps a pick inside the band and applies the 90 % rule. `override`: the user allows providers
// at 90 %, so the pick stands as it is.
export function clamp(p: Pick, orchestrator: string, snap: Snapshot, now: number, c: RoutingConfig, override = false): Pick {
  const b = bandFor(orchestrator, c)
  const notes: string[] = []
  const waits: string[] = []
  const blocked = (backend: keyof Snapshot) => !override && isBlocked(snap[backend], now)
  let implementer = { ...p.implementer, effort: within(p.implementer.effort, b.impl) }
  if (blocked(implementer.backend)) {
    notes.push(`${implementer.backend} blocked`)
    const open = FALLBACK.find(f => f.backend !== implementer.backend && !blocked(f.backend))
    if (open) implementer = { ...open, effort: implementer.effort }
    else waits.push(`every implementer is at 90 % or unavailable (${[implementer.backend, ...FALLBACK.map(f => f.backend).filter(x => x !== implementer.backend)].join(', ')})`)
  }
  if (implementer.backend === 'copilot') implementer = { ...implementer, model: 'auto' } // Student plan: auto only
  const reviewer = { model: p.reviewer.model === 'haiku' && !b.haiku ? ('sonnet' as const) : p.reviewer.model, effort: within(p.reviewer.effort, b.review) }
  if (blocked('claude')) waits.push('claude is at 90 %: the reviewer cannot run')
  // A required second Sol review is never dropped: with codex at 90 % the task waits.
  const secondSolReview = rank(orchestrator) >= 3 && p.complexity === 'hard'
  if (secondSolReview && blocked('codex')) waits.push('codex is at 90 %: the second Sol review cannot run')
  if (override) notes.push('user override: 90 % rule off')
  return { ...p, implementer, reviewer, secondSolReview, wait: waits.length ? waits.join('; ') : null, why: [p.why, ...notes].join('; ') }
}

export const ROUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['complexity', 'implementer', 'reviewer', 'reviewDepth', 'why'],
  properties: {
    complexity: { type: 'string', enum: COMPLEXITY },
    implementer: {
      type: 'object', additionalProperties: false, required: ['backend', 'model', 'effort'],
      properties: { backend: { type: 'string', enum: BACKENDS }, model: { type: 'string' }, effort: { type: 'string', enum: ORDER } },
    },
    reviewer: {
      type: 'object', additionalProperties: false, required: ['model', 'effort'],
      properties: { model: { type: 'string', enum: REVIEWERS }, effort: { type: 'string', enum: ORDER } },
    },
    reviewDepth: { type: 'string', enum: DEPTHS },
    why: { type: 'string' },
  },
}

export function routerPrompt(task: string, files: string[], orchestrator: string, quota: string, routing: string, instructions: string): string {
  return [
    'You route one coding task to models. Answer only with JSON matching the schema. You have no repository; judge from the text below.',
    'Rate complexity from the task alone. Prefer the cheapest pick that fits; move work away from providers ahead of pace and toward ones behind pace near reset.',
    `Orchestrator effort: ${orchestrator}`,
    `Quota now:\n${quota}`,
    routing ? `Routing table:\n${routing}` : '',
    instructions ? `User instructions (these win):\n${instructions}` : '',
    `Files: ${files.join(', ') || 'not listed'}`,
    `Task:\n${task}`,
  ].filter(Boolean).join('\n\n')
}

// The router's answer, checked field by field; anything off falls back to the band defaults.
export function parsePick(text: string, orchestrator: string, c: RoutingConfig): Pick {
  try {
    const j = JSON.parse(text)
    const ok =
      COMPLEXITY.includes(j.complexity) &&
      BACKENDS.includes(j.implementer?.backend) &&
      typeof j.implementer?.model === 'string' && j.implementer.model.length > 0 &&
      isEffort(j.implementer?.effort) &&
      REVIEWERS.includes(j.reviewer?.model) &&
      isEffort(j.reviewer?.effort) &&
      DEPTHS.includes(j.reviewDepth) &&
      typeof j.why === 'string'
    if (!ok) throw new Error('fields')
    return {
      complexity: j.complexity,
      implementer: { backend: j.implementer.backend, model: j.implementer.model, effort: j.implementer.effort },
      reviewer: { model: j.reviewer.model, effort: j.reviewer.effort },
      reviewDepth: j.reviewDepth,
      secondSolReview: false,
      wait: null,
      why: j.why,
    }
  } catch {
    return { ...defaults(orchestrator, c), why: 'router output unusable; defaults' }
  }
}
