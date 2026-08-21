# pi-extensions

Personal collection of custom extensions, utilities, and tools for the [Pi Coding Agent](https://pi.dev) by [@Th1nhNg0](https://github.com/Th1nhNg0).

---

## 📦 Extensions

### 1. `subscription-usage` (`extensions/subscription-usage.ts`)
Adds a live status footer line displaying subscription usage bars, usage percentages, and reset countdown timers for subscription-backed LLM providers.

#### Supported Providers:
- **Antigravity Pro**
  - Gemini & 3rd-party/Claude quotas (5h rolling & weekly buckets)
- **OpenAI Codex**
  - Plus/Team plan weekly primary window & reset countdown
- **OpenCode Go**
  - Rolling, Weekly, and Monthly limits
  - DeepSeek peak / off-peak indicator with reset timer

#### Example Display:
```text
antigravity : Antigravity Pro (Gemini)  5h: ░░░░░░  0% ↻4h  W: █████░  79% ↻4d
openai-codex: OpenAI Codex Plus         W: ███░░░  51% ↻3d
opencode-go : OpenCode Go (Peak ↻2h)    R: ░░░░░░   2% ↻3h  W: ██░░░░  44% ↻3d  M: ██████  98% ↻14d
```

#### Highlights:
- **Adaptive Fetching:** Refreshes on session start, model switch, and agent turn settlement with intelligent cooldowns.
- **Smart Scheduling:** Resets-aware wake timers that fetch immediately when a usage bucket flips.
- **Shared Cache:** Persists data across multiple sessions via `~/.pi/agent/subscription-usage-cache.json`.

---

## 🚀 Installation

Install directly into Pi globally:

```bash
pi install git:github.com/Th1nhNg0/pi-extensions
```

Or install for local development:

```bash
pi install ./path/to/pi-extensions
```

---

## 🔄 Updating

To update to the latest version at any time:

```bash
pi update --extensions
```

To reload extensions during an active Pi session, run:
```text
/reload
```

---

## 📄 License

[MIT](LICENSE) © [Thinh Ngo](https://github.com/Th1nhNg0)
