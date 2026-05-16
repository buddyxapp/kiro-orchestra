# 🎼 Kiro Orchestra

Local multi-agent orchestration UI — a Slack-like interface to command multiple kiro-cli workers in parallel.

You type a message, a master kiro-cli agent dispatches tasks to workers, and you see all conversations in real-time. Each agent has its own persistent wiki for long-term memory.

## Quick Start (2 minutes)

**Prerequisites:**
- [Node.js](https://nodejs.org/) 18+
- [kiro-cli](https://kiro.dev) installed and authenticated (`kiro-cli` in PATH)

```bash
git clone https://github.com/YOUR_ORG/kiro-orchestra.git
cd kiro-orchestra
npm install
npm start
```

Open `http://localhost:3000` in your browser.

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│  Browser (localhost:3000)                                 │
│  ┌──────────┬──────────────────────────────────────────┐ │
│  │ #all     │  user: 幫我處理今天的 email               │ │
│  │ 指揮官   │  指揮官: 分派中...                        │ │
│  │ Worker 1 │  Worker 1: 找到 3 封需處理的信...         │ │
│  │ Worker 2 │  Worker 2: SFDC 有 2 個 OPP 需更新...    │ │
│  └──────────┴──────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
        ↕ WebSocket
┌──────────────────────────────────────────────────────────┐
│  Node.js Server                                          │
│  ├─ Orchestrator (event-driven inbox + wiki)             │
│  ├─ Master: kiro-cli acp (指揮官)                        │
│  ├─ Worker 1: kiro-cli acp                               │
│  ├─ Worker 2: kiro-cli acp                               │
│  └─ ...up to 5 agents                                    │
└──────────────────────────────────────────────────────────┘
```

## Features

- **Parallel execution** — Workers run tasks simultaneously
- **Event-driven master** — Master stays responsive while workers are busy; processes your new messages immediately
- **@mention routing** — `@Worker 1 do something` sends directly to that agent
- **Per-agent wiki** — Each agent has a `wikis/<id>/` directory for persistent knowledge (LLM Wiki pattern)
- **Human-in-the-loop** — Master can generate HTML decision panels for you to choose actions
- **Cancel anytime** — Type `stop` or click ⏸ to cancel individual agents or everything
- **Browser resume** — Refresh the page and conversation history is preserved (server-side buffer)
- **Zero external dependencies** — Runs entirely on localhost, no API keys needed beyond kiro-cli auth

## Usage

### Basic
Just type a message — it goes to the master (指揮官) who decides what to do:
```
幫我處理今天的 email 和檢查 SFDC opportunity
```

### @mention specific agent
```
@Worker 1 從 1 數到 10
@指揮官 現在進度如何？
@all 大家好
```

### Interrupt
```
stop
中斷
```
Or click the ⏸ button next to a working agent in the sidebar.

### Settings
Click ⚙️ to configure agent names and personas (system prompts). Changes take effect on next agent start.

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Web server port |
| `KIRO_CMD` | `kiro-cli` | Path to kiro-cli |
| `KIRO_ARGS` | `acp --trust-all-tools` | kiro-cli arguments |
| `WORKSPACE` | Current directory | Base working directory |

## Architecture

### Event-Driven Orchestration
```
User message → inbox (timestamped)
                 ↓ (1.5s debounce)
            Master wakes, reads all new events
                 ↓
            Responds + DISPATCH worker-id: task
                 ↓
            Workers execute in parallel
                 ↓
            Results → wiki (if long) + summary → inbox
                 ↓
            Master wakes again... until DONE
```

### LLM Wiki (per agent)
Each agent has a `wikis/<id>/` directory. Long worker reports are saved as .md files. Master only sees summaries in context, reads full files when needed. Knowledge compounds over time.

### Safety
- Max 10 master rounds per minute (auto-pause if exceeded)
- Max 6 orchestration rounds per task
- `stop` / `中斷` immediately cancels everything
- Per-agent ⏸ cancel button

## Tech Stack

- **Backend**: Node.js + TypeScript + [ws](https://github.com/websockets/ws)
- **Frontend**: Single HTML file, vanilla JS, no build step
- **AI**: kiro-cli via ACP protocol (JSON-RPC over stdin/stdout)
- **Based on**: [OpenABWindows](https://github.com/buddyxapp/OpenABWindows) ACP modules

## MCP Tools

Every agent is a full kiro-cli instance with access to all your configured MCP servers (Salesforce, Outlook, AWS, etc.). Configure MCP in `~/.kiro/settings/mcp.json` as usual.

## License

MIT
