import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { Stash } from '../types'
import { addCard } from '../hooks/lib'
import { ARCHIVE_AFTER_MS, carryOver } from '../hooks/carry'
import { fake, NOW, TOOL } from './fake'

const list = async ($: Engine) => String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)

test('a queued prompt is filed by Haiku; an idle one is not; the prompt passes unchanged', async ($, on) => {
  const f = await fake($, on, ['{"new_goal":"Hide the esc hint"}'])
  const idle = await $.prompt.submit({ text: 'just a question' } as never)
  const queued = await $.prompt.submit({ text: 'also hide the esc hint', turnId: 't1', wait: false } as never)
  expect(queued).toMatchObject({ text: 'also hide the esc hint' })
  expect(idle).toMatchObject({ text: 'just a question' })
  await f.clock.advance(10)
  expect(f.asks).toHaveLength(1)
  expect(f.requests[0]).toMatchObject({ model: 'haiku', effort: 'low', timeoutMs: 10_000 })
  expect(await list($)).toContain('Hide the esc hint')
})

test('a failed Haiku call files the first line as a goal', async ($, on) => {
  const f = await fake($, on)
  await $.prompt.submit({ text: 'Fix the bar\nit flickers', turnId: 't1', wait: false } as never)
  await f.clock.advance(10)
  expect(await list($)).toContain('Fix the bar')
})

test('the inbox tool action answers at once and files through Haiku', async ($, on) => {
  const f = await fake($, on, ['{"new_goal":"Write the plan"}'])
  const r = await $.tool.call({ tool: TOOL, action: 'inbox', text: 'write the implementation plan' } as never)
  expect(String(r.text)).toBe('Sent to the inbox.')
  await f.clock.advance(10)
  expect(await list($)).toContain('Write the plan')
})

test('add with parent files a subtask under a top goal', async ($, on) => {
  await fake($, on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Goal', column: 'doing' } as never)
  const r = await $.tool.call({ tool: TOOL, action: 'add', title: 'Step', parent: 'Goal' } as never)
  expect(String(r.text)).toContain('under "Goal"')
})

test('unfinished goals carry over to the next session in the same directory', async ($, on) => {
  const f = await fake($, on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Unfinished', column: 'doing' } as never)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1' } as never)
  const stored = f.store.get('board:/work/orbit') as { carried: { cards: { title: string }[] }[] }
  expect(stored.carried[0]?.cards.map(c => c.title)).toEqual(['Unfinished'])
})

test('queued slash commands and empty prompts are not filed', async ($, on) => {
  const f = await fake($, on)
  await $.prompt.submit({ text: ' /board', turnId: 't1', wait: false } as never)
  await $.prompt.submit({ text: '  ', turnId: 't1', wait: false } as never)
  await f.clock.settle()
  expect(f.asks).toEqual([])
})

for (const reply of ['not json', '{bad json}', '{"subtask_of":"unknown","title":"x"}', '{"new_goal":"  "}']) {
  test(`invalid filing falls back: ${reply}`, async ($, on) => {
    const f = await fake($, on, [reply])
    await $.tool.call({ tool: TOOL, action: 'inbox', text: 'Fix the thing\nmore detail' } as never)
    await f.clock.settle()
    expect(await list($)).toContain('Fix the thing')
  })
}

test('a timeout result falls back and simultaneous filings both survive', async ($, on) => {
  const f = await fake($, on)
  f.failure = 'aborted'
  f.delayMs = 100
  await $.tool.call({ tool: TOOL, action: 'inbox', text: 'Fix one' } as never)
  await $.tool.call({ tool: TOOL, action: 'inbox', text: 'Fix two' } as never)
  await f.clock.settle()
  await f.clock.advance(100)
  expect(await list($)).toContain('Fix one')
  expect(await list($)).toContain('Fix two')
})

test('Haiku can file under a goal but naming a subtask id falls back', async ($, on) => {
  const f = await fake($, on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Goal', column: 'doing' } as never)
  const goalId = (await list($)).match(/\[(c\w+)\] Goal/)![1]!
  f.replies.push(`{"subtask_of":"${goalId}","title":"Step"}`)
  await $.tool.call({ tool: TOOL, action: 'inbox', text: 'Add a step' } as never)
  await f.clock.settle()
  const text = await list($)
  expect(text).toContain('    - [')
  const subId = text.match(/\[(c\w+)\] Step/)![1]!
  f.replies.push(`{"subtask_of":"${subId}","title":"Invalid child"}`)
  await $.tool.call({ tool: TOOL, action: 'inbox', text: 'Fallback goal' } as never)
  await f.clock.settle()
  expect(await list($)).toMatch(/To do \(1\)\n- \[c\w+\] Fallback goal/)
})

test('a Done-only session makes no carry-over write', async ($, on) => {
  const f = await fake($, on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Finished', column: 'done' } as never)
  const before = f.store.get('board:/work/orbit')
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1' } as never)
  expect(f.store.get('board:/work/orbit')).toBe(before)
})

test('session start expires groups and Haiku labels them; /board reloads after clear', async ($, on) => {
  const f = await fake($, on)
  f.labelReplies.push('"Old task board work"')
  const endedAt = NOW - ARCHIVE_AFTER_MS - 1
  const group = carryOver(addCard([], { title: 'Old goal', source: 'claude' }, endedAt).cards,
    { sessionId: 's0', label: 'fallback', endedAt })!
  f.store.set('board:/work/orbit', { carried: [group], archive: [] })
  await $.session.start({ cwd: '/work/orbit', surface: 'terminal', isInteractive: true })
  await f.clock.settle()
  expect(f.statuses).toEqual(['task-board: archived 1 old group'])
  const stored = f.store.get('board:/work/orbit') as Stash
  expect(stored.carried).toEqual([])
  expect(stored.archive[0]).toMatchObject({ label: 'Old task board work', isLabelled: true })
  expect(stored.archive[0]?.cards[0]?.sessionLabel).toBe('Old task board work')
  // /clear has no session.start; opening /board must read the newly persisted group.
  await $.tool.call({ tool: TOOL, action: 'add', title: 'New unfinished' } as never)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await $.command.run({ command: 'board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  const ui = await $.ui.mount({ plugin: 'task-board', component: 'Pane', requestId: 'task-board', surface: 'terminal', props: {
    title: 'Board', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {},
  } })
  expect(await ui.find({ key: 'carried' })).toBeDefined()
  await ui.unmount()
})
