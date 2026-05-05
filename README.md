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

```bash
npm install
npm run build
npm link
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

Set `server.port` to choose the listening port. Set `server.basePath` to expose every router endpoint under a prefix, for example `/ollama-router`; then chat completions move to `/ollama-router/v1/chat/completions`, health to `/ollama-router/health`, and jobs to `/ollama-router/v1/jobs/{jobId}`.

To run HTTPS directly from the router, set `server.https.enabled: true` and provide PEM certificate and key paths:

```yaml
server:
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
curl http://127.0.0.1:11435/v1/router/models
curl http://127.0.0.1:11435/v1/router/gpu
```

## Async Jobs

When a selected model is busy or the router detects heavy load and `allowAsync=true`, the API returns:

```json
{
  "id": "job_01JABCDEF123",
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

Homebrew formula template:

```bash
brew install ExeconOne/tap/ollama-agent-router
```

Debian package:

```bash
npm run build
npm run package:deb
sudo apt install ./ollama-agent-router_0.1.0_amd64.deb
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

## Release Guide

1. Update `package.json`, `packaging/nfpm.yaml`, and the Homebrew formula version.
2. Run `npm run typecheck`, `npm test`, and `npm run build`.
3. Verify `npm pack --dry-run`.
4. Publish to npm.
5. Build `.deb` with `npm run package:deb`.
6. Replace the Homebrew formula URL and SHA256 with the npm tarball values.

## Safety Notes

VRAM accounting is conservative but not perfect. Ollama can split a model across CPU and GPU when VRAM is tight. Set `router.requireGpuOnly` or `gpu.requireGpuOnlyByDefault` to block loaded models whose `ollama ps` processor column indicates CPU/GPU split.

Large exclusive models should use `exclusive: true` and `maxConcurrent: 1`. Keep `vramSafetyReserveMb` high enough for context growth and system use. If you see CPU fallback, reduce concurrency, reduce context, or route heavy work to async jobs.

Async job state is intentionally in memory for v1. Restarting the router clears queued jobs, job history, and results.
