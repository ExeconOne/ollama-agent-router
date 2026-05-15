# ollama-agent-router

Ollama Agent Router is a local LLM router for Ollama. It provides an OpenAI-compatible API gateway that routes agent and chat requests to the best local Ollama model based on task type, GPU/VRAM headroom, queue depth, loaded model state, and sync/async policy.

It is designed for machines that run several Ollama models with different strengths, for example a small triage model, one or more code models, and a larger exclusive reasoning model.

## Why use Ollama Agent Router?

Use `ollama-agent-router` when you need:

- an Ollama router for multiple local models
- an Ollama agent router for coding agents and autonomous workflows
- an OpenAI-compatible local LLM router
- GPU-aware routing, queues, async jobs, and model selection

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

`examples/gex44-secured.yaml` is the same hardware profile with the standalone plane locked down: API key required, anonymous access rejected, per-key rate limits, and the admin plane enabled on localhost. Use it as a starting point when the router is exposed beyond a single user or process.

## Routing Algorithm

### Candidate selection

For every request the router builds a candidate list from three sources, merged in order:

1. `router.preferredModels` from the request — added first, regardless of `routes`.
2. `routes[taskType]` — the ordered list for the classified task type.
3. Any model whose `purpose` or `tags` array contains the task type — acts as a catch-all fallback.

Models listed in `router.forbiddenModels` are dropped from the candidate list entirely.

### Blocking checks

Before scoring, each candidate is checked for hard blocks:

- **`gpu_only`** — `requireGpuOnly` is set (globally or per-request) and the model is not fully on GPU, has a CPU/GPU split in `ollama ps`, or there is not enough free VRAM to load it.
- **`busy`** — the model has `exclusive: true` and is already running, or `allowWhenBusy: false` and has reached `maxConcurrent`.

Blocked models are excluded from sync selection but can still be picked for async jobs.

### Scoring

Every non-blocked candidate receives a numeric score. Higher score wins. Starting value: **100**.

| Component | Delta | Notes |
|---|---|---|
| Route position | `+50` for index 0, `−8` per step | First entry in `routes[taskType]` gets the full bonus |
| `model.priority` | `+priority` | Set per model, 1–100 |
| `purpose` match | `+25` | Model's `purpose` array contains the task type |
| `preferredModels` | `+80` for index 0, `−10` per step | Request-level override |
| Already loaded in Ollama | **`+20`** | Model appears in `ollama ps` output |
| Heavy complexity + `costClass: high` | `+20` | Classifier returned `heavy`; rewards large models |
| Light complexity + `costClass: low` | `+15` | Classifier returned `light`; rewards small models |
| Free VRAM headroom | `+0..+25` | Scales with `(freeMb − requiredMb) / 512`, capped at 25 |
| Insufficient VRAM | **`−60`** | `model.sizeGb × 1024 + vramSafetyReserveMb > freeMb` |
| Queue depth | `−18 × queueDepth` | Per-model queue length |
| Running count | `−25 × running` | Per-model active executions |
| Exclusive + running | `−80 × running` additional | `exclusive: true` models penalised heavily while in use |

The candidate with the highest score is selected. The others appear in `fallbackModels` in the response.

### Model config fields that affect routing

```yaml
models:
  - name: gpt-oss:20b
    sizeGb: 14.0          # used for VRAM headroom calculation
    purpose: [agentic_reasoning, large_context, planning, tool_use, complex_debugging]
                          # +25 score when task type matches; also adds model to the candidate list
    priority: 95          # added directly to score; use to rank models of similar capability
    maxConcurrent: 1      # hard cap on parallel executions
    costClass: high       # low | medium | high — matched against request complexity for bonus/penalty
    exclusive: true       # if running, gets −80 extra penalty per execution; only one at a time
    allowWhenBusy: false  # if false and maxConcurrent reached → blocked entirely
```

**`purpose`** — declares what the model can do. Each entry that matches the request's task type adds `+25` to the score and also makes the model a candidate even when it is not listed in `routes[taskType]`. Use it for every task type the model handles well, including secondary ones (e.g. add `agentic_reasoning` to a coder model that works as a capable fallback).

**`costClass`** — signals the relative weight of the model:
- `high`: gets `+20` when the classifier decides the request is complex (`heavy`). Intended for large reasoning models.
- `low`: gets `+15` when the request is simple (`light`). Intended for small triage/chat models.
- `medium`: no complexity bonus in either direction.

**`exclusive`** — intended for large models that cannot safely share GPU memory with another concurrent execution. While one request is running, the model accumulates `−80` per running job on top of the standard `−25`, making it effectively unselectable for sync requests until free.

### `routes` config and its relation to scoring

```yaml
routes:
  agentic_reasoning: [gpt-oss:20b, qwen2.5-coder:7b]
```

Order matters: `gpt-oss:20b` at index 0 gets `+50`, `qwen2.5-coder:7b` at index 1 gets `+42`. Each additional position costs `−8`.

A model does not need to be in `routes` to be selected — if it declares the task type in `purpose` or `tags` it will still enter the candidate list (with a route-position score of 0).

### Sync vs async decision

After scoring, the router checks whether to run synchronously or push to the async queue:

1. If `router.mode: async` — always async.
2. If heavy load is detected (total queue depth ≥ `router.heavyLoadQueueDepth` **or** free VRAM < `router.heavyLoadGpuFreeMbThreshold`) and `allowAsync: true` — async.
3. If the top-scored model is busy and `allowAsync: true` — async on that model.
4. Otherwise — sync on the top-scored model.

`allowAsync` defaults to `true`. Set `"router": {"mode": "sync"}` in the request to force synchronous execution regardless of load.

### Forcing a specific model

`preferredModels` adds `+80` to the first entry, making it win unless blocked by VRAM or busy constraints. `forbiddenModels` removes models from the candidate list entirely — useful when testing a specific model in isolation.

### Request examples

**Explicit task type — let the router pick the best model for the task:**

```bash
curl -s http://127.0.0.1:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <api-key>' \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Plan a multi-service refactor"}],
    "router": {
      "taskType": "agentic_reasoning"
    }
  }'
```

**Explicit task type with async fallback on heavy load:**

```bash
curl -s http://127.0.0.1:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <api-key>' \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Plan a multi-service refactor"}],
    "router": {
      "taskType": "agentic_reasoning",
      "allowAsync": true
    }
  }'
```

Returns `202` with a job id when load is high; `200` with the result when run synchronously.

**Force a specific model, block all others:**

```bash
curl -s http://127.0.0.1:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <api-key>' \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Review this PR diff"}],
    "router": {
      "taskType": "code_review",
      "preferredModels": ["gpt-oss:20b"],
      "forbiddenModels": ["qwen2.5-coder:7b", "deepseek-coder:6.7b"]
    }
  }'
```

**Force sync, no async fallback even under load:**

```bash
curl -s http://127.0.0.1:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <api-key>' \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Fix the off-by-one error"}],
    "router": {
      "taskType": "code_fix",
      "mode": "sync",
      "allowAsync": false
    }
  }'
```

**High priority request — jumps ahead in the queue:**

```bash
curl -s http://127.0.0.1:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <api-key>' \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Summarize this log"}],
    "router": {
      "taskType": "summarize",
      "priority": "high"
    }
  }'
```

**GPU-only — reject if model would run on CPU or with a CPU/GPU split:**

```bash
curl -s http://127.0.0.1:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <api-key>' \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Generate a REST API scaffold"}],
    "router": {
      "taskType": "code_generate",
      "requireGpuOnly": true
    }
  }'
```

Returns `503` if no GPU-only candidate is available.

**Check what the router decided** — every `200` response includes a `router` object:

```json
{
  "router": {
    "mode": "sync",
    "taskType": "agentic_reasoning",
    "selectedModel": "gpt-oss:20b",
    "fallbackModels": ["gpt-oss:20b", "qwen2.5-coder:7b"],
    "queueTimeMs": 3,
    "executionTimeMs": 8420,
    "decisionReason": "Selected gpt-oss:20b for agentic_reasoning with score 290.0"
  }
}
```

`decisionReason` includes the winning score, which helps diagnose unexpected model selection — compare it against the scoring table above to see which component tipped the balance.

## Config Reference

Lookup order:

1. `--config path`
2. `./ollama-agent-router.yaml`
3. `~/.config/ollama-agent-router/config.yaml`
4. `/etc/ollama-agent-router/config.yaml`

Top-level sections:

- `server`: host, port, base path, HTTPS certificates, and JSON body limit.
- `access`: optional access control for standalone, runtime-agent, and admin planes.
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

## Access Planes

The router can expose three separate access planes:

- **Standalone plane**: the full local OpenAI-compatible router API, including `POST /v1/chat/completions` and job endpoints.
- **Runtime agent plane**: machine-local endpoints used by Kong or another gateway, including `/v1/router/*` and selected-model execution.
- **Admin plane**: access-management endpoints under `/v1/admin/access/*`.

Access control is backward-compatible. If `access` is not configured, the standalone and runtime-agent planes stay enabled without API key requirements, matching earlier releases. The admin plane is disabled by default.

API keys are sent with:

```text
Authorization: Bearer <api-key>
```

`x-api-key` is also accepted for clients that cannot set bearer tokens.

Create SHA-256 key hashes before putting keys in config:

```bash
node -e "const crypto=require('crypto'); console.log('sha256:'+crypto.createHash('sha256').update(process.argv[1]).digest('hex'))" 'secret-value'
```

Example access configuration:

```yaml
access:
  managedConfigPath: ./ollama-agent-router.access.yaml
  bootstrapIfMissing: true

  admin:
    enabled: true
    allowedIps: [127.0.0.1, "::1", 10.0.0.0/8]
    trustedProxy: false
    apiKeyHashes:
      - sha256:replace-with-admin-key-hash
    clientCert:
      required: false
      allowedFingerprints: []
      allowedSubjects: []
    auditLog: true

  managed:
    version: 1
    planes:
      standalone:
        enabled: true
        auth:
          requireApiKey: true
          anonymous: reject
        defaultLimit:
          requests: 60
          windowSeconds: 60
      runtimeAgent:
        enabled: true
        auth:
          requireApiKey: true
          anonymous: reject
        defaultLimit:
          requests: 600
          windowSeconds: 60
    apiKeys:
      - id: local-client
        name: Local standalone client
        keyHash: sha256:replace-with-client-key-hash
        enabled: true
        scopes: [standalone]
        limits:
          standalone:
            requests: 120
            windowSeconds: 60
      - id: kong-runtime
        name: Kong runtime caller
        keyHash: sha256:replace-with-kong-key-hash
        enabled: true
        scopes: [runtimeAgent]
        limits:
          runtimeAgent:
            requests: 2000
            windowSeconds: 60
```

`access.managed` is the initial access policy. When `access.managedConfigPath` is set, the router loads that file at startup. If the file is missing and `bootstrapIfMissing: true`, it writes the initial policy to that path. Admin API changes are then written atomically to this managed YAML file and survive restarts.

The admin plane security settings are boot-only. They are intentionally not managed through the admin API:

- `access.admin.allowedIps`
- `access.admin.trustedProxy`
- `access.admin.apiKeyHashes`
- `access.admin.clientCert`

This prevents the admin API from changing the rules that protect itself. When `access.admin.enabled: true`, `access.managedConfigPath` and at least one admin API key hash are required.

Admin API:

**Read the current managed access config**

```bash
curl http://127.0.0.1:11435/v1/admin/access/config \
  -H 'authorization: Bearer admin-secret'
```

**Replace the entire managed access config** (planes + all keys at once)

```bash
curl -X PUT http://127.0.0.1:11435/v1/admin/access/config \
  -H 'authorization: Bearer admin-secret' \
  -H 'content-type: application/json' \
  -d '{
    "expectedVersion": 1,
    "config": {
      "planes": {
        "standalone": {
          "enabled": true,
          "auth": {"requireApiKey": true, "anonymous": "reject"},
          "defaultLimit": {"requests": 60, "windowSeconds": 60}
        },
        "runtimeAgent": {
          "enabled": true,
          "auth": {"requireApiKey": true, "anonymous": "reject"},
          "defaultLimit": {"requests": 600, "windowSeconds": 60}
        }
      },
      "apiKeys": []
    }
  }'
```

`expectedVersion` enables optimistic concurrency. If present and the value does not match the active managed config version, the router returns `409`.

**Add an API key**

Generate a key and its SHA-256 hash first:

```bash
node -e "
const c = require('crypto'), k = 'onr-' + c.randomBytes(20).toString('hex');
console.log('key: ', k);
console.log('hash: sha256:' + c.createHash('sha256').update(k).digest('hex'));
"
```

Then add the key:

```bash
curl -X POST http://127.0.0.1:11435/v1/admin/access/keys \
  -H 'authorization: Bearer admin-secret' \
  -H 'content-type: application/json' \
  -d '{
    "id": "user-alice",
    "name": "Alice",
    "keyHash": "sha256:<hash>",
    "scopes": ["standalone"],
    "limits": {
      "standalone": {"requests": 100, "windowSeconds": 60}
    }
  }'
```

Returns `201` with the created key entry. Returns `409` if the `id` is already in use.

`scopes` controls which planes accept the key. Valid values are `standalone`, `runtimeAgent`, or both. `limits` is optional; when omitted, the plane's `defaultLimit` applies.

**Revoke an API key**

```bash
curl -X DELETE http://127.0.0.1:11435/v1/admin/access/keys/user-alice \
  -H 'authorization: Bearer admin-secret'
```

Returns `200 { "revoked": { ... } }` with the removed key entry. Returns `404` if the id is not found. The change takes effect immediately without a restart.

All admin operations are written atomically to `access.managedConfigPath` and appended to the audit log when `auditLog: true`.

For admin client certificate checks, enable HTTPS, configure `server.https.caPath`, and set:

```yaml
access:
  admin:
    clientCert:
      required: true
```

The HTTPS server requests a client certificate and the admin middleware verifies that it is trusted. Optional fingerprint and subject allowlists can narrow trust further.

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

When used with [`kong-ollama-agent-router`](https://github.com/ExeconOne/kong-ollama-agent-router), this process acts as a local runtime agent. Kong owns public request validation, classification, model selection, and response enrichment. The node-router supplies machine-local state and executes the model selected by Kong.

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
