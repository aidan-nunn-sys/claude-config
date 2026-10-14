import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { EngineInterface, ModelCompleteInput, ModelCompleteResult, Next, On, PaneCloseInput, PaneOpenArgs, PluginState } from 'claude-code'
import { LABEL_SYSTEM } from '../hooks/filer'
import { closePane } from '../hooks/register'

export const NOW = Date.parse('2026-10-13T10:00:00Z')
export const TOOL = 'mcp__task-board__board'
/** Testing Engine cannot dispatch operations. Exercise the registered ui.close
 * handler against state captured from the mounted surface, with a close sink. */
export async function closeInput(f: Fake, origin: PaneCloseInput['origin']['kind']): Promise<void> {
  const values = f.paneState as Record<string, unknown>
  const $ = { state: {
    get: async (ref: { key: string }) => ({ value: values[ref.key], version: 0 }),
    set: async (ref: { key: string }, value: unknown) => {
      values[ref.key] = value
      return { isSet: true, version: 0 }
    },
  } } as unknown as EngineInterface
  await closePane($, { id: 'task-board', origin: { kind: origin } }, (async (e: PaneCloseInput) => {
    f.closed.push(e)
    return { value: undefined }
  }) as Next<'ui.close'>)
}

export type Fake = {
  asks: string[]
  requests: ModelCompleteInput[]
  replies: string[]
  labelRequests: ModelCompleteInput[]
  labelReplies: string[]
  sessionLabel: string | null
  statuses: string[]
  opened: PaneOpenArgs[]
  closed: PaneCloseInput[]
  paneState: Pick<PluginState['task-board'], 'selected' | 'composer' | 'view'>
  clock: MockClock
  store: Map<string, unknown>
  delayMs: number
  failure: 'api-error' | 'aborted'
}

export async function fake($: Engine, on: On, replies: string[] = []): Promise<Fake> {
  const state: Fake = { asks: [], requests: [], replies, labelRequests: [], labelReplies: [], sessionLabel: null, statuses: [], opened: [], closed: [], paneState: { selected: null, composer: null, view: { kind: 'top' } }, clock: mock.clock(on, { now: NOW }), store: new Map(), delayMs: 0, failure: 'api-error' }
  on('state.set', { plugin: 'task-board' }, async ($, e, next) => {
    const result = await next(e)
    if (result.value?.isSet && e.key in state.paneState) (state.paneState as Record<string, unknown>)[e.key] = e.value
    return result
  })
  on('state.set', { plugin: 'task-board', key: 'sessionLabel' }, async ($, e, next) => {
    const result = await next(e)
    if (result.value?.isSet) state.sessionLabel = e.value
    return result
  })
  // The test Engine raises events; store operations are available only on a hook's $.
  on('store.get', ($, e) => ({ value: state.store.get(e.key) }))
  on('store.set', ($, e) => {
    state.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'board' } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__task-board__${e.name}` } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/work/orbit' }))
  on('ui.status', ($, e) => {
    state.statuses.push(String(e.text ?? ''))
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', ($, e) => { state.opened.push(e); return { value: { isPlaced: true } } })
  on('ui.close', ($, e) => { state.closed.push(e); return { value: undefined } })
  on('ui.panes', () => ({ value: [] }))
  on('ui.focus', () => ({}))
  on('model.complete', async ($, e) => {
    const isLabel = e.system === LABEL_SYSTEM
    if (isLabel) state.labelRequests.push(e)
    else {
      state.asks.push(e.prompt)
      state.requests.push(e)
    }
    const text = (isLabel ? state.labelReplies : state.replies).shift()
    if (state.delayMs > 0) await state.clock.sleep(state.delayMs)
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const value: ModelCompleteResult = text !== undefined ? { isAnswered: true, text, usage }
      : state.failure === 'aborted' ? { isAnswered: false, reason: 'aborted', usage }
      : { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage }
    return { value }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: {}, text: 'ok' }))
  await $.session.start({ cwd: '/work/orbit', surface: 'terminal', isInteractive: true })
  return state
}
