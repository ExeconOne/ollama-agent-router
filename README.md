# ollama-agent-router

`ollama-agent-router` is a local HTTP and CLI gateway for Ollama. It exposes an OpenAI-compatible chat completion endpoint and routes each request to the best configured local model based on task type, queue depth, loaded model state, GPU/VRAM headroom, priority, and sync/async policy.

It is designed for machines that run several Ollama models with different strengths, for example a small triage model, one or more code models, and a larger exclusive reasoning model.

## Architecture

Request flow:

1. `POST /v1/chat/completions` receives an OpenAI-style request, or `POST {server.basePath}/v1/chat/completions` when a base path is configured.
2. The task classifier chooses a task type using deterministic heuristics.
3. The router scores configured candidate models from `routes`.
4. GPU state, loaded Ollama models, busy exclusive models, and queue depth are applied.
5. The request is either run synchronously, accepted as an async job, or rejected.
6. Sync calls are proxied to Ollama `/v1/chat/completions`.
7. Async jobs are held in process memory and executed by per-model `p-queue` queues.

## Quick Start

Install with Homebrew on macOS or Linux:

```bash
brew install ExeconOne/tap/ollama-agent-router
ollama-agent-router configure
ollama-agent-router serve --config ollama-agent-router.yaml
```

Or install from the APT repository on Debian/Ubuntu:

```bash
curl -fsSL https://execonone.github.io/ollama-agent-router/apt/gpg.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/ollama-agent-router.gpg

echo "deb [signed-by=/usr/share/keyrings/ollama-agent-router.gpg] https://execonone.github.io/ollama-agent-router/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/ollama-agent-router.list

sudo apt-get update
sudo apt-get install ollama-agent-router
ollama-agent-router configure
ollama-agent-router serve --config ollama-agent-router.yaml
```

Then call:

```bash
curl -s http://127.0.0.1:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Write a TypeScript debounce function"}],
    "router": {"allowAsync": true}
  }'
```

## Ollama Setup

Install and start Ollama separately. Pull the models referenced by your config:

```bash
ollama pull qwen2.5-coder:7b
ollama pull deepseek-coder:6.7b
```

The router calls:

```text
POST {ollama.baseUrl}/v1/chat/completions
GET  {ollama.baseUrl}/api/tags
ollama ps
```

## GEX44 Example

`examples/gex44.yaml` is tuned for an RTX 4000 SFF Ada with 20 GB VRAM:

- `B-A-M-N/vibethinker:1.5b` for triage, simple chat, summarize, and classification.
- `qwen2.5-coder:7b` for code generation, fixes, tool use, and fallback agent work.
- `deepseek-coder:6.7b` for code review, generation, fixes, and second opinions.
- `gpt-oss:20b` for agentic reasoning, large context, planning, tool use, and complex debugging.

Start with:

```bash
ollama-agent-router serve --config examples/gex44.yaml
```

## Config Reference

Lookup order:

1. `--config path`
2. `./ollama-agent-router.yaml`
3. `~/.config/ollama-agent-router/config.yaml`
4. `/etc/ollama-agent-router/config.yaml`

Top-level sections:

- `server`: host, port, base path, HTTPS certificates, and JSON body limit.
- `ollama`: base URL, OpenAI-compatible path, native API path, keep-alive, timeout.
- `gpu`: provider, VRAM limits, GPU-only default, NVIDIA monitor command.
- `router`: default mode, heavy-load thresholds, classifier config.
- `jobs`: in-memory store, result TTL, retry count, cleanup interval.
- `models`: model specs including size, purpose, concurrency, exclusivity, tags.
- `routes`: task type to candidate model names.
- `queue`: global queue limits and default priority.

Task types:

```text
triage, simple_chat, summarize, code_generate, code_review, code_fix,
agentic_reasoning, large_context, tool_use, unknown
```

Server options:

```yaml
server:
  nodeId: local
  host: 127.0.0.1
  port: 11435
  basePath: /
  requestBodyLimit: 8mb
  https:
    enabled: false
    certPath:
    keyPath:
    caPath:
```

Set `server.nodeId` to a stable machine/runtime id when the router is used behind Kong. It is embedded in new async job ids so a gateway can route job status/result requests back to the right node-router. Allowed characters are letters, numbers, dots, and dashes. Set `server.port` to choose the listening port. Set `server.basePath` to expose every router endpoint under a prefix, for example `/ollama-router`; then chat completions move to `/ollama-router/v1/chat/completions`, health to `/ollama-router/health`, and jobs to `/ollama-router/v1/jobs/{jobId}`.

To run HTTPS directly from the router, set `server.https.enabled: true` and provide PEM certificate and key paths:

```yaml
server:
  nodeId: gex44-a
  host: 0.0.0.0
  port: 11435
  basePath: /ollama-router
  requestBodyLimit: 8mb
  https:
    enabled: true
    certPath: /etc/ollama-agent-router/tls.crt
    keyPath: /etc/ollama-agent-router/tls.key
    caPath:
```

## API Examples

Sync-preferred request:

```json
{
  "model": "auto",
  "messages": [{"role": "user", "content": "Review this TypeScript function"}],
  "router": {
    "mode": "sync",
    "taskType": "code_review",
    "priority": "high",
    "requireGpuOnly": true
  }
}
```

The router returns a normal chat completion payload with an added top-level `router` object:

```json
{
  "id": "chatcmpl_x",
  "object": "chat.completion",
  "model": "deepseek-coder:6.7b",
  "choices": [],
  "router": {
    "mode": "sync",
    "taskType": "code_review",
    "selectedModel": "deepseek-coder:6.7b",
    "fallbackModels": ["qwen2.5-coder:7b"],
    "queueTimeMs": 4,
    "executionTimeMs": 1200,
    "decisionReason": "Selected deepseek-coder:6.7b for code_review with score 250.0"
  }
}
```

Status endpoints:

```bash
curl http://127.0.0.1:11435/health
curl http://127.0.0.1:11435/metrics
curl http://127.0.0.1:11435/v1/router/status
curl http://127.0.0.1:11435/v1/router/capabilities
curl http://127.0.0.1:11435/v1/router/runtime
curl http://127.0.0.1:11435/v1/router/models
curl http://127.0.0.1:11435/v1/router/gpu
```

## Kong Runtime Agent API

When used with `kong-ollama-agent-router`, this process acts as a local runtime agent. Kong owns public request validation, classification, model selection, and response enrichment. The node-router supplies machine-local state and executes the model selected by Kong.

Kong-facing endpoints:

```bash
curl http://127.0.0.1:11435/v1/router/capabilities
curl http://127.0.0.1:11435/v1/router/runtime
curl -X POST http://127.0.0.1:11435/v1/router/execute
curl -X POST http://127.0.0.1:11435/v1/router/jobs
```

`GET /v1/router/capabilities` returns the stable routing config snapshot: `nodeId`, package version, router defaults, GPU policy, queue defaults, configured models, and routes. It does not call Ollama or GPU probes, so Kong can cache it for longer periods.

`GET /v1/router/runtime` returns volatile runtime state: Ollama reachability, loaded models, GPU snapshot, queue depth/running counts, and retained job counters. Kong should cache it only briefly.

`POST /v1/router/execute` runs a request on a model already selected by Kong. It does not classify or route again:

```json
{
  "selectedModel": "deepseek-coder:6.7b",
  "request": {
    "model": "deepseek-coder:6.7b",
    "messages": [{"role": "user", "content": "Review this TypeScript function"}],
    "stream": false
  },
  "routerDecision": {
    "taskType": "code_review",
    "score": 250,
    "reason": "Selected by Kong"
  }
}
```

The response is wrapped so Kong can add its own public `router` metadata:

```json
{
  "result": {},
  "nodeId": "gex44-a",
  "selectedModel": "deepseek-coder:6.7b",
  "queueTimeMs": 4,
  "executionTimeMs": 1200
}
```

`POST /v1/router/jobs` creates an async job on the selected model. New job ids include the node id, for example `job_gex44-a_01JABCDEF123`, so Kong can route later `GET /v1/jobs/{jobId}` and `GET /v1/jobs/{jobId}/result` calls to the owning node-router.

## Async Jobs

When a selected model is busy or the router detects heavy load and `allowAsync=true`, the API returns:

```json
{
  "id": "job_gex44-a_01JABCDEF123",
  "object": "router.job",
  "status": "queued",
  "message": "Heavy load. Job accepted for asynchronous processing."
}
```

Job endpoints:

```bash
curl http://127.0.0.1:11435/v1/jobs/{jobId}
curl http://127.0.0.1:11435/v1/jobs/{jobId}/result
curl -X DELETE http://127.0.0.1:11435/v1/jobs/{jobId}
```

## CLI Usage

```bash
ollama-agent-router serve --config examples/gex44.yaml
ollama-agent-router init
ollama-agent-router init --wizard
ollama-agent-router configure
ollama-agent-router configure --detect
ollama-agent-router configure --output ./ollama-agent-router.yaml
ollama-agent-router configure --non-interactive --answers answers.yaml --output config.yaml
ollama-agent-router validate-config --config examples/gex44.yaml
ollama-agent-router status
ollama-agent-router models
ollama-agent-router gpu
ollama-agent-router jobs
ollama-agent-router job {jobId}
ollama-agent-router result {jobId}
ollama-agent-router cancel {jobId}
```

The short alias `oar` is installed with the same commands. For a router mounted under a base path, pass it to client commands:

```bash
ollama-agent-router --url https://127.0.0.1:11435 --base-path /ollama-router status
```

## Configuration Wizard

`ollama-agent-router configure` is a detect-first YAML generator. It tries to detect the local machine and asks mainly for confirmation:

- Ollama binary path and API URL, including `OLLAMA_HOST`
- installed Ollama models from `ollama list`
- loaded model state from `ollama ps`
- Linux NVIDIA GPU/VRAM from `nvidia-smi`
- macOS Apple Silicon/unified-memory defaults
- CPU cores, system RAM, platform, and architecture

Useful modes:

```bash
ollama-agent-router configure --detect
ollama-agent-router configure --dry-run
ollama-agent-router configure --overwrite
ollama-agent-router configure --non-interactive --answers answers.yaml --output config.yaml
```

On Linux with a working NVIDIA stack, the wizard enables GPU monitoring and defaults GPU-only routing to true. On macOS, it does not enable NVIDIA monitoring and defaults GPU-only routing to false because Apple Silicon uses unified memory rather than dedicated NVIDIA VRAM.

When no suitable NVIDIA GPU is detected, the generated config is CPU-friendly: per-model concurrency is capped at `1`, global concurrency defaults to `1`, queue limits are smaller, `router.defaultMode` stays `auto`, and heavy load is triggered after a shallow queue so clients using `allowAsync: true` are moved to async jobs earlier.

Minimal non-interactive answers file:

```yaml
models:
  mode: manual
  items:
    - name: qwen2.5-coder:7b
      role: code
      sizeGb: 4.7
```

## Installation

npm:

```bash
npm install -g ollama-agent-router
ollama-agent-router init
```

Homebrew:

```bash
brew install ExeconOne/tap/ollama-agent-router
```

Debian package from a release asset:

```bash
sudo apt install ./ollama-agent-router_0.1.0_all.deb
```

APT repository from GitHub Pages:

```bash
curl -fsSL https://execonone.github.io/ollama-agent-router/apt/gpg.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/ollama-agent-router.gpg

echo "deb [signed-by=/usr/share/keyrings/ollama-agent-router.gpg] https://execonone.github.io/ollama-agent-router/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/ollama-agent-router.list

sudo apt-get update
sudo apt-get install ollama-agent-router
```

## Development

```bash
npm install
npm run dev -- --config examples/gex44.yaml
npm run build
npm run typecheck
npm test
```

The project uses TypeScript, ESM, Express, zod, pino, p-queue, nanoid, and Vitest.

Design notes:

- CLI configuration wizard HLD: `docs/cli-configurator-hld.md`
- Kong runtime agent contract plan: `docs/kong-runtime-contract-plan.md`

## Release Guide

Releases are automated through GitHub Actions when pushing a version tag.
Publishing to npm uses Trusted Publishing/OIDC, so no `NPM_TOKEN` secret is required.

Configure npm Trusted Publishing for the package:

- Provider: GitHub Actions
- Organization or user: `ExeconOne`
- Repository: `ollama-agent-router`
- Workflow filename: `release.yml`
- Environment name: leave blank

Required repository secrets:

- `TAP_GITHUB_TOKEN`: GitHub token with write access to `ExeconOne/homebrew-tap`.
- `APT_GPG_PRIVATE_KEY`: ASCII-armored private GPG key.
- `APT_GPG_PASSPHRASE`: passphrase for that key, if any.

GitHub Pages must be enabled with source set to GitHub Actions.
The APT repository is always signed; releases fail if `APT_GPG_PRIVATE_KEY` is not configured.
The release workflow runs npm on Node.js 24 because npm Trusted Publishing requires npm CLI 11.5.1+ and Node.js 22.14.0+.
The release workflow has its own verify job; npm, GitHub Release, APT, and Homebrew publishing only run after typecheck, tests, build, package dry-run, and Homebrew formula syntax checks pass.

Release flow:

```bash
npm version patch
git push origin main
git push origin v0.1.1
```

The release workflow will:

1. Run typecheck, tests, and build.
2. Publish the package to npm.
3. Prune dev dependencies and build the `.deb` package with nFPM.
4. Create a GitHub Release with npm tarball and `.deb` assets.
5. Publish a signed APT repository under GitHub Pages at `/apt`.
6. Update `Formula/ollama-agent-router.rb` in `ExeconOne/homebrew-tap`.

Local dry-run before tagging:

```bash
npm run typecheck
npm test
npm run build
npm publish --dry-run
```

## Safety Notes

VRAM accounting is conservative but not perfect. Ollama can split a model across CPU and GPU when VRAM is tight. Set `router.requireGpuOnly` or `gpu.requireGpuOnlyByDefault` to block loaded models whose `ollama ps` processor column indicates CPU/GPU split.

Large exclusive models should use `exclusive: true` and `maxConcurrent: 1`. Keep `vramSafetyReserveMb` high enough for context growth and system use. If you see CPU fallback, reduce concurrency, reduce context, or route heavy work to async jobs.

Async job state is intentionally in memory for v1. Restarting the router clears queued jobs, job history, and results.
