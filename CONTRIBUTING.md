# Contributing

Bug reports with steps to reproduce help most. For a fix:

1. Write a test that fails on the bug: `tests/sequence.mts` for the hooks, `tests/test_note.py` for the note builder.
2. Make it pass without breaking the others:

```bash
python3 -m unittest discover -s tests
node tests/sequence.mts
claude plugin test plugins/sage-relay
```

3. Build fake keys in tests from pieces (`"sk-" + "ant-..."`), so secret scanners don't flag the file.

The note builder uses Python's standard library only. Please keep it that way.
