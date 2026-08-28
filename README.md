# pi-extensions

Personal collection of custom extensions, utilities, and tools for the [Pi Coding Agent](https://pi.dev) by [@Th1nhNg0](https://github.com/Th1nhNg0).

---

## 📦 Extensions

### 1. `subscription-usage` (`extensions/subscription-usage.ts`)

Adds a minimal usage readout to Pi's footer status line — directly below the model/thinking indicator — showing usage bars (or bare percentages), and reset countdown timers for subscription-backed LLM providers. Since the footer already names the provider, no prefix is repeated.

#### Supported Providers

* **Antigravity Pro** (Gemini & 3rd-party/Claude quotas with 5h rolling & weekly buckets)
* **OpenAI Codex** (Plus/Team/Pro plan 5h rolling & weekly quota windows)
* **OpenCode Go** (Rolling, Weekly, and Monthly limits, plus DeepSeek peak/off-peak indicator)

---

### 🖥️ Footer Status Examples

Shown on the status line right under `… 12.5%/200k (auto)    kimi-k2 • high`:

| Provider | Status Line Output |
| :--- | :--- |
| **Antigravity Pro (Gemini)** | `5h: ░░░░░░ 0% ~4h · W: █████▌░ 79% ~4d` |
| **Antigravity Pro (Claude/GPT)** | `5h: ░░░░░░ 0% ~4h · W: ████░░░ 61% ~6d` |
| **OpenAI Codex** | `5h: ░░░░░░ 1% ~4h · W: ███░░░ 51% ~3d` |
| **OpenCode Go** | `Peak ~2h · R: ░░░░░░ 2% ~3h · W: ██░░░░ 44% ~3d · M: ██████ 98% ~14d` |
| **Any (percent style)** | `R 2% ~3h · W 44% ~3d · M 98% ~14d` |

#### Legend

* `5h` / `R` : 5-Hour rolling window
* `W` : Weekly quota window
* `M` : Monthly quota window
* `~` : Countdown until the next quota reset (e.g. `~4h`, `~3d`)

---

### ✨ Highlights

* **Adaptive Fetching:** Refreshes on session start, model switch, and agent turn settlement with intelligent cooldowns.
* **Smart Scheduling:** Reset-aware wake timers that automatically refresh immediately when a usage bucket flips.
* **Shared Cache:** Persists validated data across multiple Pi sessions via `~/.pi/agent/subscription-usage-cache.json`, using asynchronous atomic writes so cache I/O does not block Pi.
* **Safe Rendering:** Malformed provider values are ignored and percentages are bounded to `0–100%` before they reach the status line.
* **Stale-Request Protection:** Overlapping refreshes are coalesced, and results from a replaced session/model are discarded.

#### Display Toggle

`/usage-toggle` cycles the status line through three modes: bar cells (`bars`) → bare percentages (`percent`) → hidden (`off`). Pass a mode to jump straight to it, e.g. `/usage-toggle percent`. While hidden, no status is shown and no provider requests are made; toggling back re-renders (or refetches) immediately. The choice persists across sessions in `~/.pi/agent/subscription-usage-prefs.json`.

---

### 2. `discord-presence` (`extensions/discord-presence.ts`)

Publishes a privacy-safe, adaptive Discord Desktop Rich Presence while Pi is running.

#### Single-Session Presence

```text
Details: Thinking · GPT-5.6
State:   spring2026 · 42k tok · ctx 38%
```

During tool execution:

```text
Details: Running tests · GPT-5.6
State:   spring2026 · 47k tok · ctx 41%
```

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

Configure how much metadata is visible in Discord via `/discord-privacy [strict|project|developer]` or `PI_DISCORD_PRIVACY`:

* `strict` (**Default**): Hides the project name completely for maximum privacy. Price is included by default when pricing is available.

  ```text
  Thinking · GPT-5.6
  42k tok · ctx 38% · $0.84
  ```

* `project`: Includes the privacy-safe project directory basename.

  ```text
  Thinking · GPT-5.6
  spring2026 · 42k tok · ctx 38% · $0.84
  ```

* `developer`: Explicit developer view including project basename, tokens, context %, and pricing.

  ```text
  Thinking · GPT-5.6
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

*(For backward compatibility, `/discord-status` is also supported as an alias.)*

#### ⚙️ Configuration & Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PI_DISCORD_CLIENT_ID` | `1541350417143955466` | Custom Discord Application Client ID snowflake. Custom IDs disable default assets unless explicitly configured. |
| `PI_DISCORD_PRIVACY` | `strict` | Privacy level: `strict`, `project`, or `developer`. |
| `PI_DISCORD_BUTTONS` | `on` | Set to `off` to disable the default static Discord profile buttons. |
| `PI_DISCORD_LARGE_IMAGE` | `pi` | Large Rich Presence asset key or image URL. Set to `off` to disable. |
| `PI_DISCORD_SMALL_IMAGES` | `on` | Action badge asset key (`thinking`, `reading`, `editing`, `searching`, `running`, `testing`, `browsing`, `idle`), custom asset key, or image URL. Set to `off` to disable. |
| `PI_DISCORD_SHOW_COST` | `on` | Set to `off` to hide price from public Discord presence. |

#### Setup & Diagnostics

The extension includes a public Discord application ID, so no environment variable is required. Start or reload Pi while Discord Desktop is running, then use `/discord-status` to check connection status and inspect per-session statistics (model, phase/action, token breakdown, pricing, context %, and duration). Custom settings can be changed on the fly using `/discord-privacy` and `/discord-toggle`, and are saved to `~/.pi/agent/discord-presence-prefs.json`.

Multiple Pi sessions share a registry at `~/.pi/agent/discord-presence-state.json`. One session publishes the aggregate activity while the others send heartbeats. If the publisher exits, another active session takes over; stale sessions are removed automatically. Usage totals include assistant/tool results plus compaction and branch-summary calls. Registry locks renew their lease during long operations, and only the newest pending Discord activity is published, keeping rapid tool/phase updates responsive without replaying stale states.

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
