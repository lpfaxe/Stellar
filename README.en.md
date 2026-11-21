# Stellar — give a DSH agent a real identity: QQ × Bilibili × QZone

**English** | [中文](README.md)

> Not “a framework that pipes an LLM into QQ”. It gives the model an identity, a memory that
> forgets and remembers, a daily rhythm and two pairs of hands (QQ / Bilibili), so it can live a day on its own.

| | |
| --- | --- |
| Version | `1.0.9` |
| Target DSH | `0.2.1-rc.2 or newer` (developed and run daily on `0.2.2-rc.1`; re-check with `node scripts/verify-dsh-020-adaptation.mjs`) |
| Platform | Windows 10/11 (sandbox ACL, SnowLuma integration and launchers are Windows-bound) |
| License | MIT (SnowLuma2 is a third-party proprietary runtime and is **not** bundled) |
| Required third party | SnowLuma2 — download and QR-login it yourself |

> 🔒 **No real data ships here**: persona cards are blank templates (`roles/`), memory is an empty SQLite database created on first run (`memory/memory.db`),
> every group / member / QQ id / Bilibili mid is a placeholder, and the factory persona is empty (yours to fill).
> Runtime data only ever lives on your own machine.

> **Text and images only**: no voice, no desktop pet — this repo covers QQ / Bilibili / QZone. The `socialV2.voice`
> and `tools.sendVoice` keys in `config.json` are dead keys kept only so the two configs stay byte-identical.

---

## What it is

A two-process system that runs **on your own machine**:

- **Inside DSH**: the `stellar` plugin — settings UI, Bilibili schedule, memory maintenance, dashboards.
- **A separate process**: `src/bridge.js` — QQ transport, session mapping, console, safety gates.

Together they let the agent:

1. **Be a group member on QQ** — decide whether to read, speak, how many messages, whom to quote; then decide the thread is over and go quiet with a note on how to pick it up later.
2. **Be a user on Bilibili** — its own waking hours, preferences and daily quota; watches videos, scores them, comments, replies, posts dynamics, and can cut a vlog.
3. **Browse QZone** — the public “friends feed” (read → score → like the good ones → comment), plus posting its own 说说.
4. **Remember** — chats are split into topics, private facts (birthday, allergies, address…) are stored as weighted “facts”, videos and feeds go into sighting zones; ask “when is my birthday” and it knows.
5. **Reach out first** — turns recent memory into something it wants to figure out or share, outside quiet hours; also reminds the right person when a to-do is due.

**What it does not do**: log in or scan QR codes for you, bypass platform risk control, support multiple users,
expose the console to the internet, or delete anything irreversibly.

## Requirements

| Need | Version / notes | Required? |
| --- | --- | --- |
| Windows | 10/11 | ✅ |
| Node.js | **≥ 22.13**. Optional: the DSH desktop app ships its own node under `~/.dsh/dsh-runtimes/*/dependencies/node/bin/node.exe`, and the launchers / `bootstrap.mjs` fall back to it (and to the bundled `pnpm` when `npm` is missing) | ✅ (DSH can provide it) |
| DeepSeek Harness | `0.2.1-rc.2 or newer`, Web GUI working | ✅ |
| SnowLuma2 | third-party QQ runtime; download from its official releases and QR-login | ✅ |
| ffmpeg | only for frame grabbing and vlog cutting (PATH, `<repo>/bin/`, or `~/.dsh/stellar/bili/bin/`) | ⭕ optional |

## Install

**Windows users who prefer not to touch a terminal:** download `Stellar.exe` from
[Releases](https://github.com/lpfaxe/Stellar/releases), double-click it, pick a folder (default
`%USERPROFILE%\Stellar`), and let it extract. It then offers to run the first-start check for you.
The exe is **only a bootstrapper** — it ships a snapshot of this repo (no `config.json`, no `state/`, no
`node_modules`), installs nothing else, writes no registry keys, and uninstalling means deleting the folder.
It is unsigned, so Windows SmartScreen shows “Unknown publisher” the first time (“More info” → “Run anyway”).
Build it yourself with `node scripts/build-windows-exe.mjs` (output goes to `dist/`, which is git-ignored).

**Command-line path:** double-click **`首次启动.bat`** (“first start”) in the repo root. It checks the Node version,
installs dependencies, copies `config.example.json` → `config.json` (never overwrites an existing one),
creates `state/` and tightens its ACL, registers plugin / presets / MCP servers into DSH, and re-aligns
`dsh.baseUrl` with the running DSH port. Re-running only skips finished steps; it ends with a table of the
few things only you can fill in. Log: `state/bootstrap.log`.

```bash
node scripts/bootstrap.mjs           # same program, asks once before acting
node scripts/bootstrap.mjs --dry-run # print the plan only
```

> `npm run bootstrap` / `npm run bootstrap:check` are equivalent, but on a machine that only has DSH there is
> no `npm` on PATH — that is why the docs use `node` directly.

Or do it by hand:

```bash
git clone <this repo> stellar
cd stellar
npm install                # postinstall patches the @snowluma/sdk ESM packaging bug
cp config.example.json config.json
node scripts/setup-dsh.mjs
# restart DSH
```

Key settings in `config.json`:

| Field | Description |
| --- | --- |
| `snowluma.wsUrl` | OneBot **WebSocket** URL (e.g. `ws://127.0.0.1:3001`) |
| `snowluma.httpUrl` | OneBot **HTTP API** URL (e.g. `http://127.0.0.1:3000`) — not the WS port |
| `snowluma.accessToken` | Access token shown by SnowLuma |
| `ownerQQ` | Administrator QQ (highest privilege) |
| `allow.private` / `allow.groups` | Whitelists. **Empty = it answers nobody.** |
| `consoleToken` | Local console token on port 3100 |

Details: [`INSTALL.md`](docs/guides/getting-started/INSTALL.md) and [`DSH_SETUP.md`](docs/guides/getting-started/DSH_SETUP.md).

---

## Day-to-day

- **Settings page** (DSH → Settings → Stellar): 7 tabs — Overview / Her / QQ / Bilibili / Memory / Characters / Advanced (Extensions · All parameters · Diagnostics).
  "Her" holds the three run modes (normal / slack-off / minimal), the reminder list, and the proactive-talk settings; watch history is folded into the Bilibili tab.
- **Bridge modes** — `chat` (plain group member), `closed-agent` (admin only), `reserved` (v1 simulation), `reserved2` (v2 simulation, default: everything is a tool — read, send, wait, sleep, close).
- **Run modes** — a second, independent layer: `normal` (full daily tasks), `idle` (logs only, more browsing and chatting; the default on weekends), `minimal` (replies only, then sleeps).
- **Dashboards** — the full panel on `http://127.0.0.1:3300/` (6 pages, 31 cards) and the bridge’s own single-page console on `http://127.0.0.1:3100/?token=<consoleToken>` (17 sections).

The panel is empty on a fresh install — it reads `~/.dsh/stellar/` and `config.json`, which do not exist yet.
Contacts appear after the first message, memory after a few rounds, Bilibili/QZone after the scheduler runs once.

## Features

| Area | What you get |
| --- | --- |
| **QQ** | group / private send & receive, quotes, multi-part replies, stickers, images, pokes, forwarded-chat expansion, history catch-up, questions & approvals |
| **Bilibili** | QR login, watch / score / favourite, comments and replies, dynamics (incl. image posts), danmaku, DMs, triple, live-room watch, daily vlog, share to QQ — **58 CLI commands** |
| **QZone** | read own / friends’ / a specific contact’s feed, like, comment and reply, delete own comments; the public “friends feed” loop |
| **Memory** | topic splitting, weighted facts (birthday / allergies / address / phone), sighting zones (Bilibili / QZone), per-person profiles, style reference library, vector recall, three privacy levels |
| **Persona** | multi-character bundles, autosave slots, admin dual identity, cross-platform identity alignment |
| **Proactive** | goal hypothesis → outreach / sharing, conversation closure with “how to pick it up next” |
| **Daily** | run modes, biological clock, daily task list, to-do reminders, quiet hours |
| **Budget** | daily token limits (QQ / Bilibili / friends-feed / town / other / total), cost dashboard, price-table conversion |
| **Tool surface** | **78 MCP tools** (36 `qq_*` + 39 `stellar_*` + 3 host-level), three MCP servers, four presets, fail-closed guards |
| **UI** | settings page (7 tabs), full panel (6 pages / 31 cards), bridge console (single page) |

**Optional, off by default — Fishbowl Town.** The repo ships an *interface* to
[fishbowltown.com](https://fishbowltown.com) (a private "her own day" diary for the agent): four modules,
five read-only tools, a `town-act` shadow preset and a separate `town.db` with a 3-day TTL.
`town.enabled` defaults to `false` and no access code is bundled, so a fresh install never connects,
never wakes a session and never spends anything. Actions that would cost money (sit down / play / treat
someone) are **not registered as tools** in this version. Enable it yourself with an `fbo_…` code in
`%DSH_HOME%/fishbowl-town/settings.json` plus `town.enabled = true`; see
[docs/guides/subsystems/SUBSYSTEM-TOWN.md](docs/guides/subsystems/SUBSYSTEM-TOWN.md) (Chinese).

## Security notes

- `config.json` and `state/` are never committed; only `config.example.json` ships. Sensitive files are ACL-hardened to owner / SYSTEM / Administrators, **after** every atomic write.
- Whitelists are enforced on every send — there is no “admin exception” backdoor.
- Identity is proven by a per-session token (returned in wake prompts) plus a short-lived in-memory operator token for internal schedules — not by a self-declared key.
- Simulation sessions get **no local execution tools**: the guard hides them at registration and a runtime allowlist rejects anything outside the QQ MCP namespaces.
- The console listens on loopback only, with a token (constant-time compare), Host/Origin checks and JSON-only writes.
- Secrets are never logged; irreversible deletions are always quarantined first.
- A deterministic privacy gate runs on every outbound text (QQ private / group, Bilibili dynamics / comments / DMs, QZone posts and comments, vlog render and publish — exit code 8, nothing rendered, nothing published).
- `stellar_file_read` restricts local paths to the workspace and URLs to a public allowlist (SSRF guard).

## Repository layout

```
stellar/
  config.example.json   # sanitized config template
  docs/                 # guides: architecture / subsystems / features / operations / getting started
  dsh/agent-presets/    # qq-chat / qq-chat-v2 preset templates
  plugins/stellar/      # DSH plugin bundle
  src/                  # bridge core and MCP servers
  public/console.html   # bridge’s own web console
  stellar-manager/      # full dashboard (zero dependencies, loopback only)
  scripts/              # setup, tests and helpers
  roles/                # blank persona template
  state/                # runtime data (never committed)
```

## Testing

```bash
node scripts/test-audit.mjs        # offline regression suite, no credentials / DSH / QQ needed (159 specs;
                                   # the few that need the dev panel auto-SKIP in the public repo)
npm run test:regressions           # bridge / protocol regressions
npm run privacy-scan:strict        # must report zero hits before publishing
npm run guard:check                # after a DSH upgrade: is the asar session guard still patched?
```

> **Publishing order is fixed**: commit code → `node scripts/release-manifest.mjs` → commit the manifest separately → push.

The code-level documentation set is written in Chinese under [`docs/guides/`](docs/guides/);
start with [`ARCHITECTURE.md`](docs/guides/architecture/ARCHITECTURE.md). Index: [`docs/README.md`](docs/README.md).

## Compliance

SnowLuma is an independent third-party project, not affiliated with Tencent / QQ. Stellar never downloads,
installs or packages SnowLuma — it only detects an existing installation, opens its window and reports
connection status (EULA §5.4). Please follow the QQ and Bilibili terms of service and your local law.
