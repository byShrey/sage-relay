import { expect, test } from 'claude-code/testing'

// Wires the engine stubs once; send(text, steps) runs one reply and returns the last step's model/effort + the log.
// Model pinning is opt-in (pin-models file says "on"); the stub answers every file read with "on", which the ceiling reader ignores.
const pinOn = (on: any) => {
  on('env.get', () => ({ value: '/home' }))
  on('process.run', () => ({ value: { stdout: 'on', stderr: '', exitCode: 0 } }))
}

const setup = (on: any) => {
  pinOn(on)
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
      for await (const _ of $.turn.step({ turnId: text, index, model: 'claude-sonnet-5-5', messageCount: 1 })) { /* drain */ }
    }
    return { ...seen, log: (store.log as string[] | undefined) ?? [] }
  }
}

test('chat goes to Sonnet medium', async ($, on) => {
  const s = await setup(on)($, 'hi, quick question')
  expect(s.model).toBe('claude-sonnet-5-5')
  expect(s.effort).toBe('medium')
})

test('planning stays on Sonnet in the main chat', async ($, on) => {
  const s = await setup(on)($, 'plan the migration')
  expect(s.model).toBe('claude-sonnet-5-5')
})

test('one log line per reply, with version in the label', async ($, on) => {
  const s = await setup(on)($, 'plan it', 4)
  expect(s.log.length).toBe(1)
  expect(s.log[0]).toContain('sonnet 5.5 medium')
})

const spawned = async ($: any, on: any, input: any) => {
  let model: string | undefined
  pinOn(on)
  on('agent.spawn', (_$: any, e: any) => { model = e.model; return { model: e.model } })
  await $.agent.spawn({ prompt: 'x', ...input }).catch(() => {})
  return model
}

test('Plan helpers go to Opus', async ($, on) => {
  expect(await spawned($, on, { subagentType: 'Plan' })).toBe('claude-opus-5-5')
})

test('Explore helpers go to Haiku', async ($, on) => {
  expect(await spawned($, on, { subagentType: 'Explore' })).toBe('claude-haiku-4-5-20251001')
})

test('other helpers go to Sonnet', async ($, on) => {
  expect(await spawned($, on, { subagentType: 'general-purpose' })).toBe('claude-sonnet-5-5')
})

test('an explicit helper model wins', async ($, on) => {
  expect(await spawned($, on, { subagentType: 'Plan', model: 'claude-sonnet-5-5' })).toBe('claude-sonnet-5-5')
})

// ---- handoff trigger ----
// The sequence itself (git, relay, clear, submit) cannot run under the test engine: /clear is refused inside a
// command hook and the timer cannot call back. It is proven live with /switch ceiling 50000.
const trigger = (on: any) => {
  const timers: number[] = []
  on('session.measure', () => ({ changed: [] }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer ?? '' }))
  on('clock.after', (_$: any, e: any) => { timers.push(e.ms); return { value: undefined } })
  return timers
}
const measure = ($: any, tokens: number, fiveHour = 10) =>
  $.session.measure({ context: { tokens, window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: fiveHour }] })
const complete = ($: any) => $.turn.complete({ turnId: 't', answer: 'ok', reason: 'answer' })

test('below the line: no handoff scheduled', async ($, on) => {
  const timers = trigger(on)
  await measure($, 299_000)
  await complete($)
  expect(timers.length).toBe(0)
})

test('over 300k: handoff scheduled after the turn', async ($, on) => {
  const timers = trigger(on)
  await measure($, 310_000)
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

test('95% of the 5-hour limit schedules a handoff', async ($, on) => {
  const timers = trigger(on)
  await measure($, 50_000, 96)
  await complete($)
  expect(timers.length).toBe(1)
})

test('tool gate denies once a handoff is due', async ($, on) => {
  trigger(on)
  on('tool.call', () => ({ result: 'ran' }))
  await measure($, 310_000)
  const r = await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })
  expect(String(r.deny)).toContain('Handoff pending')
})

test('a fresh chat that starts over the ceiling does not loop', async ($, on) => {
  const timers = trigger(on)
  await $.command.run({ command: 'switch', args: 'ceiling 50000' })
  await measure($, 78_000)
  await complete($)
  expect(timers.length).toBe(1) // the first trigger (no handoff has happened yet in this test)
})
