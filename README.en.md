# Stellar — QQ × Bilibili × Desktop Pet for DeepSeek Harness

**English** | [中文](README.md)

> Stellar is not "a bot framework that pipes an LLM into QQ". It gives the model an
> identity, a memory that forgets, a daily rhythm, two pairs of hands (QQ / Bilibili)
> and a desktop avatar that sits next to you.

| | |
| --- | --- |
| Version | `1.0.0` |
| Target DSH | `0.2.1-rc.2 or newer` (rc.3 installs, feature regression not fully re-verified; run `npm run verify:adaptation`) |
| Platform | Windows (sandbox ACL, SnowLuma and the launcher scripts are bound to it) |
| License | MIT (SnowLuma is a third-party proprietary runtime and is **not** bundled) |
| Optional | Voice engine (local / cloud) and an Electron desktop pet — both deployed separately, not shipped here |

> 🔒 **This repository ships no real data**: persona cards are redacted examples (`roles/`),
> memory cards are empty shells (`examples/`), and every group / member / QQ id / Bilibili mid
> is a placeholder. Runtime data only ever lives on your own machine.

The full, code-level documentation set is written in Chinese under [`docs/guides/`](docs/guides/) —
start with [`ARCHITECTURE.md`](docs/guides/architecture/ARCHITECTURE.md). The documentation index is
[`docs/README.md`](docs/README.md); repository and script conventions are in
[`docs/FOLDER_MAP.md`](docs/FOLDER_MAP.md).

## Architecture

```
QQ messages ──► SnowLuma (OneBot v11 WS) ──► src/bridge.js ──► DSH Web API
                                                    ▲                 │
                                                    └── replies / questions / approvals

DSH host ──► stellar plugin bundle (settings page, pet API, Bilibili scheduler, memory, budget)
```

- **Bridge** (`src/bridge.js`): single instance. OneBot WS client, DSH client, local console on
  `127.0.0.1:3100`, and three bundled MCP servers (QQ tools, host probe, safe web search).
- **Plugin** (`plugins/stellar/`): the DSH bundle behind the **Stellar** settings window — QQ,
  Bilibili, two-way redacted memory, identity alignment, token budget.
- **Session auth**: the session cookie is minted offline from the persistent local signing key;
  no launch token needs to be scraped from logs.
- **Agent presets**: `qq-chat` / `qq-chat-v2` plus the shared `qq-tool-restrict` guard,
  installed by `node scripts/setup-dsh.mjs`.

## Features

- Bridges QQ group / private messages to DSH agent sessions, in either direction.
- Simulation mode ("simulated group friend") with idle / active / probing / exiting states.
- Whitelist / blacklist access control, fail-closed by default.
- Sensitive-text audit stops paths and credentials from ever reaching QQ.
- Long-term memory cards: a decayed card (the only one injected into prompts) plus a full archive
  for on-demand recall; capacity alerts with one-click compression.
- Multi-character persona bundles under `~/.dsh/stellar/characters/<id>/`, with autosave slots.
- Bilibili subsystem: watches videos in a configured time window, scores them, comments, posts.
- Token usage and cost shown per group / friend / turn in the console.
- Optional voice engine and desktop pet, connected over loopback with a one-shot token.

## Requirements

- Windows 10/11
- Node.js >= 22.13 — optional if the DSH desktop app is installed: it ships its own node under
  `~/.dsh/dsh-runtimes/.../node/bin/node.exe`, and both the `.bat` launchers and `bootstrap.mjs`
  fall back to it (and to the matching `pnpm` when `npm` is missing)
- A running DeepSeek Harness with the Web GUI enabled (default `http://127.0.0.1:3080`)
- A running SnowLuma2 with OneBot v11 WebSocket + HTTP API enabled (QQ only)

## Quick Start

Fastest path: double-click **`首次启动.bat`** ("first start") in the repository root. It checks the
Node version, installs dependencies, copies `config.example.json` to `config.json` (never overwriting
an existing one), creates `state/` and tightens its ACL, registers the plugin/presets/MCP servers
into DSH, and re-aligns `dsh.baseUrl` with the running DSH port. Re-running it only skips what is
already done, and it ends with a table of the few things only you can fill in (owner QQ, allowlist,
SnowLuma ports). Log: `state/bootstrap.log`.

```bash
node scripts/bootstrap.mjs           # same program, one question before it acts
node scripts/bootstrap.mjs --dry-run # print the plan only
```

> `npm run bootstrap` / `npm run bootstrap:check` are the same two commands. They are written with
> `node` here because on a machine that only has DSH there is no `npm` on PATH.

Editing `config.json` by hand is optional: double-click **`配置.bat`** for a local form (bound to
`127.0.0.1`, one-time token). You pick the file yourself — it never scans your disk — and it only
writes the fields the form covers, validates before writing, and backs up the old file first.

Manual equivalent:

```bash
npm install        # postinstall patches the @snowluma/sdk ESM packaging bug
#                  (no npm? run `node scripts/bootstrap.mjs` instead — it uses DSH's pnpm)
cp config.example.json config.json
node src/bridge.js # or npm start / start.bat
```

Key settings in `config.json`:

| Field | Description |
| --- | --- |
| `dsh.baseUrl` | DSH Web API URL, default `http://127.0.0.1:3080` |
| `dsh.authToken` | Normally **leave empty**: the bridge mints the session cookie from the local signing key |
| `snowluma.wsUrl` | OneBot **WebSocket** URL (e.g. `ws://127.0.0.1:3001`) |
| `snowluma.httpUrl` | OneBot **HTTP API** URL (e.g. `http://127.0.0.1:3000`); do not point this at the WS port |
| `ownerQQ` | Administrator QQ (highest privilege) |
| `allow.private` / `allow.groups` | Whitelist of QQ / group ids |
| `deny.users` / `deny.private` / `deny.groups` | Blacklists; they win over the whitelists |
| `consolePort` | Local console port, default `3100` |

Then install the DSH side once per machine:

```bash
node scripts/setup-dsh.mjs
```

and restart DSH. Details: [`docs/guides/getting-started/DSH_SETUP.md`](docs/guides/getting-started/DSH_SETUP.md).

## Security Notes

- `config.json` and `state/` are never committed; only `config.example.json` ships. Both are
  ACL-hardened to owner / SYSTEM / Administrators (`npm run harden-acl`).
- MCP send tools enforce whitelist checks and reject CQ-code injection.
- Local paths, credentials and tokens are filtered by the audit layer.
- Simulation sessions get **no local execution tools**: the guard hides them at registration time
  and a runtime allowlist rejects anything outside the QQ MCP namespaces.
- The console listens on loopback only, with a token, Host/Origin checks and JSON-only writes.
- `stellar-manager/` ships the **full dashboard** (same code as a dev deployment): overview, per-day activity, contacts, memory DB (topics / facts / sighting zones), Bilibili, QZone, logs, settings and remote access. It is empty on a fresh install because it reads `~/.dsh/stellar/` and `config.json`, which do not exist yet. Launch with `启动控制台.bat` → `http://127.0.0.1:3300/` (loopback only; `STELLAR_PANEL_HOST=0.0.0.0` to expose). The page never sees the bridge `consoleToken`; the server attaches it when proxying. The panel passphrase and audit log live in `~/.dsh/stellar/`, never in the repo.

## Repository Layout

```
stellar/
  config.example.json   # sanitized config template
  docs/                 # README, FOLDER_MAP, RELEASE, VOICE-PACKS + guides/
  dsh/agent-presets/    # qq-chat / qq-chat-v2 preset templates
  plugins/stellar/      # DSH plugin bundle
  src/                  # bridge core and MCP servers
  public/console.html   # local web console
  scripts/              # setup, tests and helpers
  roles/                # example persona cards
  assets/               # images
  state/                # runtime data (never committed)
```

## Testing

```bash
node scripts/test-audit.mjs   # isolated regression suite, no credentials / DSH / QQ needed
                              # (= npm run test:audit; panels-dependent 6 specs auto-SKIP here)
npm run self-test       # DSH-side link test
```

See [`docs/guides/development/DEV-TESTING.md`](docs/guides/development/DEV-TESTING.md) for the full list.

## Compliance

SnowLuma is an independent third-party project, not affiliated with Tencent / QQ. Stellar never
downloads, installs or packages SnowLuma — it only detects an existing installation, opens its
window and reports connection status. Please follow the QQ and Bilibili terms of service.
