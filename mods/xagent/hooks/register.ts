// xagent: run Codex, Copilot and Antigravity as workers for a Claude Code session.
//   dispatch runs one external agent; route picks models for a task by quota and complexity.
import type { Register } from 'claude-code'

const DISPATCH_SCHEMA = {
  type: 'object',
  properties: {
    backend: { type: 'string', enum: ['codex', 'copilot', 'agy'] },
    model: { type: 'string' },
    effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
    mode: { type: 'string', enum: ['read-only', 'write'] },
    prompt: { type: 'string' },
    dir: { type: 'string', description: 'working directory, absolute' },
    schema: { type: 'string', description: 'path to a JSON schema file; the full answer comes back as `answer`' },
    resume: { type: 'string', description: 'sessionId from an earlier dispatch, to continue it' },
    timeoutMs: { type: 'number' },
    override: { type: 'boolean', description: 'run on a backend at 90 % of its quota; only when the user said so' },
  },
  required: ['backend', 'mode', 'prompt'],
}

const ROUTE_SCHEMA_IN = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'the task text from the plan' },
    files: { type: 'array', items: { type: 'string' } },
    instructions: { type: 'string', description: "the user's standing instructions for this run" },
    override: { type: 'boolean', description: 'the user allows providers at 90 % of their quota' },
  },
  required: ['task'],
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.tool.register({ name: 'dispatch', description: 'Run one task on an external coding agent (codex, copilot, agy). Returns a short summary, the files it changed and a sessionId for resume.', inputSchema: DISPATCH_SCHEMA }).catch(() => {})
    await $.tool.register({ name: 'route', description: 'Pick implementer and reviewer models and efforts for one plan task, from quota, complexity and the current effort.', inputSchema: ROUTE_SCHEMA_IN }).catch(() => {})
    return r
  })
}
