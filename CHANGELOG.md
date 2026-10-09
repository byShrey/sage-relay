# Changelog

## 0.7.1
**New**
- Idle auto-handoff: a chat of 80k+ tokens left idle for 55+ minutes hands off on its own when you send your next message, instead of re-paying the whole chat. The new chat opens with the last reply word for word, and your message goes with the note, so the new chat answers it. Between 50k and 80k you get the old hold-and-resend. `/switch handoff off` turns both back into the plain hold.

**Changed**
- The Sonnet 5.5 default is now opt-in. Put `on` in `~/.claude/sage-relay/sonnet-default` to start every chat on Sonnet; without it, your model pick is left alone.

**Fixed**
- A model picked before the first message was quietly run as Sonnet, and picking it again did nothing.
- The first message was saved unredacted in the tag index. It is now redacted like the note.
- The secret filter now catches `*_KEY=` names, "my password is ..." with a digit or symbol, and Telegram, Discord, Google OAuth, Groq, Supabase, Shopify, DigitalOcean, Replicate, Perplexity, Linear and Notion tokens.
- A message typed in the moment between the clear and the note arriving could land first. It is held for up to 5 seconds.
- The handoff point can no longer sit above 95% of the window.
- A second message sent before an idle handoff starts is held for the new chat instead of landing in the old one.
- If the note never reaches the new chat, it is attached to your next message as hidden context, so you never type into a blank chat.
- Python is looked for when a chat starts, so a Mac with no Python never gets a false "stop" from the tool gate.
- A lock taken over as stale is no longer deleted by its old owner.
- The archive is cut with a margin before redacting, so a cut can't leave half a key behind.
- The notes folder is refused if it is a symlink, so the plugin can't be tricked into changing another folder's permissions.
- Git runs with `core.fsmonitor` off and Python runs isolated (`-I`), so an untrusted repo's settings can't start a program.
- Two timing tests that failed on a busy machine now measure what they mean to.

## 0.7.0
**Safety**
- A failed or empty note no longer clears the chat. The chat is kept and you see "note failed, chat kept".
- If the new chat can't be started after a clear, the note stays pending; `/switch resend` sends it.
- No double handoffs (rapid `/switch handoff`, over the ceiling plus a manual one, turn end).
- Tools are never left blocked: the gate lifts when a handoff won't run or has finished.
- A message you type while a handoff builds is passed to the new chat once, not lost.
- The 5-hour limit warns once per limit window instead of repeating or clearing.
- Per-chat state, so two open chats don't trigger each other.
- Missing Python disables handoff with one notice; it never wipes a chat.
- Idle hold: a message sent after 55+ minutes of idle in a chat of 50k+ tokens is held with the cost; send it again within 2 minutes to go through. Each chat's last turn is kept in the store, so an engine update does not reset it.
- The tool refusal during a handoff now says it is a handoff, not a token or usage limit.
- `/switch` also registers on the first message, for chats that were open before an engine restart.

**Note builder**
- Bad records can't break a note; secret filter rewritten (key blocks, any `*_PASSWORD`/`*_TOKEN` name, more token formats, database URLs, card numbers) with a linear-time check.
- Earlier handoff messages and history are quoted as untrusted; rule-like lines are listed as candidates to confirm.
- Notes are deleted after 14 days; folder 700, files 600. Note size is capped.

**Routing**
- Model routing for helpers is off by default: `/switch routing on|off`. Every chat starts on Sonnet 5.5 medium (with a notice); a menu pick, `/switch opus high` or `/switch off` wins afterwards, and usage never changes the model.
- Three helper agents the chat chooses by judgement: Deep (Opus, high), Careful (Sonnet, high), Scout (Sonnet, read-only). No Haiku anywhere, and the main chat never changes model for usage reasons.

**New commands**: `/switch status`, `/switch note` (preview without clearing), `/switch handoff off|on`.
**Other**: ceiling floor of 20k, latest write wins between the command and the file; CI runs the tests on every push.

**Measured (one handoff, small samples)**
- A fresh chat after a handoff opened at 82k tokens, against 190k with 0.6.1.
- Blind 30-question test: this note 28.5/30, 0.6.1 note 26.0/30, built-in compaction 15.5/30.
- Building a note from an 87 MB chat took 0.4 s and 31 MB of memory.

## 0.6.1
- Notice now reports the real handoff point, including the 40k wait after a handoff.
- Bundled note builder (`scripts/note.py`) is standard library only and has no personal paths.
- Notes are stored under `~/.claude/sage-relay/notes`.

## 0.6.0
- Model pinning is opt-in (`~/.claude/sage-relay/pin-models` containing `on`).
- Ceiling file moved to `~/.claude/sage-relay/ceiling`.

## 0.5.x
- Notice at 83% of the ceiling; idle warning after about 55 minutes.
- Ceiling can be set from a file.

## 0.4.x
- Handoff note is sent inside the message text (a separate field was dropped by the app).
- After a handoff, wait for 40k of growth before handing off again (fixes a loop).

## 0.3.0 and earlier
- Helper routing by type, one log line per reply, `/switch` command.
