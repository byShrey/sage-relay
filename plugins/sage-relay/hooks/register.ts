import type { Register } from 'claude-code'

type Effort = 'low' | 'medium' | 'high'
type Pick = { model: string; effort?: Effort }

const NAME = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-4-5-20251001' } as const
// Cheapest last. Under pressure we step one rung down this ladder.
// One effort per model: every model or effort change can cost a fresh cache write.
const LADDER: Pick[] = [
  { model: NAME.opus, effort: 'high' },
  { model: NAME.sonnet, effort: 'medium' },
  { model: NAME.haiku },
]
const LIMIT = 80
const KEEP = 200
// Main chat stays on one model so its saved copy stays warm; hard thinking goes to Opus helpers.
// (The sticky per-message picker this replaced is kept as version 0.2.0 in the plugin cache.)
const MAIN = 1
// Long-chat handoff. Relay's note (whole conversation minus tool output) scored 29/30 in a blind test.
const RELAY_SCRIPT = '/scripts/note.py' // bundled in the plugin, under $.plugin.root
let CEILING = 300_000 // /switch ceiling N changes it for live tests
const MAX_RUN = 2 // handoffs in a row before the person types again
const LIMIT_HARD = 95
const CEILING_FILE = '/.claude/sage-relay/ceiling' // optional file holding one number; lets a live test set the ceiling without typing
const PIN_FILE = '/.claude/sage-relay/pin-models'
const WARN = 250 / 300 // notice at this share of the ceiling
const IDLE_MS = 55 * 60_000 // the saved copy expires after about an hour
const GROWTH = 40_000 // after a handoff, wait for this much growth past the new chat's own start size

export const pick = (rung: number, fiveHour: number): Pick =>
  LADDER[Math.min(rung + (fiveHour >= LIMIT ? 1 : 0), LADDER.length - 1)]!

// Helper type -> rung: planners/reviewers get Opus, read-only searchers Haiku, the rest Sonnet.
export const helperRung = (type: string): number =>
  /plan|architect|design|review/i.test(type) ? 0 : /explore|search|read/i.test(type) ? 2 : 1

// claude-opus-5-5 -> "opus 5.5", claude-haiku-4-5-20251001 -> "haiku 4.5"
const label = (p: Pick): string => {
  const [, name, a, b] = p.model.split('-')
  return `${name} ${a}.${b} ${p.effort ?? ''}`.trim()
}

const S = { due: '' as '' | 'context' | 'limit', busy: false, run: 0, lastTag: '', pending: '', gated: false, prompts: [] as string[], base: 0, last: 0, fresh: false, warned: false, tokens: 0, doneAt: 0 }

// Order matters: every note is built BEFORE /clear, so a failure keeps the chat. Fails open.
export async function handoff($: any) {
  S.busy = true
  const reason = S.due
  try {
    $.ui.status('handing off…')
    const sid = await $.session.id()
    const cwd = await $.session.cwd()
    const git = await $.process.run(['git', 'status', '--short'], { cwd, timeoutMs: 5000 }).then((r: any) => r.stdout.trim() || '(clean)').catch(() => '(git unavailable)')
    const backup = `Facts only (the full note failed).\nLast requests:\n${S.prompts.map(p => `- ${p.slice(0, 300)}`).join('\n')}`
    let body = backup
    let tag = S.lastTag
    try {
      const r = await $.process.run(['/usr/bin/python3', $.plugin.root + RELAY_SCRIPT], { cwd, stdin: JSON.stringify({ cwd, session_id: sid, parent: S.lastTag || undefined }), timeoutMs: 120_000 })
      const o = JSON.parse(r.stdout)
      if (r.exitCode !== 0 || !o.text) throw new Error('relay')
      body = o.text; tag = o.tag
    } catch { $.ui.toast('handoff: full note failed, using a facts-only one') }
    const status = reason === 'limit' || !S.gated ? 'WAIT' : 'CONTINUE'
    S.pending = `STATUS: ${status}\n${status === 'WAIT' ? 'Say where things stand in one line, then wait for the person.' : 'Carry on from the next step in the note.'}\n\nGit status:\n${git}\n\n${body}`
    await $.command.run({ command: 'clear' })
    S.lastTag = tag
    const r = await $.prompt.submit({ text: `Continue from the handoff note below.\n\n${S.pending}`, origin: { kind: 'plugin', name: 'sage-relay' } })
    if ('drop' in r) { $.ui.toast('handoff note not delivered; type /switch resend'); return }
    S.run++
    S.fresh = true; S.base = 0
    $.ui.status(`handed off (${S.run}/${MAX_RUN})`)
    S.pending = ''
  } catch (err) {
    S.pending = ''
    $.ui.status(`handoff failed, chat kept: ${String(err).slice(0, 80)}`)
  } finally {
    S.busy = false; S.due = ''; S.gated = false
  }
}

export const register: Register = on => {
  let text = ''
  let fiveHour = 0
  let base = ''
  let mode: 'auto' | 'off' | Pick = 'off' // model pinning is opt-in: put the word on in ~/.claude/sage-relay/pin-models (or type /switch auto)

  let pinRead = false // the pin file is read once, on first use

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'switch', description: 'Model switchboard', argumentHint: '[opus|sonnet|haiku [low|medium|high]] | auto | off | log' })

    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    text = e.text
    if (e.origin.kind === 'composer' && S.doneAt && S.tokens >= 50_000 && Date.now() - S.doneAt > IDLE_MS) {
      $.ui.toast(`Idle ${Math.round((Date.now() - S.doneAt) / 60_000)} min: the saved copy has likely expired, so this message re-pays ~${Math.round(S.tokens / 1000)}k tokens. /switch handoff starts fresh.`)
    }
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') { S.run = 0; S.prompts.push(e.text); S.prompts.splice(0, S.prompts.length - 6) }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    fiveHour = e.rateLimits.find(r => r.kind === 'five_hour')?.percentUsed ?? 0
    const tokens = e.context.tokens
    if (tokens !== undefined) S.tokens = tokens
    try {
      const n = Number((await $.process.run(['/bin/cat', ((await $.env.get('HOME')) ?? '') + CEILING_FILE], { timeoutMs: 2000 })).stdout.trim())
      if (n >= 1000) CEILING = n
    } catch { /* no file: keep the current ceiling */ }
    const limit = Math.max(Math.min(CEILING, 0.8 * e.context.window), S.base ? S.base + GROWTH : 0) // what actually triggers a handoff
    if (tokens !== undefined && S.fresh) {
      if (tokens < S.last * 0.9) { S.base = tokens; S.fresh = false; S.warned = false } // first reading from the new chat; older ones are stale
    } else if (tokens !== undefined && tokens >= limit) {
      S.due ||= 'context'
      S.last = tokens
    }
    if (fiveHour >= LIMIT_HARD) S.due = 'limit'
    else if (tokens !== undefined && !S.warned && !S.due && tokens >= WARN * limit) {
      S.warned = true
      $.ui.toast(`Chat is at ${Math.round(tokens / 1000)}k tokens; it hands off at ${Math.round(limit / 1000)}k. /switch handoff does it now.`)
    }

    return next(e)
  })

  // Past the line, stop new tool calls so one huge read cannot overshoot; the turn then ends and the handoff runs.
  on('tool.call', ($, e, next) => {
    if (S.due && e.agentId === undefined && !S.busy) { S.gated = true; return { deny: 'Handoff pending: make no more tool calls. Write one line saying where you are.' } }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId === undefined) S.doneAt = Date.now()
    if (e.agentId === undefined && S.due && !S.busy && S.run < MAX_RUN) $.clock.after(0, () => void handoff($))

    return out
  })

  // The session's own model only changes when the person picks one in the menu: then we stop.
  on('turn.step', async function* ($, e, next) {
    if (!pinRead) {
      pinRead = true
      try {
        const v = (await $.process.run(['/bin/cat', ((await $.env.get('HOME')) ?? '') + PIN_FILE], { timeoutMs: 2000 })).stdout.trim()
        if (v === 'on') mode = 'auto'
      } catch { /* no file: pinning stays off */ }
    }
    if (e.agentId !== undefined || mode === 'off') return yield* next(e)
    if (base === '') base = e.model
    if (e.model !== base) { mode = 'off'; $.ui.status('switchboard off: you picked a model'); return yield* next(e) }

    const p = mode === 'auto' ? pick(MAIN, fiveHour) : mode
    if (e.index === 0) { // one line per reply, not per tool step
      const chat = (await $.session.id().catch(() => '?')).slice(0, 4)
      const why = mode === 'auto' ? `${chat} | ${text.slice(0, 40).replace(/\s+/g, ' ')} | 5h ${fiveHour}%` : `${chat} | manual`
      const log = ((await $.store.get('log')) as string[] | undefined) ?? []
      await $.store.set('log', [...log, `${label(p)} | ${why}`].slice(-KEEP))
      $.ui.status(`${label(p)} · ${mode === 'auto' ? 'auto' : 'set'}`)
    }

    return yield* next({ ...e, model: p.model, ...(p.effort ? { effort: p.effort } : {}) })
  })

  // An explicit model from the caller always wins.
  on('agent.spawn', async ($, e, next) => {
    if (!pinRead) {
      pinRead = true
      try {
        const v = (await $.process.run(['/bin/cat', ((await $.env.get('HOME')) ?? '') + PIN_FILE], { timeoutMs: 2000 })).stdout.trim()
        if (v === 'on') mode = 'auto'
      } catch { /* no file: pinning stays off */ }
    }

    return next(e.model !== undefined || mode === 'off' ? e : { ...e, model: pick(helperRung(e.subagentType), fiveHour).model })
  })

  on('command.run', { command: 'switch' }, async ($, e) => {
    const [a = '', b = 'high'] = e.args.trim().toLowerCase().split(/\s+/)
    if (a === 'auto' || a === 'off') { mode = a; if (a === 'auto') base = ''; return { text: `switchboard ${a}` } }
    if (a === 'resend' && S.pending) { await $.prompt.submit({ text: `Continue from the handoff note below.\n\n${S.pending}`, origin: { kind: 'plugin', name: 'sage-relay' } }); S.pending = ''; return { text: 'resent' } }
    if (a === 'handoff') { S.due ||= 'context'; S.gated = true; $.clock.after(0, () => void handoff($)); return { text: 'handoff starting after this turn' } }
    if (a === 'ceiling') { CEILING = Number(b) || 300_000; return { text: `handoff ceiling ${CEILING}` } }
    if (a === 'log') return { text: (((await $.store.get('log')) as string[] | undefined) ?? ['(empty)']).slice(-10).join('\n') }
    if (a in NAME && ['low', 'medium', 'high'].includes(b)) {
      mode = { model: NAME[a as keyof typeof NAME], effort: a === 'haiku' ? undefined : (b as Effort) }

      return { text: `fixed to ${label(mode)} until /switch auto` }
    }

    return { text: 'Usage: /switch opus high | sonnet medium | haiku | auto | off | log' }
  })
}
