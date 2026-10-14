import { expect, test } from 'claude-code/testing'

import { engine, START } from './engine'

test('registers dispatch and route on session start', async ($, on) => {
  const { tools } = engine(on)
  await $.session.start(START)
  expect(tools).toEqual(['dispatch', 'route'])
})
