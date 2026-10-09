import type { Register } from 'claude-code'

type Effort = 'low' | 'medium' | 'high'
type Pick = { model: string; effort?: Effort }

const NAME = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' } as const // no Haiku: a wrong "not found" costs more than the saving
const KEEP = 200
// Long-chat handoff. Relay's note (whole conversation minus tool output) scored 29/30 in a blind test.
const RELAY_SCRIPT = '/scripts/note.py' // bundled in the plugin, under $.plugin.root
const DEFAULT_CEILING = 300_000
const FLOOR = 20_000 // lowest ceiling /switch ceiling or the file may set
const MAX_RUN = 2 // handoffs in a row before the person types again
const LIMIT_HARD = 95 // 5-hour usage: one notice per limit window, never a clear
const CEILING_FILE = '/.claude/sage-relay/ceiling' // optional file holding one number; lets a live test set the ceiling without typing
const PIN_FILE = '/.claude/sage-relay/pin-models' // legacy: "on" in it switches routing on at first use
const SONNET_FILE = '/.claude/sage-relay/sonnet-default' // "on" in it starts every chat on Sonnet 5.5 medium; off by default
const WARN = 250 / 300 // notice at this share of the handoff point
const IDLE_MS = 55 * 60_000 // the saved copy expires after about an hour
const IDLE_MIN_TOKENS = 50_000 // below this a cold restart is cheap, so no hold
const IDLE_HANDOFF_TOKENS = 80_000 // at or above this an idle chat hands off on its own instead of holding
const NOTE_WAIT_MS = 5_000 // after our clear, the person's messages wait this long for the note to land first
const IDLE_RESEND_MS = 2 * 60_000 // sending again within this long after a hold goes through
const GROWTH = 40_000 // after a handoff, wait for this much growth past the new chat's own start size
const RETRY_GROWTH = 20_000 // after a failed note, try again once the chat has grown this much
const MAX_FAILS = 3 // failed notes in a row before automatic handoff pauses for the chat
const PY_RETRY_MS = 10 * 60_000 // look for python again this long after finding none
const HOLD_MSGS = 50 // messages held while a note builds
const HOLD_CHARS = 100_000 // and their total size
const SESSIONS = 20 // state kept for this many recent chats in one process
const HEAD = 'Continue from the handoff note below.'
const ORIGIN = { kind: 'plugin', name: 'sage-relay' } as const

// Helpers that name no model (routing on only): planners/reviewers get Opus, everything else Sonnet.
// Covers the built-ins exactly too: Plan -> Opus, Explore -> Sonnet.
export const helperModel = (type: string): string =>
  /plan|architect|design|review/i.test(type) ? NAME.opus : NAME.sonnet

// claude-opus-5-5 -> "opus 5.5"
const label = (model: string, effort?: unknown): string => {
  const [, name, a, b] = model.split('-')
  return `${name} ${a}.${b} ${effort ?? ''}`.trim()
}

// Helper types the chat picks by reading their descriptions; always offered, routing on or off.
const EASY = 'Easy questions, edits, explanations and small fixes: do not start a helper, just answer in the main chat. One keyword alone on a trivial ask is not enough.'
const HELPER_PROMPT = "You work alone and start without the chat's history. Do exactly what the brief says, check your own result, and return a short result: the answer, then what you checked, then anything the caller must verify. Do not paste long working."
export const HELPERS = [
  { name: 'deep', model: NAME.opus, effort: 'high', description: `Use Deep for hard thinking: planning, design, architecture, research, comparing options, audits and reviews, root-cause hunting after a failed fix, anything with high stakes (deleting data, money, going public, changing a schema), a new system or many files, or real trade-offs with no obvious answer. Words like plan, design, research, audit, review, migrate, security are clues, but size, stakes and fuzziness decide; two or more signals means use it. ${EASY}` },
  { name: 'careful', model: NAME.sonnet, effort: 'high', description: `Use Careful for well-defined multi-step work that needs more care than a quick edit: tests for known code, a one-file refactor, summarizing several documents, debugging with a clear repro. ${EASY}` },
  { name: 'scout', model: NAME.sonnet, description: `Use Scout for finding, listing, reading and searching with no judgement needed. ${EASY}` },
].map(h => ({ ...h, prompt: HELPER_PROMPT, omitClaudeMd: true as const, maxTurns: h.name === 'scout' ? 20 : 40, ...(h.name === 'scout' && { tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'] }) })) // ponytail: no rules file in helpers (the brief carries what matters); Scout is read-only

const fresh = () => ({ due: '' as '' | 'context' | 'manual', scheduled: false, busy: false, cleared: false, run: 0, lastTag: '', pending: '', gated: false, queue: [] as string[], base: 0, last: 0, fresh: false, warned: false, tokens: 0, window: 0, doneAt: 0, auto: true, fixed: undefined as Pick | undefined, menu: '', text: '', reg: false, routing: undefined as boolean | undefined, cmd: undefined as { v: number; t: number } | undefined, fails: 0, retryAt: 0, idleHeldAt: 0, pinTried: false, clearAt: 0 })
type St = ReturnType<typeof fresh>
// State per chat: one module may serve several open chats. Oldest dropped past SESSIONS.
export const M = new Map<string, St>()
const stOf = (sid: string): St => {
  const s = M.get(sid) ?? fresh()
  M.delete(sid); M.set(sid, s)
  if (M.size > SESSIONS) M.delete(M.keys().next().value!)
  return s
}
const st = async ($: any) => stOf(await $.session.id().catch(() => '?'))
// Per process: the ceiling file, the account-wide 5-hour reading, the routing default, python. Everything else is per chat.
let tick = 0 // orders writes: a later write (file change or command) wins
let file: { v: number | null; t: number } = { v: null, t: 0 }
let fileSeen: string | null | undefined // ceiling file content at the last read
let fiveHour = 0
let limitNoticed = false
let routingDefault: boolean | undefined // undefined until first use reads the legacy pin file
let PY: string | null | undefined // the python that starts; null = none, handoff disabled
let pyAt = 0 // when python was last probed

// This chat's ceiling: its own /switch ceiling if that is the latest write, else the file, else the default.
const ceilOf = (S: St): { v: number; src: 'default' | 'file' | 'command' } =>
  S.cmd && S.cmd.t >= file.t ? { v: S.cmd.v, src: 'command' } : file.v !== null ? { v: file.v, src: 'file' } : { v: DEFAULT_CEILING, src: 'default' }
const point = (S: St) => Math.min(Math.max(Math.min(ceilOf(S).v, 0.8 * (S.window || Infinity)), S.base ? S.base + GROWTH : 0), 0.95 * (S.window || Infinity)) // what actually triggers a handoff
const willRun = (S: St) => S.auto && S.run < MAX_RUN && PY !== null
const readHome = async ($: any, p: string): Promise<string | null> => {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  if (!home) return null
  try { return await $.fs.read(home + p) } catch { return null }
}
const routingOn = async ($: any, S: St) => S.routing ?? (routingDefault ??= (await readHome($, PIN_FILE))?.trim() === 'on')

async function syncCeiling($: any) {
  const raw = await readHome($, CEILING_FILE)
  if (raw === fileSeen) return
  fileSeen = raw
  const t = raw?.trim() ?? ''
  if (/^\d+$/.test(t) && +t >= FLOOR) file = { v: +t, t: ++tick }
  else if (raw === null) file = { ...file, v: null } // deleted: back to the default, but a later command still wins
}

// Python is probed once; if none was found, again after PY_RETRY_MS (called from measure and /switch handoff).
const retryPy = () => { if (PY === null && Date.now() - pyAt > PY_RETRY_MS) PY = undefined }
async function python($: any): Promise<string | null> {
  if (PY !== undefined) return PY
  pyAt = Date.now()
  for (const py of ['python3', 'python', 'py', '/usr/bin/python3']) { // macOS's stub /usr/bin/python3 without developer tools fails the probe
    const r = await $.process.run([py, '-c', 'import sys;print(1 if sys.version_info>=(3,9) else 0)'], { timeoutMs: 10_000 }).catch(() => null)
    if (r?.exitCode === 0 && r.stdout.trim() === '1') return (PY = py)
  }
  return (PY = null)
}

async function gitStatus($: any, cwd: string): Promise<string> {
  const r = await $.process.run(['git', '-c', 'core.fsmonitor=false', 'status', '--porcelain'], { cwd, timeoutMs: 2000 }).catch(() => null)
  if (!r) return '(git unavailable)'
  if (r.exitCode !== 0) return '(not a git repo)'
  const lines: string[] = r.stdout.split('\n').map((l: string) => l.trimEnd()).filter(Boolean) // keep the leading status column
  return lines.length ? lines.slice(0, 20).join('\n').slice(0, 3000) + (lines.length > 20 ? `\n+${lines.length - 20} more` : '') : '(clean)'
}

// The note, or why it failed. Never clears anything.
async function buildNote($: any, S: St): Promise<{ tag: string; text: string } | string> {
  const py = await python($)
  if (!py) return 'no python3'
  try {
    const cwd = await $.session.cwd()
    const r = await $.process.run([py, '-I', $.plugin.root + RELAY_SCRIPT], { cwd, stdin: JSON.stringify({ cwd, session_id: await $.session.id(), parent: S.lastTag || undefined }), timeoutMs: 120_000 })
    const o = r.exitCode === 0 ? JSON.parse(r.stdout) : null
    return o?.text && o.tag ? o : (r.stderr.trim() || 'empty note').slice(0, 120)
  } catch (err) { return String(err).slice(0, 120) }
}

// Last finished turn per chat (time and size), kept in the store so it survives an engine restart.
type Idle = Record<string, { t: number; tokens: number }>
const idleMap = async ($: any): Promise<Idle> => ((await $.store.get('idle').catch(() => undefined)) as Idle | undefined) ?? {}
async function rememberIdle($: any, t: number, tokens: number) {
  const m = await idleMap($)
  m[await $.session.id().catch(() => '?')] = { t, tokens }
  const keep = Object.entries(m).sort((a, b) => b[1].t - a[1].t).slice(0, SESSIONS)
  await $.store.set('idle', Object.fromEntries(keep)).catch(() => {})
}

// Sends the pending note; it stays pending until a submit goes through.
async function resend($: any, S: St): Promise<boolean> {
  const r = await $.prompt.submit({ text: `${HEAD}\n\n${S.pending}`, origin: ORIGIN }).catch(() => ({ drop: 'failed' }))
  if (r.drop !== undefined) { $.ui.status('chat cleared, type /switch resend'); $.ui.toast('Handoff note not delivered: chat cleared, type /switch resend'); return false }
  S.pending = ''
  return true
}

// Order matters: the note is built BEFORE /clear, so a failure keeps the chat.
export async function handoff($: any, S: St) {
  S.scheduled = false
  if (S.busy) return
  S.busy = true; S.cleared = false; S.last = S.tokens
  try {
    $.ui.status('handing off…')
    const cwd = await $.session.cwd()
    const [git, note] = await Promise.all([gitStatus($, cwd), buildNote($, S)])
    if (typeof note === 'string') {
      if (PY === null) $.ui.toast('Sage Relay: handoff needs python3. Automatic handoff is off; the chat is kept.')
      else if (++S.fails >= MAX_FAILS) { S.auto = false; $.ui.toast(`Sage Relay: note failed ${S.fails} times, chat kept (${note}). Automatic handoff paused for this chat; /switch handoff tries again.`) }
      else { S.retryAt = S.tokens + RETRY_GROWTH; $.ui.toast(`Sage Relay: note failed, chat kept (${note}). Trying again after ${RETRY_GROWTH / 1000}k more tokens (${S.fails}/${MAX_FAILS}).`) }
      $.ui.status('note failed, chat kept')
      return
    }
    const status = S.due === 'context' && S.gated ? 'CONTINUE' : 'WAIT'
    const old = await $.session.id()
    await $.command.run({ command: 'clear' })
    S.cleared = true; S.clearAt = Date.now(); S.lastTag = note.tag; S.run++; S.fresh = true; S.base = 0; S.warned = false; S.reg = false; S.fails = 0; S.retryAt = 0
    M.delete(old); M.set(await $.session.id().catch(() => old), S) // the new chat carries this state
    const typed = S.queue.length ? `\n\nWhile the handoff ran, the person also typed:\n${S.queue.map(q => `- ${q}`).join('\n')}` : ''
    S.pending = `STATUS: ${status}\n${status === 'CONTINUE' ? 'Carry on from the next step in the note.' : S.queue.length ? "First show the person the note's 'Where it stopped' section in full, word for word. Then answer what they typed, listed at the end." : "First show the person the note's 'Where it stopped' section in full, word for word. Then say where things stand in one line and wait for them."}\n\nGit status:\n${git}\n\n${note.text}${typed}`
    if (await resend($, S)) $.ui.status(`handed off (${S.run}/${MAX_RUN})`)
  } catch (err) {
    $.ui.status(S.cleared ? 'chat cleared, type /switch resend' : `handoff failed, chat kept: ${String(err).slice(0, 80)}`)
  } finally {
    // Messages held while the note was built go back in if the chat was kept.
    if (!S.cleared && S.queue.length) void $.prompt.submit({ text: S.queue.join('\n\n'), origin: ORIGIN }).catch(() => {})
    S.busy = false; S.due = ''; S.gated = false; S.queue = []
  }
}

// /switch is registered once per process. A chat that was open before an engine restart gets no session.start, so the first message registers it too.
let cmdRegistered = false
const regCommand = async ($: any) => {
  if (cmdRegistered) return
  cmdRegistered = true
  await $.command.register({ name: 'switch', description: 'Sage Relay: handoff and routing', argumentHint: 'status | note | handoff [on|off] | resend | ceiling N | routing on|off | log' }).catch(() => { cmdRegistered = false })
}

const regHelpers = async ($: any, S: St) => {
  await regCommand($)
  if (S.reg) return
  S.reg = true
  S.reg = await Promise.all(HELPERS.map(h => $.agent.register(h))).then(() => true, () => false)
}

// prompt.submit: while the note builds, hold what the person types (it goes to the new chat); returns the drop, or nothing to pass it on.
async function holdMessage($: any, e: any): Promise<{ drop: string } | { context: string } | undefined> {
  if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return
  const S = await st($)
  if ((S.busy || S.scheduled) && !S.cleared) { // scheduled too: a second message sent before the handoff starts must not land in the old chat
    if (S.queue.length >= HOLD_MSGS || S.queue.reduce((n, q) => n + q.length, 0) + e.text.length > HOLD_CHARS) return { drop: 'Handoff is running and the hold is full. Wait for the new chat, then send this again.' }
    S.queue.push(e.text)
    return { drop: 'Held: it goes to the new chat with the handoff note.' }
  }
  if (S.pending && Date.now() - S.clearAt < NOTE_WAIT_MS) return { drop: 'Held: the handoff note is arriving. Send this again in a moment.' }
  if (S.pending) { // the note never arrived: it rides along with this message instead of the person typing into a blank chat
    const note = `${HEAD}\n\n${S.pending}`; S.pending = ''
    $.ui.toast('Sage Relay: the handoff note was attached to your message.')
    return { context: note }
  }
  // Idle hold: last turn time and size come from the store, so an engine restart does not forget them. A second send within 2 minutes goes through.
  const last = S.doneAt ? { t: S.doneAt, tokens: S.tokens } : (await idleMap($))[await $.session.id().catch(() => '?')]
  if (last && last.tokens >= IDLE_MIN_TOKENS && Date.now() - last.t > IDLE_MS) {
    S.run = 0
    if (last.tokens >= IDLE_HANDOFF_TOKENS && willRun(S) && !S.scheduled) { // the note costs no tokens; waking the old chat would
      S.tokens = last.tokens; S.doneAt = Date.now(); S.queue = [e.text]; S.due = 'manual'; S.scheduled = true
      $.clock.after(0, () => void handoff($, S))
      return { drop: `Held: this chat was idle ${Math.round((Date.now() - last.t) / 60_000)} min and waking it would re-pay about ${Math.round(last.tokens / 1000)}k tokens, so Sage Relay is handing off to a fresh chat. Your message goes with the note.` }
    }
    if (Date.now() - S.idleHeldAt > IDLE_RESEND_MS) {
      S.idleHeldAt = Date.now()
      return { drop: `Held: this chat was idle ${Math.round((Date.now() - last.t) / 60_000)} min, so its saved copy has likely expired and this message re-pays about ${Math.round(last.tokens / 1000)}k tokens. Send it again within 2 minutes to continue anyway, or type /switch handoff to start a fresh chat from a note.` }
    }
    S.doneAt = Date.now(); S.tokens = last.tokens; S.idleHeldAt = 0
  }
  S.run = 0; S.text = e.text.slice(0, 40)
  void regHelpers($, S) // after a /clear no session.start fires; registering again is harmless
}

// tool.call: past the line (or while the note is built) deny new main-chat tool calls; says whether this is a plan approval to watch.
async function toolGate($: any, e: any): Promise<{ deny?: { deny: string }; plan?: St }> {
  if (e.agentId !== undefined) return {}
  const S = await st($)
  if (S.busy || S.scheduled || (S.due && willRun(S))) { S.gated = true; return { deny: { deny: 'Sage Relay is saving a handoff note and starting a fresh chat. This is not a token or usage limit and nothing is wrong. Make no more tool calls: write one line saying where you are, then stop.' } } }
  return e.tool === 'ExitPlanMode' && !(await routingOn($, S)) ? { plan: S } : {}
}

// agent.spawn: with routing on, a helper that names no model gets one. An explicit model from the caller, or a plugin type's own, wins.
async function spawnModel($: any, e: any): Promise<string | undefined> {
  if (e.model !== undefined || e.subagentType.includes(':') || !(await routingOn($, await st($)))) return
  return helperModel(e.subagentType)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await regHelpers($, await st($))
    void python($) // known before the first handoff, so a missing python never gates tools

    return next(e)
  })

  // A /clear the person typed starts over: no parent tag, no stale state. Our own clear runs while busy.
  on('session.end', ($, e, next) => {
    if (e.reason === 'clear' && !M.get(e.sessionId)?.busy) M.delete(e.sessionId)

    return next(e)
  })

  // A gate that crashes is absent: the message, tool call or helper goes through. .catch says so out loud.
  on('prompt.submit', async ($, e, next) => {
    const h = await holdMessage($, e)
    return h && 'context' in h ? next({ ...e, context: [...(e.context ?? []), h.context] }) : h ?? next(e)
  }).catch(() => undefined)

  on('session.measure', async ($, e, next) => {
    const fh = e.rateLimits.find(r => r.kind === 'five_hour')?.percentUsed
    if (fh !== undefined) {
      fiveHour = fh
      if (fh < LIMIT_HARD) limitNoticed = false
      else if (!limitNoticed) { limitNoticed = true; $.ui.toast(`5-hour limit at ${fh}%. /switch handoff saves a note and starts a fresh chat if you want one.`) }
    }
    await syncCeiling($); retryPy()
    const S = await st($)
    const tokens = e.context.tokens
    if (tokens === undefined || S.busy) return next(e)
    S.tokens = tokens; S.window = e.context.window
    if (S.fresh) { S.base = tokens; S.fresh = false; S.warned = false; return next(e) } // first reading from the new chat, whatever its size
    const at = point(S)
    if (tokens >= Math.max(at, S.retryAt)) S.due ||= 'context'
    else if (!S.warned && !S.due && !S.retryAt && tokens >= WARN * at) {
      S.warned = true
      $.ui.toast(`Chat is at ${Math.round(tokens / 1000)}k tokens; it hands off at ${Math.round(at / 1000)}k. /switch handoff does it now.`)
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const g = await toolGate($, e)
    if (g.deny) return g.deny
    if (!g.plan) return next(e)
    const r: any = await next(e) // the person approves or rejects the plan inside this call
    if (r.result && !r.isError && !r.result.awaitingLeaderApproval) { g.plan.routing = true; $.ui.toast('Plan approved: Sage Relay routing is on for this chat. /switch routing off stops it.') }

    return r
  }).catch(() => undefined)

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined) return out
    const S = await st($)
    S.doneAt = Date.now()
    if (S.tokens) await rememberIdle($, S.doneAt, S.tokens)
    if (S.due && !S.busy && !S.scheduled && willRun(S)) { S.scheduled = true; $.clock.after(0, () => void handoff($, S)) }

    return out
  })

  // The main chat keeps the person's menu pick. Only a /switch opus|sonnet they typed overrides it, until they pick in the menu.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const S = await st($)
    if (!S.pinTried) { // with the sonnet-default file on, each chat starts on Sonnet 5.5 medium; Opus work goes to a Deep helper. A menu pick or /switch opus later wins.
      S.pinTried = true
      if (e.model !== NAME.sonnet && !S.fixed && (await readHome($, SONNET_FILE))?.trim() === 'on') { S.fixed = { model: NAME.sonnet, effort: 'medium' }; $.ui.toast('Sage Relay: this chat runs on Sonnet 5.5 medium; hard thinking goes to a Deep (Opus) helper. /switch opus high keeps this chat on Opus; /switch off stops this.') }
    }
    if (S.fixed && (S.menu ||= e.model) !== e.model) { S.fixed = undefined; $.ui.status('fixed model off: you picked one in the menu') }
    const f = S.fixed
    if (e.index === 0 && (f || await routingOn($, S))) { // one line per reply, the model that runs
      const chat = (await $.session.id().catch(() => '?')).slice(0, 4)
      try {
        const log = ((await $.store.get('log')) as string[] | undefined) ?? []
        await $.store.set('log', [...log, `${f ? label(f.model, f.effort) : label(e.model, e.effort)} | ${chat} | ${f ? 'fixed' : `${S.text.replace(/\s+/g, ' ')} | 5h ${fiveHour}%`}`].slice(-KEEP))
      } catch { /* a locked store must not stop the turn */ }
    }

    return yield* next(f ? { ...e, model: f.model, ...(f.effort ? { effort: f.effort } : {}) } : e)
  })

  // AgentSpawnInput has no effort field, so effort comes only from the helper types' own definitions.
  on('agent.spawn', async ($, e, next) => {
    const model = await spawnModel($, e)

    return next(model ? { ...e, model } : e)
  }).catch(() => undefined)

  on('command.run', { command: 'switch' }, async ($, e) => {
    const [a = '', b = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const S = await st($)
    if (a === 'routing' && (b === 'on' || b === 'off')) { S.routing = b === 'on'; return { text: `routing ${b} for this chat` } }
    if (a === 'auto') { S.routing = true; return { text: 'routing on for this chat' } } // legacy alias
    if (a === 'off') { S.routing = false; S.fixed = undefined; S.pinTried = true; return { text: 'routing off for this chat, no fixed model' } }
    if (a === 'resend') return { text: !S.pending ? 'nothing to resend' : await resend($, S) ? 'resent' : 'not delivered; the note is kept, try /switch resend again' }
    if (a === 'handoff' && (b === 'on' || b === 'off')) { S.auto = b === 'on'; S.fails = 0; S.retryAt = 0; return { text: `automatic handoff ${b} for this chat` } }
    if (a === 'handoff') {
      if (S.busy || S.scheduled) return { text: 'a handoff is already running' }
      retryPy()
      if (PY === null) return { text: 'handoff needs python3 (3.9 or newer); the chat is kept' }
      S.due = 'manual'; S.scheduled = true; $.clock.after(0, () => void handoff($, S))
      return { text: 'handoff starting after this turn' }
    }
    if (a === 'ceiling') {
      if (!/^\d+$/.test(b) || +b < FLOOR) return { text: `the ceiling must be a whole number of at least ${FLOOR}; it stays ${ceilOf(S).v}` }
      await syncCeiling($) // a file change made before this command must not override it
      S.cmd = { v: +b, t: ++tick }
      return { text: `handoff ceiling ${b} for this chat` }
    }
    if (a === 'baton') { // unlisted on purpose
      const leg = S.run >= MAX_RUN ? `anchor leg (${S.run}/${MAX_RUN}): the next handoff waits for you to type` : `leg ${S.run}/${MAX_RUN}${S.lastTag ? `, carrying ${S.lastTag}` : ', baton in hand'}`
      return { text: ['     o', `   _/|\\_[=]   ${leg}`, '     / \\', `  ${'- '.repeat(14)}`].join('\n') }
    }
    if (a === 'log') return { text: (((await $.store.get('log')) as string[] | undefined) ?? ['(empty)']).slice(-10).join('\n') }
    if (a === 'note') {
      if (S.busy) return { text: 'a handoff is running' }
      const n = await buildNote($, S)
      if (typeof n === 'string') return { text: `note failed, chat kept: ${n}` }
      return { text: `note ${n.tag}: ${n.text.length} chars, about ${Math.round(n.text.length / 4000)}k tokens, saved as ~/.claude/sage-relay/notes/<project>/${n.tag}.md. Not sent, chat not cleared.\n\n${n.text.slice(0, 600)}` }
    }
    if (a === 'status') {
      await syncCeiling($)
      const ceil = ceilOf(S)
      const ver = await $.fs.read($.plugin.root + '/.claude-plugin/plugin.json').then((t: string) => JSON.parse(t).version, () => '?')
      return { text: [
        `Sage Relay ${ver}`,
        `chat ${Math.round(S.tokens / 1000)}k tokens; hands off at ${Math.round(point(S) / 1000)}k (ceiling ${ceil.v} from ${ceil.src}${S.base ? `; this chat started at ${Math.round(S.base / 1000)}k after a handoff at ${Math.round(S.last / 1000)}k` : ''})`,
        `automatic handoff ${S.auto ? 'on' : 'off'} for this chat${S.fails ? `; ${S.fails}/${MAX_FAILS} failed notes, next try at ${Math.round(S.retryAt / 1000)}k` : ''}; python ${PY === null ? 'missing' : PY ?? 'not checked yet'}`,
        `due ${S.due || 'no'}, scheduled ${S.scheduled}, busy ${S.busy}, fresh ${S.fresh}, handoffs in a row ${S.run}/${MAX_RUN}`,
        `routing ${(await routingOn($, S)) ? 'on' : 'off'} for this chat${S.fixed ? `; fixed to ${label(S.fixed.model, S.fixed.effort)}` : ''}; 5h ${fiveHour}%`,
        `last note ${S.lastTag || 'none'}${S.pending ? '; one waiting, /switch resend' : ''}`,
      ].join('\n') }
    }
    if (a in NAME && ['', 'low', 'medium', 'high'].includes(b)) {
      S.fixed = { model: NAME[a as keyof typeof NAME], effort: (b || 'high') as Effort }; S.menu = ''

      return { text: `fixed to ${label(S.fixed.model, S.fixed.effort)} until /switch off or a menu pick` }
    }

    return { text: 'Usage: /switch status | note | handoff [on|off] | resend | ceiling N | routing on|off | log | opus|sonnet [low|medium|high] (a fixed model for this chat) | off (routing off, no fixed model; also stops the Sonnet default). auto = routing on (legacy).' }
  })
}

