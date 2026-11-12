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

function processSocketInodes(pid) {
  const inodes = new Set();
  try {
    for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
      const link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      const m = link.match(/^socket:\[(\d+)\]$/);
      if (m?.[1]) inodes.add(m[1]);
    }
  } catch {}
  return inodes;
}

const LOOPBACK_IPV4_HEX = "7F000001";

function parseLoopbackPort(localAddress) {
  const m = localAddress?.match(/^([0-9A-F]+):([0-9A-F]{4})$/);
  if (!m?.[1] || !m[2]) return null;
  const hex = m[1];
  // IPv4 addresses are hex-encoded little-endian inside tcp; tcp6 entries
  // may embed an IPv4 loopback as ::ffff:127.0.0.1.
  const isLoopback = hex.length === 8
    ? hex.match(/../g)?.reverse().join("") === LOOPBACK_IPV4_HEX
    : hex.toLowerCase().endsWith(LOOPBACK_IPV4_HEX.toLowerCase());
  return isLoopback ? parseInt(m[2], 16) : null;
}

function listeningPortsForTable(table, inodeSet) {
  const found = [];
  let rows = [];
  try {
    rows = fs.readFileSync(table, "utf-8").split("\n");
  } catch {
    return found;
  }
  for (const line of rows) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || !/^\d+$/.test(cols[9])) continue;
    if (!inodeSet.has(cols[9])) continue;
    const port = parseLoopbackPort(cols[1]);
    if (port !== null) found.push(port);
  }
  return found;
}

/** Is this pid a top-level kimi-code process (not a zygote/renderer child)? */
function isKimiHostProcess(pid) {
  let cmdline = "";
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
  } catch {
    return false;
  }
  return cmdline.includes("kimi-code") && !cmdline.includes("--type=");
}

function numericProcEntries() {
  try {
    return fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }
}

function localKimiPorts() {
  const ports = new Set();
  for (const pid of numericProcEntries()) {
    if (!isKimiHostProcess(pid)) continue;
    const inodeSet = processSocketInodes(pid);
    if (inodeSet.size === 0) continue;
    // /proc/net/tcp and tcp6 both carry a header row and store the socket
    // inode as a bare decimal in column 9.
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      for (const port of listeningPortsForTable(table, inodeSet)) {
        ports.add(port);
      }
    }
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
    "📞 Incoming message from **" + caller + "**:",
    "",
    body,
  ];

  if (WITH_REPLY) {
    const reply = PHONE + " send " + caller + " 'your message'";
    lines.push("", "Reply: `" + reply + "`");
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
  wo-u send <target> --stdin        Read message body from stdin (safe for backticks)
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

function requireSelfId() {
  return resolveSelfId().then((me) => {
    if (!me) throw new Error("Cannot locate current session. Set WO_U_SESSION_ID or KIMI_MESSENGER_SESSION_ID");
    return me;
  });
}

function sessionMark(s) {
  if (s.archived) return "·";
  return s.busy ? "●" : "○";
}

function paddedLabel(s) {
  return (s.name || "(unnamed)").padEnd(16);
}

function truncatedTitle(s) {
  return s.title ? `  "${s.title.slice(0, 24)}"` : "";
}

async function runRosterCommand() {
  const list = await roster();
  if (list.length === 0) {
    console.log("(No sessions found. Verify server token and host API port)");
    return;
  }
  for (const s of list) {
    console.log(`${sessionMark(s)} ${paddedLabel(s)} ${s.id}${truncatedTitle(s)}`);
  }
  console.log("\n● busy  ○ idle  · archived");
}

function runBookCommand() {
  const rows = directory();
  if (rows.length === 0) {
    console.log("(Directory is empty. Run 'wo-u name <alias>' to register)");
    return;
  }
  for (const r of rows) console.log(`${r.name.padEnd(16)} ${r.session_id}`);
}

function runDoctorCommand() {
  const s = doctor();
  console.log(`Directory ${s.path}`);
  console.log(`          exists=${s.exists}  ${s.bytes} bytes  modified=${s.modifiedAt || "-"}`);
  console.log(`aliases   ${s.aliases} rows`);
}

async function runWhoamiCommand() {
  const me = await requireSelfId();
  const list = await roster({ self: me });
  const hit = list.find((s) => s.isSelf);
  const label = hit?.name ? `  (${hit.name})` : "  (unnamed)";
  console.log(`${me}${label}`);
  console.log(hit?.cwd || "");
}

async function runNameCommand(rest) {
  const wanted = rest.join(" ").trim();
  if (!wanted) {
    console.log("Usage: wo-u name <alias>");
    return;
  }
  const me = await requireSelfId();
  const r = await register({ sessionId: me, name: wanted });
  console.log(`Registered: ${r.name} -> ${r.sessionId}`);
}

function sendFailureText(reason) {
  return {
    archived: "Recipient session is archived",
    missing_token: "Cannot locate host API authentication token",
    wake_disabled: "Wake notifications disabled on this host",
  }[reason] ?? `Delivery failed: ${reason}`;
}

function readStdinText() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => resolve(raw));
    // Never hang the CLI on an open pipe.
    setTimeout(() => resolve(raw.length > 0 ? raw : null), 1500).unref();
  });
}

async function runSendCommand(rest) {
  const flags = rest.filter((x) => x === "--stdin");
  const positional = rest.filter((x) => x !== "--stdin");
  const [to, ...words] = positional;
  const inlineText = words.join(" ");
  const pipedText = flags.includes("--stdin") ? await readStdinText() : null;

  // --stdin wins when both are given; inline remains the default form.
  const text = flags.includes("--stdin") ? (pipedText ?? "").trim() : inlineText;
  if (!to || !text) {
    console.log(USAGE);
    return;
  }
  const me = await requireSelfId();
  const r = await send({ from: me, to, text });
  const who = r.to.name || shortId(r.to.id);

  if (r.ok) {
    console.log(`Sent to ${who} (delivered)`);
    return;
  }
  console.log(`Failed to send to ${who}: ${sendFailureText(r.reason)}`);
  process.exitCode = 1;
}

async function runCardCommand(rest) {
  console.log(formatMessage(rest[0] || "<caller>", "<message body>"));
}

const COMMANDS = {
  roster: () => runRosterCommand(),
  book: () => runBookCommand(),
  doctor: () => runDoctorCommand(),
  whoami: () => runWhoamiCommand(),
  name: (rest) => runNameCommand(rest),
  send: (rest) => runSendCommand(rest),
  card: (rest) => runCardCommand(rest),
};

export async function cli(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const handler = COMMANDS[cmd];
  if (!handler) {
    console.log(USAGE);
    return;
  }
  await handler(rest);
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
