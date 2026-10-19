// Quota per provider: windows of used %, pace against elapsed time, and the 90 % stop.
// A window past its reset and a cooldown past its end are old news: they never block.
import type { ProviderQuota, Snapshot, Window } from '../types'

export const BLOCK_AT = 90
const KIND_MINUTES: Record<string, number> = { five_hour: 300, seven_day: 10080 }

const current = (w: Window, now: number) => w.resetsAt === null || w.resetsAt > now

export function pace(w: Window, now: number): number | null {
  if (w.resetsAt === null || w.resetsAt <= now) return null
  const total = w.windowMinutes * 60_000
  const elapsed = Math.min(Math.max(total - (w.resetsAt - now), 0), total)
  return w.usedPercent - (elapsed / total) * 100
}

export function isBlocked(q: ProviderQuota, now: number): boolean {
  if (q.state === 'unavailable') return true
  if (q.state === 'cooldown') return q.until > now
  if (q.state === 'windows') return q.windows.some(w => current(w, now) && w.usedPercent >= BLOCK_AT)
  return false
}

export function merge(mark: ProviderQuota | undefined, live: ProviderQuota, now: number): ProviderQuota {
  if (mark?.state === 'unavailable') return mark
  if (mark?.state === 'cooldown' && mark.until > now) return mark
  return live
}

export function codexFromRollout(text: string): ProviderQuota {
  let last: any = null
  for (const l of text.split('\n')) {
    if (!l.includes('rate_limits')) continue
    try {
      const j = JSON.parse(l)
      if (j.payload?.rate_limits) last = j.payload.rate_limits
    } catch {}
  }
  if (!last) return { state: 'unknown' }
  const windows: Window[] = [last.primary, last.secondary]
    .filter((w: any) => w && typeof w.used_percent === 'number')
    .map((w: any) => ({ usedPercent: w.used_percent, windowMinutes: w.window_minutes ?? 300, resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null }))
  return windows.length ? { state: 'windows', windows } : { state: 'unknown' }
}

export function claudeFromUsage(limits: { kind: string; percentUsed: number; resetsAt?: string }[]): ProviderQuota {
  if (!limits.length) return { state: 'unknown' }
  return {
    state: 'windows',
    windows: limits.map(l => ({ usedPercent: l.percentUsed, windowMinutes: KIND_MINUTES[l.kind] ?? 300, resetsAt: l.resetsAt ? Date.parse(l.resetsAt) : null })),
  }
}

function windowLine(name: string, w: Window, now: number): string {
  if (w.resetsAt !== null && w.resetsAt <= now) return `${name}: ${w.windowMinutes}m window reset passed`
  const p = pace(w, now)
  const lead = p === null ? 'reset time unknown' : p >= 0 ? `${Math.round(p)} ahead of pace` : `${Math.round(-p)} behind pace`
  const resets = w.resetsAt === null ? '' : `, resets in ${Math.round((w.resetsAt - now) / 60_000)}m`
  return `${name}: ${w.windowMinutes}m window ${Math.round(w.usedPercent)}% used, ${lead}${resets}`
}

export function describeOne(name: string, q: ProviderQuota, now: number): string {
  if (q.state === 'unknown') return `${name}: unknown`
  if (q.state === 'unavailable') return `${name}: unavailable (${q.reason})`
  if (q.state === 'cooldown') return q.until > now ? `${name}: cooling down for ${Math.round((q.until - now) / 60_000)}m` : `${name}: unknown`
  return q.windows.map(w => windowLine(name, w, now)).join('\n')
}

export function describe(s: Snapshot, now: number): string {
  return (['claude', 'codex'] as const).map(k => describeOne(k, s[k], now)).join('\n')
}
