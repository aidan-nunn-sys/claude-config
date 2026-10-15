import { expect, test } from 'claude-code/testing'
import { closeInput, fake, NOW, TOOL } from './fake'
import { addCard } from '../hooks/lib'
import { carryOver, storedGoalKey } from '../hooks/carry'

const PANE = <S extends 'vscode' | 'terminal' | 'desktop'>(surface: S) => ({
  plugin: 'task-board', component: 'Pane', requestId: 'task-board', surface,
  props: { title: 'Board', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}) as const

test('/board opens with closeOnEscape', async ($, on) => {
  const f = await fake($, on)
  await $.command.run({ command: 'board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 80 } })
  expect(f.opened[0]).toMatchObject({ id: 'task-board', closeOnEscape: true })
})

test('a top goal shows its subtask count and opens into its own board', async ($, on) => {
  await fake($, on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Goal', column: 'doing' } as never)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Step A', parent: 'Goal' } as never)
  const ui = await $.ui.mount(PANE('vscode'))
  expect(await ui.find({ type: 'Text', text: /▸ 0\/1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Step A/ })).toBeUndefined()
  const open = (await ui.findAll({ type: 'Button' })).find(b => /Open/.test(String(b.text)))!
  await ui.press({ key: open.key! })
  await ui.press({ key: 'subtasks' })
  expect(await ui.find({ type: 'Text', text: /Step A/ })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /Step A/ })).toBeUndefined()
  await ui.unmount()
})

test('carried over opens, lists groups and pulls a goal in', async ($, on) => {
  const f = await fake($, on)
  const group = carryOver(addCard([], { title: 'Leftover', source: 'claude', column: 'doing', sessionId: 's0' }, NOW - 86_400_000).cards,
    { sessionId: 's0', label: 'Old session work', endedAt: NOW - 86_400_000 })!
  group.isLabelled = true
  const id = group.cards[0]!.id
  f.store.set('board:/work/orbit', { carried: [group], archive: [] })
  await $.session.start({ cwd: '/work/orbit', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(PANE(surface))
    if (surface === 'terminal') {
      await ui.press({ key: 'carried' })
      expect(await ui.find({ type: 'Text', text: /Old session work/ })).toBeDefined()
      await closeInput(f, 'person')
      expect(f.paneState.view).toEqual({ kind: 'top' })
      expect(f.closed).toEqual([])
      await ui.press({ key: 'carried' })
      await ui.press({ key: `pull:${storedGoalKey({ list: 'carried', sessionId: group.sessionId, endedAt: group.endedAt, id })}` })
      await ui.press({ key: 'back' })
    }
    expect(await ui.find({ key: 'carried' })).toBeUndefined()
    await ui.unmount()
  }
  expect(String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)).toContain('Leftover')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: arrows highlight cards, Space opens details, Enter drills, and person close walks up`, async ($, on) => {
    const f = await fake($, on)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'First' } as never)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'Second' } as never)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'Active', column: 'doing' } as never)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'Step A', parent: 'Second' } as never)
    const ui = await $.ui.mount(PANE(surface))
    await ui.resize({ columns: 80, rows: 40 })
    // Click the empty header to give the Client focus without opening a card.
    await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left' })
    await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left' })
    await ui.key({ key: 'down' })
    const second = (await $.tool.call({ tool: TOOL, action: 'list' } as never)).text!.match(/\[(c\w+)\] Second/)![1]!
    const highlighted = await ui.find({ key: `card:${second}`, in: 'columns' })
    expect(highlighted!.props.borderColor).toBe('claude')
    await ui.key({ key: 'right' })
    await ui.key({ key: ' ' })
    expect(await ui.find({ key: 'subtasks' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Active' })).toBeDefined()
    await ui.key({ key: ' ' })
    expect(await ui.find({ key: 'subtasks' })).toBeDefined()
    await closeInput(f, 'person')
    expect(f.paneState.selected).toBeNull()
    expect(f.closed).toEqual([])
    await ui.key({ key: 'left' })
    await ui.key({ key: 'up' })
    await ui.key({ key: 'down' })
    await ui.key({ key: 'return' })
    expect(await ui.find({ key: 'back' })).toBeDefined()
    expect(JSON.stringify(await ui.drawn())).toContain('Step A')
    await ui.key({ key: 'return' })
    expect(await ui.find({ key: 'make-goal' })).toBeDefined()
    await ui.key({ key: 'return' })
    expect(await ui.find({ key: 'make-goal' })).toBeDefined()
    await closeInput(f, 'person')
    expect(f.paneState.selected).toBeNull()
    expect(f.paneState.view).toEqual({ kind: 'goal', id: second })
    await closeInput(f, 'person')
    expect(f.paneState.view).toEqual({ kind: 'top' })
    expect(f.closed).toEqual([])
    await closeInput(f, 'person')
    expect(f.closed.map(e => e.id)).toEqual(['task-board'])
    await ui.unmount()
  })

  test(`${surface}: plugin close passes through even with nested details open`, async ($, on) => {
    const f = await fake($, on)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'Goal' } as never)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'Step', parent: 'Goal' } as never)
    const ui = await $.ui.mount(PANE(surface))
    await ui.key({ key: 'return' })
    await ui.key({ key: ' ' })
    expect(await ui.find({ key: 'make-goal' })).toBeDefined()
    await closeInput(f, 'plugin')
    expect(f.closed.map(e => e.origin.kind)).toEqual(['plugin'])
    await ui.unmount()
  })

  test(`${surface}: archive is accessible by itself and Pull in persists removal`, async ($, on) => {
    const f = await fake($, on)
    const group = carryOver(addCard([], { title: 'Archived goal', source: 'claude', column: 'doing' }, NOW - 20 * 86_400_000).cards,
      { sessionId: 's0', label: 'Archived session work', endedAt: NOW - 20 * 86_400_000 })!
    group.isLabelled = true
    f.store.set('board:/work/orbit', { carried: [], archive: [group] })
    await $.session.start({ cwd: '/work/orbit', surface, isInteractive: true })
    const ui = await $.ui.mount(PANE(surface))
    expect(await ui.find({ key: 'carried' })).toBeUndefined()
    await ui.press({ key: 'archive' })
    expect(await ui.find({ type: 'Text', text: /Archived session work/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /days left/ })).toBeUndefined()
    await closeInput(f, 'person')
    expect(f.paneState.view).toEqual({ kind: 'top' })
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    expect(await ui.find({ key: 'archive' })).toBeDefined()
    await ui.press({ key: 'archive' })
    await ui.press({ key: `pull:${storedGoalKey({ list: 'archive', sessionId: group.sessionId, endedAt: group.endedAt, id: group.cards[0]!.id })}` })
    expect(await ui.find({ type: 'Text', text: 'Nothing here.' })).toBeDefined()
    expect(f.store.get('board:/work/orbit')).toMatchObject({ archive: [] })
    await ui.press({ key: 'back' })
    expect(String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)).toMatch(/To do \(1\)\n- \[c\w+\] Archived goal/)
    await ui.unmount()
  })

  test(`${surface}: inbox stays visible while filing and clears after the reply`, async ($, on) => {
    const f = await fake($, on, ['{"new_goal":"Hide the esc hint"}'])
    f.delayMs = 100
    await $.tool.call({ tool: TOOL, action: 'inbox', text: 'also hide the esc hint' } as never)
    await f.clock.settle()
    const ui = await $.ui.mount(PANE(surface))
    expect(await ui.find({ type: 'Text', text: /✉ Inbox:.*also hide the esc hint.*filing/ })).toBeDefined()
    await f.clock.advance(100)
    expect(await ui.find({ type: 'Text', text: /✉ Inbox:/ })).toBeUndefined()
    expect(JSON.stringify(await ui.drawn())).toContain('✧')
    await ui.unmount()
  })

  test(`${surface}: drill into a goal's draggable subtask board and back`, async ($, on) => {
    await fake($, on)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'Goal' } as never)
    await $.tool.call({ tool: TOOL, action: 'add', title: 'Step A', parent: 'Goal' } as never)
    const listed = String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)
    const id = listed.match(/\[(c\w+)\] Goal/)![1]!
    const ui = await $.ui.mount(PANE(surface))
    await ui.post({ type: 'open', id })
    await ui.press({ key: 'subtasks' })
    expect(await ui.find({ type: 'Text', text: 'Goal' })).toBeDefined()
    expect(JSON.stringify(await ui.drawn())).toContain('Step A')
    await ui.press({ key: 'back' })
    expect(JSON.stringify(await ui.drawn())).not.toContain('Step A')
    await ui.unmount()
  })
}

test('goal-view composer nests new cards; corrections promote and reparent them', async ($, on) => {
  await fake($, on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Goal A' } as never)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Goal B' } as never)
  const listed = String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)
  const a = listed.match(/\[(c\w+)\] Goal A/)![1]!
  const b = listed.match(/\[(c\w+)\] Goal B/)![1]!
  const ui = await $.ui.mount(PANE('vscode'))
  await ui.press({ key: `open:${a}` })
  await ui.press({ key: 'subtasks' })
  await ui.press({ key: 'new' })
  await ui.input({ key: 'title', text: 'New step' })
  const text = String((await $.tool.call({ tool: TOOL, action: 'list' } as never)).text)
  const sub = text.match(/\[(c\w+)\] New step/)![1]!
  expect(text).toContain(`    - [${sub}] New step (To do)`)
  await ui.press({ key: `open:${sub}` })
  await ui.select({ key: 'move-under', value: b })
  expect(await ui.find({ type: 'Text', text: 'New step' })).toBeUndefined()
  await ui.press({ key: 'back' })
  await ui.press({ key: `open:${b}` })
  await ui.press({ key: 'subtasks' })
  await ui.press({ key: `open:${sub}` })
  await ui.press({ key: 'make-goal' })
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: 'New step' })).toBeDefined()
  await ui.unmount()
})
