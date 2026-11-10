# AGENTS.md

**W/o U (without User)**: Peer-to-peer session-level communication phone for AI agents.

## Hard Rules

### 1. NEVER delete the active database file
Do NOT delete `~/.kimi-messenger/dm.db` or its `-wal`/`-shm` companions while sessions are live.
Deleting the active database causes a deceptive failure: prompts are still pushed into recipient sessions via HTTP, but message records vanish, falsely appearing as a routing bug.

If the store must be cleared:
- Delete specific rows by sequence or sender: `DELETE FROM messages WHERE sender = ?`
- To reset entirely: back up first via `mv dm.db dm.db.bak-$(date +%s)` while confirming no sessions have open descriptors (`lsof dm.db`).

### 2. No Lifecycle Hooks Allowed
**Do NOT reintroduce Kimi Code or host lifecycle hooks.**
W/o U is explicitly hook-free. User context must remain 100% clean during normal prompt interactions. Communication notifications happen exclusively when `wo-u send` directly triggers a host wake API.

### 3. Maintain Dual Cursors
The `cursors` table maintains two distinct sequence pointers:
- `notified_seq`: tracks incoming calls that have already triggered a wake event.
- `last_seq`: tracks message bodies that have actually been consumed by `wo-u read`.

Advancing `last_seq` upon push delivery is strictly prohibited, as it causes new message bodies to disappear before the recipient explicitly invokes `read`.

### 4. Zero External Runtime Dependencies
Use Node.js native `node:sqlite` (Node >= 22.5). Do not re-add `better-sqlite3` or compiled native addons that cause ABI mismatches with Electron-packaged Node environments.

### 5. Physical Container Discipline
Do not merge or auto-discover databases across phone containers. Each phone directory is an isolated unit.
- Customizations apply to command names, endpoints, and templates, not to merging multi-tenant databases into a single runtime.

---

## Verification Suite

After any modification, verify:
```bash
npx tsc --noEmit
wo-u doctor
wo-u roster
wo-u card
```
Confirm both `wo-u read` and `wo-u pending` behave as expected with dual cursors.
