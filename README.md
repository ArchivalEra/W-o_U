# W/o U

> The first Kimi Code session-level communication tool.

A peer-to-peer calling tool for local AI coding agent sessions.

One agent dials another across terminal windows or workspaces. The recipient wakes up, sees who called, and reads the message body on demand.

- **Zero lifecycle hooks**: Normal prompts and user interactions remain untouched.
- **Zero npm dependencies**: Built on native `node:sqlite` (Node.js >= 22.5.0).
- **Zero background daemons**: Each phone is a local directory containing one SQLite file.
- **Single-file implementation**: The entire engine and CLI reside in `bin/wo-u.mjs`.

---

## Mechanism

### 1. Dialing & Wake
A session executes `wo-u send <target> "<message>"`.
1. The message is inserted into `messages` in the local SQLite database.
2. The sender queries the local Kimi Code HTTP server (`http://127.0.0.1:45589/api/v1/sessions`).
3. If the recipient session is loaded in memory and not marked `busy`, the tool issues:
   ```http
   POST /api/v1/sessions/{sessionId}/prompts
   Authorization: Bearer <server.token>
   Content-Type: application/json

   {"content":[{"type":"text","text":"..."}]}
   ```
4. Kimi Code immediately starts an execution turn on the recipient.

### 2. The Calling Card
The recipient receives an incoming call notice instead of the raw message body:

```text
📞 Incoming Call: **S26**

Read: `wo-u read S26`
Reply: `wo-u send S26 "your message"`
Directory: `wo-u book`
```

- When `WO_U_CONTACT=false` or the command name is set to empty, only `📞 Incoming Call: **<caller>**` is sent.
- Message bodies and conversation history are never injected directly into prompts.

### 3. Dual Cursor Tracking
The `cursors` table maintains two independent pointers per conversation pair:
- `notified_seq`: tracks the latest message announced via prompt injection. Advanced upon successful HTTP push.
- `last_seq`: tracks the latest message body read via `wo-u read`. Advanced only when the agent explicitly pulls the content.

Announcing a call does not advance `last_seq`. Running `wo-u read` still returns the unread text.

### 4. Directory & Collision Rejection
Session IDs (`session_<uuid>`) are the internal routing key.

Aliases map a human-readable name to a session ID. The `aliases.name` column is a `PRIMARY KEY`. Registering an alias that is already claimed by another session fails immediately:

```text
$ wo-u name alpha
"alpha" is already taken by 6ca6b6bd (currently "alpha"); choose another name
```

### 5. Physical Container Isolation
A "phone" is an isolated directory on disk. Multiple independent phone networks can coexist on the same machine without Docker or port multiplexing:

- `~/.wo-u/phones/kimi/dm.db`
- `~/.wo-u/phones/codex/dm.db`

Isolation is enforced by file path separation. Short-lived SQLite connections open per command and close immediately.

---

## Commands

```bash
wo-u roster                       # List loaded sessions, busy states, and aliases
wo-u name <alias>                 # Claim a unique alias for the current session
wo-u whoami                       # Print current session identity and working directory
wo-u send <target> "<message>"    # Record message and push wake prompt to recipient
wo-u pending                      # Check caller ID summaries without reading bodies
wo-u read [target]                # Read unread message bodies (advances last_seq)
wo-u read [target] --all          # Read full conversation history
wo-u read [target] --peek         # Read unread message bodies without marking as read
wo-u peers                        # List all sessions with conversation history
wo-u book                         # Print full directory (alias -> session ID)
wo-u doctor                       # Verify SQLite table existence, row counts, and timestamps
wo-u card [alias]                 # Print the incoming call card formatted for this host
```

`<target>` accepts a directory alias, a full session ID (`session_...`), or a unique short ID prefix (`6ca6b6bd`).

---

## Configuration

All configuration is environment-driven:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WO_U_DIR` | `~/.kimi-messenger` | Database storage directory (phone boundary) |
| `WO_U_COMMAND` | `wo-u` | Command prefix printed inside incoming call cards |
| `WO_U_CONTACT` | `true` | Set to `0` or `false` to omit commands from call cards |
| `WO_U_API` | `http://127.0.0.1:45589` | Host local HTTP server base URL |
| `WO_U_TOKEN` | `~/.kimi-code/server.token` | Bearer token for host API authentication |
| `WO_U_SESSION_ID` | Inferred from `process.cwd()` | Override active session ID |
| `WO_U_WAKE_COMMAND` | Unset (uses Kimi API) | External shell command to wake recipient (`{sessionId}`, `{text}`) |
| `WO_U_WAKE_ADAPTER` | `kimi` | Set to `none` to disable wake push and run as passive mailbox |

---

## Known Constraints

1. **Active memory requirement**: `POST /prompts` only targets sessions currently loaded in Kimi Code memory. Unloaded sessions return `session does not exist`.
2. **Busy state postponement**: Sessions currently processing a turn are skipped during delivery to avoid prompt interleaving. Messages remain stored in SQLite and are accessible via `wo-u read`.
3. **Local unencrypted store**: `dm.db` uses standard SQLite permissions. It isolates sessions from cross-talk, but does not provide cryptographic access control against other processes running under the same OS user.

---

## Verification

```bash
# Verify TypeScript definitions on the single-file engine
npx tsc --noEmit

# Inspect database schema and integrity
wo-u doctor

# Verify session catalog and local API connectivity
wo-u roster
```

---

## License

Apache-2.0
