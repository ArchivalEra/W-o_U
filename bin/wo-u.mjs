#!/usr/bin/env node
/**
 * W/o U (without User) — Direct session-level phone for AI agents.
 *
 * Minimalist architecture:
 *   - Zero message storage: Messages are delivered directly into the recipient's
 *     session context. The host agent transcript is the single source of truth.
 *   - Only the Directory is stored: A tiny SQLite database mapping unique aliases
 *     to session IDs. No cursors, no message logs, no state skew.
 *   - Instant Wake: Direct delivery via Kimi Code HTTP API or custom wake command.
 *   - Simple result: Sent successfully or failed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Environment & Paths
// ---------------------------------------------------------------------------

const KIMI_HOME = process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
const STORE_DIR = process.env.WO_U_DIR || process.env.KIMI_MESSENGER_DIR || path.join(os.homedir(), ".kimi-messenger");
const STORE_FILE = path.join(STORE_DIR, "directory.db");

/**
 * Host API base URL.
 *
 * Kimi Code Desktop binds a random loopback port each launch, so a hardcoded
 * port cannot survive a reboot. Discovery order:
 *   1. explicit override (WO_U_API / KIMI_MESSENGER_API)
 *   2. port recorded by the last known-good call (~/.wo-u/api.json)
 *   3. probe: every loopback port owned by the kimi-code process, verified
 *      against /api/v1/sessions; the winner is cached for next time.
 */
const API_OVERRIDE = process.env.WO_U_API || process.env.KIMI_MESSENGER_API || null;
const DISCOVERY_CACHE = path.join(
  process.env.WO_U_DIR || process.env.KIMI_MESSENGER_DIR || path.join(os.homedir(), ".kimi-messenger"),
  "api.json",
);

function readCachedBase() {
  try {
    const raw = JSON.parse(fs.readFileSync(DISCOVERY_CACHE, "utf-8"));
    if (typeof raw?.base === "string" && raw.base.startsWith("http://127.0.0.1:")) return raw.base;
  } catch {}
  return null;
}

function writeCachedBase(base) {
  try {
    fs.mkdirSync(path.dirname(DISCOVERY_CACHE), { recursive: true });
    fs.writeFileSync(DISCOVERY_CACHE, JSON.stringify({ base, updatedAt: new Date().toISOString() }));
  } catch {}
}

function localKimiPorts() {
  const ports = new Set();
  let pids = [];
  try {
    pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return ports;
  }
  for (const pid of pids) {
    let cmdline = "";
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    } catch {
      continue;
    }
    if (!cmdline.includes("kimi-code") || cmdline.includes("--type=")) continue;
    try {
      // Collect raw socket inode numbers owned by this process.
      const inodeSet = new Set();
      try {
        for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
          const link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
          const m = link.match(/^socket:\[(\d+)\]$/);
          if (m?.[1]) inodeSet.add(m[1]);
        }
      } catch {}
      if (inodeSet.size === 0) continue;

      // Match against /proc/net/tcp and tcp6; both tables carry a header row
      // and store the inode as a bare decimal in column 9.
      for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        let rows = [];
        try {
          rows = fs.readFileSync(table, "utf-8").split("\n");
        } catch {
          continue;
        }
        for (const line of rows) {
          const cols = line.trim().split(/\s+/);
          if (cols.length < 10 || !/^\d+$/.test(cols[9])) continue;
          if (!inodeSet.has(cols[9])) continue;
          const local = cols[1];
          const m = local?.match(/^([0-9A-F]+):([0-9A-F]{4})$/);
          if (!m?.[1] || !m[2]) continue;
          // IPv4 addresses are hex-encoded little-endian inside tcp; tcp6
          // entries may embed an IPv4 loopback as ::ffff:127.0.0.1.
          const hex = m[1];
          const isLoopback = hex.length === 8
            ? hex.match(/../g)?.reverse().join("") === "7F000001"
            : hex.toLowerCase().endsWith("7f000001");
          if (!isLoopback) continue;
          ports.add(parseInt(m[2], 16));
        }
      }
    } catch {}
  }
  return ports;
}

let cachedApiBase = API_OVERRIDE;

async function resolveApiBase() {
  if (cachedApiBase) return cachedApiBase;

  const cached = readCachedBase();
  const candidates = [];
  if (cached) candidates.push(cached);
  for (const port of localKimiPorts()) candidates.push(`http://127.0.0.1:${port}`);
  candidates.push("http://127.0.0.1:45589");

  const seen = new Set();
  for (const base of candidates) {
    if (seen.has(base)) continue;
    seen.add(base);
    const token = apiToken();
    if (!token) break;
    try {
      const res = await fetch(`${base}/api/v1/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1500),
      });
      const body = await apiJson(res);
      if (body?.code === 0 && Array.isArray(body?.data?.items)) {
        writeCachedBase(base);
        cachedApiBase = base;
        return base;
      }
    } catch {}
  }
  // Nothing verified; fall back to the cached port or the historical default
  // so callers get a coherent error instead of a malformed URL.
  cachedApiBase = cached || "http://127.0.0.1:45589";
  return cachedApiBase;
}

const PHONE = (process.env.WO_U_COMMAND || process.env.KIMI_MESSENGER_PHONE || "wo-u").trim();

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

const WITH_REPLY = envFlag("WO_U_CONTACT", envFlag("KIMI_MESSENGER_CONTACT", true)) && PHONE.length > 0;

// ---------------------------------------------------------------------------
// Host Wake System
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
  const base = await resolveApiBase();
  const token = apiToken();
  if (!token) return null;
  try {
    const res = await fetch(`${base}${pathname}`, {
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
    const base = await resolveApiBase();
    const token = apiToken();
    if (!token) return { ok: false, reason: "missing_token" };

    try {
      const res = await fetch(`${base}/api/v1/sessions/${sessionId}/prompts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: [{ type: "text", text }] }),
        signal: AbortSignal.timeout(5000),
      });
      const body = await apiJson(res);
      const result = body?.code === 0
        ? { ok: true, promptId: body.data?.prompt_id }
        : { ok: false, reason: body?.msg || "rejected" };

      // Direct-inject optimization: if the recipient was busy, the prompt
      // landed in the queue and would only surface after the active turn
      // ends. Steer it into the running turn so the call is seen now.
      if (result.ok && result.promptId) {
        const steered = await this.steerPending(sessionId, result.promptId);
        if (steered) result.steered = true;
      }
      return result;
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  },

  /**
   * Steer a queued prompt into the recipient's active turn.
   * Idempotent: fails benignly when the prompt is not pending (already
   * running, or the turn ended and the queue drained on its own).
   */
  async steerPending(sessionId, promptId) {
    const base = await resolveApiBase();
    const token = apiToken();
    if (!token) return false;
    try {
      const res = await fetch(
        `${base}/api/v1/sessions/${sessionId}/prompts/${promptId}:steer`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(5000),
        },
      );
      const body = await apiJson(res);
      return body?.code === 0 && body?.data?.steered === true;
    } catch {
      return false;
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
// Directory Database (Only Stores Aliases)
// ---------------------------------------------------------------------------

function withDirectory(fn) {
  fs.mkdirSync(STORE_DIR, { recursive: true });

  const db = new DatabaseSync(STORE_FILE);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS aliases (
        name       TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        updated_at TEXT NOT NULL
      );
    `);
    return fn(db);
  } finally {
    db.close();
  }
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
    rows = withDirectory((db) => db.prepare("SELECT session_id, name FROM aliases").all());
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

  return withDirectory((db) => {
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
  const hit = withDirectory((db) =>
    db.prepare("SELECT session_id FROM aliases WHERE name = ?").get(wanted));

  if (!hit) {
    throw new Error(`Unknown "${raw}": not a session id and not in directory.\nRun "wo-u roster" to view available sessions.`);
  }

  return requireSession(hit.session_id);
}

export function directory() {
  return withDirectory((db) =>
    db.prepare("SELECT name, session_id, updated_at FROM aliases ORDER BY name").all());
}

export function formatMessage(caller, body) {
  const lines = [
    `📞 Incoming message from **${caller}**:`,
    "",
    body,
  ];

  if (WITH_REPLY) {
    lines.push("", `Reply: \`${PHONE} send ${caller} "your message"\``);
  }

  return lines.join("\n");
}

export async function send({ from, to, text }) {
  const body = String(text ?? "").trim();
  if (!body) throw new Error("Message body cannot be empty");

  const [me, peer] = await Promise.all([resolveRef(from), resolveRef(to)]);
  if (me.id === peer.id) throw new Error("Cannot send a message to yourself");

  if (peer.archived) {
    return { ok: false, to: peer, reason: "archived" };
  }

  const caller = me.name || shortId(me.id);
  const payload = formatMessage(caller, body);

  const adapter = getWakeAdapter();
  const pushed = await adapter.wake(peer.id, payload);
  if (!pushed.ok) {
    return { ok: false, to: peer, reason: pushed.reason };
  }

  return { ok: true, to: peer };
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

export function doctor() {
  let stat = null;
  try {
    stat = fs.statSync(STORE_FILE);
  } catch {}

  const aliasCount = withDirectory((db) => {
    try {
      return db.prepare("SELECT COUNT(*) AS c FROM aliases").get().c;
    } catch {
      return 0;
    }
  });

  return {
    path: STORE_FILE,
    exists: Boolean(stat),
    bytes: stat?.size ?? 0,
    modifiedAt: stat ? stat.mtime.toISOString() : null,
    aliases: aliasCount,
  };
}

// ---------------------------------------------------------------------------
// CLI Execution
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  wo-u roster                       List active sessions and their aliases
  wo-u name <alias>                 Register an alias for this session
  wo-u whoami                       Show current session identity
  wo-u send <target> <message>      Call target session (direct delivery)
  wo-u book                         Show directory (alias -> session_id)
  wo-u doctor                       Inspect directory database status

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

    case "doctor": {
      const s = doctor();
      console.log(`Directory ${s.path}`);
      console.log(`          exists=${s.exists}  ${s.bytes} bytes  modified=${s.modifiedAt || "-"}`);
      console.log(`aliases   ${s.aliases} rows`);
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
      const who = r.to.name || shortId(r.to.id);

      if (r.ok) {
        console.log(`Sent to ${who} (delivered)`);
        return;
      }

      const why = {
        archived: "Recipient session is archived",
        missing_token: "Cannot locate host API authentication token",
        wake_disabled: "Wake notifications disabled on this host",
      }[r.reason] ?? `Delivery failed: ${r.reason}`;
      console.log(`Failed to send to ${who}: ${why}`);
      process.exitCode = 1;
      return;
    }

    default:
      return console.log(USAGE);
  }
}

// ---------------------------------------------------------------------------
// Self-Invocation Check
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
