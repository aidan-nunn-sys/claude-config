// Reads each CLI's JSON lines into one result, and one line of status for the radar.
import type { Backend, Parsed } from '../types'

export const SUMMARY_CAP = 4000
export const STRUCTURED_CAP = 200_000
export const KEEP_CAP = 2 * STRUCTURED_CAP // what feed() keeps of a run's stdout

type J = Record<string, any>

function lines(stdout: string): J[] {
  const out: J[] = []
  for (const l of stdout.split('\n')) {
    try {
      const j = JSON.parse(l)
      if (j && typeof j === 'object') out.push(j)
    } catch {}
  }
  return out
}

export function firstLine(text: string, n: number): string {
  return (text.split('\n')[0] ?? '').slice(0, n)
}

function done(answer: string | null, sessionId: string | null, error: string | undefined, structured: boolean): Parsed {
  const summary = (answer ?? '').trim().slice(0, SUMMARY_CAP)
  if (error) return { ok: false, summary, sessionId, error }
  if (answer === null) return { ok: false, summary: '', sessionId, error: 'no answer in output' }
  if (!structured) return { ok: true, summary, full: answer.trim(), sessionId }
  // A schema answer goes back whole: a cut one is not JSON and would break the plan-review loop.
  const whole = answer.trim()
  if (whole.length > STRUCTURED_CAP) return { ok: false, summary, sessionId, error: 'answer too long' }
  try {
    JSON.parse(whole)
  } catch {
    return { ok: false, summary, sessionId, error: 'answer is not valid JSON' }
  }
  return { ok: true, summary, full: whole, answer: whole, sessionId }
}

export function sessionIdIn(backend: Backend, stdout: string): string | null {
  let id: string | null = null
  for (const j of lines(stdout)) {
    if (backend === 'codex' && j.type === 'thread.started') id = j.thread_id ?? null
    if (backend === 'opencode' && !id && typeof j.sessionID === 'string') id = j.sessionID
  }
  return id
}

export function parse(backend: Backend, stdout: string, structured: boolean): Parsed {
  let answer: string | null = null
  let error: string | undefined
  const sessionId = sessionIdIn(backend, stdout)
  if (backend === 'codex') {
    for (const j of lines(stdout)) {
      if (j.type === 'item.completed' && j.item?.type === 'agent_message') answer = String(j.item.text ?? '')
      if (j.type === 'turn.failed' || j.type === 'error') error = j.error?.message ?? j.message ?? 'codex failed'
    }
  }
  if (backend === 'opencode') {
    for (const j of lines(stdout)) {
      if (j.type === 'text') answer = String(j.part?.text ?? '')
      if (j.type === 'error') error = j.error?.data?.message ?? j.error?.message ?? 'opencode failed'
    }
  }
  return done(answer, sessionId, error, structured)
}

// The lines parse() and sessionIdIn() read. Command output and reasoning are dropped as they stream.
function wanted(backend: Backend, j: J, first: boolean): boolean {
  if (backend === 'codex') return j.type === 'thread.started' || j.type === 'turn.failed' || j.type === 'error' || (j.type === 'item.completed' && j.item?.type === 'agent_message')
  if (backend === 'opencode') return first || j.type === 'text' || j.type === 'error' // the first event carries sessionID
  return false
}

// Takes stdout as it streams. An event can arrive split across chunks, so lines are put back
// together first. Only wanted lines are kept, within KEEP_CAP: the oldest go first, except the
// first, which carries the session id.
export function feed(backend: Backend) {
  let partial = ''
  let size = 0
  const kept: string[] = []
  let first = true
  const take = (line: string): string | null => {
    let j: J
    try {
      j = JSON.parse(line)
    } catch {
      return null
    }
    if (!j || typeof j !== 'object') return null
    const isFirst = first
    first = false
    if (wanted(backend, j, isFirst)) {
      kept.push(line)
      size += line.length + 1
      while (size > KEEP_CAP && kept.length > 1) size -= (kept.splice(1, 1)[0] ?? '').length + 1
    }
    return lastLine(backend, line)
  }
  return {
    // The newest radar status in this chunk, if any.
    push(text: string): string | null {
      const parts = (partial + text).split('\n')
      partial = parts.pop() ?? ''
      if (partial.length > KEEP_CAP) partial = '' // a line that long is never a usable answer
      let status: string | null = null
      for (const l of parts) status = take(l) ?? status
      return status
    },
    // What parse() should read, including a last line that had no newline.
    text(): string {
      if (partial) take(partial)
      partial = ''
      return kept.join('\n')
    },
  }
}

export function lastLine(backend: Backend, line: string): string | null {
  let j: J
  try {
    j = JSON.parse(line)
  } catch {
    return null
  }
  if (backend === 'codex') {
    if (j.item?.type === 'command_execution') return `running ${String(j.item.command).slice(0, 60)}`
    if (j.item?.type === 'file_change') return 'editing files'
    if (j.item?.type === 'agent_message') return 'writing'
    if (j.type === 'turn.started') return 'thinking'
    return null
  }
  if (backend === 'opencode') {
    if (j.type === 'tool_use') return `tool: ${String(j.part?.tool ?? 'unknown').slice(0, 60)}`
    if (j.type === 'text') return 'writing'
    return null
  }
  return null
}
