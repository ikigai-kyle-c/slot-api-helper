# 🎰 Slot API Helper (API Test Console)

**A dual-interface (Web UI + CLI) automated testing and debugging suite for RGS (Remote Game Server) Play Flows, Lobby Integrations, and Game Maintenance states.**

Welcome to the team! This tool simulates entire player lifecycles and administrative actions without needing a real game client. It handles JWT token negotiation, caching, automated payload generation, and JSON trace logging.

---

## 🚀 New Developer Quick Start

We built this repository to be as frictionless as possible. We use **Bun** as our JavaScript runtime and test runner because it is incredibly fast and requires zero complex configuration.

### 1. Prerequisites
* Install Bun (check the official Bun website for the install script)
* Ensure you have `jq` installed on your machine for the shell scripts (e.g., brew install jq or apt-get install jq).

### 2. Setup & Test
Clone the repository and run the lightning-fast setup and test commands. This will install dependencies, mock the API, and verify the entire system is healthy.

Run the following in your terminal:
```bash
bun install
bun test && bunx bats tests/
```

*If you see all green, you are ready to code!*

### 3. Start the Local Web Console
Run the server:
```bash
bun run src/ApiTestWeb/server.js
```

👉 Open **http://localhost:3000** in your browser.

---

## 📂 Project Architecture

To keep the root directory clean, all functional code lives inside the `src/` folder. Dependencies (node_modules) and configurations remain at the root.

```
slot-api-helper/
├── package.json           (Global dependencies: Bun, Supertest, BATS)
├── tests/                 (Comprehensive test suite)
│   ├── app.test.js        (Frontend UI DOM tests using happy-dom)
│   ├── server.test.js     (Backend API endpoint tests)
│   └── scripts.bats       (CLI Bash script regression tests)
└── src/
    ├── ApiTestWeb/            (Node.js server & Vanilla JS UI)
    ├── InternalMaintenanceApi/(CLI & configs for AM tokens & Maintenance Patching)
    ├── RGSBetFlow/            (CLI & configs for the Session -> Bet -> Action -> Finish loop)
    └── RGSLobby/              (CLI & configs for Session -> Lobby Token -> Refresh)
```

---

## 💻 How to Use the Web UI (src/ApiTestWeb)

The Web UI acts as an orchestrator for the API flows. 
* **Smart Forms:** Textareas automatically parse and format valid JSON when you click out of them (onblur).
* **State Persistence:** Switching tabs (Bet, Lobby, Maintenance) remembers your payloads, results, and trace logs.
* **Record Keeping:** Every flow execution generates a timestamped .json result and a .trace.json file. The UI retains and lists the last 10 executions for quick review.

---

## 🤖 The AI-Friendly CLI

The bash scripts located in src/*/ (bet-flow.sh, lobby-flow.sh, maintenance-flow.sh) have been engineered for CI/CD pipelines and **AI Agents**. They support POSIX-compliant flags and structured JSON outputs to avoid messy string parsing.

### Standard Arguments
* --domain : Target API URL (Loads from .env or defaults to localhost)
* --game-code : Target slot game code (Loads from .env or defaults to LGS-006)
* --json-out : Suppresses stdout logs and outputs a single strict JSON object (Defaults to false)

### Standardized Exit Codes
Agents and CI runners can rely on exit status codes to branch logic based on failures:
* 0: **Success** - Flow completed perfectly.
* 1: **Configuration Error** - Missing variables, missing .env, or missing dependencies (jq).
* 2: **Network/API Error** - HTTP 4xx/5xx errors, or JWT parsing failures.
* 3: **Maintenance Block** - The game is under maintenance (returns a specific RGS maintenance error).

**Example AI Integration Command:**
```bash
# An AI agent can safely run this and pipe to jq without fear of parsing human text
result=$(bash src/InternalMaintenanceApi/maintenance-flow.sh --domain [http://api.game.local](http://api.game.local) --game-code SLT-001 --json-out)
status=$(echo "$result" | jq -r .status)
```

---

## 🔐 Environment & Caching

Each flow directory contains its own .env file (copy from .env.example).
To prevent spamming token endpoints, the system utilizes local cache files (e.g., .token-cache.json, .am-token-cache.json).

**Cache Lifecycle:**
1. Script/Server checks if a cache exists and matches the current GAME_CODE and API_DOMAIN.
2. Parsers validate the JWT exp claim to ensure it hasn't expired.
3. If valid, the system reuses the cached accessToken and sessionId.
4. If expired, missing, or explicitly bypassed, it executes the token negotiation phase and writes a new cache file.

---

## 🧪 Testing Guidelines

Whenever you add a new feature, you must write a regression test. 

* **Node.js/UI Tests (bun test)**: We use supertest for API endpoints and @happy-dom/global-registrator to test vanilla JS DOM manipulations in under 10ms. Add these to tests/server.test.js or tests/app.test.js.
* **Bash Tests (bunx bats)**: We use BATS (Bash Automated Testing System) to mock curl commands. This tests the shell scripts' exit codes, JSON outputs, and parameter validations without hitting live APIs. Add these to tests/scripts.bats.