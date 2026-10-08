# Sage Relay

A plugin for Claude Code (desktop Code tab) that does two jobs:

1. **Long-chat handoff.** When a chat gets long, it saves a note of the whole conversation, clears the chat, and starts a fresh one that carries on from the note. Every message in a long chat re-pays for the whole chat, so a fresh start is cheaper.
2. **Helper agents and optional model routing.** Three helper types ship with the plugin, and the chat picks one by judgement: **Deep** (Opus, high effort) for hard thinking such as planning, design, research and audits; **Careful** (Sonnet, high effort) for well-defined multi-step work; **Scout** (Sonnet, read-only tools) for finding and reading. Easy questions stay in your own chat. Helpers start without your rules files and without the chat's history, so the chat must give them a full brief. They add about 300 tokens to every chat (their descriptions). Routing is off by default; `/switch routing on` makes helpers that name no model get one by type. Your own model pick for the main chat is never overridden.

The plugin makes no network calls and no model calls of its own. The note builder is plain Python from the standard library. Note that the new chat does send the note to the API, like any message.

## Install

```bash
claude plugin marketplace add byShrey/sage-relay
claude plugin install sage-relay@sage-relay
```

Restart the app afterwards. Needs `python3` on your PATH or at `/usr/bin/python3` (macOS or Linux). On macOS without the developer tools, install them first. If Python can't run, handoff turns itself off with one notice and never clears a chat.

## What it does

| Event | Behaviour |
|---|---|
| Chat reaches 83% of the ceiling | One notice per chat, saying where the handoff will fire. |
| Chat reaches the ceiling (default 300k tokens, or 80% of the window) | Blocks new tool calls, builds the note, clears the chat, and sends the note as the first message of the new chat. A message you type while the note builds is held and sent once with the note. |
| 95% of your 5-hour limit | One notice per limit window. It does not clear anything. `/switch handoff` starts a fresh chat if you want one. |
| New chat after a handoff | Waits for 40k tokens of growth past its own start size before it can hand off again. At most 2 handoffs in a row. |
| Message after about 55 minutes idle in a chat of 50k+ | A warning that the saved copy has likely expired and the next message re-pays for the whole chat. |

If building the note fails, the chat is **not** cleared: you see "note failed, chat kept", and automatic handoff stays off for that chat until `/switch handoff on` or a successful manual handoff. If the new chat can't be started after a clear, the note stays pending and `/switch resend` sends it.

An automatic handoff says `STATUS: CONTINUE` (the new chat carries on) only if work was stopped mid-turn. A manual handoff says `STATUS: WAIT` (the new chat reports and waits for you).

## Commands

```
/switch status          size, handoff point, flags, last note, version
/switch note            build the note and preview it, without clearing
/switch handoff         hand off now
/switch handoff off|on  stop or start automatic handoff for this chat
/switch resend          send the last note again
/switch ceiling 200000  change the ceiling (minimum 20000)
/switch routing on|off  helper routing by type (off by default)
/switch opus high | sonnet medium    fix a model for this chat
/switch log             last 10 routing log lines
```

`/switch auto` and `/switch off` still work as older names for routing on and off.

## Settings (plain files)

- `~/.claude/sage-relay/ceiling`: one number, the ceiling in tokens (minimum 20000). The newest write wins between this file and `/switch ceiling`; deleting the file restores 300k.
- `~/.claude/sage-relay/pin-models`: put `on` to switch routing on at start. Off by default.
- Notes are saved in `~/.claude/sage-relay/notes`, folder private to you (700), files 600, and deleted after 14 days.

## Choosing a ceiling

A replay of 9 days of one person's real chats (5,849 replies, one user, so treat it as a hint):

| Ceiling | Handoffs per day | Cost vs 300k |
|---|---|---|
| 200k | 8.6 | about 20% lower |
| 300k | 3.9 | baseline |
| 400k | 2.4 | about 13% higher |
| 500k | 1.6 | about 26% higher |

The replay cannot measure how much detail each handoff loses, so lower is not automatically better. 300k is the default.

## What was tested, and what was not

- 18 unit tests for the hooks, 21 handoff-sequence scenarios on a fake engine (one per fixed bug), 22 tests for the note builder, including a secret-filter corpus and a speed test on hostile input.
- Two independent audits (a Claude Opus helper and a blind Gemini review) found the bugs fixed in 0.7.0. Each confirmed bug fails on 0.6.1 and passes on 0.7.0.
- Note quality, blind-scored on 30 questions about one real chat: this note 29/30, a summary-based note 26/30, built-in compaction 20/30. One chat, one run; differences of a few points are within noise.
- Handoff sequence tested live: forced and unforced, note arrived in the new chat.
- **Not tested:** the idle warning (needs a real hour of waiting), auto-on at plan approval (works on the fake engine, not yet seen live), whether helper registration survives a `/clear` you type yourself, how often the chat picks the right helper, Windows (no file locking there).
- Very long chats: the middle of the conversation is trimmed to fit a size cap, so the note is not word for word for those.

## Privacy

The note contains your conversation minus tool output, with secrets redacted by pattern (key blocks, common token formats, `*_PASSWORD`-style names, database URLs with passwords, card numbers). It is written to your own disk and sent to the new chat, which means it goes to the API like any message. Redaction is best effort: read a note (`/switch note`) before sharing it. Carried history is labelled as untrusted in the note, and rule-like lines are listed as candidates for you to confirm.

## Credits

The hooks are original. The note builder grew out of the author's own earlier tool. Ideas from claude-auto-handoff, Sting25, context-relay, usage-guard and effortless (all MIT; no code copied).

## Licence

MIT, see LICENSE.
