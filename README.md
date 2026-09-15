# Fast Context MCP

AI-driven semantic code search as an MCP tool — powered by Windsurf's reverse-engineered SWE-grep protocol.

Any MCP-compatible client (Claude Code, Claude Desktop, Cursor, etc.) can use this to search codebases with natural language queries. All tools are bundled via npm — **no system-level dependencies** needed (ripgrep via `@vscode/ripgrep`, tree via `tree-node-cli`). Works on macOS, Windows, and Linux.

## How It Works

```
You: "where is the authentication logic?"
         │
         ▼
┌─────────────────────────┐
│  Fast Context MCP       │
│  (local MCP server)     │
│                         │
│  1. Maps project → /codebase
│  2. Sends query to Windsurf Devstral API
│  3. AI generates rg/readfile/tree commands
│  4. Executes commands locally (built-in rg)
│  5. Returns results to AI
│  6. Repeats for N rounds
│  7. Returns file paths + line ranges
│     + keywords + bounded source
└─────────────────────────┘
         │
         ▼
Found 3 relevant files.
  [1/3] /project/src/auth/handler.py (L10-60)
  [2/3] /project/src/middleware/jwt.py (L1-40)
  [3/3] /project/src/models/user.py (L20-80)

Suggested search keywords:
  authenticate, jwt.*verify, session.*token
```

## Prerequisites

- **Node.js** >= 18
- **Windsurf account** — free tier works (needed for API key)

No need to install ripgrep — it's bundled via `@vscode/ripgrep`.

## Installation

### Option 1: npm (Recommended)

```bash
# Latest stable release
npm install @sammysnake/fast-context-mcp

# Or beta/next release
npm install @sammysnake/fast-context-mcp@next
```

### Option 2: From Source

```bash
git clone https://github.com/SammySnake-d/fast-context-mcp.git
cd fast-context-mcp
npm install
```

## Setup

### 1. Get Your Windsurf/Devin API Key

The server auto-extracts the API key from Devin CLI/Desktop or a legacy Windsurf installation. You can also use the `extract_windsurf_key` MCP tool after setup, or set `WINDSURF_API_KEY` manually.

Desktop credentials are discovered in this order: `Devin`, legacy `Deviv`, then `Windsurf`.

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Devin/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%/Devin/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Devin/User/globalStorage/state.vscdb` |

On WSL/Linux, the server first checks Devin CLI credentials at `~/.local/share/devin/credentials.toml`. If a Windows-extracted key returns 403 inside WSL, run `devin login` inside WSL and retry.

### 2. Configure MCP Client

#### Claude Code

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "fast-context": {
    "command": "npx",
    "args": ["-y", "--prefer-online", "@sammysnake/fast-context-mcp"],
    "env": {
      "WINDSURF_API_KEY": "sk-ws-01-xxxxx"
    }
  }
}
```

For beta/next release:

```json
{
  "fast-context": {
    "command": "npx",
    "args": ["-y", "--prefer-online", "@sammysnake/fast-context-mcp@next"],
    "env": {
      "WINDSURF_API_KEY": "sk-ws-01-xxxxx"
    }
  }
}
```

#### Claude Desktop

Add to `claude_desktop_config.json` under `mcpServers`:

```json
{
  "fast-context": {
    "command": "npx",
    "args": ["-y", "--prefer-online", "@sammysnake/fast-context-mcp"],
    "env": {
      "WINDSURF_API_KEY": "sk-ws-01-xxxxx"
    }
  }
}
```

For beta/next release:

```json
{
  "fast-context": {
    "command": "npx",
    "args": ["-y", "--prefer-online", "@sammysnake/fast-context-mcp@next"],
    "env": {
      "WINDSURF_API_KEY": "sk-ws-01-xxxxx"
    }
  }
}
```

> If `WINDSURF_API_KEY` is omitted, the server auto-discovers it from your local Windsurf installation.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WINDSURF_API_KEY` | *(auto-discover)* | Windsurf API key |
| `FC_MAX_TURNS` | `3` | Search rounds per query (more = deeper but slower) |
| `FC_MAX_COMMANDS` | `8` | Max parallel commands per round |
| `FC_TIMEOUT_MS` | `30000` | Connect-Timeout-Ms for streaming requests |
| `FC_HIDE_EXTRACT_WINDSURF_KEY_TOOL` | `false` | Hide `extract_windsurf_key` from MCP tools when set to `1`, `true`, `yes`, or `on` |
| `FC_RESULT_MAX_LINES` | `50` | Max lines per command output (truncation) |
| `FC_LINE_MAX_CHARS` | `250` | Max characters per output line (truncation) |
| `FC_CACHE_DISABLED` | *(unset)* | Disable the in-memory result cache with `1`, `true`, `yes`, or `on` |
| `FC_CACHE_TTL_MS` | `300000` | Result-cache TTL; `<=0` disables caching |
| `FC_CACHE_MAX_ENTRIES` | `200` | Maximum in-memory cache entries |
| `FC_ALLOW_INSECURE_TLS` | *(unset)* | Set to `1` only when a trusted corporate proxy requires disabled TLS verification |
| `WS_MODEL` | `MODEL_SWE_1_6_FAST` | Windsurf model name |
| `WS_APP_VER` | `1.48.2` | Windsurf app version (protocol metadata) |
| `WS_LS_VER` | `1.9544.35` | Windsurf language server version (protocol metadata) |

## Available Models

The model can be changed by setting `WS_MODEL` (see environment variables above).

![Available Models](docs/models.png)

Default: `MODEL_SWE_1_6_FAST` — fastest speed, richest grep keywords, finest location granularity.

## MCP Tools

### `fast_context_search`

AI-driven semantic code search with tunable parameters.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | — | Natural language search query |
| `project_path` | string | No | cwd | Absolute path to project root |
| `tree_depth` | integer | No | `3` | Directory tree depth for repo map (1-6). Higher = more context but larger payload. Auto falls back to lower depth if tree exceeds 250KB. Use 1-2 for huge monorepos (>5000 files), 3 for most projects, 4-6 for small projects. |
| `max_turns` | integer | No | `3` | Search rounds (1-5). More = deeper search but slower. Use 1-2 for simple lookups, 3 for most queries, 4-5 for complex analysis. |
| `max_results` | integer | No | `10` | Maximum number of files to return (1-30). Smaller = more focused, larger = broader exploration. |
| `exclude_paths` | string[] | No | `[]` | Directory/file patterns excluded from the repository map and search context. |
| `snippet_chars` | integer | No | `6000` | Total appended source budget across files (0–12000), including excerpt headers and line numbers. Set 0 to omit excerpts without changing tools. |

Returns:
1. **Relevant files** with line ranges
2. **Suggested search keywords** (rg patterns used during AI search)
3. **Diagnostic metadata** (`[config]` line showing actual tree_depth used, tree size, and whether fallback occurred)
4. **Bounded source excerpts**, allocated across distinct files before refilling unused capacity. Source is reread locally even on a locator cache hit. Each file contributes at most three ranges of twenty complete lines; missing, excluded, unsafe or oversized files can remain locator-only.

Successful responses include `[context] version=1, budget_chars=N, used_chars=M` before the excerpts. `M` counts the appended excerpt text in JavaScript UTF-16 code units (headers/newlines included), not tokens or bytes. A zero value also means enrichment has already been handled; adapters should not add a second set of excerpts. The original locator list and diagnostics remain available regardless of this budget. Read omitted ranges, wider context or code needing verification before edits. Filtering is conservative, not a complete secret scanner.

Example output (locator section, followed by the context marker and any excerpts):
```
Found 3 relevant files.

  [1/3] /project/src/auth/handler.py (L10-60, L120-180)
  [2/3] /project/src/middleware/jwt.py (L1-40)
  [3/3] /project/src/models/user.py (L20-80)

grep keywords: authenticate, jwt.*verify, session.*token

[config] tree_depth=3, tree_size=12.5KB, max_turns=3
```

Error output includes status-specific hints:
```
Error: Request failed: HTTP 403

[hint] 403 Forbidden: Authentication failed. The API key may be expired or revoked.
Try re-extracting with extract_windsurf_key, or set a fresh WINDSURF_API_KEY env var.
If you are running inside WSL, run `devin login` inside WSL so `~/.local/share/devin/credentials.toml` exists.
```

```
Error: Request failed: HTTP 413

[diagnostic] tree_depth_used=3, tree_size=280.0KB (auto fell back from requested depth)
[hint] If the error is payload-related, try a lower tree_depth value.
```

### `extract_windsurf_key`

Extract Windsurf API Key from local installation. No parameters.

Set `FC_HIDE_EXTRACT_WINDSURF_KEY_TOOL=1` at MCP server startup to hide this tool from `tools/list`. This does not disable internal API-key auto-discovery for `fast_context_search`.

## Project Structure

```
fast-context-mcp/
├── package.json
├── src/
│   ├── server.mjs        # MCP server entry point
│   ├── core.mjs          # Auth, message building, streaming, search loop
│   ├── executor.mjs      # Tool executor: rg, readfile, tree, ls, glob
│   ├── extract-key.mjs   # Windsurf API Key extraction (SQLite)
│   ├── path-safety.mjs   # Project-root confinement for model-selected paths
│   ├── response-repair.mjs # Malformed response repair and evidence salvage
│   ├── shared.mjs        # Repository map, answer parser, prompt builder
│   ├── cache.mjs         # In-memory search-result cache
│   └── protobuf.mjs      # Protobuf encoder/decoder + Connect-RPC frames
├── test/                 # Unit and MCP stdio integration tests
├── README.md
└── LICENSE
```

## How the Search Works

1. Project directory is mapped to virtual `/codebase` path
2. Directory tree generated at requested depth (default L=3), with **automatic fallback** to lower depth if tree exceeds 250KB
3. Query + directory tree sent to Windsurf's Devstral model via Connect-RPC/Protobuf
4. Devstral generates tool commands (ripgrep, file reads, tree, ls, glob)
5. Commands executed locally in parallel (up to `FC_MAX_COMMANDS` per round)
6. Results sent back to Devstral for the next round
7. After `max_turns` rounds, Devstral returns file paths + line ranges
8. The local server validates and supplements those ranges with budgeted source excerpts before returning the same tool response
8. All rg patterns used during search are collected as suggested keywords
9. Diagnostic metadata appended to help the calling AI tune parameters

## Technical Details

- **Protocol**: Connect-RPC over HTTP/1.1, Protobuf encoding, gzip compression
- **Model**: Devstral (`MODEL_SWE_1_6_FAST`, configurable)
- **Local tools**: `rg` (bundled via @vscode/ripgrep), `readfile` (Node.js fs), `tree` (tree-node-cli), `ls` (Node.js fs), `glob` (Node.js fs)
- **Auth**: API Key → JWT (auto-fetched per session)
- **Runtime**: Node.js >= 18 (ESM)

### Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server framework |
| `@vscode/ripgrep` | Bundled ripgrep binary (cross-platform) |
| `tree-node-cli` | Cross-platform directory tree (replaces system `tree`) |
| `sql.js` | Read Devin/Windsurf's local SQLite DB without a native build step |
| `zod` (`^3.25.76`) | Schema validation; avoids the incomplete `3.25.0` tarball served by some npm mirrors |

## 友情链接

- [LINUX DO](https://linux.do/t/topic/1583790/64)

## License

MIT

## Local reliability fork

This fork limits each MCP server process to one active search, with at most eight
accepted active/queued calls. Queueing, cooldown, retries and network work share a
110-second deadline. MCP cancellation propagates to waits and network requests.
Existing local read commands retain their own bounded timeouts; cancellation does
not forcibly interrupt a synchronous file read already executing.

Transient network errors, HTTP 429/500/502/503/504 and Connect
resource_exhausted/unavailable/internal/aborted errors receive at most two retries
at the inference request boundary, before local commands execute. Backoff is
1s then 2s plus jitter, respecting Retry-After. Authentication errors and timeouts
are not retried. Persistent exhaustion triggers a 30s process-wide cooldown (or
longer Retry-After) for subsequent queued searches. With WAM enabled, the current
search may also fail over once as described below. Queues are process-local: multiple MCP
processes do not share a global account limit. Use one shared McpMux instance.

Logs are JSON lines on stderr (stdout remains MCP-only). Set FC_LOG_FILE for
persistent logging: rotation at 5 MiB retains one previous file. Fields include
requestId, callId, queue/cooldown duration, attempt, status/RPC code, traceId,
backoff and terminal outcome. Query text, file paths, tokens, response bodies and
raw error messages are not logged. Logging failures never fail a search.

Account failover requires the WAM pool below. Switching accounts does not solve
service-wide outages; resource_exhausted does not guarantee that another account
will succeed. The global concurrency bound and process-wide cooldown remain in place.


### WAM local account source (fork)

Set `FC_WAM_EXE` to the installed WAM fork executable. WAM must contain logged-in,
active accounts with a Windsurf API key. The MCP reads only account IDs and API keys
through a short-lived local process pipe; passwords and refresh tokens are not exported.
No plaintext token file or HTTP credential endpoint is used. When enabled, WAM failure
never silently falls back to WINDSURF_API_KEY or another desktop account.

Within the single MCP server queue, choose the least recently used eligible account
and pin it for the whole read-only search. Network disconnects, 502/503/504,
resource_exhausted and HTTP 429 may replay the search on one other healthy account,
at most once in total and within the existing deadline, after request-level retries.
Authentication errors cool that credential for five minutes; permission denial
blocks that credential. Changed API keys have independent state. Resource exhaustion
and 429 cool only the affected account for at least 60 seconds or Retry-After, whichever
is longer. If no other account is ready, the original failure is returned; authentication
and permission errors never trigger account failover.

Nonsecret account fingerprints, last-used times and cooldowns persist at
`%LOCALAPPDATA%/fast-context-mcp/account-state.json` (override with FC_WAM_STATE_FILE).
Run a single shared MCP instance through McpMux; independent processes must use separate
state files and do not share the in-process request queue. Existing structured diagnostics
include account IDs and failover categories, never keys. This integration does not keep
sessions alive with background traffic: refresh or log in in WAM when necessary.
