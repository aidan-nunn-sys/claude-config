import { expect, test } from 'claude-code/testing'
import { fake, TOOL } from './fake'
import type { Stash } from '../types'

const WINDOW = 3 * 60_000

test('goal-title changes set a running Haiku label in session state', async ($, on) => {
  const f = await fake($, on)
  f.labelReplies.push('Build the task board')
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Implement board' } as never)
  await f.clock.settle()
  expect(f.labelRequests).toHaveLength(1)
  expect(f.labelRequests[0]).toMatchObject({ model: 'haiku', effort: 'low', timeoutMs: 10_000 })
  expect(f.labelRequests[0]!.prompt).toContain('Implement board')
  expect(f.sessionLabel).toBe('Build the task board')
})

test('labels debounce rapid changes into one trailing call with the latest title set', async ($, on) => {
  const f = await fake($, on)
  f.labelReplies.push('Build the task board', 'Finish the board polish')
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Implement board' } as never)
  await f.clock.settle()
  await f.clock.advance(60_000)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Polish keys' } as never)
  await f.clock.advance(60_000)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Update README' } as never)
  await f.clock.advance(WINDOW - 1)
  expect(f.labelRequests).toHaveLength(1)
  await f.clock.advance(1)
  expect(f.labelRequests).toHaveLength(2)
  expect(f.labelRequests[1]!.prompt).toContain('Polish keys')
  expect(f.labelRequests[1]!.prompt).toContain('Update README')
  expect(f.sessionLabel).toBe('Finish the board polish')
  await f.clock.advance(WINDOW * 2)
  expect(f.labelRequests).toHaveLength(2)
})

test('subtasks, column moves, and duplicate titles do not change the goal-title set', async ($, on) => {
  const f = await fake($, on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Goal' } as never)
  await f.clock.settle()
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Step', parent: 'Goal' } as never)
  await $.tool.call({ tool: TOOL, action: 'move', card: 'Goal', column: 'doing' } as never)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Goal' } as never)
  await f.clock.advance(WINDOW * 2)
  expect(f.labelRequests).toHaveLength(1)
})

test('session.end stores the latest label and cancels trailing work without a model call', async ($, on) => {
  const f = await fake($, on)
  f.labelReplies.push('Build the task board')
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Implement board' } as never)
  await f.clock.settle()
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Polish keys' } as never)
  const before = f.labelRequests.length
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1' } as never)
  const stored = f.store.get('board:/work/orbit') as Stash
  expect(stored.carried[0]).toMatchObject({ label: 'Build the task board', isLabelled: true })
  expect(stored.carried[0]!.cards.every(c => c.sessionLabel === 'Build the task board')).toBe(true)
  expect(f.labelRequests).toHaveLength(before)
  await f.clock.advance(WINDOW * 2)
  expect(f.labelRequests).toHaveLength(before)
})

test('a failed running Haiku call keeps the previous label', async ($, on) => {
  const f = await fake($, on)
  f.labelReplies.push('Build the task board')
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Implement board' } as never)
  await f.clock.settle()
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Polish keys' } as never)
  await f.clock.advance(WINDOW)
  expect(f.labelRequests).toHaveLength(2)
  expect(f.sessionLabel).toBe('Build the task board')
})

test('without a running label, end saves the date fallback and start relabels it', async ($, on) => {
  const f = await fake($, on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Implement board' } as never)
  await f.clock.settle()
  const before = f.labelRequests.length
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  expect(f.labelRequests).toHaveLength(before)
  expect((f.store.get('board:/work/orbit') as Stash).carried[0]).toMatchObject({ label: 'Oct 13 · Implement board', isLabelled: false })
  f.labelReplies.push('Build the task board')
  await $.session.start({ cwd: '/work/orbit', surface: 'terminal', isInteractive: true })
  await f.clock.settle()
  expect((f.store.get('board:/work/orbit') as Stash).carried[0]).toMatchObject({ label: 'Build the task board', isLabelled: true })
})

test('a background label never delays card writes or session.end; late replies cannot replace the saved label', async ($, on) => {
  const f = await fake($, on)
  f.labelReplies.push('Build the task board')
  f.delayMs = 10_000
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Implement board' } as never)
  await f.clock.settle()
  expect(f.labelRequests).toHaveLength(1)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await f.clock.advance(10_000)
  expect((f.store.get('board:/work/orbit') as Stash).carried[0]).toMatchObject({ label: 'Oct 13 · Implement board', isLabelled: false })
})

test('ending an empty board with a pending inbox ask makes no label call while creating its fallback goal', async ($, on) => {
  const f = await fake($, on, ['{"new_goal":"Late title"}'])
  f.delayMs = 10_000
  await $.tool.call({ tool: TOOL, action: 'inbox', text: 'Keep this unfinished ask' } as never)
  await f.clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  expect(f.labelRequests).toHaveLength(0)
  expect((f.store.get('board:/work/orbit') as Stash).carried[0]).toMatchObject({ label: 'Oct 13 · Keep this unfinished ask', isLabelled: false })
  await f.clock.advance(10_000)
  expect(f.labelRequests).toHaveLength(0)
})
