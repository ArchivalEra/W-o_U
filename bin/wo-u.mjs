#!/usr/bin/env node
/**
 * W/o U (without User) — Direct messaging between AI agent sessions.
 *
 * Single-file deep module:
 *   - Persistent SQLite store via Node's native node:sqlite (zero npm deps).
 *   - Dual cursors (notified_seq for incoming calls, last_seq for body reads).
 *   - Directory alias registry with strict collision rejection.
 *   - Pluggable host wake adapter (built-in Kimi Code HTTP prompt, custom command, or quiet).
 *   - Physical directory isolation (every directory is an independent phone).
 *   - Self-executable CLI entrypoint when run from command line.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths & Environment
// ---------------------------------------------------------------------------

const KIMI_HOME = process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
const STORE_DIR = process.env.WO_U_DIR || process.env.KIMI_MESSENGER_DIR || path.join(os.homedir(), ".kimi-messenger");
const STORE_FILE = path.join(STORE_DIR, "dm.db");
const API_BASE = process.env.WO_U_API || process.env.KIMI_MESSENGER_API || "http://127.0.0.1:45589";

const PHONE = (process.env.WO_U_COMMAND || process.env.KIMI_MESSENGER_PHONE || "wo-u").trim();

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

const WITH_CONTACT = envFlag("WO_U_CONTACT", envFlag("KIMI_MESSENGER_CONTACT", true)) && PHONE.length > 0;

// ---------------------------------------------------------------------------
// Wake Adapter: Pluggable host notification
// ---------------------------------------------------------------------------

function apiToken() {
  if (process.env.WO_U_TOKEN || process.env.KIMI_MESSENGER_TOKEN) {
    return process.env.WO_U_TOKEN || process.env.KIMI_MESSENGER_TOKEN;
  }
  try {
    return fs.readFileSync(path.join(KIMI_HOME, "server.token"), "utf-8").trim();
  } catch {
    return null;
  }
}

/** @returns {Promise<{ code: number, msg?: string, data?: any } | null>} */
async function apiJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function kimiApiGet(pathname) {
  const token = apiToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE}${pathname}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    const body = await apiJson(res);
    return body?.code === 0 ? body.data : null;
  } catch {
    return null;
  }
}

function projectNames() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(KIMI_HOME, "projects.json"), "utf-8"));
    const map = new Map();
    for (const entry of Object.values(raw.projects || {})) {
      if (typeof entry?.root !== "string" || typeof entry.name !== "string") continue;
      const root = entry.root.replace(/\/+$/, "");
      if (root && entry.name.trim()) map.set(root, entry.name.trim());
    }
    return map;
  } catch {
    return new Map();
  }
}

function labelFor(cwd) {
  const abs = String(cwd || "").replace(/\/+$/, "");
  return projectNames().get(abs) || path.basename(abs) || "root";
}

const KimiHostAdapter = {
  name: "kimi",
  async listSessions() {
    const data = await kimiApiGet("/api/v1/sessions");
    const items = data?.items || [];
    return items.map((it) => {
      const cwd = (it.metadata?.cwd || "").replace(/\/+$/, "");
      return {
        id: it.id,
        label: labelFor(cwd),
        cwd,
        busy: Boolean(it.busy),
        archived: Boolean(it.archived),
        title: it.title || "",
      };
    });
  },

  async wake(sessionId, text) {
    const token = apiToken();
    if (!token) return { ok: false, reason: "missing_token" };

    try {
      const res = await fetch(`${API_BASE}/api/v1/sessions/${sessionId}/prompts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: [{ type: "text", text }] }),
        signal: AbortSignal.timeout(5000),
      });
      const body = await apiJson(res);
      return body?.code === 0
        ? { ok: true, promptId: body.data?.prompt_id }
        : { ok: false, reason: body?.msg || "rejected" };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  },
};

function getWakeAdapter() {
  const customCmd = process.env.WO_U_WAKE_COMMAND;
  if (customCmd) {
    return {
      name: "custom_command",
      async listSessions() {
        return KimiHostAdapter.listSessions();
      },
      async wake(sessionId, text) {
        return new Promise((resolve) => {
          const cmd = customCmd.replaceAll("{sessionId}", sessionId).replaceAll("{text}", JSON.stringify(text));
          const child = spawn(cmd, { shell: true, stdio: "ignore" });
          child.on("close", (code) => {
            resolve(code === 0 ? { ok: true } : { ok: false, reason: `exit_${code}` });
          });
          child.on("error", (err) => resolve({ ok: false, reason: err.message }));
        });
      },
    };
  }

  const mode = (process.env.WO_U_WAKE_ADAPTER || "kimi").toLowerCase();
  if (mode === "none") {
    return {
      name: "none",
      async listSessions() { return []; },
      async wake() { return { ok: false, reason: "wake_disabled" }; },
    };
  }

  return KimiHostAdapter;
}

// ---------------------------------------------------------------------------
// Store Primitives
// ---------------------------------------------------------------------------

function withStore(fn) {
  fs.mkdirSync(STORE_DIR, { recursive: true });

  const db = new DatabaseSync(STORE_FILE);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        pair         TEXT NOT NULL,
        sender       TEXT NOT NULL,
        recipient    TEXT NOT NULL,
        body         TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pair_seq ON messages(pair, seq);

      CREATE TABLE IF NOT EXISTS cursors (
        owner        TEXT NOT NULL,
        pair         TEXT NOT NULL,
        last_seq     INTEGER NOT NULL DEFAULT 0,
        notified_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner, pair)
      );

      CREATE TABLE IF NOT EXISTS aliases (
        name       TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        updated_at TEXT NOT NULL
      );
    `);

    const cols = db.prepare("PRAGMA table_info(cursors)").all().map((c) => c.name);
    if (!cols.includes("notified_seq")) {
      db.exec("ALTER TABLE cursors ADD COLUMN notified_seq INTEGER NOT NULL DEFAULT 0");
    }

    return fn(db);
  } finally {
    db.close();
  }
}

function pairKey(a, b) {
  return [a, b].sort().join("|");
}

function stamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function sessionMatch(id, ref) {
  const target = String(ref ?? "").trim();
  if (!target) return false;
  if (id === target) return true;
  if (id.startsWith(target)) return true;
  const noPrefix = id.replace(/^session_/, "");
  if (noPrefix === target || noPrefix.startsWith(target)) return true;
  return false;
}

function nameLookup() {
  let rows = [];
  try {
    rows = withStore((db) => db.prepare("SELECT session_id, name FROM aliases").all());
  } catch {
    return () => null;
  }
  const map = new Map(rows.map((r) => [r.session_id, r.name]));
  return (id) => map.get(id) || null;
}

async function requireSession(ref) {
  const raw = String(ref ?? "").trim();
  if (!raw) throw new Error("A session reference is required");

  const adapter = getWakeAdapter();
  const all = await adapter.listSessions();
  const nameOf = nameLookup();

  const matched = all.filter((s) => sessionMatch(s.id, raw));
  if (matched.length === 1) {
    return { ...matched[0], name: nameOf(matched[0].id) || null };
  }
  if (matched.length > 1) {
    throw new Error(
      `"${raw}" matches ${matched.length} sessions; use a longer prefix:\n`
      + matched.map((s) => `  ${s.id}  (${nameOf(s.id) || s.label})`).join("\n"),
    );
  }

  throw new Error(`Unknown session: ${raw}\nRun "wo-u roster" to list available session ids`);
}

function normalizeName(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "")
    .slice(0, 32);
}

function shortId(id) {
  return String(id).replace(/^session_/, "").slice(0, 8);
}

// ---------------------------------------------------------------------------
// Core Operations
// ---------------------------------------------------------------------------

export async function register({ sessionId, name }) {
  const session = await requireSession(sessionId);
  const wanted = normalizeName(name);
  if (!wanted) throw new Error("Alias cannot be empty");

  return withStore((db) => {
    const taken = db.prepare("SELECT session_id FROM aliases WHERE name = ?").get(wanted);
    if (taken && taken.session_id !== session.id) {
      const owner = db.prepare("SELECT name FROM aliases WHERE session_id = ?").get(taken.session_id);
      throw new Error(
        `"${wanted}" is already taken by ${shortId(taken.session_id)}`
        + `${owner ? ` (currently "${owner.name}")` : ""}; choose another name`,
      );
    }

    db.prepare(
      `INSERT INTO aliases (name, session_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    ).run(wanted, session.id, stamp());

    return { name: wanted, sessionId: session.id };
  });
}

async function resolveRef(ref) {
  const raw = String(ref ?? "").trim();
  if (!raw) throw new Error("A session reference is required");

  try {
    return await requireSession(raw);
  } catch (idError) {
    const message = idError instanceof Error ? idError.message : String(idError);
    if (!/Unknown session:/.test(message)) throw idError;
  }

  const wanted = normalizeName(raw);
  const hit = withStore((db) =>
    db.prepare("SELECT session_id FROM aliases WHERE name = ?").get(wanted));

  if (!hit) {
    throw new Error(`Unknown "${raw}": not a session id and not in directory.\nRun "wo-u roster" to view available sessions.`);
  }

  return requireSession(hit.session_id);
}

export function directory() {
  return withStore((db) =>
    db.prepare("SELECT name, session_id, updated_at FROM aliases ORDER BY name").all());
}

export function callerCard(caller) {
  const lines = [`📞 Incoming Call: **${caller}**`];

  if (WITH_CONTACT) {
    lines.push(
      "",
      `Read: \`${PHONE} read ${caller}\``,
      `Reply: \`${PHONE} send ${caller} "your message"\``,
      `Directory: \`${PHONE} book\``,
    );
  }

  return lines.join("\n");
}

export async function send({ from, to, text }) {
  const body = String(text ?? "").trim();
  if (!body) throw new Error("Message body cannot be empty");

  const [me, peer] = await Promise.all([resolveRef(from), resolveRef(to)]);
  if (me.id === peer.id) throw new Error("Cannot send a message to yourself");

  const pair = pairKey(me.id, peer.id);
  const at = stamp();

  withStore((db) => {
    db.prepare(
      "INSERT INTO messages (pair, sender, recipient, body, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(pair, me.id, peer.id, body, at);
  });

  const outcome = {
    delivered: false,
    to: { id: peer.id, name: peer.name },
    ...(peer.archived ? { reason: "archived" } : {}),
  };

  if (peer.archived) return outcome;

  const caller = me.name || shortId(me.id);
  const adapter = getWakeAdapter();
  const pushed = await adapter.wake(peer.id, callerCard(caller));
  if (!pushed.ok) return { ...outcome, reason: pushed.reason };

  withStore((db) => {
    const row = db.prepare("SELECT MAX(seq) AS seq FROM messages WHERE pair = ?").get(pair);
    db.prepare(
      `INSERT INTO cursors (owner, pair, last_seq, notified_seq) VALUES (?, ?, 0, ?)
       ON CONFLICT(owner, pair) DO UPDATE SET notified_seq = excluded.notified_seq`,
    ).run(peer.id, pair, row.seq);
  });

  return { delivered: true, to: { id: peer.id, name: peer.name } };
}

export function pending({ self, ack = false }) {
  const me = String(self ?? "").trim();
  if (!me) throw new Error("A session id is required");

  const book = new Map(directory().map((r) => [r.session_id, r.name]));

  return withStore((db) => {
    const rows = db.prepare(
      `SELECT m.seq, m.pair, m.sender, m.created_at
         FROM messages m
         LEFT JOIN cursors c ON c.owner = ? AND c.pair = m.pair
        WHERE m.recipient = ?
          AND m.seq > COALESCE(c.notified_seq, 0)
        ORDER BY m.seq ASC`,
    ).all(me, me);

    const calls = new Map();
    for (const row of rows) {
      const key = row.sender;
      const cur = calls.get(key);
      if (cur) {
        cur.count += 1;
        cur.last = row.created_at;
        cur.maxSeq = Math.max(cur.maxSeq, row.seq);
      } else {
        calls.set(key, {
          sessionId: key,
          name: book.get(key) || null,
          count: 1,
          last: row.created_at,
          maxSeq: row.seq,
        });
      }
    }

    if (ack && rows.length > 0) {
      const advance = db.prepare(
        `INSERT INTO cursors (owner, pair, notified_seq) VALUES (?, ?, ?)
         ON CONFLICT(owner, pair) DO UPDATE SET notified_seq = excluded.notified_seq`,
      );
      for (const row of rows) advance.run(me, row.pair, row.seq);
    }

    return { total: rows.length, calls: [...calls.values()] };
  });
}

function resolveOne(ref) {
  const raw = String(ref ?? "").trim();
  if (!raw) return null;

  return withStore((db) => {
    const hit = db.prepare("SELECT session_id FROM aliases WHERE name = ?").get(raw);
    if (hit) return hit.session_id;

    const senders = db.prepare("SELECT DISTINCT sender AS id FROM messages UNION SELECT DISTINCT recipient AS id FROM messages").all().map((r) => r.id);
    const matched = senders.filter((id) => sessionMatch(id, raw));
    if (matched.length === 1) return matched[0];

    if (!raw.startsWith("session_") && senders.includes(`session_${raw}`)) {
      return `session_${raw}`;
    }

    return raw;
  });
}

export function read({ self, peer, markRead = false, all = false, limit = 20 }) {
  const me = String(self ?? "").trim();
  if (!me) throw new Error("A session id is required");

  const book = new Map(directory().map((r) => [r.session_id, r.name]));
  const only = peer ? resolveOne(peer) : null;

  return withStore((db) => {
    const whereSeq = all ? "" : "AND m.seq > COALESCE(c.last_seq, 0)";
    const rows = db.prepare(
      `SELECT m.seq, m.pair, m.sender, m.body, m.created_at
         FROM messages m
         LEFT JOIN cursors c ON c.owner = ? AND c.pair = m.pair
        WHERE m.recipient = ?
          ${whereSeq}
        ORDER BY m.seq ASC`,
    ).all(me, me);

    const filtered = only ? rows.filter((r) => r.sender === only) : rows;
    const shown = filtered.slice(-limit);

    if (markRead && shown.length > 0 && !all) {
      const advance = db.prepare(
        `INSERT INTO cursors (owner, pair, last_seq) VALUES (?, ?, ?)
         ON CONFLICT(owner, pair) DO UPDATE SET last_seq = excluded.last_seq`,
      );
      for (const m of shown) advance.run(me, m.pair, m.seq);
    }

    return {
      total: filtered.length,
      messages: shown.map((m) => ({
        from: m.sender,
        fromName: book.get(m.sender) || null,
        content: m.body,
        at: m.created_at,
      })),
    };
  });
}

export async function roster(opts = {}) {
  const { self } = opts;
  const adapter = getWakeAdapter();
  const list = await adapter.listSessions();
  const nameOf = nameLookup();
  return list.map((s) => ({
    ...s,
    name: nameOf(s.id) || null,
    isSelf: Boolean(self) && s.id === self,
  }));
}

export function peers({ self }) {
  const me = String(self ?? "").trim();
  if (!me) throw new Error("A session id is required");

  return withStore((db) => db.prepare(
    `SELECT CASE WHEN sender = ? THEN recipient ELSE sender END AS peer,
            COUNT(*) AS messages
       FROM messages WHERE sender = ? OR recipient = ?
       GROUP BY peer ORDER BY messages DESC`,
  ).all(me, me, me));
}

export function inspect() {
  let stat = null;
  try {
    stat = fs.statSync(STORE_FILE);
  } catch {}

  const tables = withStore((db) => {
    const count = (name) => {
      try { return db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get().c; }
      catch { return null; }
    };
    const span = (() => {
      try {
        return db.prepare(
          "SELECT COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM messages",
        ).get();
      } catch { return null; }
    })();
    return {
      messages: count("messages"),
      cursors: count("cursors"),
      aliases: count("aliases"),
      oldest: span?.first ?? null,
      newest: span?.last ?? null,
    };
  });

  return {
    path: STORE_FILE,
    exists: Boolean(stat),
    bytes: stat?.size ?? 0,
    modifiedAt: stat ? stat.mtime.toISOString() : null,
    ...tables,
  };
}

// ---------------------------------------------------------------------------
// CLI Execution
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  wo-u roster                       List active sessions and their aliases
  wo-u name <alias>                 Register an alias for this session
  wo-u whoami                       Show current session identity
  wo-u send <target> <message>      Call target session (wakes recipient)
  wo-u pending                      Check caller ID (who called, message count)
  wo-u read [target] [--all] [--peek] Read message body (--all for history, --peek keeps unread)
  wo-u peers                        List who you have talked to
  wo-u book                         Show directory (alias -> session_id)
  wo-u doctor                       Inspect store health and message counts
  wo-u card [alias]                 Preview this phone's incoming call card

  <target> accepts an alias or session id (unique prefix ok).`;

async function resolveSelfId() {
  const envId = process.env.WO_U_SESSION_ID || process.env.KIMI_MESSENGER_SESSION_ID;
  if (envId) return envId;

  const cwd = process.cwd().replace(/\/+$/, "");
  const mine = (await roster()).filter((s) => !s.archived && s.cwd === cwd);
  return mine.length === 1 ? mine[0].id : null;
}

export async function cli(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case "roster": {
      const list = await roster();
      if (list.length === 0) return console.log("(No sessions found. Verify server token and host API port)");
      for (const s of list) {
        const mark = s.archived ? "·" : s.busy ? "●" : "○";
        const name = s.name ? s.name.padEnd(16) : "(unnamed)".padEnd(16);
        console.log(`${mark} ${name} ${s.id}${s.title ? `  "${s.title.slice(0, 24)}"` : ""}`);
      }
      console.log("\n● busy  ○ idle  · archived");
      return;
    }

    case "book": {
      const rows = directory();
      if (rows.length === 0) return console.log("(Directory is empty. Run 'wo-u name <alias>' to register)");
      for (const r of rows) console.log(`${r.name.padEnd(16)} ${r.session_id}`);
      return;
    }

    case "card": {
      console.log(callerCard(rest[0] || "<caller>"));
      return;
    }

    case "doctor": {
      const s = inspect();
      console.log(`Database  ${s.path}`);
      console.log(`          exists=${s.exists}  ${s.bytes} bytes  modified=${s.modifiedAt || "-"}`);
      console.log(`messages  ${s.messages} rows`);
      console.log(`cursors   ${s.cursors} rows`);
      console.log(`aliases   ${s.aliases} rows`);
      if (s.messages === 0) {
        console.log("\nNotice: 'messages' table is empty. If you just sent a message, check if the database was recreated.");
      } else {
        console.log(`\nearliest  ${s.oldest}\nlatest    ${s.newest}`);
      }
      return;
    }

    case "whoami": {
      const me = await resolveSelfId();
      if (!me) return console.log("Cannot locate current session. Set WO_U_SESSION_ID or KIMI_MESSENGER_SESSION_ID");
      const list = await roster({ self: me });
      const hit = list.find((s) => s.isSelf);
      console.log(`${me}${hit?.name ? `  (${hit.name})` : "  (unnamed)"}`);
      console.log(hit?.cwd || "");
      return;
    }

    case "name": {
      const wanted = rest.join(" ").trim();
      if (!wanted) return console.log("Usage: wo-u name <alias>");

      const me = await resolveSelfId();
      if (!me) return console.log("Cannot locate current session. Set WO_U_SESSION_ID or KIMI_MESSENGER_SESSION_ID");

      const r = await register({ sessionId: me, name: wanted });
      console.log(`Registered: ${r.name} -> ${r.sessionId}`);
      return;
    }

    case "send": {
      const [to, ...words] = rest;
      const text = words.join(" ");
      if (!to || !text) return console.log(USAGE);

      const me = (await resolveSelfId())
        || (() => { throw new Error("Cannot locate current session. Set WO_U_SESSION_ID or KIMI_MESSENGER_SESSION_ID"); })();

      const r = await send({ from: me, to, text });

      const book = new Map(directory().map((row) => [row.session_id, row.name]));
      const who = book.get(r.to.id) || r.to.name || r.to.id;

      if (r.delivered) return console.log(`Delivered to ${who} (recipient woken)`);

      const why = {
        busy: "Recipient is currently busy; message saved for next read",
        archived: "Recipient session is archived; message saved",
        offline: "Recipient session is offline; message saved",
        missing_token: "Cannot locate host API authentication token",
        wake_disabled: "Wake notifications disabled on this host",
      }[r.reason] ?? `Delivery failed: ${r.reason}`;
      console.log(`Not delivered to ${who} — ${why}`);
      return;
    }

    case "pending": {
      const me = await resolveSelfId();
      if (!me) return console.log("Cannot locate current session. Set WO_U_SESSION_ID or KIMI_MESSENGER_SESSION_ID");

      const { calls, total } = pending({ self: me });
      if (calls.length === 0) return console.log("(No pending calls)");
      for (const c of calls) {
        const who = c.name || shortId(c.sessionId);
        console.log(`📞 ${who.padEnd(16)} ${c.count} messages  latest ${c.last}`);
      }
      console.log(`\n${total} unread message(s) in total`);
      return;
    }

    case "read": {
      const me = await resolveSelfId();
      if (!me) return console.log("Cannot locate current session. Set WO_U_SESSION_ID or KIMI_MESSENGER_SESSION_ID");

      const [who] = rest.filter((x) => !x.startsWith("--"));
      const isAll = rest.includes("--all");
      const isPeek = rest.includes("--peek");

      const { messages, total } = read({
        self: me,
        peer: who,
        all: isAll,
        markRead: !isPeek && !isAll,
      });

      if (messages.length === 0) return console.log(isAll ? "(No message history)" : "(No unread messages. Use --all to view history)");
      for (const m of messages) {
        const who2 = m.fromName || shortId(m.from);
        console.log(`[${who2}] ${m.at}\n${m.content}\n`);
      }
      if (total > messages.length) {
        console.log(`(${total} messages in total, showing latest ${messages.length})`);
      }
      return;
    }

    case "peers": {
      const me = await resolveSelfId();
      if (!me) return console.log("Cannot locate current session. Set WO_U_SESSION_ID or KIMI_MESSENGER_SESSION_ID");

      const list = peers({ self: me });
      if (list.length === 0) return console.log("(No contacts yet)");

      const book = new Map(directory().map((r) => [r.session_id, r.name]));
      for (const p of list) {
        console.log(`${(book.get(p.peer) || shortId(p.peer)).padEnd(16)} ${p.peer}  (${p.messages} messages)`);
      }
      return;
    }

    default:
      return console.log(USAGE);
  }
}

// ---------------------------------------------------------------------------
// Main Self-Invocation Check
// ---------------------------------------------------------------------------

const isDirectRun = process.argv[1] && (
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  || path.resolve(process.argv[1]).endsWith("/bin/wo-u")
  || path.resolve(process.argv[1]).endsWith("/wo-u")
);

if (isDirectRun) {
  cli().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
