# Project Helios

Project Helios is a local-first, autonomous agentic software engineering platform. It plans work
hierarchically, inspects a real repository, executes through policy-gated tools, verifies results with
real commands, and reports only what it can prove. It runs on your machine and talks to the model
providers you configure (bring your own key, local models, or OpenAI-compatible endpoints).

## What it does

- **Agent runtime** — Understand → inspect → plan → execute → observe → evaluate → correct → verify →
  report. Failed tasks are diagnosed and replanned; runs are resumable and can be paused or cancelled.
- **Hierarchical planning** — Tasks, subtasks, dependencies, blockers, complexity, conditional and
  parallel scheduling, dynamic replanning, and recovery tasks after failures.
- **Persistent memory** — Working, episodic, semantic, procedural, and project layers. Automatic
  extraction from completed runs, hybrid keyword + vector retrieval, fingerprint dedupe,
  contradiction detection, supersession, consolidation, and full user inspection/edit/delete.
- **Repository intelligence** — File index, symbols, imports, dependency following, semantic-ish
  search, conventions, multi-file edits, patches, and diffs.
- **Tool orchestration** — Shell, filesystem, editor, git, package/build/test, browser, web, docs,
  SQLite, memory, and verification tools with schemas, risk levels, timeouts, audit records, and
  approval gates.
- **Verification engine** — Typecheck, lint, unit/integration tests, build, runtime checks, regression
  checks, and diff inspection. The runtime refuses to claim success without evidence.
- **Human control** — Pause, resume, stop, inspect, and approve. Destructive, external, and sensitive
  actions require explicit approval by default.
- **Checkpoints and rollback** — Git-backed checkpoints before risky work, with diff and rollback.
- **Multi-provider model layer** — OpenAI, Anthropic, Gemini, Ollama, and many OpenAI-compatible
  providers; routing per task kind; fallback; streaming; token and cost accounting.
- **Seven modes** — `ask`, `plan`, `code`, `autonomous`, `debug`, `review`, `research`.
- **Developer UI** — Workspace chat, execution dashboard, memory browser, code editor, live activity
  feed, and insights/metrics.

## Requirements

- Node.js **>= 22.5** (uses the built-in `node:sqlite` module)
- npm
- Git (for checkpoints, diffs, and rollback; optional but recommended)

## Quick start

```bash
npm install
npm run build

# Start the local API + web interface (default: http://127.0.0.1:4319)
npm run helios -- serve
```

Open <http://127.0.0.1:4319>, add a local repository as a project, configure a provider in
**Settings**, and start an objective from the **Workspace**.

The server can also be started directly:

```bash
npm start
```

### Configure a provider

Provider presets are created on first launch in `~/.helios/config.json`. Store a key encrypted at
rest with:

```bash
npm run helios -- secrets set openai sk-...
npm run helios -- secrets list
```

Keys can also come from provider environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`, …). Local providers that need no key — Ollama, LM Studio, vLLM, and any
OpenAI-compatible server — only need their `baseUrl` and model configured.

### CLI

```bash
npm run helios -- doctor
npm run helios -- project add /path/to/repo
npm run helios -- run "Fix the failing tests" --project /path/to/repo --mode code
npm run helios -- runs
npm run helios -- memory <projectId> "build command"
npm run helios -- approve <approvalId> approve
npm run helios -- insights
```

Run `npm run helios -- --help` for the full command list.

## Architecture

```
apps/
  web/                 React 19 + Vite 6 + CodeMirror developer interface
packages/
  core/                Runtime, planning, tools, policy, memory, context, providers, insights
    src/runtime/       Planner, task loop, approvals, verifier, checkpoints, event bus
    src/tools/         Tool registry + shell/fs/git/verify/search/web/browser/sqlite/memory tools
    src/memory/        Memory manager, hybrid retrieval, embeddings, working memory
    src/context/       Repository indexer, symbol/import extraction, context assembly
    src/providers/     OpenAI-compatible, Anthropic, Gemini, Ollama adapters + routing
    src/db/            node:sqlite schema, migrations, and store
  server/              Fastify 5 REST API, SSE + WebSocket streams, static UI serving
  cli/                 Command-line interface
```

Runtime data lives in `~/.helios` (override with `HELIOS_HOME`): SQLite database, configuration,
encrypted secrets, checkpoints, and logs.

## Security model

- Local subprocess execution with a policy gate; no container or remote execution is implied.
- Five risk classes — `read`, `write`, `destructive`, `network`, `external` — evaluated per mode.
- Defaults: reads and writes allowed; destructive, network, and external actions require approval.
  Read-only modes (`ask`, `plan`, `review`, `research`) deny workspace mutation.
- Command validation blocks privilege escalation, root/home recursive deletion, disk formatting,
  piping remote content into an interpreter, force-push, and other dangerous patterns.
- Path resolution prevents escaping the workspace, including through symlinks; sensitive credential
  files are guarded.
- Secrets are encrypted at rest (AES-256-GCM) and redacted from logs.
- Every tool call, approval decision, and run event is persisted in the audit trail.
- Project Helios does not silently change its safety policy or promote unverified procedures.

## Verification status

- TypeScript typecheck and the production web build pass.
- The full flow (planning, tool use, approval, verification, checkpoints, memory extraction,
  insights, UI) was exercised against a **scripted OpenAI-compatible test provider**, not a live
  commercial model. Provider adapters are implemented but were not exercised against paid APIs in
  this environment.
- The automated Vitest suite is not included in this snapshot. Treat the project as a working
  implementation that still needs its test suite and your own provider/security review before
  production use.

No functionality in the UI is hardcoded or simulated: every panel reads and writes real API data.

## License

No license has been declared for this repository yet.
