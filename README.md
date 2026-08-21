# Pi Extensions

A collection of custom extensions for the [Pi Coding Agent](https://pi.dev).

---

## Extensions Included

### 1. `subscription-usage` (`extensions/subscription-usage.ts`)
Displays real-time subscription usage bars, usage percentages, and reset countdowns in the status line/footer for subscription-backed providers:

- **Antigravity Pro** (Gemini & 3rd-party/Claude quotas, 5h & weekly buckets)
- **OpenAI Codex** (Plus/Team weekly primary window and reset countdown)
- **OpenCode Go** (Rolling, Weekly, and Monthly limits, plus DeepSeek peak/off-peak indicators)

#### Features
- Live status bar line showing progress cells (e.g. `5h: ░░░░░░ 0% ↻4h  W: ████░░ 61% ↻6d`)
- Adaptive background caching (`~/.pi/agent/subscription-usage-cache.json`)
- Smart reset-aware wake timers and exponential backoff on network failures

---

## Installation & Usage

### Option 1: Install as a Pi package
```bash
pi install ./pi-extensions
```
Or if published to a git remote:
```bash
pi install git:github.com/<your-username>/pi-extensions
```

### Option 2: Load directly in `settings.json`
Add the path to your global `~/.pi/agent/settings.json`:
```json
{
  "extensions": [
    "C:/Users/weepingangel89/Desktop/pi-extensions/extensions/subscription-usage.ts"
  ]
}
```
