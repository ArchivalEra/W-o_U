# W/o U (without User)

> The first Kimi Code session-level communication tool.

A direct peer-to-peer phone system for AI agent sessions.

One agent dials another across terminal windows or workspaces. The message body is pushed directly into the recipient's session context along with the incoming call card. Zero message polling. Zero intermediate mailboxes.

- **Direct Delivery**: The host agent's context and conversation transcript is the single source of truth.
- **Zero Message Storage**: No messages table, no read cursors, no database skew.
- **Directory-Only SQLite**: Only stores unique alias-to-session mappings via native `node:sqlite`.
- **Zero npm Dependencies**: Requires Node.js >= 22.5.0. No native C++ addons.
- **Single-File Engine**: The entire tool and CLI live in `bin/wo-u.mjs`.

---

## Provenance

The problem shape — multiple CLI agent sessions in one codebase that need to coordinate without a daemon — was first explored by [fwens](https://github.com/matttennie/fwens) (MIT), an MCP multi-agent coordination server. W/o U started as an evaluation of that project and owes it the initial insight: shared state between sessions, a directory of participants, and message passing as the coordination primitive.

Everything here diverged from fwens early and deliberately. Its `channel` field is a query filter, not an access-control model, and its `messages` table has no recipient column — routing by room name was not enough for one-to-one calls. Its multi-process design also keeps long-lived SQLite handles per MCP server, which turns fatal the moment the database file is replaced: every process keeps writing into an unlinked inode that nobody can read (both failure modes were hit in practice during the evaluation). W/o U therefore stores nothing but a directory of aliases, keys every message on session ids, routes bodies directly into the recipient's prompt, and opens its database only in short-lived connections. No code is shared with fwens; the MIT license is acknowledged as provenance.

---

## The Call Card

When Agent A dials Agent B, the message body is delivered directly into Agent B's context:

```text
📞 Incoming message from **S26**:

Task 42 implementation is complete and verified.

Reply: `wo-u send S26 'your message'`
```

The recipient sees the message immediately upon waking. No extra `read` command required.

---

## Quick Install

Requires Node.js >= 22.5.0:

```bash
git clone https://github.com/ArchivalEra/W-o_U.git ~/.wo-u/app
ln -sf ~/.wo-u/app/bin/wo-u ~/.local/bin/wo-u
```

---

## Commands

```bash
wo-u roster                       # List loaded sessions, busy states, and aliases
wo-u name <alias>                 # Claim a unique alias for the current session
wo-u whoami                       # Print current session identity and working directory
wo-u send <target> "<message>"    # Dial target session with direct message delivery
wo-u book                         # Show phone directory (alias -> session ID)
wo-u doctor                       # Inspect directory database status
```

`<target>` accepts a directory alias, a full session ID (`session_...`), or a unique short ID prefix.

---

## Configuration

All configuration is environment-driven:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WO_U_COMMAND` | `wo-u` | Command label printed in the reply prompt |
| `WO_U_CONTACT` | `true` | Set `0` or `false` to omit the reply prompt |
| `WO_U_DIR` | `~/.kimi-messenger` | Directory storage path (phone boundary) |
| `WO_U_API` | `http://127.0.0.1:45589` | Host local HTTP server base URL |
| `WO_U_TOKEN` | `~/.kimi-code/server.token` | Bearer token for host API authentication |
| `WO_U_SESSION_ID` | Inferred from `process.cwd()` | Override active session ID |
| `WO_U_WAKE_COMMAND` | Unset (uses Kimi API) | External shell command to wake recipient |
| `WO_U_WAKE_ADAPTER` | `kimi` | Set to `none` to disable wake push |

---

## Project Structure

```text
bin/wo-u.mjs         # The entire self-executable deep engine
bin/wo-u             # Symlink to bin/wo-u.mjs
package.json         # Package definition and scripts
tsconfig.json        # TypeScript configuration
AGENTS.md            # Rules for autonomous agents
README.md            # Documentation
LICENSE              # Apache-2.0
```

---

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.
