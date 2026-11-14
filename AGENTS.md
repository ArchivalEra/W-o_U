# AGENTS.md

W/o U: session-level direct messaging between AI coding agents. One session
calls another; the message body arrives inside the recipient's prompt turn.

## Rules

- Store nothing but aliases. The SQLite database (`directory.db`) holds one
  table (`aliases`: name PRIMARY KEY, session_id UNIQUE). Never add tables
  for messages, chat history, or read cursors. The recipient's transcript is
  the single source of truth; a second copy introduces state skew and lost
  writes.

- Alias collisions fail at registration. Never route by picking the first
  match.

- Deliver message bodies inside the wake prompt. Never reintroduce
  read/pending/polling commands; a body that needs a second step to view is
  a design regression.

- Keep the whole implementation in `bin/wo-u.mjs`. No wrapper scripts, no
  library files.

- Runtime dependencies come from Node.js built-ins only (`node:sqlite`,
  `node:fs`, `node:os`, `node:path`, `node:process`, `node:child_process`,
  `node:url`). No npm packages at runtime.

- Push is allowed only per-repo with explicit maintainer enablement. A push
  request plus code-review conclusion goes in the session's final output;
  push only after the maintainer replies. Never push without that review
  conclusion in the commit message.

- README stays user-facing. Push policy, approvals, and account details
  belong here, never there.

## Verify

After any change:

```
npx tsc --noEmit
wo-u doctor
wo-u roster
wo-u book
```
