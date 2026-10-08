import { expect, test } from 'claude-code/testing'

// Routing is opt-in: on('fs.read') answering "on" plays the legacy pin file; with no stub every file is missing.
const pinOn = (on: any) => {
  on('env.get', () => ({ value: '/home' }))
  on('fs.read', () => ({ value: 'on' }))
}

// send(text, steps) runs one reply and returns the last step's model/effort + the log.
const setup = (on: any, routing = true) => {
  if (routing) pinOn(on)
  let seen: { model?: string; effort?: string } = {}
  const store: Record<string, unknown> = {}
  on('turn.step', async function* (_$: any, e: any) {
    seen = { model: e.model, effort: e.effort }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'abcd1234' }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => { store[e.key] = e.value; return { value: undefined } })
  return async ($: any, text: string, steps = 1) => {
    await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
    for (let index = 0; index < steps; index++) {
      for await (const _ of $.turn.step({ turnId: text, index, model: 'claude-sonnet-5-5', effort: 'low', messageCount: 1 })) { /* drain */ }
    }
    return { ...seen, log: (store.log as string[] | undefined) ?? [] }
  }
}

test('routing off by default: the main chat model is untouched, nothing logged', async ($, on) => {
  const s = await setup(on, false)($, 'hi, quick question')
  expect(s.model).toBe('claude-sonnet-5-5')
  expect(s.effort).toBe('low')
  expect(s.log.length).toBe(0)
})

test('routing on never overrides the main chat model', async ($, on) => {
  const s = await setup(on)($, 'plan the migration')
  expect(s.model).toBe('claude-sonnet-5-5')
  expect(s.effort).toBe('low')
})

test('routing on: one log line per reply, with the model that ran', async ($, on) => {
  const s = await setup(on)($, 'plan it', 4)
  expect(s.log.length).toBe(1)
  expect(s.log[0]).toContain('sonnet 5.5 low')
})

test('/switch opus high fixes the main model for this chat', async ($, on) => {
  const send = setup(on, false)
  await $.command.run({ command: 'switch', args: 'opus high' })
  const s = await send($, 'go')
  expect(s.model).toBe('claude-opus-5-5')
  expect(s.effort).toBe('high')
})

const spawned = async ($: any, on: any, input: any, routing = true) => {
  let model: string | undefined
  if (routing) pinOn(on)
  on('agent.spawn', (_$: any, e: any) => { model = e.model; return { model: e.model ?? 'default' } })
  await $.agent.spawn({ prompt: 'x', ...input }).catch(() => {})
  return model
}

test('routing on: Plan helpers go to Opus', async ($, on) => {
  expect(await spawned($, on, { subagentType: 'Plan' })).toBe('claude-opus-5-5')
})

test('routing on: Explore helpers go to Haiku', async ($, on) => {
  expect(await spawned($, on, { subagentType: 'Explore' })).toBe('claude-haiku-4-5-20251001')
})

test('routing on: other helpers go to Sonnet', async ($, on) => {
  expect(await spawned($, on, { subagentType: 'general-purpose' })).toBe('claude-sonnet-5-5')
})

test('an explicit helper model wins', async ($, on) => {
  expect(await spawned($, on, { subagentType: 'Plan', model: 'claude-sonnet-5-5' })).toBe('claude-sonnet-5-5')
})

test('routing off: helpers keep no model', async ($, on) => {
  expect(await spawned($, on, { subagentType: 'Plan' }, false)).toBe(undefined)
})

test('three helper types are registered at session start', async ($, on) => {
  const specs: any[] = []
  on('agent.register', (_$: any, e: any) => { specs.push(e); return { value: { agent: 'sage-relay:' + e.name } } })
  on('command.register', () => ({ value: undefined }) as any)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'reg' }))
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  expect(specs.map(s => `${s.name} ${s.model} ${s.effort ?? '-'}`).join(', ')).toBe('deep claude-opus-5-5 high, careful claude-sonnet-5-5 high, scout claude-haiku-4-5-20251001 -')
})

// ---- handoff trigger ----
// Most trigger tests stop at scheduling; the last ones run the whole handoff with stubs.
const trigger = (on: any) => {
  const timers: number[] = []
  sid = 'sid-' + Math.random() // a fresh chat per test
  on('session.measure', () => ({ changed: [] }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer ?? '' }))
  on('clock.after', (_$: any, e: any) => { timers.push(e.ms); return { value: undefined } })
  on('session.id', () => ({ value: sid }))
  on('env.get', () => ({ value: '/home' }))
  on('fs.read', () => { throw new Error('ENOENT') }) // no ceiling or pin file
  return timers
}
let sid = ''
const measure = ($: any, tokens: number, fiveHour = 10) =>
  $.session.measure({ context: { tokens, window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: fiveHour }] })
const complete = ($: any) => $.turn.complete({ turnId: 't', answer: 'ok', reason: 'answer' })

test('below the line: no handoff scheduled', async ($, on) => {
  const timers = trigger(on)
  await measure($, 299_000)
  await complete($)
  expect(timers.length).toBe(0)
})

test('over 300k: one handoff scheduled after the turn, even if the turn ends twice', async ($, on) => {
  const timers = trigger(on)
  await measure($, 310_000)
  await complete($)
  await complete($)
  expect(timers.length).toBe(1)
})

test('notice at 250k, once, and none below it', async ($, on) => {
  trigger(on)
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.message ?? e.text ?? ''); return { value: undefined } })
  await measure($, 200_000)
  expect(toasts.length).toBe(0)
  await measure($, 260_000)
  await measure($, 265_000)
  expect(toasts.length).toBe(1)
})

test('95% of the 5-hour limit: one notice, no handoff', async ($, on) => {
  const timers = trigger(on)
  const toasts: string[] = []
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.message ?? e.text ?? ''); return { value: undefined } })
  await measure($, 50_000, 96)
  await complete($)
  await measure($, 51_000, 97)
  expect(timers.length).toBe(0)
  expect(toasts.filter(t => t.includes('5-hour')).length).toBe(1)
})

test('tool gate denies once a handoff is due, and lifts when it will not run', async ($, on) => {
  trigger(on)
  on('tool.call', () => ({ result: 'ran' }))
  await measure($, 310_000)
  const r = await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })
  expect(String(r.deny ?? r.text)).toContain('Handoff pending')
  await $.command.run({ command: 'switch', args: 'handoff off' })
  const r2 = await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })
  expect(String(r2.deny ?? r2.text)).not.toContain('Handoff pending')
})

// The whole handoff (git, note, clear, submit) with every outside call stubbed. The chat id changes at the clear.
const handoffStubs = (on: any) => {
  const log: string[] = []
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/p' }))
  on('process.run', (_$: any, e: any) => ({ value: { stdout: e.argv[0] === 'git' ? '' : e.argv[1] === '-c' ? '1\n' : JSON.stringify({ tag: 'tg', text: 'NOTE' }), stderr: '', exitCode: 0 } }))
  on('command.run', { command: 'clear' }, () => { log.push('CLEAR'); sid += '+'; return { text: '' } })
  on('prompt.submit', (_$: any, e: any) => { log.push('SUBMIT'); return { text: e.text } })
  return log
}
const settle = () => new Promise(r => (globalThis as any).setTimeout(r, 50))

test('over the ceiling, /switch handoff plus the turn end run one handoff, not two', async ($, on) => {
  trigger(on)
  const log = handoffStubs(on)
  await measure($, 310_000)
  await $.command.run({ command: 'switch', args: 'handoff' })
  await complete($)
  await settle()
  expect(log.join(' ')).toBe('CLEAR SUBMIT')
})

test('a fresh chat that starts over the ceiling does not loop', async ($, on) => {
  trigger(on)
  const log = handoffStubs(on)
  await measure($, 310_000)
  await complete($)
  await settle()
  expect(log.filter(l => l === 'CLEAR').length).toBe(1)
  await measure($, 285_000) // the new chat starts big: a large note
  await complete($)
  await measure($, 320_000) // over the ceiling, under its own start + 40k
  await complete($)
  await settle()
  expect(log.filter(l => l === 'CLEAR').length).toBe(1)
  await measure($, 330_000) // 45k past its own start: hands off again
  await complete($)
  await settle()
  expect(log.filter(l => l === 'CLEAR').length).toBe(2)
})

test('/switch ceiling refuses values under 20000', async ($, on) => {
  trigger(on)
  const r = await $.command.run({ command: 'switch', args: 'ceiling 5000' })
  expect(String(r.text)).toContain('at least 20000')
})

