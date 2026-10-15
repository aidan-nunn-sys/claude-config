import { describe, expect, test } from 'claude-code/testing'

import { byModel, rate, record, table } from '../hooks/stats'

const DAY = 86_400_000
const T = Date.UTC(2026, 9, 14, 12)

describe('tps stats', () => {
  test('skips short or instant responses', () => {
    expect(record({}, 'm', 5, 1000, T)).toEqual({})
    expect(record({}, 'm', 100, 50, T)).toEqual({})
  })

  test('sums per model and windows by day', () => {
    let h = record({}, 'opus', 100, 2000, T)
    h = record(h, 'opus', 300, 2000, T)
    h = record(h, 'opus', 600, 2000, T - 3 * DAY)
    h = record(h, 'haiku', 200, 1000, T)
    expect(rate(byModel(h, T, 1).opus!)).toBe(100)
    expect(Math.round(rate(byModel(h, T, 7).opus!))).toBe(167)
    expect(byModel(h, T, 2).opus!.steps).toBe(2)
    expect(rate(byModel(h, T).haiku!)).toBe(200)
  })

  test('keeps 90 days', () => {
    let h = {}
    for (let i = 0; i < 100; i++) h = record(h, 'm', 100, 1000, T - i * DAY)
    expect(Object.keys(h)).toHaveLength(90)
  })

  test('table lists fastest model first', () => {
    let h = record({}, 'slow', 100, 2000, T)
    h = record(h, 'fast', 400, 2000, T)
    const lines = table(h, {}, { fast: 200 }, T).split('\n')
    expect(lines[2]).toMatch(/^fast/)
    expect(lines[3]).toMatch(/^slow/)
  })
})
