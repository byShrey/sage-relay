# Sage Relay

A plugin for Claude Code (desktop Code tab) that does two jobs:

1. **Long-chat handoff.** When a chat gets long, it saves a note of the whole conversation, clears the chat, and starts a fresh one that carries on from the note. Every message in a long chat re-pays for the whole chat, so a fresh start is cheaper.
2. **Model routing (optional).** Keeps the main chat on one model so its saved copy stays warm, and sends helper agents to a model that fits: planners and reviewers to Opus, searchers to Haiku, the rest to Sonnet.

No outside calls, no network, no model calls of its own. The note builder is plain Python from the standard library.

## Install

```bash
claude plugin marketplace add byShrey/sage-relay
claude plugin install sage-relay@sage-relay
```

Restart the app afterwards. Needs `/usr/bin/python3` (macOS or Linux).

## What it does

| Event | Behaviour |
|---|---|
| Chat reaches 83% of the ceiling | One notice per chat, saying where the handoff will fire. |
| Chat reaches the ceiling (default 300k tokens, or 80% of the window) or 95% of your 5-hour limit | Blocks new tool calls, builds the note, clears the chat, and sends the note as the first message of the new chat. |
| New chat after a handoff | Waits for 40k tokens of growth past its own start size before it can hand off again. At most 2 handoffs in a row. |
| Message after about 55 minutes idle in a chat of 50k+ | A warning that the saved copy has likely expired and the next message re-pays for the whole chat. |

If building the note fails, the chat is **not** cleared.

## Commands

```
/switch handoff        hand off now
/switch resend         send the last note again
/switch ceiling 200000 change the ceiling for this session
/switch log            last 10 routing log lines
/switch opus high | sonnet medium | haiku    fix a model until /switch auto
/switch auto | off
```

## Settings (plain files)

- `~/.claude/sage-relay/ceiling`: one number, the ceiling in tokens. Read every turn.
- `~/.claude/sage-relay/pin-models`: put `on` to enable model pinning and helper routing. Off by default.
- Notes are saved in `~/.claude/sage-relay/notes`.

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

- 13 unit tests for the hooks.
- Note quality, blind-scored on 30 questions about one real chat: this note 29/30, a summary-based note 26/30, built-in compaction 20/30. One chat, one run; differences of a few points are within noise.
- Handoff sequence tested live: forced and unforced, note arrived in the new chat.
- **Not tested:** the idle warning (needs a real hour of waiting), the notice on other setups, Windows (no file locking there).

## Privacy

The note contains your conversation word for word, minus tool output, with obvious secrets redacted by pattern. It is written to your own disk and sent to the new chat. Nothing leaves your machine. Redaction is best effort: read a note before sharing it.

## Credits

Written from scratch. Ideas from claude-auto-handoff, Sting25, context-relay, usage-guard and effortless (all MIT; no code copied).

## Licence

MIT, see LICENSE.
