import { expect, test } from 'claude-code/testing'

import type { ProviderQuota } from '../types'
import { claudeFromUsage, codexFromRollout, copilotFromNanoAiu, copilotMonthStart, describe, isBlocked, merge, pace } from '../hooks/quota'

const H = 3_600_000
const NOW = Date.UTC(2026, 9, 14, 12)

test('pace: 60 % used with half the window gone is 10 ahead; unknown reset has no pace', () => {
  expect(Math.round(pace({ usedPercent: 60, windowMinutes: 300, resetsAt: NOW + 2.5 * H }, NOW) ?? NaN)).toBe(10)
  expect(pace({ usedPercent: 60, windowMinutes: 300, resetsAt: null }, NOW)).toBe(null)
})

test('blocked at 90 %, active cooldown, unavailable; not when unknown', () => {
  expect(isBlocked({ state: 'windows', windows: [{ usedPercent: 91, windowMinutes: 300, resetsAt: NOW + H }] }, NOW)).toBe(true)
  expect(isBlocked({ state: 'windows', windows: [{ usedPercent: 50, windowMinutes: 300, resetsAt: NOW + H }] }, NOW)).toBe(false)
  expect(isBlocked({ state: 'cooldown', until: NOW + 1 }, NOW)).toBe(true)
  expect(isBlocked({ state: 'cooldown', until: NOW - 1 }, NOW)).toBe(false)
  expect(isBlocked({ state: 'unavailable', reason: 'not logged in' }, NOW)).toBe(true)
})

test('a window past its reset no longer blocks', () => {
  expect(isBlocked({ state: 'windows', windows: [{ usedPercent: 95, windowMinutes: 300, resetsAt: NOW - 1 }] }, NOW)).toBe(false)
  expect(isBlocked({ state: 'windows', windows: [{ usedPercent: 95, windowMinutes: 300, resetsAt: null }] }, NOW)).toBe(true) // live reading, reset unknown: still counts
})

test('an expired cooldown gives way to live data', () => {
  const live: ProviderQuota = { state: 'windows', windows: [{ usedPercent: 10, windowMinutes: 300, resetsAt: NOW + H }] }
  expect(merge({ state: 'cooldown', until: NOW - 1 }, live, NOW)).toEqual(live)
  expect(merge({ state: 'cooldown', until: NOW + H }, live, NOW)).toEqual({ state: 'cooldown', until: NOW + H })
  expect(merge({ state: 'unavailable', reason: 'x' }, live, NOW)).toEqual({ state: 'unavailable', reason: 'x' })
  expect(merge(undefined, live, NOW)).toEqual(live)
})

test('missing data is unknown, not blocked', () => {
  expect(codexFromRollout('')).toEqual({ state: 'unknown' })
  expect(claudeFromUsage([])).toEqual({ state: 'unknown' })
  expect(copilotFromNanoAiu(null, NOW)).toEqual({ state: 'unknown' })
  expect(isBlocked({ state: 'unknown' }, NOW)).toBe(false)
})

test('codex: last rate_limits in a rollout file', () => {
  const line = (p: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: p, window_minutes: 300, resets_at: 1792000000 }, secondary: { used_percent: 9, window_minutes: 10080 } } } })
  expect(codexFromRollout(`${line(1)}\nnoise\n${line(4)}\n`)).toEqual({
    state: 'windows',
    windows: [
      { usedPercent: 4, windowMinutes: 300, resetsAt: 1792000000_000 },
      { usedPercent: 9, windowMinutes: 10080, resetsAt: null },
    ],
  })
})

test('claude: five_hour and seven_day windows', () => {
  expect(claudeFromUsage([{ kind: 'five_hour', percentUsed: 44, resetsAt: '2026-10-14T13:00:00Z' }, { kind: 'seven_day', percentUsed: 20 }])).toEqual({
    state: 'windows',
    windows: [
      { usedPercent: 44, windowMinutes: 300, resetsAt: Date.parse('2026-10-14T13:00:00Z') },
      { usedPercent: 20, windowMinutes: 10080, resetsAt: null },
    ],
  })
})

test('copilot: nano AIU this month against 200 credits; the real month length', () => {
  expect(copilotFromNanoAiu(50e9, NOW)).toEqual({ state: 'windows', windows: [{ usedPercent: 25, windowMinutes: 31 * 24 * 60, resetsAt: Date.UTC(2026, 10, 1) }] })
  const feb = Date.UTC(2027, 1, 10)
  expect(copilotFromNanoAiu(0, feb)).toEqual({ state: 'windows', windows: [{ usedPercent: 0, windowMinutes: 28 * 24 * 60, resetsAt: Date.UTC(2027, 2, 1) }] })
  expect(copilotMonthStart(NOW)).toBe('2026-10-01 00:00:00')
})

test('describe is a few short lines', () => {
  const text = describe({
    claude: { state: 'unknown' },
    codex: { state: 'windows', windows: [{ usedPercent: 60, windowMinutes: 300, resetsAt: NOW + 2.5 * H }, { usedPercent: 99, windowMinutes: 10080, resetsAt: NOW - 1 }] },
    copilot: { state: 'unavailable', reason: 'not logged in' },
    agy: { state: 'cooldown', until: NOW + H },
  }, NOW)
  expect(text).toBe([
    'claude: unknown',
    'codex: 300m window 60% used, 10 ahead of pace, resets in 150m',
    'codex: 10080m window reset passed',
    'copilot: unavailable (not logged in)',
    'agy: cooling down for 60m',
  ].join('\n'))
})
