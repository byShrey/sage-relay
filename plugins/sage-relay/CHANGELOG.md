# Changelog

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
