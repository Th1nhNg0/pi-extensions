# pi-extensions

Personal collection of custom extensions, utilities, and tools for the [Pi Coding Agent](https://pi.dev) by [@Th1nhNg0](https://github.com/Th1nhNg0).

---

## 📦 Extensions

### 1. `subscription-usage` (`extensions/subscription-usage.ts`)
Adds a live status footer line in Pi displaying subscription usage bars, percentages, and reset countdown timers for subscription-backed LLM providers.

#### Supported Providers:
* **Antigravity Pro** (Gemini & 3rd-party/Claude quotas with 5h rolling & weekly buckets)
* **OpenAI Codex** (Plus/Team plan weekly primary window & reset countdown)
* **OpenCode Go** (Rolling, Weekly, and Monthly limits, plus DeepSeek peak/off-peak indicator)

---

### 🖥️ Status Bar Examples

| Provider | Live Footer Output |
|:---|:---|
| **Antigravity Pro (Gemini)** | `Antigravity Pro (Gemini)   5h: ░░░░░░  0% ↻4h   W: █████░ 79% ↻4d` |
| **Antigravity Pro (Claude/GPT)** | `Antigravity Pro (Claude)   5h: ░░░░░░  0% ↻4h   W: ████░░ 61% ↻6d` |
| **OpenAI Codex** | `OpenAI Codex Plus          W: ███░░░ 51% ↻3d` |
| **OpenCode Go** | `OpenCode Go (Peak ↻2h)     R: ░░░░░░  2% ↻3h   W: ██░░░░ 44% ↻3d   M: ██████ 98% ↻14d` |

#### Legend:
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
