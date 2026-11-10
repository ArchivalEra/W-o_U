# AGENTS.md

**W/o U (without User)**: Session-level direct communication phone for AI agents.

## Core Invariants

### 1. No Message Storage Allowed
Do not add tables for messages, chat history, or read cursors.
Messages are pushed directly into the target session's prompt queue via the host API. The recipient's agent transcript is the single source of truth. Storing an intermediate duplicate mailbox in SQLite introduces state skew, inode leakage, and unnecessary complexity.

### 2. Directory Only
The local SQLite database (`directory.db`) must ONLY store alias-to-session mappings (`aliases` table).
Aliases are strictly unique: collision must fail at registration (`name PRIMARY KEY`).

### 3. No Polling or Read Commands
Do not reintroduce `read` or `pending` commands. Messages arrive directly in the recipient's prompt turn.

### 4. Single-File Architecture
Keep the entire implementation inside `bin/wo-u.mjs`. Do not extract middle-man CLI wrappers or multi-file libraries unless explicitly requested.

### 5. Zero External Runtime Dependencies
Use Node.js native `node:sqlite` (Node >= 22.5). Do not add npm runtime dependencies.

---

## Verification

After any modification, verify:
```bash
npx tsc --noEmit
wo-u doctor
wo-u roster
wo-u book
```
Confirm `wo-u send` delivers directly without intermediate message store.
