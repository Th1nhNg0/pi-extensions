# pi-extensions

Personal collection of custom extensions, utilities, and tools for the [Pi Coding Agent](https://pi.dev) by [@Th1nhNg0](https://github.com/Th1nhNg0).

---

## 📦 Extensions

### 1. `subscription-usage` (`extensions/subscription-usage.ts`)

Adds a minimal usage readout to Pi's footer status line — directly below the model/thinking indicator — showing usage bars (or bare percentages), and reset countdown timers for subscription-backed LLM providers. Since the footer already names the provider, no prefix is repeated.

#### Supported Providers

* **Antigravity Pro** (Gemini & 3rd-party/Claude quotas with 5h rolling & weekly buckets)
* **OpenAI Codex** (Plus/Team/Pro plan 5h rolling & weekly quota windows, plus banked rate-limit resets)
* **OpenCode Go** (Rolling, Weekly, and Monthly limits, plus DeepSeek peak/off-peak indicator)
* **DeepSeek API** (Account balance from `/user/balance`, plus peak/off-peak billing windows shown in your local time)

---

### 🖥️ Footer Status Examples

Shown on the status line right under `… 12.5%/200k (auto)    kimi-k2 • high`:

| Provider | Status Line Output |
| :--- | :--- |
| **Antigravity Pro (Gemini)** | `5h: ░░░░░░ 0% ~4h · W: █████▌░ 79% ~4d` |
| **Antigravity Pro (Claude/GPT)** | `5h: ░░░░░░ 0% ~4h · W: ████░░░ 61% ~6d` |
| **OpenAI Codex** | `5h: ░░░░░░ 1% ~4h · W: ███░░░ 51% ~3d · 3 resets left` |
| **OpenCode Go** | `Peak ~2h · R: ░░░░░░ 2% ~3h · W: ██░░░░ 44% ~3d · M: ██████ 98% ~14d` |
| **DeepSeek API** | `Off-Peak ~5h · $12.34` |
| **Any (percent style)** | `R 2% ~3h · W 44% ~3d · M 98% ~14d` |
#### Legend

* `5h` / `R` : 5-Hour rolling window
* `W` : Weekly quota window
* `M` : Monthly quota window
* `~` : Countdown until the next quota reset (e.g. `~4h`, `~3d`)
* `Peak` / `Off-Peak` : DeepSeek billing state. Windows are `01:00–04:00` and `06:00–10:00` UTC, converted to your local time; `+1`/`-1` marks a window that crosses local midnight. Off-peak hours are billed at 50%.
* `$12.34` : DeepSeek API account balance (`GET /user/balance`), shown for pay-as-you-go accounts.
* `3 resets left` : Banked rate-limit resets available for OpenAI Codex subscriptions.

---

### ✨ Highlights

* **Adaptive Fetching:** Refreshes on session start, model switch, and agent turn settlement with intelligent cooldowns.
* **Smart Scheduling:** Reset-aware wake timers that automatically refresh immediately when a usage bucket flips.
* **Shared Cache:** Persists validated data across multiple Pi sessions via `~/.pi/agent/subscription-usage-cache.json`, using asynchronous atomic writes so cache I/O does not block Pi.
* **Safe Rendering:** Malformed provider values are ignored and percentages are bounded to `0–100%` before they reach the status line.
* **Stale-Request Protection:** Overlapping refreshes are coalesced, and results from a replaced session/model are discarded.

#### Commands

All controls live under one `/usage` command:

- `/usage` shows every window for **all** providers as a detailed readout (percents, bars, reset countdowns + absolute reset times, plan, balance, and freshness). Only the active provider is live-fetched; the rest render from cache. It works even while the footer is hidden. For DeepSeek it also lists both peak windows in your local time alongside their canonical UTC ranges.
- `/usage toggle` cycles the status line through three modes: bar cells (`bars`) → bare percentages (`percent`) → hidden (`off`). Pass a mode to jump straight to it, e.g. `/usage toggle percent`. While hidden, no status is shown and no provider requests are made; toggling back re-renders (or refetches) immediately. The choice persists across sessions in `~/.pi/agent/subscription-usage-prefs.json`.
- `/usage refresh [all|<provider>|active]` requests fresh usage immediately, bypassing cooldowns. It refreshes **every** configured provider by default; pass `active` for just the provider behind the current model, or a provider id/alias (`opencode-go`, `zen`, `openai-codex`, `codex`, `antigravity`, `deepseek`, …) for a single one. An unknown target warns without issuing any request. Providers with no stored credential are reported as *skipped* rather than failed, and only the provider active at completion owns the footer status and wake timer. When the display is `off`, this command makes no requests; enable it with `/usage toggle` first. Automatic retries recover from temporary provider failures without needing a model switch or reload.

```text
Subscription usage — openai-codex (plus) • gpt-5
• 5h: 1% ░░░░░░ — resets ~4h (2026-09-06 16:00 UTC)
• weekly: 51% ███░░░ — resets ~3d (2026-09-09 12:00 UTC)
• resets: 3 left
Updated 5m ago
```

```text
Subscription usage — deepseek • deepseek-v4-flash
• balance: $12.34
• deepseek pool: Peak hours (13:00–17:00) ~48m left
• peak windows: 08:00–11:00, 13:00–17:00 (local) · 01:00–04:00 UTC, 06:00–10:00 UTC
Updated just now
```

---

### 2. `discord-presence` (`extensions/discord-presence.ts`)

Publishes a privacy-safe, adaptive Discord Desktop Rich Presence while Pi is running.

#### Single-Session Presence

```text
Details: Thinking · Claude 3.7 Sonnet (high)
State:   spring2026 · 42k tok · ctx 38%
```

During tool execution:

```text
Details: Running tests · Claude 3.7 Sonnet (high)
State:   spring2026 · 47k tok · ctx 41%
```

For models supporting reasoning/extended thinking, the active thinking mode level is shown in parentheses after the model name (e.g. `Claude 3.7 Sonnet (high)` or `Claude 3.7 Sonnet (off)` when disabled). Non-reasoning models omit the thinking indicator.

#### Multi-Session Presence

When multiple Pi instances run concurrently:

```text
Details: 3 Pi sessions · 82k tok · $1.24
State:   2 active · multiple models · 3 projects
```

#### 🔒 Privacy Guarantees

Discord Presence **never** sends:

* Prompts or prompt summaries
* Source code content
* File paths or filenames
* Shell commands or command arguments
* Tool arguments or tool outputs
* Private repository URLs

#### 🛡️ Privacy Modes

Configure how much metadata is visible in Discord via `/discord privacy [strict|project|developer]` or `PI_DISCORD_PRIVACY`:

* `strict` (**Default**): Hides the project name completely for maximum privacy. Price is included by default when pricing is available.

  ```text
  Thinking · Claude 3.7 Sonnet (high)
  42k tok · ctx 38% · $0.84
  ```

* `project`: Includes the privacy-safe project directory basename.

  ```text
  Thinking · Claude 3.7 Sonnet (high)
  spring2026 · 42k tok · ctx 38% · $0.84
  ```

* `developer`: Explicit developer view including project basename, tokens, context %, and pricing.

  ```text
  Thinking · Claude 3.7 Sonnet (high)
  spring2026 · 42k tok · ctx 38% · $0.84
  ```

#### 🎮 Slash Commands

All presence controls are consolidated under a single clean `/discord` command:

| Command | Usage | Description |
| :--- | :--- | :--- |
| `/discord status` | `/discord status` | View live connection status, publisher details, active models, token metrics, and per-session diagnostics. |
| `/discord privacy` | `/discord privacy [strict\|project\|developer]` | Cycle or set privacy mode immediately without restarting Pi. Persists across sessions. |
| `/discord toggle` | `/discord toggle [on\|off]` | Turn Discord Presence publishing on or off on the fly. Persists in preferences. |
| `/discord config` | `/discord config` | View an overview of all active settings, client ID, image keys, and preferences. |

#### ⚙️ Configuration & Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PI_DISCORD_CLIENT_ID` | `1541350417143955466` | Custom Discord Application Client ID snowflake. Custom IDs disable default assets unless explicitly configured. |
| `PI_DISCORD_PRIVACY` | `strict` | Privacy level: `strict`, `project`, or `developer`. |
| `PI_DISCORD_BUTTONS` | `on` | Set to `off` to disable the default static Discord profile buttons. |
| `PI_DISCORD_LARGE_IMAGE` | `pi` | Large Rich Presence asset key or image URL. Set to `off` to disable. |
| `PI_DISCORD_SMALL_IMAGES` | `on` | Action badge asset key (`thinking`, `reading`, `editing`, `searching`, `running`, `testing`, `browsing`, `idle`), custom asset key, or image URL. Set to `off` to disable. |
| `PI_DISCORD_SHOW_COST` | `on` | Set to `off` to hide price from public Discord presence. |
| `PI_DISCORD_TRANSPORT` | `auto` | `ipc` or `wsl`; WSL auto-selects the `npiperelay.exe` bridge for Windows Discord. |
| `PI_DISCORD_NPIPERELAY` | `npiperelay.exe` | Optional Windows path/name of the `npiperelay.exe` bridge used from WSL. |
| `PI_DISCORD_MIN_INTERVAL_MS` | `15000` | Minimum milliseconds between Discord presence updates. Discord accepts about one Rich Presence update per 15 seconds; lower values can make Discord silently clear the presence or close the RPC socket. |

##### Default Badge Icons

The default action badges use [Phosphor Duotone](https://phosphoricons.com/) icons rasterized as 72×72 PNG images through [Iconify](https://iconify.design/) and `wsrv.nl` for Discord compatibility. Each action has its own vivid, high-contrast color:

| Action | Icon | Color |
| :--- | :--- | :--- |
| Thinking | `brain` | `#ff375f` |
| Testing | `test-tube` | `#ff9f0a` |
| Editing | `pencil-simple` | `#0a84ff` |
| Searching | `magnifying-glass` | `#00c7be` |
| Reading | `book-open` | `#bf5af2` |
| Running | `terminal-window` | `#30d158` |
| Browsing | `globe` | `#5e5ce6` |
| Tools | `wrench` | `#ffd60a` |
| Idle | `pause-circle` | `#ffffff` |

Set `PI_DISCORD_SMALL_IMAGES` to a custom asset key or image URL to replace the defaults.

#### Setup & Diagnostics

The extension includes a public Discord application ID, so no environment variable is required. Start or reload Pi while Discord Desktop is running, then use `/discord status` to check connection status and inspect per-session statistics (model, phase/action, token breakdown, pricing, context %, and duration). Custom settings can be changed on the fly using `/discord privacy` and `/discord toggle`, and are saved to `~/.pi/agent/discord-presence-prefs.json`.

##### WSL + Windows Discord

WSL cannot open Discord's Windows named pipe directly. When Pi is running in WSL, the extension automatically uses `npiperelay.exe`; install/build it on the Windows filesystem and make it available on the WSL `PATH`, or set `PI_DISCORD_NPIPERELAY` to its mounted Windows path:

```bash
sudo apt install golang-go
git clone https://github.com/jstarks/npiperelay.git
cd npiperelay
mkdir -p /mnt/c/Users/<windows-user>/bin
GOOS=windows go build -o /mnt/c/Users/<windows-user>/bin/npiperelay.exe .
export PI_DISCORD_NPIPERELAY=/mnt/c/Users/<windows-user>/bin/npiperelay.exe
```

Keep Discord Desktop running on Windows, restart Pi, and run `/discord status`. Set `PI_DISCORD_TRANSPORT=ipc` only when Discord is running inside Linux instead.

Multiple Pi sessions share a registry at `~/.pi/agent/discord-presence-state.json`. One session publishes the aggregate activity while the others send heartbeats. If the publisher exits, another active session takes over; stale sessions are removed automatically. Usage totals include assistant/tool results plus compaction and branch-summary calls. Registry locks renew their lease during long operations, and rapid tool/phase updates are coalesced into the newest pending state, which is published at most once per Discord Rich Presence window (15s). Publishing faster than that makes Discord silently clear the presence, so the cadence is capped by `PI_DISCORD_MIN_INTERVAL_MS` and reconnects keep to Discord's limit of 2 IPC connections per minute.

The publisher reloads saved privacy preferences before each publish, so changes made from a standby session apply on the next publisher update (normally within one heartbeat). Reconnection attempts respect exponential backoff even during tool activity, and an off→on toggle restarts a stopped presence manager.

---

### 3. `live-throughput-status` (`extensions/live-throughput-status.ts`)

Adds a model-neutral decode-rate readout to the footer, directly below the subscription-usage line. It is derived entirely from Pi's standard assistant-stream events, so it works with local and hosted models alike — no provider id, model id, or inference-server log/metric is ever read.

The footer deliberately carries **one short number**; everything else is available through `/throughput`.

#### Footer Status Examples

| Phase | Status Line Output |
| :--- | :--- |
| Streaming (`characters / 4` estimate) | `⚡ ~42.1 tok/s` |
| Settled, provider reported usage | `⚡ 39.8 tok/s` |
| Settled, provider reported no usage | `⚡ ~42.1 tok/s` |
| No rate yet (first 200 ms) | previous rate stays; nothing new is printed |
| Buffered output, no deltas | previous rate stays; `/throughput` shows the token count |

The line is cleared on session start, on model switch, by `/throughput toggle off`, and on shutdown.

#### What the Numbers Mean

* **Decode rate** — the footer value: tokens generated per second, the one figure that stays comparable across models and providers.
* **`~` prefix** — the rate is a `characters / 4` estimate, because most providers do not report a cumulative token count on every stream chunk. Thinking and tool-call deltas count as generated output, not just visible text.
* **Exact rate** — when the provider reports token usage on `message_end`, the reported output-token count is spread over the client-observed first-to-last delta interval, with the first token excluded because it defines the start boundary. The `~` disappears. This matches the common OpenAI-compatible pattern of sending usage once, in a final chunk.
* **No invented numbers** — a rate needs at least 200 ms of stream time, so the first moments of a response keep the previous value instead of printing a divide-by-near-zero spike.
* **Everything else** — TTFT (measured from Pi's `before_provider_request` hook to the first observed output delta), the uncached/cached input split, and the decode window — is in `/throughput`. TTFT also contains network, queue, scheduling, and stream-start overhead, so the `Input/TTFT` estimate it feeds is a client-side prompt-rate comparison, **not** authoritative server prefill throughput; cache reads are excluded because the model never re-read them.

#### Provider Behavior

| Provider Behavior | Live Footer | Final Footer |
| :--- | :--- | :--- |
| Reports final output usage | `~42.1 tok/s` estimate | `39.8 tok/s` exact |
| Reports no output usage | `~42.1 tok/s` estimate | `~42.1 tok/s` estimate |
| Buffers output instead of streaming deltas | nothing measurable | previous rate stays; `/throughput` shows tokens with no rate |

For an OpenAI-compatible local server, Pi requests streaming usage by default. Keep `supportsUsageInStreaming` enabled only when the server accepts `stream_options: { "include_usage": true }`; otherwise set it to `false` and the extension keeps using its explicit `chars / 4` fallback.

#### Commands

| Command | Usage | Description |
| :--- | :--- | :--- |
| `/throughput` | `/throughput` | Detailed readout of the last measurement (model, TTFT, input split, decode rate and span, freshness). Works even while the footer line is hidden. |
| `/throughput toggle` | `/throughput toggle [on\|off]` | Cycle `on` → `off`, or jump straight to a mode. Persists in `~/.pi/agent/live-throughput-prefs.json`; `off` clears the line and stops all measurement. |
| `/throughput help` | `/throughput help` | Show the command help. |

```text
Live throughput — openai-codex • gpt-5
• TTFT: 1.24s · Input/TTFT: ~1.5k tok/s
• input: 1.9k tok (1.9k uncached + 62 cache write) · 50k cache read
• decode: 841.0 tok/s · 842 tok over 1.00s
Measured just now
```

#### Limitations

* The live `characters / 4` estimate varies with prose, code, JSON, and CJK.
* Even with an exact final token count, client timing is affected by stream buffering and network jitter.
* Short outputs do not have enough first-to-last span for a stable rate; during the first 200 ms of a stream the previous rate stays on screen.
* `Input/TTFT` in `/throughput` divides by TTFT, which also contains network/queue/scheduling overhead; use inference-server metrics for true prefill throughput.

---

## 🧰 My Pi Setup

My current user-level Pi package setup:

```text
npm:pi-web-access
npm:pi-mcp-adapter
npm:@juicesharp/rpiv-ask-user-question
npm:@ff-labs/pi-fff
npm:pi-antigravity
git:github.com/Th1nhNg0/pi-extensions
npm:pi-background-tasks
npm:pi-hashline-edit-pro@latest
npm:pi-advisor-flow
```

To inspect the currently installed packages:

```bash
pi list
```

---

## 🚀 Installation

Install globally into Pi:

```bash
pi install git:github.com/Th1nhNg0/pi-extensions
```

Or install for local development:

```bash
pi install ./path/to/pi-extensions
```

---

## 🔄 Updating

To fetch and apply updates at any time:

```bash
pi update --extensions
```

To reload extensions during an active Pi session:

```text
/reload
```

---

## 📄 License

[MIT](LICENSE) © [Thinh Ngo](https://github.com/Th1nhNg0)
