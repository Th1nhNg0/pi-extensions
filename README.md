# pi-extensions

Personal collection of custom extensions, utilities, and tools for the [Pi Coding Agent](https://pi.dev) by [@Th1nhNg0](https://github.com/Th1nhNg0).

---

## 📦 Extensions

### 1. `subscription-usage` (`extensions/subscription-usage.ts`)

Adds a live status footer line in Pi displaying subscription usage bars, percentages, and reset countdown timers for subscription-backed LLM providers.

#### Supported Providers

* **Antigravity Pro** (Gemini & 3rd-party/Claude quotas with 5h rolling & weekly buckets)
* **OpenAI Codex** (Plus/Team plan weekly primary window & reset countdown)
* **OpenCode Go** (Rolling, Weekly, and Monthly limits, plus DeepSeek peak/off-peak indicator)

---

### 🖥️ Status Bar Examples

| Provider | Live Footer Output |
| :--- | :--- |
| **Antigravity Pro (Gemini)** | `Antigravity Pro (Gemini)   5h: [□□□□□□]  0% ↻4h   W: [■■■■■□] 79% ↻4d` |
| **Antigravity Pro (Claude/GPT)** | `Antigravity Pro (Claude)   5h: [□□□□□□]  0% ↻4h   W: [■■■■□□] 61% ↻6d` |
| **OpenAI Codex** | `OpenAI Codex Plus          W: [■■■□□□] 51% ↻3d` |
| **OpenCode Go** | `OpenCode Go (Peak ↻2h)     R: [□□□□□□]  2% ↻3h   W: [■■□□□□] 44% ↻3d   M: [■■■■■■] 98% ↻14d` |

#### Legend

* `5h` / `R` : 5-Hour rolling window
* `W` : Weekly quota window
* `M` : Monthly quota window
* `↻` : Countdown until the next quota reset (e.g. `↻4h`, `↻3d`)

---

### ✨ Highlights

* **Adaptive Fetching:** Refreshes on session start, model switch, and agent turn settlement with intelligent cooldowns.
* **Smart Scheduling:** Reset-aware wake timers that automatically refresh immediately when a usage bucket flips.
* **Shared Cache:** Persists data across multiple Pi sessions via `~/.pi/agent/subscription-usage-cache.json`.

---

### 2. `discord-presence` (`extensions/discord-presence.ts`)

Publishes a privacy-safe Discord Desktop Rich Presence while Pi is running.

The activity aggregates all active Pi sessions:

```text
Details: 3 Pi sessions · 82k tok · $1.24
State: pi-extensions · openai-codex/gpt-5 · Thinking
```

It updates between `Thinking`, `Using tools`, and `Idle`, includes the earliest active session timer, tracks tokens/cost/context usage, and never sends prompts, paths, filenames, commands, or tool arguments. Providers without pricing show `cost n/a`. Discord must be running in the background; if it is unavailable, the extension logs one warning and retries without interrupting Pi.

#### Setup

The extension includes the public application ID `1541350417143955466`, so no environment variable is required. Start or reload Pi while Discord Desktop is running, then use `/discord-status` to check the connection.

To use your own Discord application instead, set `PI_DISCORD_CLIENT_ID` before starting Pi:

```powershell
$env:PI_DISCORD_CLIENT_ID = "123456789012345678"
```

On macOS/Linux:

```bash
export PI_DISCORD_CLIENT_ID="123456789012345678"
```

Multiple Pi sessions share a registry at `~/.pi/agent/discord-presence-state.json`. One session publishes the aggregate activity while the others send heartbeats. If the publisher exits, another active session takes over; stale sessions are removed automatically. Usage totals include assistant/tool results plus compaction and branch-summary calls. The registry contains only project/model/state/metrics metadata. `/discord-status` shows the per-session project, model, phase, tokens, cost, context, and duration.

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
