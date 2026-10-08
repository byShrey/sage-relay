# Changelog

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

**Note builder**
- Bad records can't break a note; secret filter rewritten (key blocks, any `*_PASSWORD`/`*_TOKEN` name, more token formats, database URLs, card numbers) with a linear-time check.
- Earlier handoff messages and history are quoted as untrusted; rule-like lines are listed as candidates to confirm.
- Notes are deleted after 14 days; folder 700, files 600. Note size is capped.

**Routing**
- Model routing is now off by default: `/switch routing on|off`. Your own model pick is never overridden.
- Three helper agents the chat chooses by judgement: Deep (Opus, high), Careful (Sonnet, high), Scout (Haiku).

**New commands**: `/switch status`, `/switch note` (preview without clearing), `/switch handoff off|on`.
**Other**: ceiling floor of 20k, latest write wins between the command and the file; CI runs the tests on every push.

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
