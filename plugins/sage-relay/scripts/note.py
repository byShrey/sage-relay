#!/usr/bin/env python3
"""Builds the handoff note for the Sage Relay plugin.

Reads one JSON object on stdin: {cwd, session_id, transcript_path?, parent?}
Prints {tag, text} on stdout. `text` is the whole conversation, word for word,
minus tool output, with secrets redacted, plus the last message, pinned rules
and git state. No network, no model calls, standard library only.

Derived from the author's earlier "session-relay" tool (same author, MIT).
"""
import contextlib
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

try:
    import fcntl  # POSIX only
except ImportError:
    fcntl = None


STATE_ROOT = Path(os.environ.get("RELAY_STATE_DIR", Path.home() / ".claude" / "sage-relay" / "notes"))


RESUME_WORDS = sorted(
    (w.strip().lower() for w in os.environ.get(
        "RELAY_RESUME_WORDS", "continue,resume,carry on,keep going").split(",") if w.strip()),
    key=len, reverse=True,  # longest phrase first, so "carry on" beats a bare "carry"
)


NOTE_MAX_AGE_HOURS = float(os.environ.get("RELAY_NOTE_MAX_AGE_HOURS", "336"))


# Whole-session summary, opt-in. Off by default: turning it on sends the
# (redacted) conversation to a model. Writers, tried in order: any
# OpenAI-compatible endpoint (URL + model + key or key command), then the
# local `claude` CLI on its cheapest model.
SUMMARY_MODE = os.environ.get("RELAY_SUMMARY", "off")


SUMMARY_MAX_CHARS = 400_000  # ~100k tokens: fits Haiku's 200k window with room for the prompt


# ponytail: pattern redaction, not a real secret scanner. Covers the shapes
# measured leaking on 2026-09-17 (13 kinds, 7 got through before); upgrade to
# gitleaks rules if a real key ever turns up in a note or summary. Anchored to
# key prefixes or to "name = value" so commit hashes and prose survive.
_SECRET_RE = re.compile(
    r"\b(?:sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{10,}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}"
    r"|AKIA[0-9A-Z]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}"
    r"|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"
    r"|(?i:\bbearer\s+)[A-Za-z0-9._~+/=-]{16,}"
    r"|(?i:\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b[\"']?\s*[:=]\s*)[\"']?[^\s\"',;]{6,}"
    r"|(?i:\b(?:api-keys?|key)\s*[:=]\s*)[\"']?[A-Za-z0-9-]{24,}"
)


NAME_WORDS = 4  # a note's name: the first few words of what the session is about


def redact(text):
    return _SECRET_RE.sub("[redacted]", text)


def project_slug(cwd):
    return re.sub(r"[^A-Za-z0-9]+", "-", cwd).strip("-") or "root"


def project_dir(cwd):
    d = STATE_ROOT / project_slug(cwd)
    d.mkdir(parents=True, exist_ok=True)
    return d


def session_dir(data):
    """The note folder for the project this session was STARTED in.

    Hook `cwd` is the current working folder, which drifts when a session
    cd's into a subfolder. Caught live: a usage-limit save landed under a
    second tag in the subfolder's slot, and the real tag's note stayed 15
    minutes stale. Claude Code files each transcript under
    ~/.claude/projects/<launch-folder-encoded>/, fixed for the session's
    life, so that folder name is the stable key. It slugs to the same name
    project_dir(launch cwd) always produced, so existing notes stay put.
    """
    tp = data.get("transcript_path")
    if tp and Path(tp).parent.parent.name == "projects":
        return project_dir(Path(tp).parent.name)
    return project_dir(str(data.get("cwd") or os.getcwd()))


def atomic_write(path, text):
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)  # atomic on the same filesystem; avoids two hooks racing on the same file


@contextlib.contextmanager
def _locked(d):
    """Serializes the tags.json/session_tag.json read-modify-write across
    processes. Measured, not theoretical: 20 truly concurrent save() calls
    without this lost 3 of 20 tags outright, because atomic_write() only
    makes the WRITE atomic -- two processes can still both read the same
    "before" state and the second write clobbers the first's addition.

    POSIX only (fcntl); on a platform without it (Windows, untested by
    this project either way) this silently degrades to no locking rather
    than crashing -- the same trade-off the rest of this tool already
    makes for a single-machine, single-user scale, just no longer the
    default on the platform this was actually measured on.
    """
    if fcntl is None:
        yield
        return
    lock_path = d / ".tags.lock"
    with open(lock_path, "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def load_json(path, default):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return default


def _tags_path(d):
    return d / "tags.json"


def set_parent(d, session_id, parent_tag):
    """Remember that this session continued <parent_tag>, so a later resume
    can walk the whole chain A -> B -> C (measured: C lost A without it)."""
    with _locked(d):
        parents = load_json(d / "parents.json", {})
        parents[session_id] = parent_tag
        atomic_write(d / "parents.json", json.dumps(parents, indent=1))


def _session_tag_path(d):
    return d / "session_tag.json"


def _prune_expired(tags, max_age_hours):
    cutoff = time.time() - max_age_hours * 3600
    return {t: v for t, v in tags.items() if v.get("saved_at", 0) >= cutoff}


def _slug(text):
    words = re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).split()
    return "-".join(words[:NAME_WORDS])[:40].strip("-")


def _name_base(d, session_id, transcript_path):
    """What the session is about, as a name you can read: a resumed session
    takes the name it continued (numbered below); otherwise Claude Code's own
    title for it, else the first thing typed. Replaced random names like
    'violet-harrier', which said nothing about the work."""
    parent = load_json(d / "parents.json", {}).get(session_id)
    if parent:
        return re.sub(r"-\d+$", "", parent)
    records = read_json_lines(transcript_path) if transcript_path else []
    titles = [r.get("customTitle") or r.get("aiTitle") for r in records
              if r.get("type") in ("ai-title", "custom-title")]
    typed = recent_user_texts(records, 50)
    for text in [t for t in reversed(titles) if t] + typed[:1]:
        if _parse_resume(text)[0] is None and _slug(text):  # "Continue keen-vole" says nothing
            return _slug(text)
    resumed = typed and _parse_resume(typed[0])[1]
    return re.sub(r"-\d+$", "", _slug(resumed)) if resumed else "session"


def get_or_create_tag(d, session_id, task_hint=None, transcript_path=None):
    """Return this session's tag, creating one on first use. Idempotent."""
    with _locked(d):
        session_tag = load_json(_session_tag_path(d), {})
        tags = _prune_expired(load_json(_tags_path(d), {}), NOTE_MAX_AGE_HOURS)

        existing = session_tag.get(session_id)
        if existing and existing in tags:
            return existing

        # base, base-2, base-3...: for a chain the number counts the handoffs
        base = _name_base(d, session_id, transcript_path)
        tag, n = base, 1
        while tag in tags or (d / f"{tag}.md").exists():
            n += 1
            tag = f"{base}-{n}"

        tags[tag] = {"session_id": session_id, "task": task_hint or "", "saved_at": time.time()}
        session_tag = {sid: t for sid, t in session_tag.items() if t in tags}  # drop dangling entries
        session_tag[session_id] = tag

        atomic_write(_tags_path(d), json.dumps(tags))
        atomic_write(_session_tag_path(d), json.dumps(session_tag))
        return tag


def touch_tag(d, tag, task_hint=None):
    with _locked(d):
        tags = _prune_expired(load_json(_tags_path(d), {}), NOTE_MAX_AGE_HOURS)
        if tag not in tags:
            return
        tags[tag]["saved_at"] = time.time()
        if task_hint:
            tags[tag]["task"] = task_hint
        atomic_write(_tags_path(d), json.dumps(tags))


def resume_line(tag):
    return f"continue {tag}"


def read_json_lines(path, max_bytes=400_000):
    """Read the tail of a transcript.jsonl and return parsed records.

    Fails open: any read/parse problem returns [] rather than raising, so a
    format change in Claude Code's transcript file never blocks a prompt.
    """
    try:
        p = Path(path)
        size = p.stat().st_size
        with p.open("rb") as f:
            if max_bytes is not None and size > max_bytes:
                f.seek(size - max_bytes)
                f.readline()  # drop the partial first line
            data = f.read().decode("utf-8", errors="ignore")
    except Exception:
        return []
    records = []
    for line in data.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return records


def message_text(rec):
    msg = rec.get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(p for p in parts if p)
    return ""


def last_assistant_text(records):
    """The most recent non-empty text Claude actually said, scanning every
    assistant record regardless of whether it carries usage.

    Deliberately separate from last_turn(), which is anchored to the last
    usage-carrying record for the size/gap calculation -- that record can
    be tool-use only, with no text at all, if the turn ended on a tool
    call rather than a wrap-up reply. Caught live: a real session's last
    usage-carrying record was exactly that (a Bash call), so its note's
    "Where it stopped" section came out completely empty even though the
    assistant's actual last words were only a few records earlier.
    """
    for rec in reversed(records):
        # isApiErrorMessage: Claude Code's own "You've hit your weekly limit"
        # record. Caught live: it was saved as the session's last words.
        if rec.get("type") != "assistant" or rec.get("isApiErrorMessage"):
            continue
        t = message_text(rec).strip()
        if t:
            return t
    return ""


def _usage_size(usage):
    return ((usage.get("input_tokens", 0) or 0) + (usage.get("cache_read_input_tokens", 0) or 0)
            + (usage.get("cache_creation_input_tokens", 0) or 0))


def last_turn(records):
    """(timestamp, size) from the last real conversational turn -- an
    assistant record that carries a usage block. Deliberately restricted
    to that one record type: Claude Code appends other housekeeping
    records to the same transcript file (queue-operation, artifact-
    comment-monitor, artifact-autoreact-ledger, and others), and those can
    carry a timestamp far more recent than the actual last reply. Taking
    "when did anything last touch this file" as the idle clock made an
    hours-cold session look like it had just been active a few minutes
    ago -- caught live, on a real session, where it silently let a
    session-relay-cost message through with no warning at all because the
    cold-guard's gap check came out far too small. Both values now always
    come from the same record on purpose: computing them from two
    independent scans is exactly what caused that.

    Also skips an assistant record whose usage sums to zero. That shape
    shows up on a failed, cancelled, or otherwise empty generation -- found
    on a second real session in the same live check, where the literal
    last assistant record read (0, 0, 0) while the real conversation seven
    seconds earlier was ~819k tokens. Taking the zero-usage record at face
    value would have reported the size as 0 instead of the real figure.
    """
    for rec in reversed(records):
        if rec.get("type") != "assistant":
            continue
        msg = rec.get("message")
        if not isinstance(msg, dict):
            continue
        usage = msg.get("usage")
        if not isinstance(usage, dict):
            continue
        ts = rec.get("timestamp")
        if not ts:
            continue
        size = _usage_size(usage)
        if size <= 0:
            continue
        try:
            import datetime
            t = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
        return t, size
    return None, None


def last_usage_total(records):
    """Kept for callers (and tests) that only need the size. Delegates to
    last_turn() so it can never disagree with the gap calculation."""
    return last_turn(records)[1]


def recent_user_texts(records, n=6):
    """The last few things the user actually typed, most recent last.

    Skips a `<task-notification>`-wrapped message: Claude Code injects
    these as a `user`-role record (with `isMeta` false, so the existing
    isMeta filter doesn't catch it) to report a background task's status
    -- the user never typed it. Caught live: a real resume note's "Task"
    field showed one of these instead of the user's actual last request.
    """
    out = []
    for rec in reversed(records):
        if rec.get("type") == "user" and not rec.get("isMeta"):
            t = message_text(rec).strip()
            if t.startswith("<task-notification>"):
                continue
            if t and t not in out:
                out.append(t)
        if len(out) >= n:
            break
    out.reverse()
    return out


def truncate_at_boundary(text, limit):
    """Cut text to at most `limit` characters, at a word boundary, with a
    clear marker when it actually was cut.

    Caught live: the old fixed [:1200] slice cut a real last message off
    mid-word ("Sketchboo" instead of "Sketchbook"), and did so silently --
    no sign in the note that anything was missing, and 1200 characters is
    well short of a typical substantive wrap-up reply. Raised the caller's
    limit and made truncation honest here, rather than pretending a
    partial word is the complete message.
    """
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(None, 1)[0] if " " in text[:limit] else text[:limit]
    return cut + f" [...truncated, {len(text) - len(cut)} more characters]"


def changed_files(records, n=10):
    paths = []
    for rec in records:
        msg = rec.get("message") or {}
        for block in (msg.get("content") or []):
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            if block.get("name") not in ("Edit", "Write", "MultiEdit"):
                continue
            fp = (block.get("input") or {}).get("file_path")
            if fp and fp not in paths:
                paths.append(fp)
    return paths[-n:]


def git_status(cwd):
    try:
        import subprocess
        branch = subprocess.run(["git", "-C", cwd, "branch", "--show-current"],
                                 capture_output=True, text=True, timeout=3).stdout.strip()
        if not branch:
            return None
        status = subprocess.run(["git", "-C", cwd, "status", "--short"],
                                 capture_output=True, text=True, timeout=3).stdout.strip()
        return branch, status
    except Exception:
        return None


def fmt_tokens(n):
    if n is None:
        return "unknown"
    return f"{n/1000:.0f}k" if n >= 1000 else str(n)


# Sentences the user wrote that lay down a rule. Copied out word for word and
# never shown to a model before being stored: a paraphrase of a constraint is a
# lossy copy of a constraint, and "never consolidate that debt" coming back as
# "prefers the current structure" inverts it into something a fresh session will
# happily argue with. Copying cannot invert.
#
# This exists for the two cases where the verbatim conversation carry drops out
# silently: the CHAIN_MAX_CHARS budget cutting older sessions, and Claude Code
# pruning a transcript after 30 days (_note_conversation then returns ""). In
# both, the chain falls back to the summary, measured at 12/30 on recall against
# 28/30 for the real conversation.
# Whole words only. Caught on real data: a plain substring match pulled in
# "whenever" as "never", and would take "mustard" and "nonstop" the same way.
#
# The word list is short on purpose. Measured over every transcript on this
# machine, `don't` alone produced 206 of 403 lines and 85 of those were "I don't
# know / think / see / understand" -- an admission, not a rule. `stop` matched
# "phone stop is pointing towards me". Precision beats recall here: one missed
# rule costs one wrong decision, but 35 junk lines pinned as "binding" degrade
# every decision after them. Add a word back only with real data showing it pays.
_RULE_RE = re.compile(r"\b(never|must|always|rejected|don'?t|do not)\b", re.I)


# "I don't know how this works" is not an instruction. Imperative "Don't
# rebuild viewer.html" is, which is why don't/do not stay in the list above.
#
# Only the knowing verbs. An earlier version killed any "I don't ..." and took
# "I don't like the logo on the website" with it -- which is exactly the
# kind of standing preference this feature exists to carry. "I don't like" and
# "I don't want" are rules; "I don't know" is a confession.
_ADMISSION_RE = re.compile(
    r"\bi\s+(don'?t|do not|didn'?t|did not|can'?t|cannot)\s+"
    r"(know|think|understand|get|see|remember|recall|have|feel)\b", re.I)


# Text this plugin itself injects into a session. Without this it harvests its
# own resume instructions back as the user's rules -- found 5 times in real
# transcripts -- and a chain re-feeds them at every hop until they crowd out
# the real ones. Anything the plugin writes into a conversation belongs here.
_OWN_TEXT = ("Where it stopped", "Resuming saved session", "session-relay:",
             "Standing rules from this work", "read that file in full with the Read tool",
             "Model check:", "continued from:")


_FENCE_RE = re.compile(r"```.*?```", re.S)


_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+|\n+")


_LIST_LINE_RE = re.compile(r"^\s*([-*+>#|]|\d+[.)])\s", re.M)


PINNED_PER_SESSION = 30


def _is_pasted(text):
    """A report, table or document pasted into the chat, rather than something
    typed. Measured: half of every line this used to collect came from pasted
    documents -- handoff notes, audit tables, another agent's output -- because
    those are dense with "must" and "never" and none of it is the user speaking.
    """
    return text.count("\n") > 12 or len(_LIST_LINE_RE.findall(text)) >= 3


def pinned_lines(records):
    """The user's own rule-setting sentences, oldest first, verbatim.

    `records` may be a generator -- see `user_records`. Pass the WHOLE session,
    not a tail: measured on real transcripts, reading only the last 400 KB
    (`read_json_lines`'s default) missed 89% of the rules, and on the largest
    session it found none at all, because rules get set early and referenced
    later. That is the opposite end of the file from where a tail looks.

    ponytail: still word matching, so it still over-collects a little. That is
    the accepted floor. Do not reach for a model to filter it -- a model that
    can drop a line can also reword one, which is the failure this whole thing
    exists to prevent.
    """
    out = []
    for rec in records:
        if rec.get("type") != "user" or rec.get("isMeta"):
            continue
        text = message_text(rec).strip()
        if not text or text.startswith(("<task-notification>", "<local-command", "<command-")):
            continue
        if _is_pasted(text) or any(m in text for m in _OWN_TEXT):
            continue
        text = _FENCE_RE.sub(" ", text)  # pasted code and stack traces are not rules
        for s in _SENTENCE_RE.split(text):
            s = s.strip()
            if not (5 <= len(s.split()) and len(s) <= 300):
                continue
            if s.endswith("?") or _ADMISSION_RE.search(s):
                continue  # a question and an admission are both not a rule
            if _RULE_RE.search(s) and s not in out:
                out.append(s)
    return [redact(s) for s in out[-PINNED_PER_SESSION:]]


def user_records(path):
    """Stream just the user messages out of a transcript, whole file, oldest
    first. Never raises.

    Streamed rather than handed to `read_json_lines(path, None)` because the
    rules need the entire session (see `pinned_lines`) and the largest
    transcript on this machine is 87 MB: walking it costs 0.95s either way, but
    keeping every parsed record at once peaked at 362 MB, and this runs on a
    Stop hook after every single reply.
    """
    try:
        with open(path, "rb") as f:
            for raw in f:
                if b'"user"' not in raw:
                    continue
                try:
                    rec = json.loads(raw.decode("utf-8", errors="ignore"))
                except Exception:
                    continue
                if isinstance(rec, dict) and rec.get("type") == "user":
                    yield rec
    except Exception:
        return


def read_pinned(path):
    """The bullet lines back out of a .pinned.md, or [] if there isn't one.

    Catches everything, like every other reader in this file. It was OSError
    only, and one corrupt byte then raised out of `resume_context` and cost the
    resume its ENTIRE context -- note, summary and conversation -- not just the
    rules. A bad pinned file must lose the pinned file and nothing else.
    """
    try:
        return [ln[2:] for ln in path.read_text(errors="replace").splitlines()
                if ln.startswith("- ")]
    except Exception:
        return []


def cmd_save(data):
    cwd = str(data.get("cwd") or os.getcwd())
    session_id = data.get("session_id", "unknown")
    transcript_path = data.get("transcript_path")
    records = read_json_lines(transcript_path) if transcript_path else []

    task_lines = recent_user_texts(records, 6)
    first_task = task_lines[0] if task_lines else "(no user message recorded)"
    later_tasks = task_lines[1:]

    # Claude Code's own Stop hook field is preferred when present, but it
    # can legitimately be empty (the last turn ended on a tool call with
    # no closing text) -- fall back to scanning the transcript ourselves
    # rather than leaving "Where it stopped" blank when real text exists
    # just a few records earlier.
    last_reply = (data.get("last_assistant_message") or "").strip() or last_assistant_text(records)
    stopped_reason = data.get("hook_event_name") == "StopFailure"

    d = session_dir(data)
    tag = get_or_create_tag(d, session_id, task_hint=first_task[:140], transcript_path=transcript_path)
    touch_tag(d, tag, task_hint=first_task[:140])

    lines = [
        f"# Session note -- {project_slug(cwd)}",
        "",
        f"- tag: {tag}",
        f"- resume with: {resume_line(tag)}",
        f"- session: {session_id}",
        f"- full conversation: {transcript_path or 'unknown'}",
        f"- project: {cwd}",
        f"- saved: {time.strftime('%Y-%m-%d %H:%M %Z')}",
    ]
    parent = load_json(d / "parents.json", {}).get(session_id)
    if parent:
        lines.append(f"- continued from: {parent}")
    if stopped_reason:
        lines.append(f"- stopped by: usage limit ({data.get('error_type', 'rate_limit')})")

    gs = git_status(cwd)
    if gs:
        branch, status = gs
        lines.append(f"- git branch: {branch}")
        if status:
            lines.append(f"- uncommitted: {', '.join(status.splitlines()[:8])}")

    size = last_usage_total(records)
    if size is not None:
        lines.append(f"- last known size: {fmt_tokens(size)} tokens")

    lines += ["", "## Task", first_task]
    if later_tasks:
        lines += ["", "## More recent messages"] + [f"- {t[:300]}" for t in later_tasks]

    if last_reply.strip():
        lines += ["", "## Where it stopped", redact(truncate_at_boundary(last_reply.strip(), 6000))]

    files = changed_files(records)
    if files:
        lines += ["", "## Files touched", *[f"- {p}" for p in files]]

    note = redact("\n".join(lines) + "\n")

    atomic_write(d / f"{tag}.md", note)
    atomic_write(d / "latest.md", note)  # convenience copy of the most recent save, for humans reading by hand

    # The WHOLE transcript, not `records` -- that is only the last 400 KB, which
    # measured out at 89% of real rules missed, and none at all on the largest
    # session. Streamed, so a big file costs time but not memory.
    pins = pinned_lines(user_records(transcript_path)) if transcript_path else []
    if pins:
        atomic_write(d / f"{tag}.pinned.md", "\n".join(f"- {p}" for p in pins) + "\n")

    # _skip_summary: the handoff path writes its summary in the foreground, so it
    # must not also launch one in the background here.
    if SUMMARY_MODE == "auto" and transcript_path and not data.get("_skip_summary"):
        launch_summary(d, tag, transcript_path, force=stopped_reason)
    return {}


def conversation_text(transcript_path):
    """What was actually said, from the WHOLE transcript: user messages,
    Claude's text replies, one line per tool call. Drops tool output and
    thinking, which is most of the file -- measured: a 6.2 MB transcript
    came out at 139 KB. Redacted before it can leave the machine."""
    lines = []
    for rec in read_json_lines(transcript_path, max_bytes=None):
        kind = rec.get("type")
        if kind not in ("user", "assistant") or rec.get("isMeta") or rec.get("isApiErrorMessage"):
            continue
        t = message_text(rec).strip()
        if t and not t.startswith(("<task-notification>", "<local-command", "<command-")):
            lines.append(f"{'User' if kind == 'user' else 'Claude'}: {t}")
        for b in (rec.get("message") or {}).get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                inp = b.get("input") or {}
                lines.append(f"[{b.get('name')} {inp.get('file_path') or inp.get('description') or ''}]".rstrip())
    text = redact("\n".join(lines))
    if len(text) > SUMMARY_MAX_CHARS:
        # ponytail: keeps the start (the goal) and the recent end, cuts the middle.
        # Split into pieces and summarize each if a middle-heavy session ever needs it.
        text = text[:100_000] + "\n[... middle of session cut for length ...]\n" + text[-(SUMMARY_MAX_CHARS - 100_000):]
    return text


def launch_summary(*args, **kwargs):
    """AI summaries are not part of this plugin."""


def resume_context(match, note_path):
    """The additionalContext string for resuming a saved note: the note,
    the summary, and the whole previous conversation word for word (tool
    output removed).

    Why the whole conversation: measured on a real session, 30 questions a
    resumed session needs answered: the conversation text answered 28, note +
    summary only 12. It is small -- at a 500k handoff the conversation text
    was 7k-24k tokens across his real sessions.

    Claude Code shows the model only a preview of hook context over 10,000
    characters and saves the rest to its own file (measured: a word at the
    end of 31k chars was invisible until read). The model may read that file
    without a permission prompt (measured), unlike a file we write ourselves
    under ~/.claude/session-relay, which was refused in a real resume -- and
    the model then invented what the session was about. So: pass everything,
    and put the read-it-all instruction first, where the preview shows it.

    Still tells the model to quote "Where it stopped" verbatim: caught live,
    it paraphrased the note otherwise.
    """
    note = note_path.read_text()
    body = note + _summary_block(note_path)
    conv = _note_conversation(note)
    pins = read_pinned(note_path.parent / f"{match}.pinned.md")

    # Earlier sessions in the chain, newest first, until the budget runs out;
    # past it an older session keeps only its summary.
    earlier, seen, budget = [], {match}, CHAIN_MAX_CHARS - len(conv)
    parent = _note_field(note, "continued from")
    while parent and parent not in seen and (note_path.parent / f"{parent}.md").is_file():
        seen.add(parent)
        p_path = note_path.parent / f"{parent}.md"
        p_note = p_path.read_text()
        p_conv = _note_conversation(p_note)
        pins = read_pinned(note_path.parent / f"{parent}.pinned.md") + pins
        part = f"\n### Session {parent}\n" + _summary_block(p_path)
        if p_conv and len(p_conv) <= budget:
            budget -= len(p_conv)
            part += "\n#### Its conversation, word for word\n" + _wrap(p_conv) + "\n"
        elif p_conv:
            budget = -1  # keep the chain in order: nothing older gets its conversation either
            part += (f"\n(Conversation left out to keep this short; the full record is "
                     f"{_note_field(p_note, 'full conversation')}.)\n")
        earlier.append(part)
        parent = _note_field(p_note, "continued from")

    # Deliberately outside the budget above: these are a few KB, and they are
    # what has to survive precisely when a conversation gets cut for size.
    # Newest kept when over the cap -- his rules arrive after something goes
    # wrong, so the late ones are the ones worth keeping.
    pins = list(dict.fromkeys(pins))[-PINNED_TOTAL:]
    if pins:
        body = ("## Standing rules from this work, in the user's own words\n"
                "Copied word for word from what he typed. No model wrote or rewrote them.\n"
                "Treat them as binding, and do not undo one because a summary below "
                "reads differently.\n\n"
                + "\n".join(f"- {p}" for p in pins) + "\n\n" + body)

    if earlier:
        body += ("\n## Earlier sessions this work continued from, oldest first\n"
                 + "".join(reversed(earlier)))
    if conv:
        body += "\n## The whole previous conversation, word for word (tool output removed)\n" + _wrap(conv) + "\n"
    return (
        f"Resuming saved session '{match}'. This context is long. If you see only a preview "
        f"of it with a file path, then BEFORE replying or doing anything else, read that "
        f"file in full with the Read tool, in parts with offset/limit until the last line. "
        f"It holds any standing rules he set, the note, a summary and the entire previous "
        f"conversation word for word: "
        f"it is your memory of that session, so rely on it for decisions, their reasons and "
        f"the user's preferences, and never guess what the session was about. Then, if the "
        f"user asks what you last said, what happened, or to continue, quote the note's "
        f"\"Where it stopped\" section verbatim, word for word -- do not paraphrase it -- "
        f"and carry on from there.\n\n" + body
    )


CHAIN_MAX_CHARS = 400_000  # ~100k tokens of conversation across the whole chain


PINNED_TOTAL = 50  # standing rules kept across the whole chain, newest first


def _note_field(note, name):
    return next((l.split(": ", 1)[1].strip() for l in note.splitlines()
                 if l.startswith(f"- {name}: ")), None)


def _note_conversation(note):
    tp = _note_field(note, "full conversation")
    if not tp or tp == "unknown":  # notes saved before the 'full conversation' line existed
        sid = _note_field(note, "session")
        tp = sid and _transcript_for(sid)
    return conversation_text(tp) if tp and Path(tp).is_file() else ""


def _wrap(conv):
    import textwrap
    return "\n".join(w for line in conv.splitlines() for w in (textwrap.wrap(line, 1500) or [""]))


def _summary_block(note_path):
    """The AI-written whole-session summary, if one exists, labelled as less
    exact than the word-for-word note above it."""
    p = note_path.with_name(note_path.stem + ".summary.md")
    if not p.is_file():
        return ""
    model = load_json(note_path.with_name(note_path.stem + ".summary.json"), {}).get("model", "a model")
    return (f"\n## Summary of the whole session (written by {model}, may be imprecise -- "
            f"the sections above are exact)\n{p.read_text()}")


def _parse_resume(prompt):
    """'continue swift-otter' -> ('continue', 'swift-otter'); 'continue' -> ('continue', '')."""
    p = prompt.strip().lower()
    for phrase in RESUME_WORDS:
        if p == phrase:
            return phrase, ""
        if p.startswith(phrase + " "):
            # Stray quotes/punctuation from copying the tag out of a message:
            # "continue x-2'" missed its note on 2026-09-24 and started empty.
            return phrase, p[len(phrase):].strip().strip("'\"`.,;:!?")
    return None, None


def _transcript_for(session_id):
    home = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
    return next(iter((home / "projects").glob(f"*/{session_id}.jsonl")), None)


def main():
    try:
        data = json.load(sys.stdin)
        data.setdefault("transcript_path", str(_transcript_for(data["session_id"]) or ""))
        d = session_dir(data)
        if data.get("parent"):
            set_parent(d, data["session_id"], data["parent"])
        cmd_save({**data, "_skip_summary": True, "hook_event_name": "Handoff"})
        tag = get_or_create_tag(d, data["session_id"])
        print(json.dumps({"tag": tag, "text": resume_context(tag, d / f"{tag}.md")}))
    except Exception as e:
        print(f"note failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
