// Pure bookkeeping for the tps mod: buckets of output tokens and generation time, per day per model.
export type Bucket = { tokens: number; ms: number; steps: number }
export type History = Record<string, Record<string, Bucket>> // day -> model -> bucket

// Responses shorter than this are mostly latency, not speed.
export const MIN_TOKENS = 20
export const MIN_MS = 300
const KEEP_DAYS = 90

export const rate = (b: Bucket): number => (b.ms > 0 ? (b.tokens / b.ms) * 1000 : 0)

export function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function record(h: History, model: string, tokens: number, ms: number, now: number): History {
  if (tokens < MIN_TOKENS || ms < MIN_MS) return h
  const d = day(now)
  const b = h[d]?.[model] ?? { tokens: 0, ms: 0, steps: 0 }
  const next: History = { ...h, [d]: { ...h[d], [model]: { tokens: b.tokens + tokens, ms: b.ms + ms, steps: b.steps + 1 } } }
  const days = Object.keys(next).sort()
  for (const old of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete next[old]
  return next
}

// Sums every bucket of each model over the last `days` days (all of them when omitted).
export function byModel(h: History, now: number, days?: number): Record<string, Bucket> {
  const from = days === undefined ? '' : day(now - (days - 1) * 86_400_000)
  const out: Record<string, Bucket> = {}
  for (const [d, models] of Object.entries(h)) {
    if (d < from) continue
    for (const [m, b] of Object.entries(models)) {
      const t = out[m] ?? { tokens: 0, ms: 0, steps: 0 }
      out[m] = { tokens: t.tokens + b.tokens, ms: t.ms + b.ms, steps: t.steps + b.steps }
    }
  }
  return out
}

export function table(h: History, session: Record<string, Bucket>, last: Record<string, number>, now: number): string {
  const today = byModel(h, now, 1)
  const week = byModel(h, now, 7)
  const all = byModel(h, now)
  const models = Object.keys(all).sort((a, b) => rate(all[b]!) - rate(all[a]!))
  if (models.length === 0) return 'No samples yet. Speeds appear after a response of 20+ tokens.'
  const f = (b?: Bucket) => (b && b.steps ? rate(b).toFixed(1) : '·').padStart(7)
  const rows = models.map(m => `${m.padEnd(26)}${(last[m]?.toFixed(1) ?? '·').padStart(7)}${f(session[m])}${f(today[m])}${f(week[m])}${f(all[m])}${String(all[m]!.steps).padStart(7)}`)
  return ['tokens/s (output tokens over streaming time, per model request)', `${'model'.padEnd(26)}${'last'.padStart(7)}${'sess'.padStart(7)}${'today'.padStart(7)}${'7d'.padStart(7)}${'all'.padStart(7)}${'steps'.padStart(7)}`, ...rows].join('\n')
}
