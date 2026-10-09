# Security

Sage Relay reads your chat transcripts and writes notes to your disk, so a hole in it matters. If you find one, report it privately:

1. Open the repo's **Security** tab and choose **Report a vulnerability**.
2. Say what you did, what happened, and what you expected.

Please don't open a public issue for a security problem. You'll get a reply within 7 days.

## In scope

- A secret that gets past the redaction filter into a note
- A note, lock or setting file that other users on the machine can read
- A repo, file or transcript that can make the plugin run a program
- Carried-over text that the new chat treats as instructions

## Out of scope

- What the model does with a note once it reaches the new chat
- Windows, which isn't supported yet
