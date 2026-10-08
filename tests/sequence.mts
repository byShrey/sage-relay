// Runs the real hooks/register.ts on a fake engine, so handoff() (git, note, clear, submit) runs end to end.
// Usage: node tests/sequence.mts            (Node 24, no dependencies)
//        REG=/path/to/register.ts node tests/sequence.mts   (run the same scenarios against another copy)
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Copied to .mts so Node loads it as an ES module with its types stripped (the repo has no package.json).
const SRC = process.env.REG ?? fileURLToPath(new URL('../plugins/sage-relay/hooks/register.ts', import.meta.url))
const COPY = mkdtempSync(tmpdir() + '/sage-relay-') + '/register.mts'
copyFileSync(SRC, COPY)
const REG = pathToFileURL(COPY).href
const HOME = '/home/x'

async function make(o: any = {}) {
  const m = await import(REG + '?' + Math.random()) // fresh module state per scenario
  const hooks: Record<string, any[]> = {}
  const log: string[] = []
  const timers: (() => void)[] = []
  const files: Record<string, string> = { '/r/.claude-plugin/plugin.json': '{"version":"9.9.9"}', ...(o.files ?? {}) }
  const specs: any[] = []
  const kv: Record<string, unknown> = o.kv ?? {} // the mod's saved store; pass it to a second make() to simulate an engine restart
  let sid = o.sid ?? 'sess1'
  let notes = 0
  const on = (ev: string, a: any, b?: any) => { (hooks[ev] ||= []).push(b ?? a); return { catch: () => ({}) } }
  m.register(on as any, {} as any)
  const fire = async (ev: string, e: any, next: any = async (x: any) => x) => { const h = hooks[ev]?.[0]; return h ? h($, e, next) : next(e) }
  const $: any = { plugin: { root: '/r' },
    ui: { status: (t: string) => log.push('status: ' + t), toast: (t: string) => log.push('toast: ' + t) },
    session: { id: async () => sid, cwd: async () => '/proj' },
    env: { get: async (k: string) => (k === 'HOME' ? HOME : undefined) },
    fs: { read: async (p: string) => { if (p in files) return files[p]; throw new Error('ENOENT ' + p) } },
    store: { get: async (k: string) => kv[k], set: async (k: string, v: unknown) => { kv[k] = v } },
    agent: { register: async (s: any) => { specs.push(s); return { agent: 'sage-relay:' + s.name } } },
    command: {
      register: async (c: any) => { log.push('REGISTER ' + c.name) },
      run: async (c: any) => {
        log.push('COMMAND ' + c.command)
        if (o.clearThrows) throw new Error('clear refused')
        const old = sid; sid = sid + '+'
        await fire('session.end', { reason: 'clear', sessionId: old, resume: {} })
      },
    },
    prompt: { submit: async (p: any) => {
      log.push('SUBMIT ' + p.text.replace(/\n/g, '|'))
      if (o.submitThrows) throw new Error('submit failed')
      return o.submitDrop ? { drop: 'x' } : { text: p.text }
    } },
    process: {
      run: async (argv: string[], init: any) => {
        if (argv[0] === 'git') return { stdout: o.git ?? ' M a.ts\n', stderr: '', exitCode: o.gitExit ?? 0 }
        if (argv[0] === '/bin/cat') { if (argv[1] in files) return { stdout: files[argv[1]], stderr: '', exitCode: 0 }; return { stdout: '', stderr: 'no file', exitCode: 1 } }
        if (o.noPython) throw new Error('spawn ' + argv[0] + ' ENOENT')
        if (argv[1] === '-c') return { stdout: '1\n', stderr: '', exitCode: 0 }
        log.push('PYTHON stdin=' + init.stdin)
        if (o.noteGate) await o.noteGate
        if (o.pythonFail) return { stdout: '', stderr: 'note failed: boom', exitCode: 1 }
        return { stdout: JSON.stringify({ tag: 'tag' + ++notes, text: o.perChatNote ? 'NOTE FOR ' + JSON.parse(init.stdin).session_id : 'NOTE BODY' }), stderr: '', exitCode: 0 }
      },
    },
    clock: { after: (_ms: number, f: () => void) => { log.push('TIMER scheduled'); timers.push(f) } },
  }
  // Another open chat in the same module (the real situation: one plugin process, several chats).
  const fork = (name: string) => {
    let cs = name
    const $c: any = { ...$,
      session: { id: async () => cs, cwd: async () => '/proj' },
      command: { register: async () => {}, run: async (c: any) => {
        log.push(`COMMAND ${c.command} ${name}`)
        const old = cs; cs = cs + '+'
        await hooks['session.end'][0]($c, { reason: 'clear', sessionId: old, resume: {} }, async (x: any) => x)
      } },
      prompt: { submit: async (p: any) => { log.push(`SUBMIT ${name}: ` + p.text.replace(/\n/g, '|')); return { text: p.text } } },
    }
    const f = (ev: string, e: any, next: any = async (x: any) => x) => { const h = hooks[ev]?.[0]; return h ? h($c, e, next) : next(e) }
    return {
      sid: () => cs,
      measure: (tokens: number, fiveHour = 10, window = 1_000_000) => f('session.measure', { context: { tokens, window }, rateLimits: [{ kind: 'five_hour', percentUsed: fiveHour }], changed: ['context'] }),
      complete: () => f('turn.complete', {}),
      prompt: (text: string) => f('prompt.submit', { text, origin: { kind: 'composer' } }),
      spawn: (e: any) => f('agent.spawn', e, async (x: any) => ({ model: x.model })),
      sw: (args: string) => hooks['command.run'][0]($c, { args }),
    }
  }
  return {
    m, log, $, timers, files, specs, o, fork, kv,
    sid: () => sid, setSid: (s: string) => { sid = s },
    start: () => fire('session.start', { cwd: '/proj', surface: null, isInteractive: true }),
    measure: (tokens: number, fiveHour = 10, window = 1_000_000) => fire('session.measure', { context: { tokens, window }, rateLimits: [{ kind: 'five_hour', percentUsed: fiveHour }], changed: ['context'] }),
    tool: (agentId?: string, tool = 'Read') => fire('tool.call', { tool, agentId }, async () => (o.toolResult ?? { result: 'ran' })),
    complete: (agentId?: string) => fire('turn.complete', { agentId }),
    prompt: (text: string, kind = 'composer') => fire('prompt.submit', { text, origin: { kind } }),
    userClear: async () => { const old = sid; sid = sid + '*'; await fire('session.end', { reason: 'clear', sessionId: old, resume: {} }) },
    step: async (model = 'claude-sonnet-5-5', index = 0) => { let seen: any; const g = await fire('turn.step', { turnId: 't', index, model, effort: 'low', messageCount: 1 }, async function* (x: any) { seen = x; return {} }); if (g?.[Symbol.asyncIterator]) for await (const _ of g) { /* drain */ } return seen },
    spawn: (e: any) => fire('agent.spawn', e, async (x: any) => ({ model: x.model })),
    sw: (args: string) => hooks['command.run'][0]($, { args }),
    run: async () => { while (timers.length) { const fs = timers.splice(0); await Promise.all(fs.map(async f => { f() })); await new Promise(r => setTimeout(r, 30)) } },
    count: (re: RegExp) => log.filter(l => re.test(l)).length,
  }
}

let failed = 0
async function scenario(name: string, f: () => Promise<string | void>) {
  let why: string | void
  try { why = await f() } catch (e) { why = 'threw ' + String(e).slice(0, 160) }
  if (why) failed++
  console.log(`${why ? 'FAIL' : 'PASS'} ${name}${why ? ' :: ' + why : ''}`)
}
const want = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg) }

await scenario('B1 note fails: chat kept, no clear, no facts-only body', async () => {
  const h = await make({ pythonFail: true }); await h.prompt('x'); await h.measure(310_000); await h.complete(); await h.run()
  want(h.count(/^COMMAND clear/) === 0, 'cleared: ' + h.log.join(' / '))
  want(h.count(/note failed, chat kept/) >= 1, 'no "note failed, chat kept" message')
  want((await h.tool()).deny === undefined, 'tools still gated after the failed note')
})

await scenario('B2 submit throws after the clear: note kept, /switch resend works', async () => {
  const h = await make({ submitThrows: true }); await h.prompt('x'); await h.measure(310_000); await h.complete(); await h.run()
  want(h.count(/chat cleared, type \/switch resend/) >= 1, 'no "chat cleared, type /switch resend": ' + h.log.slice(-3).join(' / '))
  h.o.submitThrows = false
  const r = await h.sw('resend')
  want(/resent/.test(r.text), 'resend said: ' + r.text)
  want(/NOTE BODY/.test(h.log.at(-1)!), 'resend did not carry the note')
})

await scenario('B2b submit dropped: note kept for /switch resend', async () => {
  const h = await make({ submitDrop: true }); await h.sw('handoff'); await h.run()
  h.o.submitDrop = false
  const r = await h.sw('resend')
  want(/resent/.test(r.text) && /NOTE BODY/.test(h.log.at(-1)!), 'resend failed: ' + r.text)
})

await scenario('B3 /switch handoff typed twice: one clear', async () => {
  const h = await make(); await h.sw('handoff'); await h.sw('handoff'); await h.run()
  want(h.count(/^COMMAND clear/) === 1, `clears: ${h.count(/^COMMAND clear/)}`)
})

await scenario('B3 over the ceiling + /switch handoff + turn end: one clear', async () => {
  const h = await make(); await h.prompt('x'); await h.measure(310_000); await h.sw('handoff'); await h.complete(); await h.run()
  want(h.count(/^COMMAND clear/) === 1, `clears: ${h.count(/^COMMAND clear/)}`)
})

await scenario('B10 manual handoff at 60k, new chat 20k then 400k: exactly one more schedule', async () => {
  const h = await make(); await h.prompt('x'); await h.measure(60_000); await h.sw('handoff'); await h.run()
  const before = h.count(/TIMER/)
  await h.measure(20_000); await h.complete(); await h.measure(400_000); await h.complete(); await h.complete()
  want(h.count(/TIMER/) - before === 1, `schedules after the handoff: ${h.count(/TIMER/) - before}`)
})

await scenario('B10 handoff at 310k, new chat starts at 285k, grows to 900k: hands off again', async () => {
  const h = await make(); await h.prompt('x'); await h.measure(310_000); await h.complete(); await h.run()
  await h.measure(285_000); await h.complete(); await h.measure(400_000); await h.measure(900_000); await h.complete(); await h.run()
  want(h.count(/^COMMAND clear/) === 2, `clears: ${h.count(/^COMMAND clear/)}`)
})

await scenario('B11 5-hour usage at 96%: one notice, no clear, no tool denial, typing does not re-arm', async () => {
  const h = await make(); const denied: boolean[] = []
  for (let i = 0; i < 3; i++) { await h.prompt('msg ' + i); await h.measure(60_000 + i, 96); denied.push((await h.tool()).deny !== undefined); await h.complete(); await h.run() }
  want(h.count(/^COMMAND clear/) === 0, `clears: ${h.count(/^COMMAND clear/)}`)
  want(!denied.some(Boolean), 'tool denied: ' + denied)
  want(h.count(/toast: 5-hour/) === 1, `5-hour notices: ${h.count(/toast: 5-hour/)}`)
  await h.measure(61_000, 40); await h.measure(62_000, 97)
  want(h.count(/toast: 5-hour/) === 2, 're-arm after the window dropped: ' + h.count(/toast: 5-hour/))
})

await scenario('B12 run cap reached with no user message: tool gate lifts', async () => {
  const h = await make(); await h.prompt('x')
  for (let i = 0; i < 3; i++) { await h.measure(310_000 + i * 200_000); await h.complete(); await h.run(); await h.measure(100_000 + i); await h.measure(200_000 + i * 200_000) }
  await h.measure(900_000)
  want(h.count(/^COMMAND clear/) === 2, `clears: ${h.count(/^COMMAND clear/)}`)
  want((await h.tool()).deny === undefined, 'tools denied forever at the run cap')
})

await scenario('B12 automatic handoff off: no gate', async () => {
  const h = await make(); await h.sw('handoff off'); await h.measure(310_000)
  want((await h.tool()).deny === undefined, 'tool denied with handoff off'); await h.complete()
  want(h.count(/TIMER/) === 0, 'scheduled with handoff off')
  await h.sw('handoff'); await h.run()
  want(h.count(/^COMMAND clear/) === 1, 'manual handoff did not run with automatic off')
})

await scenario('B15 git: porcelain, status column kept, capped at 20 + "+N more"', async () => {
  const git = [' M first.ts', ...Array.from({ length: 49 }, (_, i) => `?? f${i}.ts`)].join('\n') + '\n'
  const h = await make({ git }); await h.sw('handoff'); await h.run()
  const s = h.log.find(l => l.startsWith('SUBMIT')) ?? ''
  want(s.includes('Git status:| M first.ts|'), 'leading status column lost: ' + s.slice(0, 120))
  want(s.includes('+30 more') && !s.includes('f20.ts'), 'not capped')
  const h2 = await make({ gitExit: 128, git: '' }); await h2.sw('handoff'); await h2.run()
  want((h2.log.find(l => l.startsWith('SUBMIT')) ?? '').includes('(not a git repo)'), 'nonzero git exit not reported')
})

await scenario('B17 parent tag: kept across our own clear, reset by the person\'s /clear', async () => {
  const h = await make(); await h.sw('handoff'); await h.run(); await h.sw('handoff'); await h.run()
  const py = h.log.filter(l => l.startsWith('PYTHON'))
  want(py[1]?.includes('"parent":"tag1"'), 'our own clear lost the parent: ' + py[1])
  await h.userClear(); await h.sw('handoff'); await h.run()
  const last = h.log.filter(l => l.startsWith('PYTHON')).at(-1)!
  want(!last.includes('parent'), 'the person\'s /clear kept the parent: ' + last)
})

await scenario('B18 message typed while the note builds: held, sent once inside the handoff message', async () => {
  let open!: () => void
  const h = await make({ noteGate: new Promise<void>(r => { open = r }) })
  await h.sw('handoff'); const t = h.run()
  await new Promise(r => setTimeout(r, 10))
  const held = await h.prompt('also fix the footer')
  const tool = await h.tool()
  open(); await t
  want(held?.drop !== undefined, 'typed message passed through as its own prompt')
  want(tool.deny !== undefined, 'tool not gated while the note builds')
  const subs = h.log.filter(l => l.startsWith('SUBMIT'))
  want(subs.length === 1 && subs[0].includes('the person also typed:|- also fix the footer'), 'not in the handoff message: ' + subs.join(' / ').slice(0, 200))
  want((await h.tool()).deny === undefined, 'gate not lifted after the handoff')
})

await scenario('B18b held message is replayed when the note fails (chat kept)', async () => {
  let open!: () => void
  const h = await make({ pythonFail: true, noteGate: new Promise<void>(r => { open = r }) })
  await h.sw('handoff'); const t = h.run()
  await new Promise(r => setTimeout(r, 10))
  await h.prompt('keep this')
  open(); await t
  want(h.count(/^COMMAND clear/) === 0, 'cleared')
  want(h.log.some(l => l === 'SUBMIT keep this'), 'held message lost: ' + h.log.join(' / '))
})

await scenario('python missing: chat kept, one toast, handoff disabled', async () => {
  const h = await make({ noPython: true }); await h.prompt('x'); await h.measure(310_000); await h.complete(); await h.run()
  await h.complete(); await h.run()
  const r = await h.sw('handoff')
  want(h.count(/^COMMAND clear/) === 0, 'cleared without python')
  want(h.count(/needs python3/) === 1, `python toasts: ${h.count(/needs python3/)}`)
  want(/python3/.test(r.text), '/switch handoff said: ' + r.text)
  want((await h.tool()).deny === undefined, 'tools gated with handoff disabled')
})

await scenario('ceiling: file vs command, latest write wins; junk ignored; delete restores 300k only if from the file', async () => {
  const F = HOME + '/.claude/sage-relay/ceiling'
  const h = await make({ files: { [F]: '100000' } })
  const ceil = async () => (await h.sw('status')).text.match(/ceiling (\d+) from (\w+)/)?.slice(1).join(' ')
  await h.measure(50_000); want(await ceil() === '100000 file', 'file not applied: ' + await ceil())
  await h.sw('ceiling 500000'); await h.measure(60_000); want(await ceil() === '500000 command', 'command lost to an unchanged file: ' + await ceil())
  h.files[F] = '200000'; await h.measure(70_000); want(await ceil() === '200000 file', 'changed file not applied: ' + await ceil())
  for (const junk of ['1e3', '-5', 'abc', '5000']) { h.files[F] = junk; await h.measure(71_000); want(await ceil() === '200000 file', `junk "${junk}" applied: ` + await ceil()) }
  delete h.files[F]; await h.measure(72_000); want(await ceil() === '300000 default', 'delete did not restore 300k: ' + await ceil())
  h.files[F] = '150000'; await h.measure(73_000); await h.sw('ceiling 400000'); delete h.files[F]; await h.measure(74_000)
  want(await ceil() === '400000 command', 'delete overrode a command value: ' + await ceil())
  const r = await h.sw('ceiling 1000'); want(/at least 20000/.test(r.text), 'floor not enforced: ' + r.text)
})

await scenario('per-session isolation: two chats interleaved', async () => {
  const h = await make()
  h.setSid('A'); await h.measure(310_000)
  h.setSid('B'); await h.measure(100_000)
  want((await h.tool()).deny === undefined, 'chat B gated by chat A'); await h.complete()
  want(h.count(/TIMER/) === 0, 'chat B scheduled chat A\'s handoff')
  h.setSid('A'); await h.complete()
  want(h.count(/TIMER/) === 1, 'chat A did not schedule')
})

await scenario('routing off by default: models untouched; pin file "on" routes helpers only', async () => {
  const h = await make()
  const s = await h.step(); want(s.model === 'claude-sonnet-5-5' && s.effort === 'low', 'main model changed: ' + JSON.stringify(s))
  const sp = await h.spawn({ subagentType: 'Plan', prompt: 'x' }); want(sp.model === undefined, 'helper model set with routing off: ' + sp.model)
  const h2 = await make({ files: { [HOME + '/.claude/sage-relay/pin-models']: 'on\n' } })
  const s2 = await h2.step(); want(s2.model === 'claude-sonnet-5-5' && s2.effort === 'low', 'routing on changed the main model: ' + JSON.stringify(s2))
  want((await h2.spawn({ subagentType: 'Plan', prompt: 'x' })).model === 'claude-opus-5-5', 'Plan not on Opus')
  want((await h2.spawn({ subagentType: 'Explore', prompt: 'x' })).model === 'claude-sonnet-5-5', 'Explore not on Sonnet')
  want((await h2.spawn({ subagentType: 'sage-relay:scout', prompt: 'x' })).model === undefined, 'a plugin type\'s own model overridden')
  await h.sw('routing on'); want((await h.spawn({ subagentType: 'Plan', prompt: 'x' })).model === 'claude-opus-5-5', '/switch routing on did nothing')
})

await scenario('helper types registered with the right model and effort, again after a /clear', async () => {
  const h = await make(); await h.start()
  const got = h.specs.map(s => `${s.name}:${s.model}:${s.effort ?? '-'}`).join(' ')
  want(got === 'deep:claude-opus-5-5:high careful:claude-sonnet-5-5:high scout:claude-sonnet-5-5:-', 'specs: ' + got)
  want(h.specs.every(s => /Do not paste long working/.test(s.prompt) && /do not start a helper/.test(s.description)), 'prompt or rubric missing')
  await h.userClear(); await h.prompt('hi'); await new Promise(r => setTimeout(r, 10))
  want(h.specs.length === 6, 'not registered again after a /clear: ' + h.specs.length)
})

await scenario('/switch note and /switch status', async () => {
  const h = await make(); await h.measure(120_000)
  const n = await h.sw('note')
  want(/note tag1: 9 chars/.test(n.text) && /NOTE BODY/.test(n.text) && h.count(/^COMMAND clear/) === 0, 'note: ' + n.text)
  const s = (await h.sw('status')).text
  want(/Sage Relay 9\.9\.9/.test(s) && /120k tokens; hands off at 300k/.test(s) && /routing off/.test(s), 'status: ' + s)
  const h2 = await make({ pythonFail: true })
  want(/note failed, chat kept/.test((await h2.sw('note')).text), 'note failure not reported')
})

await scenario('plan approval (ExitPlanMode) turns routing on', async () => {
  const h = await make({ toolResult: { result: { plan: 'p', isAgent: false } } })
  await h.tool(undefined, 'ExitPlanMode')
  want((await h.spawn({ subagentType: 'Plan', prompt: 'x' })).model === 'claude-opus-5-5', 'routing still off after approval')
  const h2 = await make({ toolResult: { deny: 'rejected' } })
  await h2.tool(undefined, 'ExitPlanMode')
  want((await h2.spawn({ subagentType: 'Plan', prompt: 'x' })).model === undefined, 'routing on after a rejection')
})

await scenario('R1 note fails: retries after 20k more tokens, three times, then pauses with a notice', async () => {
  const h = await make({ pythonFail: true }); await h.prompt('x')
  const tries = () => h.count(/^PYTHON/)
  await h.measure(310_000); await h.complete(); await h.run()
  want(tries() === 1 && h.count(/Trying again after 20k more tokens \(1\/3\)/) === 1, 'first failure: ' + h.log.slice(-3).join(' / '))
  await h.measure(320_000); await h.complete(); await h.run()
  want(tries() === 1, 'retried before 20k more tokens: ' + tries())
  want((await h.tool()).deny === undefined, 'tools gated while waiting to retry')
  await h.measure(335_000); await h.complete(); await h.run()
  want(tries() === 2, 'no second try after growth: ' + tries())
  await h.measure(360_000); await h.complete(); await h.run()
  want(tries() === 3 && h.count(/failed 3 times, chat kept/) === 1, 'third failure: ' + h.log.slice(-3).join(' / '))
  await h.measure(900_000); await h.complete(); await h.run()
  want(tries() === 3 && h.count(/^COMMAND clear/) === 0, 'kept trying after pausing: ' + tries())
  const r = await h.sw('handoff on'); want(/automatic handoff on/.test(r.text), r.text)
  await h.measure(950_000); await h.complete(); await h.run()
  want(tries() === 4, '/switch handoff on did not re-arm: ' + tries())
})

await scenario('R1b a note that works after a failure resets the count', async () => {
  const h = await make({ pythonFail: true }); await h.prompt('x')
  await h.measure(310_000); await h.complete(); await h.run()
  h.o.pythonFail = false
  await h.measure(335_000); await h.complete(); await h.run()
  want(h.count(/^COMMAND clear/) === 1, 'did not hand off on the retry')
  want(/failed notes/.test((await h.sw('status')).text) === false, 'failure count not reset: ' + (await h.sw('status')).text)
})

await scenario('R2 python missing: looked for again after 10 minutes', async () => {
  const real = Date.now
  try {
    const h = await make({ noPython: true }); await h.prompt('x')
    await h.measure(310_000); await h.complete(); await h.run()
    want(h.count(/needs python3/) === 1, 'no toast')
    h.o.noPython = false
    await h.measure(312_000); await h.complete(); await h.run()
    want(h.count(/^COMMAND clear/) === 0, 'probed again too soon')
    Date.now = () => real() + 11 * 60_000
    await h.measure(314_000); await h.complete(); await h.run()
    want(h.count(/^COMMAND clear/) === 1, 'did not find python after 10 minutes: ' + h.log.slice(-3).join(' / '))
  } finally { Date.now = real }
})

await scenario('R3 hold while the note builds: 50 messages, 100k characters, then a visible refusal', async () => {
  let open!: () => void
  const h = await make({ noteGate: new Promise<void>(r => { open = r }) })
  await h.sw('handoff'); const t = h.run(); await new Promise(r => setTimeout(r, 10))
  for (let i = 0; i < 50; i++) { const r: any = await h.prompt('m' + i); want(/^Held/.test(r.drop), `message ${i}: ` + JSON.stringify(r)) }
  const r51: any = await h.prompt('one too many'); want(/hold is full/.test(r51.drop), '51st: ' + JSON.stringify(r51))
  open(); await t
  const sent = h.log.find(l => l.startsWith('SUBMIT '))!
  want(sent.includes('- m0') && sent.includes('- m49') && !sent.includes('one too many'), 'held messages not in the handoff message')
  const h2 = await make({ noteGate: new Promise<void>(r => { open = r }) })
  await h2.sw('handoff'); const t2 = h2.run(); await new Promise(r => setTimeout(r, 10))
  const big: any = await h2.prompt('x'.repeat(100_001)); want(/hold is full/.test(big.drop), 'oversized message was held: ' + JSON.stringify(big))
  open(); await t2
})

await scenario('R5 WAIT message tells the new chat to show the last message in full', async () => {
  const h = await make(); await h.sw('handoff'); await h.run()
  const sub = h.log.find(l => l.startsWith('SUBMIT '))!
  want(/STATUS: WAIT/.test(sub) && /'Where it stopped' section in full, word for word/.test(sub), 'wording: ' + sub.slice(0, 200))
})

await scenario('M1 routing and ceiling are per chat; the ceiling file is the default for all', async () => {
  const F = HOME + '/.claude/sage-relay/ceiling'
  const h = await make(); const A = h.fork('A'), B = h.fork('B')
  await A.sw('routing on')
  want((await A.spawn({ subagentType: 'Plan', prompt: 'x' })).model === 'claude-opus-5-5', 'chat A routing not on')
  want((await B.spawn({ subagentType: 'Plan', prompt: 'x' })).model === undefined, 'chat A\'s routing leaked into chat B')
  await A.sw('ceiling 100000')
  await A.measure(120_000); await B.measure(120_000)
  want(/hands off at 100k \(ceiling 100000 from command/.test((await A.sw('status')).text), 'A status: ' + (await A.sw('status')).text)
  want(/hands off at 300k \(ceiling 300000 from default/.test((await B.sw('status')).text), 'B inherited A\'s ceiling: ' + (await B.sw('status')).text)
  await A.complete(); await B.complete()
  want(h.timers.length === 1, 'timers: ' + h.timers.length + ' (only chat A is over its own ceiling)')
  h.timers.length = 0
  h.files[F] = '150000'; await A.measure(121_000); await B.measure(121_000)
  want(/ceiling 150000 from file/.test((await A.sw('status')).text) && /ceiling 150000 from file/.test((await B.sw('status')).text), 'a later file change did not reach both chats')
  await B.sw('ceiling 400000')
  want(/ceiling 400000 from command/.test((await B.sw('status')).text) && /ceiling 150000 from file/.test((await A.sw('status')).text), 'B\'s command changed A')
  await A.sw('routing off'); await B.sw('routing on')
  want((await A.spawn({ subagentType: 'Plan', prompt: 'x' })).model === undefined && (await B.spawn({ subagentType: 'Plan', prompt: 'x' })).model === 'claude-opus-5-5', 'routing off/on did not stay per chat')
})

await scenario('M4 three chats hand off at the same moment: each gets its own note, counters and state', async () => {
  const h = await make({ perChatNote: true })
  const cs = [h.fork('A'), h.fork('B'), h.fork('C')]
  for (const c of cs) await c.measure(310_000)
  for (const c of cs) await c.complete()
  await h.run()
  want(h.count(/^COMMAND clear/) === 3, 'clears: ' + h.count(/^COMMAND clear/))
  for (const n of ['A', 'B', 'C']) {
    const subs = h.log.filter(l => l.startsWith(`SUBMIT ${n}: `))
    want(subs.length === 1 && subs[0].includes(`NOTE FOR ${n}`) && !new RegExp(`NOTE FOR (?!${n}\\b)`).test(subs[0]), `chat ${n} got: ` + subs.join(' / ').slice(-300))
  }
  const tags = new Set<string>()
  for (const c of cs) {
    const s = (await c.sw('status')).text
    want(/handoffs in a row 1\/2/.test(s) && c.sid().endsWith('+'), 'status: ' + s)
    tags.add(s.match(/last note (tag\d+)/)![1])
  }
  want(tags.size === 3, 'chats share a note tag: ' + [...tags].join(','))
})

await scenario('R9 main chat never steps down for usage: 99% of the 5-hour limit keeps the model on every step', async () => {
  const h = await make({ files: { [HOME + '/.claude/sage-relay/pin-models']: 'on\n' } })
  await h.prompt('x'); await h.measure(60_000, 99)
  for (const i of [0, 1, 2]) { const s = await h.step('claude-sonnet-5-5', i); want(s.model === 'claude-sonnet-5-5', `step ${i} became ${s.model}`) }
  const s = await h.step('claude-opus-5-5'); want(s.model === 'claude-opus-5-5', 'opus pick changed at 99%: ' + s.model)
})

await scenario('R10 no Haiku anywhere in the hook code or the helper types', async () => {
  const src = (await import('node:fs')).readFileSync(SRC, 'utf8').replace(/^.*\/\/ no Haiku.*$/m, '')
  want(!/haiku/i.test(src), 'haiku still in register.ts')
  const h = await make(); await h.start()
  want(h.specs.every(s => !/haiku/i.test(s.model)), 'a helper type uses Haiku')
  const r = await h.sw('haiku'); want(/Usage/.test(r.text), '/switch haiku was accepted: ' + r.text)
})

await scenario('R11 idle hold: survives an engine restart, one resend goes through, short chats and recent ones are not held', async () => {
  const real = Date.now
  try {
    const h1 = await make(); await h1.prompt('x'); await h1.measure(120_000); await h1.complete()
    Date.now = () => real() + 30 * 60_000
    const h30 = await make({ kv: h1.kv })
    want((await h30.prompt('after 30 min')).drop === undefined, 'held after only 30 min')
    Date.now = () => real() + 70 * 60_000
    const h2 = await make({ kv: h1.kv }) // fresh module = engine restarted, memory empty, same chat id
    const held: any = await h2.prompt('after the update')
    want(/^Held: this chat was idle 70 min/.test(held.drop) && /120k tokens/.test(held.drop), 'not held after restart: ' + JSON.stringify(held))
    want((await h2.prompt('after the update')).drop === undefined, 'second send did not go through')
    const h3 = await make(); await h3.prompt('x'); await h3.measure(30_000); await h3.complete()
    Date.now = () => real() + 200 * 60_000
    const h4 = await make({ kv: h3.kv })
    want((await h4.prompt('small chat')).drop === undefined, 'a 30k chat was held')
  } finally { Date.now = real }
})

await scenario('R11b idle hold is per chat: chat B finishing a turn does not hide chat A being idle', async () => {
  const real = Date.now
  try {
    const h = await make(); const A = h.fork('A'), B = h.fork('B')
    await A.measure(120_000); await A.complete()
    Date.now = () => real() + 70 * 60_000
    await B.measure(80_000); await B.complete()
    want(/^Held/.test(((await A.prompt('back again')) as any).drop ?? ''), 'chat A not held')
    want(((await B.prompt('still here')) as any).drop === undefined, 'chat B held although it just finished a turn')
  } finally { Date.now = real }
})

await scenario('R12 the tool refusal says it is a handoff, not a token or usage limit', async () => {
  const h = await make(); await h.prompt('x'); await h.measure(310_000)
  const d = (await h.tool()).deny
  want(/not a token or usage limit/.test(d) && /fresh chat/.test(d) && !/out of tokens/i.test(d), 'wording: ' + d)
})

await scenario('R15 a chat open before an engine restart (no session.start) still gets /switch after its first message', async () => {
  const h = await make()
  want(h.count(/^REGISTER switch/) === 0, 'registered before any hook ran')
  await h.prompt('hello'); await new Promise(r => setTimeout(r, 20))
  want(h.count(/^REGISTER switch/) === 1, 'registered ' + h.count(/^REGISTER switch/) + ' times after the first message')
  await h.prompt('again'); await h.start(); await new Promise(r => setTimeout(r, 20))
  want(h.count(/^REGISTER switch/) === 1, 'registered more than once: ' + h.count(/^REGISTER switch/))
})

console.log(failed ? `${failed} FAILED` : 'all passed')
process.exit(failed ? 1 : 0)
