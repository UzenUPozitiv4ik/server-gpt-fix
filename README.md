## Community

[![LINUX DO](https://img.shields.io/badge/LINUX%20DO-community-00a1d6)](https://linux.do)

This project acknowledges and links to the LINUX DO community:

https://linux.do

# server-gpt-fix

A local HTTP proxy for the **OpenAI Responses API** (`/v1/responses`)
that fixes two specific 400 errors from the upstream:

1. **`invalid_encrypted_content`** — *"The encrypted content ... could not be verified"*
2. **`missing_required_parameter`** on **`tools[N].tools`**

The proxy **never sees your API key**: it forwards the
`Authorization` header the client sends, untouched. Single file, zero
dependencies beyond Node.js 18+.

---

## How the fixes work

### 1. `invalid_encrypted_content` — strip and retry

`reasoning.encrypted_content` is an opaque blob the upstream encrypts
server-side. The decryption key is held by the upstream and bound to
the issuing context, so we **cannot decrypt it ourselves** or
synthesize a replacement — only delete it.

What survives the strip: each reasoning item still carries `id`,
`summary`, and `type`. The model can re-derive context from the
summary text, so the request goes through. The trade-off is that the
full internal chain-of-thought is lost; on long reasoning chains you
may notice mild degradation, but for typical short-to-medium turns
it''s fine.

Modes (`strip_encrypted`):

* `true` / `"on"` (default) — pre-strip every request, plus reactive retry on 400
* `false` / `"off"` — disabled entirely; the 400 from the upstream goes straight to the client
* `"auto"` — don''t touch the request, but if the upstream returns 400 then strip and retry

### 2. `missing_required_parameter` on `tools[N].tools` — repair the array

The proxy walks the request''s `tools` array and rewrites each entry it
can''t pass through verbatim. For every `tools[i]` exactly one branch
is taken:

1. **Standard `type`** — kept as-is. The whitelist is `function`,
   `custom`, `mcp`, `file_search`, `web_search`, `web_search_preview`,
   `computer`, `computer_use_preview`, `code_interpreter`,
   `image_generation`, `local_shell`.

   *Special case:* an `mcp` entry without a `tools` sub-field gets an
   empty `tools: []` injected. The Responses API requires the field
   for `mcp` tools; an empty array satisfies the schema and registers
   the MCP server with no allowlisted sub-tools.

2. **Non-standard `type` that wraps a `tools` sub-array** — the
   wrapper is dropped and its inner tools are flattened up to the
   top-level `tools`. This handles desktop-codex constructs like
   `{type:"namespace", name:"mcp__node_repl__", tools:[...]}`: the
   wrapper isn''t a real OpenAI tool type, but the inner entries
   usually are valid `function`/`custom` tools, so they survive the
   trip and stay callable.

3. **Anything else** — dropped from the array. Non-standard `type`
   with no usable inner tools has nothing the upstream can do with it.

If every entry is already standard with all required fields,
`repairTools` returns `null` and the body is forwarded byte-for-byte.
So for clients that only emit standard tools this fixer is a no-op
even when enabled.

**Example.** Desktop codex sends 21 tool entries, two of which are
`namespace` wrappers (`mcp__node_repl__` with 2 inner tools and
`codex_app` with 1). After repair: 19 untouched standard tools + 3
flattened sub-tools = 22 entries, all of standard type, all callable.

Modes (`repair_tools`):

* `true` / `"on"` (default) — pre-repair every request, plus reactive retry on 400
* `false` / `"off"` — disabled
* `"auto"` — only repair after a 400

### Pre-emptive + reactive

Both fixers run **pre-emptively** on the body before forwarding, so
there''s no extra roundtrip. If a 400 still slips through (e.g. the
upstream introduces a new variant), the proxy reactively retries the
same fixers up to `max_fixes` times.

---

## API key handling (read this)

The proxy does **not** store, read, or log your API key. It forwards
the `Authorization` header from the client untouched. Your key lives
where codex already keeps it — typically in `~/.codex/auth.json`:

```json
{
  "OPENAI_API_KEY": "sk-..."
}
```

Codex reads that file, sends `Authorization: Bearer <key>` to the
proxy, and the proxy passes the header straight through to the
upstream. Benefits:

* the key is never in `config.json` (which lives next to the script)
* the key is never written to `proxy.log`
* you can rotate the key by editing one file (`auth.json`); restart
  codex, no proxy restart required

If your codex install reads the key from a different file or env var,
that''s fine too — anything that ends up in `Authorization` on the
incoming request reaches the upstream as-is.

---

## Quick start

```bash
git clone https://github.com/UzenUPozitiv4ik/server-gpt-fix.git
cd server-gpt-fix

# 1) (Optional) interactive setup — upstream, port, fixer toggles, retry count
node server.mjs --setup

# 2) Run
node server.mjs
```

`--setup` does not ask for the API key (the proxy never handles it).
If you''d rather edit by hand, copy `config.example.json` to
`config.json`:

```json
{
  "upstream": "https://examplerouter.top",
  "port": 8765,
  "strip_encrypted": true,
  "repair_tools": true,
  "max_fixes": 4
}
```

> `config.json` is in `.gitignore` — though there''s nothing
> sensitive in it now, keeping it untracked avoids leaking your
> upstream URL.

The proxy listens on `127.0.0.1:<port>` and logs to
`~/.codex/proxy-logs/proxy.log`.

---

## Client setup (codex example)

1. Put the key in `~/.codex/auth.json`:

   ```json
   {
     "OPENAI_API_KEY": "sk-..."
   }
   ```

2. Point codex at the proxy in `~/.codex/config.toml`:

   ```toml
   model_provider = "local"
   model          = "gpt-5.5"

   [model_providers.local]
   name     = "server-gpt-fix"
   base_url = "http://127.0.0.1:<port>/v1"
   wire_api = "responses"
   ```

   `env_key` tells codex which key from `auth.json` to send in
   `Authorization`. The proxy doesn''t care what name you use — it
   forwards whatever header arrives.

---

## Configuration

`server.mjs` looks for `config.json` in this order:

1. **`./config.json`** — next to the script (preferred for portable installs)
2. **`~/.codex/proxy/config.json`** — separate from the code

If neither exists, the first run writes a template to `./config.json`
and exits with a hint.

| Field | Type | Default | Description |
|---|---|---|---|
| `upstream` | string | `https://examplerouter.top` | Where to forward requests |
| `port` | number | `8765` | Port to bind on 127.0.0.1 |
| `strip_encrypted` | `true` / `false` / `"auto"` | `true` | encrypted_content fixer (modes above) |
| `repair_tools` | `true` / `false` / `"auto"` | `true` | tools[N] fixer (modes above) |
| `max_fixes` | number | `4` | Max reactive retries on upstream 400 (hard ceiling: 16) |

Note: there''s no `api_key` field. Old configs that still have one
will keep working — the field is silently ignored at load time. The
key belongs in your codex auth file.

`SERVER_GPT_FIX_LOG` (or `CODEX_PROXY_LOG`) overrides the log file
path. UTF-8 BOM in `config.json` is tolerated (Notepad / PowerShell
`Set-Content -Encoding utf8` add one by default).

---

## Status endpoint

```
GET http://127.0.0.1:<port>/__status
-> {
     "ok": true,
     "port": 8765,
     "upstream": "https://examplerouter.top",
     "strip_encrypted": true,
     "repair_tools": true,
     "max_fixes": 4
   }
```

Useful for confirming the proxy is alive and which fixers are active.

---

## Logs

```powershell
# Windows
Get-Content "$env:USERPROFILE\.codex\proxy-logs\proxy.log" -Tail 30 -Wait
```

```bash
# Linux / macOS
tail -f ~/.codex/proxy-logs/proxy.log
```

What to look for:

* `> POST /v1/responses body=N` — incoming request (after pre-passes)
* `pre-strip encrypted xK` — `K` `encrypted_content` fields removed
* `pre-repair tools (X->Y)` — tools array cleaned / flattened
* `flattening tools[i] type="..." -> N sub-tools` — wrapper unpacked
* `dropping tools[i] type="..."` — invalid tool dropped entirely
* `< 200 streaming` — successful upstream -> client pipe
* `< 200 streaming (after N fixes)` — succeeded after `N` reactive retries
* `gave up after N fix attempts` — error passed through to client

The `Authorization` header is never logged.

---

## Architecture

```
handle(req, res)
  +-- GET /__status                -> JSON status (incl. fixer toggles)
  +-- readBody                     -> body buffer
  +-- forward client headers as-is (Authorization untouched)
  +-- if strip_encrypted == "on": pre-strip encrypted_content
  +-- if repair_tools    == "on": pre-repair tools array
  +-- loop (up to cfg.max_fixes):
       +-- forward -> upstream
       +-- 2xx -> pipe to res, exit
       +-- on 4xx/5xx, run any reactive fixer whose mode is "on" or "auto":
            +-- isEncryptedError    -> stripEncryptedReasoning -> retry
            +-- isToolsParamError   -> repairTools             -> retry
            +-- nothing matched      -> pass errBuf to client
```

All fixers are idempotent: a second pass on an already-clean body
returns `null`, terminating the loop early.

---

## License

MIT
