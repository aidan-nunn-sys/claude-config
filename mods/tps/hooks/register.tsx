// tps: tokens per second for every model response.
//   status line:  ⚡ 62 t/s · sess 55 · opus
//   /tps:         last, session, today, 7-day and all-time averages per model
// Speed is output tokens over first chunk to response end, per `turn.step` (a model request).
import type { Register } from 'claude-code'

import { byModel, record, rate, table } from './stats'
import type { Bucket, History } from './stats'

const KEY = 'history'

export const register: Register = (on, _options) => {
  let session: Record<string, Bucket> = {}
  const last: Record<string, number> = {}

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tps', description: 'Tokens per second per model: last, session, today, 7d, all-time.', immediate: true })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // Time from the first streamed chunk to the response's end: the wait for the first token is not generation.
    let first = 0
    const stream = next(e)
    let step = await stream.next()
    while (!step.done) {
      if (first === 0) first = await $.clock.now()
      yield step.value
      step = await stream.next()
    }
    const r = step.value
    const u = r.usage
    if (u && first > 0) {
      const now = await $.clock.now()
      const ms = now - first
      const h = ((await $.store.get(KEY)) ?? {}) as History
      const after = record(h, u.model, u.output_tokens, ms, now)
      if (after !== h) {
        await $.store.set(KEY, after)
        const b = session[u.model] ?? { tokens: 0, ms: 0, steps: 0 }
        session = { ...session, [u.model]: { tokens: b.tokens + u.output_tokens, ms: b.ms + ms, steps: b.steps + 1 } }
        last[u.model] = (u.output_tokens / ms) * 1000
        $.ui.status(`⚡ ${last[u.model]!.toFixed(0)} t/s · sess ${rate(session[u.model]!).toFixed(0)} · ${u.model.replace(/^claude-/, '')}`)
      }
    }
    return r
  })

  on('command.run', { command: 'tps' }, async $ => {
    const h = ((await $.store.get(KEY)) ?? {}) as History
    return { text: table(h, session, last, await $.clock.now()) }
  })
}
