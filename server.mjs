#!/usr/bin/env node
// server-gpt-fix
//
// A local HTTP proxy for the OpenAI Responses API (`/v1/responses`).
// Fixes two specific 400 errors that some OpenAI-compatible upstreams
// return:
//
//   1. invalid_encrypted_content
//      "The encrypted content ... could not be verified". The
//      `reasoning.encrypted_content` field is opaque server-side state
//      that only the upstream can decrypt — we cannot decrypt it or
//      synthesize a replacement, only delete it. The reasoning item's
//      `id`, `summary`, and `type` are kept so the model can regenerate
//      context from the summary.
//      Modes (cfg.strip_encrypted): true/"on" = pre-strip + reactive,
//      false/"off" = disabled, "auto" = reactive only (don't touch the
//      request unless the upstream complains, then strip + retry).
//
//   2. missing_required_parameter on `tools[N].tools`
//      The proxy walks the request's `tools` array and rewrites each
//      entry it can't pass through verbatim. Standard `type`s pass
//      through; non-standard wrappers with valid sub-tools are
//      flattened to the top level; everything else is dropped.
//      Modes (cfg.repair_tools): true/"on" = pre-repair + reactive,
//      false/"off" = disabled, "auto" = reactive only.
//
// Both fixers run pre-emptively. If a 400 still slips through, the
// proxy reactively retries up to `cfg.max_fixes` times.
//
// Auth model: the proxy does NOT touch the `Authorization` header.
// It forwards whatever the client sends, byte-for-byte. Keep your
// API key in your codex auth file (e.g. `~/.codex/auth.json`); the
// proxy never reads or stores it.
//
// Configuration (looked up in order):
//   1. ./config.json            (next to this script — preferred)
//   2. ~/.codex/proxy/config.json
// First run with no config writes a template at location 1 and exits.
// `node server.mjs --setup` runs an interactive prompt instead.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME_CFG_DIR = path.join(os.homedir(), ".codex", "proxy");
const CFG_CANDIDATES = [
  path.join(SCRIPT_DIR, "config.json"),
  path.join(HOME_CFG_DIR, "config.json"),
];
const DEFAULT_CFG = {
  upstream: "https://examplerouter.top",
  port: 8765,
  strip_encrypted: true,
  repair_tools: true,
  max_fixes: 4,
};

const MAX_BODY = 64 * 1024 * 1024;
const MAX_FIXES_HARD_LIMIT = 16;
const LOG_PATH =
  process.env.SERVER_GPT_FIX_LOG ||
  process.env.CODEX_PROXY_LOG ||
  path.join(os.homedir(), ".codex", "proxy-logs", "proxy.log");

// ---------- Setup / config ----------

function findConfigPath() {
  for (const p of CFG_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

function writeTemplate(target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(DEFAULT_CFG, null, 2) + "\n");
}

function readJsonFileTolerantBom(p) {
  let text = fs.readFileSync(p, "utf8");
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return JSON.parse(text);
}

function loadConfigOrExit() {
  const p = findConfigPath();
  if (!p) {
    const target = CFG_CANDIDATES[0];
    writeTemplate(target);
    console.error(
      `[server-gpt-fix] no config found.\n` +
      `Wrote a template to:\n  ${target}\n` +
      `Edit it (set "upstream" if needed), or run with --setup, then rerun.`,
    );
    process.exit(2);
  }
  let raw;
  try { raw = readJsonFileTolerantBom(p); }
  catch (e) {
    console.error(`[server-gpt-fix] config at ${p} is invalid JSON: ${e.message}`);
    process.exit(1);
  }
  // Migration: silently drop legacy `api_key` so old configs keep working.
  // The proxy no longer stores or injects the key.
  if (raw && Object.prototype.hasOwnProperty.call(raw, "api_key")) {
    delete raw.api_key;
  }
  const cfg = { ...DEFAULT_CFG, ...raw, _path: p };
  cfg.upstream = String(cfg.upstream).replace(/\/+$/, "");
  cfg.port = Number(cfg.port) || 8765;
  cfg.strip_encrypted = normalizeMode(cfg.strip_encrypted, true);
  cfg.repair_tools    = normalizeMode(cfg.repair_tools,    true);
  let m = Number(cfg.max_fixes);
  if (!Number.isFinite(m) || m < 0) m = 4;
  cfg.max_fixes = Math.min(m, MAX_FIXES_HARD_LIMIT);
  return cfg;
}

// Three-state mode: true (pre + reactive), false (off), "auto" (reactive only).
// Accepts liberal aliases from config.json or interactive input.
function normalizeMode(v, fallback) {
  if (v === true || v === false) return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (!t) return fallback;
    if (t === "auto") return "auto";
    if (["on", "true", "yes", "y", "1"].includes(t)) return true;
    if (["off", "false", "no", "n", "0"].includes(t)) return false;
  }
  return fallback;
}

function modeLabel(v) {
  if (v === true) return "on";
  if (v === false) return "off";
  if (v === "auto") return "auto";
  return String(v);
}

// Pre-pass runs only when the mode is explicitly on.
function shouldPre(v) { return v === true; }
// Reactive (post-400) runs both for "on" and "auto".
function shouldReactive(v) { return v === true || v === "auto"; }

async function interactiveSetup() {
  const target = CFG_CANDIDATES[0];
  let existing = { ...DEFAULT_CFG };
  if (fs.existsSync(target)) {
    try { existing = { ...DEFAULT_CFG, ...readJsonFileTolerantBom(target) }; } catch {}
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(r => rl.question(q, r));

  console.log(`server-gpt-fix setup — config will be saved to:\n  ${target}\n`);
  console.log(`Note: the proxy does not store your API key. Put it in your`);
  console.log(`codex auth file (e.g. ~/.codex/auth.json) — codex sends the`);
  console.log(`Authorization header itself, the proxy just forwards it.\n`);

  const upstream = ((await ask(`Upstream URL [${existing.upstream}]: `)) || "").trim() || existing.upstream;

  const portIn = ((await ask(`Port [${existing.port}]: `)) || "").trim();
  const port = portIn ? Number(portIn) : existing.port;

  console.log(`\nFixers — modes: on (pre-pass + reactive), off (disabled), auto (reactive only).`);
  const seIn = ((await ask(`  Strip encrypted_content [${modeLabel(existing.strip_encrypted)}]: `)) || "").trim();
  const strip_encrypted = normalizeMode(seIn, existing.strip_encrypted);

  const rtIn = ((await ask(`  Repair tools array       [${modeLabel(existing.repair_tools)}]: `)) || "").trim();
  const repair_tools = normalizeMode(rtIn, existing.repair_tools);

  const mfIn = ((await ask(`  Max reactive retries on upstream 400 [${existing.max_fixes}]: `)) || "").trim();
  let max_fixes = mfIn ? Number(mfIn) : existing.max_fixes;
  if (!Number.isFinite(max_fixes) || max_fixes < 0) max_fixes = existing.max_fixes;
  if (max_fixes > MAX_FIXES_HARD_LIMIT) max_fixes = MAX_FIXES_HARD_LIMIT;

  rl.close();

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({
    upstream: upstream.replace(/\/+$/, ""),
    port,
    strip_encrypted,
    repair_tools,
    max_fixes,
  }, null, 2) + "\n");

  console.log(`\nSaved.`);
  console.log(`Run:  node ${path.basename(fileURLToPath(import.meta.url))}`);
}

// ---------- Logging ----------

function makeLogger(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  return function log(level, ...parts) {
    const ts = new Date().toISOString();
    const msg = parts.map(p => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    const line = `${ts} [${level}] ${msg}\n`;
    fs.appendFile(logPath, line, () => {});
    process.stdout.write(line);
  };
}

// ---------- HTTP helpers ----------

function readBody(stream, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on("data", c => {
      total += c.length;
      if (total > max) { stream.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    stream.once("end", () => resolve(Buffer.concat(chunks)));
    stream.once("error", reject);
  });
}

function forward(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        headers,
      },
      resolve,
    );
    req.on("error", reject);
    if (body && body.length) req.write(body);
    req.end();
  });
}

// ---------- Fixer 1: encrypted_content ----------
//
// We cannot decrypt `reasoning.encrypted_content` — the key is held by
// the upstream and bound to the issuing context. The only safe action
// is to delete it. The reasoning item's `id`, `summary`, and `type` are
// preserved, so the model can re-derive context from the summary.

function isEncryptedError(buf) {
  const s = buf.toString("utf8");
  if (s.includes('"invalid_encrypted_content"')) return true;
  if (s.includes("encrypted content") && s.includes("could not be")) return true;
  return false;
}

function stripEncryptedReasoning(bodyBuf) {
  let obj;
  try { obj = JSON.parse(bodyBuf.toString("utf8")); } catch { return { body: null, changes: 0 }; }
  let changes = 0;
  function clean(item) {
    if (!item || typeof item !== "object") return item;
    if ("encrypted_content" in item) { delete item.encrypted_content; changes++; }
    return item;
  }
  if (Array.isArray(obj.input))    obj.input    = obj.input.map(clean);
  if (Array.isArray(obj.messages)) obj.messages = obj.messages.map(clean);
  if (changes === 0) return { body: null, changes };
  return { body: Buffer.from(JSON.stringify(obj), "utf8"), changes };
}

// ---------- Fixer 2: tools array ----------
//
// For each `tools[i]` exactly one branch is taken:
//   * standard `type` — kept (mcp without `tools` gets an empty array)
//   * non-standard wrapper with valid sub-tools — flattened up
//   * anything else — dropped

const STANDARD_TOOL_TYPES = new Set([
  "function",
  "custom",
  "file_search",
  "web_search",
  "web_search_preview",
  "computer",
  "computer_use_preview",
  "code_interpreter",
  "image_generation",
  "local_shell",
  "mcp",
]);

function isToolsParamError(buf) {
  const s = buf.toString("utf8");
  if (!s.includes('"missing_required_parameter"')) return false;
  return /"param"\s*:\s*"tools\[\d+\]/.test(s);
}

function repairTools(bodyBuf, log) {
  let obj;
  try { obj = JSON.parse(bodyBuf.toString("utf8")); } catch { return null; }
  if (!Array.isArray(obj.tools)) return null;
  let changed = false;
  const before = obj.tools.length;
  const out = [];
  for (let i = 0; i < obj.tools.length; i++) {
    const t = obj.tools[i];
    if (!t || typeof t !== "object") {
      log("info", `dropping tools[${i}]: not an object`);
      changed = true; continue;
    }
    if (STANDARD_TOOL_TYPES.has(t.type)) {
      if (t.type === "mcp" && !Array.isArray(t.tools)) {
        t.tools = []; changed = true;
        log("info", `added empty tools[] to mcp tool at index ${i}`);
      }
      out.push(t); continue;
    }
    if (Array.isArray(t.tools) && t.tools.length > 0) {
      const valid = t.tools.filter(s => s && typeof s === "object" && STANDARD_TOOL_TYPES.has(s.type));
      if (valid.length > 0) {
        log("info", `flattening tools[${i}] type="${t.type}" name="${t.name ?? "?"}" -> ${valid.length} sub-tools`);
        out.push(...valid); changed = true; continue;
      }
    }
    log("info", `dropping tools[${i}] type="${t.type}" name="${t.name ?? "?"}" entry=${JSON.stringify(t).slice(0, 300)}`);
    changed = true;
  }
  if (!changed) return null;
  obj.tools = out;
  log("info", `repairTools: tools array ${before} -> ${out.length}`);
  return Buffer.from(JSON.stringify(obj), "utf8");
}

// ---------- Reactive fix dispatch ----------

function makeTryFix(cfg, log) {
  return function tryFix(body, errBuf) {
    if (shouldReactive(cfg.strip_encrypted) && isEncryptedError(errBuf)) {
      const r = stripEncryptedReasoning(body);
      if (r.body) {
        log("info", `fix: stripped encrypted x${r.changes} (${body.length}->${r.body.length})`);
        return r.body;
      }
    }
    if (shouldReactive(cfg.repair_tools) && isToolsParamError(errBuf)) {
      const repaired = repairTools(body, log);
      if (repaired) {
        log("info", `fix: repaired tools (${body.length}->${repaired.length})`);
        return repaired;
      }
    }
    return null;
  };
}

// ---------- Main ----------

function startServer() {
  const cfg = loadConfigOrExit();
  const PORT = cfg.port;
  const UPSTREAM = cfg.upstream;
  const log = makeLogger(LOG_PATH);
  const tryFix = makeTryFix(cfg, log);

  async function handle(req, res) {
    if (req.method === "GET" && req.url === "/__status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        port: PORT,
        upstream: UPSTREAM,
        strip_encrypted: cfg.strip_encrypted,
        repair_tools: cfg.repair_tools,
        max_fixes: cfg.max_fixes,
      }));
      return;
    }

    let body;
    try { body = await readBody(req); }
    catch (e) {
      log("error", `read body: ${e.message}`);
      res.writeHead(400); res.end("proxy: " + e.message); return;
    }

    // Forward client headers as-is — including Authorization, which the
    // client owns. We strip only hop-by-hop / length headers we'll
    // recompute. The proxy does not see, store, or log the API key.
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    delete headers["accept-encoding"];

    if (shouldPre(cfg.strip_encrypted) && body.length > 0) {
      const r = stripEncryptedReasoning(body);
      if (r.body) {
        log("info", `pre-strip encrypted x${r.changes} (${body.length}->${r.body.length})`);
        body = r.body;
      }
    }

    if (shouldPre(cfg.repair_tools) && body.length > 0) {
      const repaired = repairTools(body, log);
      if (repaired) {
        log("info", `pre-repair tools (${body.length}->${repaired.length})`);
        body = repaired;
      }
    }

    const target = UPSTREAM + req.url;
    log("info", `> ${req.method} ${req.url} body=${body.length}`);

    let upstream;
    let errBuf;
    let attempt = 0;

    while (true) {
      if (body.length > 0) headers["content-length"] = String(body.length);

      try { upstream = await forward(req.method, target, headers, body); }
      catch (e) {
        log("error", `upstream connect: ${e.message}`);
        res.writeHead(502); res.end("proxy: upstream connect failed: " + e.message); return;
      }

      if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
        const tag = attempt > 0 ? ` (after ${attempt} fix${attempt > 1 ? "es" : ""})` : "";
        log("info", `< ${upstream.statusCode} streaming${tag}`);
        res.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(res);
        upstream.on("error", e => log("error", `upstream stream: ${e.message}`));
        return;
      }

      try { errBuf = await readBody(upstream); }
      catch (e) {
        log("error", `read upstream err: ${e.message}`);
        res.writeHead(502); res.end("proxy: " + e.message); return;
      }

      log(
        "warn",
        `< ${upstream.statusCode} body=${errBuf.length} preview=${errBuf.toString("utf8").slice(0, 300).replace(/\s+/g, " ")}`,
      );

      if (attempt >= cfg.max_fixes) {
        log("warn", `gave up after ${cfg.max_fixes} fix attempt${cfg.max_fixes === 1 ? "" : "s"}`);
        break;
      }
      const fixed = tryFix(body, errBuf);
      if (!fixed) { log("info", "no fixer matched; passing error through"); break; }
      body = fixed;
      attempt++;
    }

    res.writeHead(upstream.statusCode, upstream.headers);
    res.end(errBuf);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => {
      log("error", `unhandled: ${e.stack || e.message}`);
      if (!res.headersSent) { res.writeHead(500); res.end("proxy: " + e.message); }
      else { try { res.end(); } catch {} }
    });
  });

  server.on("clientError", (err, socket) => {
    log("warn", `client error: ${err.message}`);
    try { socket.destroy(); } catch {}
  });

  server.listen(PORT, "127.0.0.1", () => {
    log(
      "info",
      `server-gpt-fix listening at http://127.0.0.1:${PORT} -> ${UPSTREAM} ` +
      `(strip_encrypted=${cfg.strip_encrypted} repair_tools=${cfg.repair_tools} max_fixes=${cfg.max_fixes}) ` +
      `(config: ${cfg._path})`,
    );
  });
}

if (process.argv.includes("--setup")) {
  interactiveSetup().catch(e => { console.error(e); process.exit(1); });
} else {
  startServer();
}
