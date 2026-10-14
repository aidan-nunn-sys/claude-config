// HUD: one line under the prompt, in place of the permission-mode text.
//   ⏵⏵  ☀ ███▒▒······ 23% ❄ 4:12 ⧗ 41% 2h13m   (•ᴗ•)✎__
// The ⧗ reading is the 5-hour session limit and the time until it resets.
// The mascot follows what Claude is doing (writing to you, thinking, editing, running, reading,
// an agent, idle, asleep), easing from one pose to the next through a blink.
// The context reading and the cache countdown are after hamzafer's context-bar and
// token-weather mods (github.com/hamzafer/claude-code-mods).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Activity, CacheTtl, Context, Limit, Mood, Slice } from '../types'

const FRAME_MS = 600
// A pose is held at least this long, so quick switches (text, tool, text) do not flicker.
const HOLD_MS = 1_200
// The blink shown between two poses.
const BLINK_MS = 300
// Idle this long and the mascot falls asleep.
const SLEEP_MS = 3 * 60_000
const BAR = 10
const ORANGE = '#d97757'
const PALETTE = ['#7aa2f7', '#7dcfff', '#bb9af7', '#9ece6a', '#e0af68', '#f7768e', '#73daca', '#ff9e64']
const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const
const TAIL_BYTES = 1024 * 1024

const WEATHER = [
  { upTo: 25, icon: '☀', color: 'yellow' },
  { upTo: 50, icon: '☁', color: 'cyan' },
  { upTo: 75, icon: '☂', color: 'blue' },
  { upTo: 90, icon: '☇', color: 'magenta' },
  { upTo: Infinity, icon: '↯', color: 'red' },
] as const

const MODES = [
  { pattern: /auto mode on/i, arrows: '⏵⏵', color: 'warning' },
  { pattern: /accept edits on/i, arrows: '⏵⏵', color: 'autoAccept' },
  { pattern: /plan mode on/i, arrows: '⏸', color: 'planMode' },
  { pattern: /bypass permissions on/i, arrows: '⏵⏵', color: 'error' },
] as const
const MODE_TEXT = /(⏵⏵|⏸)?\s*(auto mode|accept edits|plan mode|bypass permissions) on(\s*\([^)]*\))?/i
// Hint parts dropped from the line: the mode cycle key, the interrupt key, and the queued-message notice.
const HIDDEN = /shift\+tab|esc to interrupt|queued|to edit/i

// Each mascot pose loops through its frames; all frames are padded to one width so the line never jumps.
const POSES = {
  idle: ['(•ᴗ•)', '(•ᴗ•)', '(-ᴗ-)', '(•ᴗ•)', '(•ᴗ•)♪', '(•ᴗ•)'],
  thinking: ['(•_•) .', '(•_•) ..', '(•_•) ...', '(・_・)?'],
  writing: ['(•ᴗ•)✎__', '(•ᴗ•)_✎_', '(•ᴗ•)__✎', '(•ᴗ•)_✎_'],
  editing: ['(•̀ᴗ•́)⌨', '(•̀ᴗ•́)⌨.', '(•̀ᴗ•́)⌨..', '(•̀ᴗ•́)⌨.'],
  running: ['(•o•)◐', '(•o•)◓', '(•o•)◑', '(•o•)◒'],
  reading: ['(°_°)⌕', '(°_°) ⌕', '(°-°) ⌕', '(°_°)⌕'],
  agent: ['(•ᴗ•)ﾉ⚑', '(•ᴗ•)ﾉ ⚑', '(•ᴗ•)ノ⚑', '(•ᴗ•)ﾉ ⚑'],
  sad: ['(╥_╥)', '(╥_╥)', '(T_T)', '(╥_╥) .'],
  happy: ['(ᵔᴗᵔ)♪', '\\(ᵔᴗᵔ)/', '(ᵔᴗᵔ)♫', '\\(ᵔᴗᵔ)/'],
  sleeping: ['(-ᴗ-)z', '(-ᴗ-)zZ', '(-ᴗ-)zZz', '(-ᴗ-)zZ'],
} as const
const BLINK = '(-ᴗ-)'
type Pose = keyof typeof POSES
const POSE_WIDTH = 10

const SAD_WORDS = /\b(no+|nope|wrong|stop|undo|revert|broke|broken|ugh|wtf|why did you|that'?s not|didn'?t work|doesn'?t work|not what i)\b/i
const HAPPY_WORDS = /\b(thanks?|thank you|ty|great|perfect|nice|awesome|love it|good job|works|amazing)\b/i

const context = atom({ plugin: 'hud', key: 'context' } as const, null as Context | null)
const lastRequestAt = atom({ plugin: 'hud', key: 'lastRequestAt' } as const, null as number | null)
const ttl = atom({ plugin: 'hud', key: 'ttl' } as const, '5m' as CacheTtl)
const activity = atom({ plugin: 'hud', key: 'activity' } as const, 'idle' as Activity)
const mood = atom({ plugin: 'hud', key: 'mood' } as const, null as Mood | null)
const limit = atom({ plugin: 'hud', key: 'limit' } as const, null as Limit | null)

// The animation clock and the pose on screen; a reload of this file starts them over.
let frame = 0
let ticker: Timer | undefined
let shown: { pose: Pose; since: number; frame: number } | null = null
let lastActiveAt = 0
// The last activity a response chunk set, so a stream of chunks writes the state once.
let streaming: Activity | null = null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    lastActiveAt = await $.clock.now()
    const known = await $.store.get('ttl').catch(() => undefined)
    if (known === '5m' || known === '1h') await update($, ttl, () => known)
    await refreshContext($).catch(() => {})
    await refreshLimit($).catch(() => {})
    ticker?.cancel()
    ticker = $.clock.every(FRAME_MS, () => {
      frame += 1
      void tick($).catch(() => {})
    })
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await update($, lastRequestAt, () => null)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await react($, e.text).catch(() => {})
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e)
    await setActivity($, activityFor(e.tool)).catch(() => {})
    const result = await next(e)
    await afterTool($, e.tool, String((e as { command?: unknown }).command ?? ''), result).catch(() => {})
    return result
  })

  // Claude's response as it streams: visible text is writing to you, thinking is thinking.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    let step = await stream.next()
    while (!step.done) {
      const c = step.value
      if (!e.agentId && (c.kind === 'text' || c.kind === 'thinking')) {
        const a: Activity = c.kind === 'text' ? 'writing' : 'thinking'
        if (a !== streaming) {
          streaming = a
          await setActivity($, a).catch(() => {})
        }
      }
      yield c
      step = await stream.next()
    }
    const result = step.value
    if (!e.agentId && result.stopReason !== null) {
      const now = await $.clock.now()
      await update($, lastRequestAt, () => now)
      await refreshContext($).catch(() => {})
      await refreshLimit($).catch(() => {})
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      await setActivity($, 'idle')
      await refreshContext($).catch(() => {})
      const found = ttlFromTranscript(await readTail($))
      if (found !== null && found !== (await read($, ttl))) {
        await update($, ttl, () => found)
        await $.store.set('ttl', found).catch(() => {})
      }
    }
    return result
  })

  // Pushed after each turn and whenever a rate-limit window moves a whole point.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await setLimit($, e.rateLimits).catch(() => {})
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) await refreshContext($).catch(() => {})
    return result
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const mode = MODES.find(m => m.pattern.test(e.props.hint))
    const rest = e.props.hint
      .replace(MODE_TEXT, '')
      .split('·')
      .map(part => part.trim())
      .filter(part => part !== '' && !HIDDEN.test(part))
      .join(' · ')
    const ctx = await read($, context)
    const since = await read($, lastRequestAt)
    const cacheLeft = since === null ? null : since + TTL_MS[await read($, ttl)] - now
    const face = display(await currentPose($, now, e.props.isWorking), now)
    const lim = await read($, limit)

    return (
      <Box flexDirection="row">
        <Text wrap="truncate-end">
          {mode && <Text color={mode.color}>{`${mode.arrows}  `}</Text>}
          {ctx && weather(ctx)}
          {cacheLeft !== null && cachePart(cacheLeft)}
          {lim && limitPart(lim)}
          <Text color={ORANGE}>{`  ${face}`}</Text>
          {rest !== '' && <Text dimColor>{`   ${rest}`}</Text>}
        </Text>
      </Box>
    )

    function weather(c: Context) {
      const w = WEATHER.find(b => c.percent < b.upTo) ?? WEATHER[4]
      return (
        <Text>
          <Text color={w.color}>{`${w.icon} `}</Text>
          {cells(c.slices, c.window, BAR).map(cell => (
            <Text color={cell.color} dimColor={cell.kind !== 'used'}>{cell.text}</Text>
          ))}
          <Text color={c.percent >= 90 ? 'red' : c.percent >= 70 ? 'yellow' : undefined}>{` ${c.percent}%`}</Text>
        </Text>
      )
    }

    function cachePart(left: number) {
      if (left <= 0) return <Text dimColor>{'  ❄ cold'}</Text>
      return <Text color={left < 60_000 ? 'yellow' : 'cyan'} dimColor={left >= 60_000}>{`  ❄ ${clock(left)}`}</Text>
    }

    function limitPart(l: Limit) {
      const color = l.percent >= 80 ? 'red' : l.percent >= 50 ? 'yellow' : 'green'
      const resets = l.resetsAt === null ? '' : ` ${duration(l.resetsAt - now)}`
      return (
        <Text>
          <Text color={color}>{`  ⧗ ${Math.round(l.percent)}%`}</Text>
          {resets !== '' && <Text dimColor>{resets}</Text>}
        </Text>
      )
    }

  })
}

async function tick($: EngineInterface) {
  $.ui.invalidate('ui.render')
}

async function setActivity($: EngineInterface, a: Activity) {
  lastActiveAt = await $.clock.now()
  if (a === 'idle') streaming = null
  await update($, activity, () => a)
}

async function react($: EngineInterface, text: string) {
  const now = await $.clock.now()
  if (SAD_WORDS.test(text)) await setMood($, 'sad', now + 10_000)
  else if (HAPPY_WORDS.test(text)) await setMood($, 'happy', now + 8_000)
  await setActivity($, 'thinking')
}

async function afterTool($: EngineInterface, tool: string, command: string, result: { deny?: string; isError?: true }) {
  streaming = null
  await setActivity($, 'thinking')
  const now = await $.clock.now()
  if (result.deny !== undefined) await setMood($, 'sad', now + 5_000)
  else if (result.isError) await setMood($, 'sad', now + 4_000)
  else if (tool === 'Bash' && /\b(test|verify|check)\b/.test(command)) await setMood($, 'happy', now + 5_000)
}

async function setMood($: EngineInterface, kind: Mood['kind'], until: number) {
  await update($, mood, () => ({ kind, until }))
}

async function currentPose($: EngineInterface, now: number, isWorking: boolean): Promise<Pose> {
  const m = await read($, mood)
  if (m && m.until > now) return m.kind
  const a = await read($, activity)
  if (a !== 'idle') return a
  if (isWorking) return 'thinking'
  return now - lastActiveAt >= SLEEP_MS ? 'sleeping' : 'idle'
}

// The pose on screen eases toward the wanted one: each pose is held a moment, a change goes
// through a blink, and the new pose starts from its first frame.
function display(wanted: Pose, now: number) {
  if (!shown) shown = { pose: wanted, since: now - BLINK_MS, frame } // the first pose needs no blink
  else if (wanted !== shown.pose && now - shown.since >= HOLD_MS) shown = { pose: wanted, since: now, frame }
  if (now - shown.since < BLINK_MS) return BLINK.padEnd(POSE_WIDTH)
  return pose(shown.pose, frame - shown.frame)
}

export function pose(name: Pose, frame: number) {
  const frames = POSES[name]
  return frames[frame % frames.length]!.padEnd(POSE_WIDTH)
}

export function activityFor(tool: string): Activity {
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return 'editing'
  if (tool === 'Bash') return 'running'
  if (/^(Read|Grep|Glob|WebFetch|WebSearch)$/.test(tool)) return 'reading'
  if (tool === 'Agent' || tool === 'Task') return 'agent'
  return 'thinking'
}

export function clock(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Time left as `2h13m`, or `13m` under an hour.
export function duration(ms: number) {
  const m = Math.max(0, Math.ceil(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

async function refreshLimit($: EngineInterface) {
  const usage = await $.session.usage()
  await setLimit($, usage.rateLimits)
}

async function setLimit($: EngineInterface, limits: { kind: string; percentUsed: number; resetsAt?: string }[]) {
  const five = limits.find(l => l.kind === 'five_hour')
  if (!five) return
  const resetsAt = five.resetsAt ? Date.parse(five.resetsAt) : NaN
  const reading: Limit = { percent: five.percentUsed, resetsAt: Number.isNaN(resetsAt) ? null : resetsAt }
  await update($, limit, () => reading)
}

async function refreshContext($: EngineInterface) {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  if (!b || !(b.rawMaxTokens > 0)) return
  const reading = toContext(b)
  await update($, context, () => reading)
}

export function toContext(b: {
  categories: { name: string; tokens: number; kind: string }[]
  totalTokens: number
  rawMaxTokens: number
  percentage: number
}): Context {
  let n = 0
  const slices: Slice[] = b.categories
    .filter(c => c.kind !== 'deferred' && c.tokens > 0)
    .map(c => ({ tokens: c.tokens, kind: c.kind as Slice['kind'], name: c.name.toLowerCase() }))
    .sort((x, y) => Number(x.kind !== 'used') - Number(y.kind !== 'used'))
    .map(c => ({
      tokens: c.tokens,
      kind: c.kind,
      color: c.kind !== 'used' ? 'gray' : c.name === 'messages' ? ORANGE : PALETTE[n++ % PALETTE.length]!,
    }))
  return { percent: b.percentage, tokens: b.totalTokens, window: b.rawMaxTokens, slices }
}

// The bar as runs of cells: each used slice its proportional share of `width`, the rest free.
// Rounding the running total keeps the filled length true to the overall share; a slice too small for a cell gets none.
export function cells(slices: Slice[], window: number, width: number) {
  const out: { color: string; kind: Slice['kind']; text: string }[] = []
  let used = 0
  let tokens = 0
  for (const s of slices.filter(x => x.kind === 'used')) {
    tokens += s.tokens
    const end = Math.min(width, Math.round((tokens / window) * width))
    if (end > used) out.push({ color: s.color, kind: 'used', text: '█'.repeat(end - used) })
    used = Math.max(used, end)
  }
  if (used < width) out.push({ color: 'gray', kind: 'free', text: '·'.repeat(width - used) })
  return out
}

// The end of this session's transcript, where the last response's cache usage is.
async function readTail($: EngineInterface) {
  try {
    const home = await $.env.get('HOME')
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home ? `${home}/.claude` : undefined)
    if (!configDir) return ''
    const project = (await $.session.root()).replace(/[^a-zA-Z0-9]/g, '-')
    const path = `${configDir}/projects/${project}/${await $.session.id()}.jsonl`
    const { size } = await $.fs.stat(path)
    if (size <= TAIL_BYTES) return await $.fs.read(path)
    const { exitCode, stdout } = await $.process.run(['tail', '-c', String(TAIL_BYTES), path])
    return exitCode === 0 ? stdout : ''
  } catch {
    return ''
  }
}

export function ttlFromTranscript(text: string): CacheTtl | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: any
    try {
      entry = JSON.parse(lines[i] ?? '')
    } catch {
      continue
    }
    if (entry?.type !== 'assistant' || entry.isSidechain || !entry.message?.usage) continue
    const written = entry.message.usage.cache_creation
    if (Number(written?.ephemeral_1h_input_tokens) > 0) return '1h'
    if (Number(written?.ephemeral_5m_input_tokens) > 0) return '5m'
    return null
  }
  return null
}
