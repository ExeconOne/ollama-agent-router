# HLD: CLI Configuration Wizard

## 1. Goal

Add an interactive CLI configuration wizard for `ollama-agent-router` that helps a user produce a ready-to-run YAML config without hand-writing every field.

The wizard must detect machine-specific settings first, especially Ollama location, GPU/VRAM details, available local models, and basic machine capacity. It should ask the user only to confirm, correct, or fill in values that cannot be detected confidently. The output is a complete `ollama-agent-router.yaml` compatible with the normal `serve --config` command.

No runtime behavior should depend on the wizard. The wizard is only a config authoring tool.

## 2. Proposed Commands

Primary command:

```bash
ollama-agent-router configure
```

Aliases:

```bash
ollama-agent-router init --wizard
oar configure
```

Useful options:

```bash
ollama-agent-router configure --output ./ollama-agent-router.yaml
ollama-agent-router configure --preset gex44
ollama-agent-router configure --non-interactive --answers answers.yaml
ollama-agent-router configure --detect
ollama-agent-router configure --dry-run
ollama-agent-router configure --overwrite
```

`init` remains a simple starter-config command. `configure` is the guided multi-step wizard.

## 3. UX Principles

The wizard should:

1. Auto-detect as much as possible before asking any questions.
2. Ask a small number of high-signal confirmation questions.
3. Prefer confirmation prompts over blank manual-entry prompts.
4. Show detected values with confidence and source before accepting them.
5. Make manual entry available as a fallback for every detected value.
6. Prefer conservative defaults for VRAM and concurrency.
7. Explain risky choices briefly in terminal copy.
8. Never overwrite an existing config unless `--overwrite` is passed or the user explicitly confirms.
9. Generate a complete YAML file, not a partial patch.
10. Run config validation before writing.

## 4. High-Level Flow

```text
Start
  |
  v
Choose output path
  |
  v
Run detection pipeline
  |
  v
Show detection summary
  |
  v
Ask for confirmation/corrections
  |
  v
Ask only unresolved required questions
  |
  v
Generate model roles and routes from detected models
  |
  v
Ask for policy overrides
  |
  v
Generate candidate config
  |
  v
Validate config
  |
  v
Preview summary
  |
  v
Write YAML
```

## 5. Step Details

### 5.1. Output Path

Ask:

- Where should the config be written?

Default:

```text
./ollama-agent-router.yaml
```

If the file exists:

- Ask for confirmation before overwrite.
- Offer alternate path.
- Respect `--overwrite` in automation.

### 5.2. Detection Pipeline

Detection should be best-effort and non-fatal.

Commands:

```bash
ollama --version
ollama list
ollama ps
nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits
```

Additional detection sources:

```text
PATH lookup for ollama
PATH lookup for nvidia-smi
OLLAMA_HOST environment variable
process.platform and process.arch
os.cpus()
os.totalmem()
```

The detection pipeline must support both macOS and Linux. Platform-specific command failures are expected and must not abort the wizard.

Detected values:

- Ollama binary path.
- Ollama availability.
- Ollama base URL from `OLLAMA_HOST`, if present.
- Ollama default base URL reachability at `http://127.0.0.1:11434`.
- Ollama model names from `ollama list`.
- Currently loaded models from `ollama ps`.
- GPU provider.
- GPU name.
- Total VRAM.
- Used/free VRAM.
- GPU utilization.
- `nvidia-smi` path if available.
- OS platform and architecture.
- CPU core count.
- System RAM.

If detection fails, the wizard falls back to manual entry.

Detection result shape:

```ts
interface DetectionResult<T> {
  value?: T;
  source: 'command' | 'env' | 'default' | 'manual' | 'not_found';
  confidence: 'high' | 'medium' | 'low';
  message?: string;
}
```

The wizard should keep raw detection outputs available for debug logging, but the default user-facing view should be concise.

### 5.3. Platform Support: macOS and Linux

The wizard must behave well on both macOS and Linux.

Supported platforms:

```text
darwin arm64
darwin x64
linux x64
linux arm64
```

Platform detection:

```ts
const platform = process.platform; // darwin, linux
const arch = process.arch;         // arm64, x64
```

The wizard should use platform-specific probes only after detecting the platform. Missing commands should be treated as low-confidence detection results, not as hard failures.

#### macOS Detection

Likely Ollama binary locations:

```text
/usr/local/bin/ollama
/opt/homebrew/bin/ollama
/Applications/Ollama.app/Contents/Resources/ollama
PATH lookup result
```

Likely Ollama service/runtime behavior:

- Ollama may be running as a desktop app.
- Default API URL is still usually `http://127.0.0.1:11434`.
- `OLLAMA_HOST` may override the API URL.

Useful macOS commands:

```bash
which ollama
sysctl -n hw.memsize
sysctl -n hw.ncpu
system_profiler SPDisplaysDataType
system_profiler SPHardwareDataType
```

Apple Silicon GPU notes:

- `nvidia-smi` is normally unavailable on macOS.
- Apple Silicon uses unified memory, not dedicated VRAM.
- For Apple Silicon, set `gpu.provider: none` unless a future provider is added.
- The wizard may still record a friendly GPU/machine note in its summary, but generated config should not pretend dedicated NVIDIA VRAM exists.
- `requireGpuOnlyByDefault` should default to `false` on macOS unless the user explicitly enables it.

macOS default recommendations:

```yaml
gpu:
  provider: none
  name: Apple Silicon / macOS GPU
  vramTotalMb: 0
  vramSafetyReserveMb: 1024
  maxGpuUtilizationPct: 95
  requireGpuOnlyByDefault: false
  monitor:
    enabled: false
    intervalMs: 5000
    nvidiaSmiPath: nvidia-smi
```

The wizard should explain that macOS memory pressure is governed by unified system memory and Ollama behavior, so CPU/GPU split detection via `ollama ps` processor text is less reliable than on NVIDIA Linux hosts.

#### Linux Detection

Likely Ollama binary locations:

```text
/usr/bin/ollama
/usr/local/bin/ollama
/snap/bin/ollama
PATH lookup result
```

Likely Ollama service/runtime behavior:

- Ollama may be running under systemd.
- Default API URL is usually `http://127.0.0.1:11434`.
- `OLLAMA_HOST` may override the API URL.

Useful Linux commands:

```bash
which ollama
systemctl is-active ollama
nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits
cat /proc/meminfo
nproc
lscpu
```

Linux NVIDIA defaults:

- If `nvidia-smi` works, set `gpu.provider: nvidia`.
- Enable GPU monitor by default.
- Set `requireGpuOnlyByDefault: true` by default for NVIDIA hosts.
- Use detected VRAM to derive `vramSafetyReserveMb`.

Linux without NVIDIA:

- Set `gpu.provider: none`.
- Disable GPU monitor.
- Set `requireGpuOnlyByDefault: false`.
- Still configure models and queues from Ollama model inventory.

#### Cross-Platform Path and Process Rules

The wizard must not assume GNU utilities on macOS or BSD utilities on Linux. Prefer Node APIs where possible:

- Use `os.totalmem()` instead of parsing memory commands when sufficient.
- Use `os.cpus().length` instead of `nproc` when sufficient.
- Use PATH lookup implemented in Node before shelling out.
- Run commands with `execFile`, not shell interpolation.
- Keep command runner injectable for tests.

Do not require elevated privileges for detection. The wizard should not use `sudo`.

#### Platform-Specific Output Summary

The summary should include platform-specific caveats:

macOS example:

```text
Platform: macOS arm64
GPU: Apple Silicon unified memory detected. Dedicated VRAM monitoring is disabled.
GPU-only routing default: false
```

Linux NVIDIA example:

```text
Platform: linux x64
GPU: NVIDIA RTX 4000 SFF Ada, 20480 MB VRAM
GPU monitor: enabled through /usr/bin/nvidia-smi
GPU-only routing default: true
```

Linux no-GPU example:

```text
Platform: linux x64
GPU: no NVIDIA GPU detected
GPU monitor: disabled
GPU-only routing default: false
```

### 5.4. Detection Summary and Confirmation

Before asking detailed questions, show a summary:

```text
Detected environment

Ollama:
  binary: /usr/local/bin/ollama
  base URL: http://127.0.0.1:11434
  models: 4 found

GPU:
  provider: nvidia
  name: RTX 4000 SFF Ada
  VRAM: 20480 MB total, 18720 MB free
  nvidia-smi: /usr/bin/nvidia-smi

Machine:
  OS: linux x64
  CPU cores: 16
  RAM: 65536 MB
```

Then ask:

```text
Use these detected values? [Y/n]
```

If the user accepts, the wizard should skip most manual prompts and proceed to model role/routing confirmation.

If the user rejects or edits, offer targeted correction prompts:

- Correct Ollama path/base URL.
- Correct GPU provider/name/VRAM.
- Correct detected model list.
- Correct server bind/port/base path.

The wizard should not force the user through every field when detection is successful.

### 5.5. Server/API Exposure

Detect:

- Suggested host defaults to `127.0.0.1`.
- Suggested port defaults to `11435`.
- Suggested base path defaults to `/`.
- Existing config file may be read only to suggest its current server values if the user is editing or overwriting.

Ask only for confirmation:

```text
Expose router at http://127.0.0.1:11435/? [Y/n]
```

If rejected, ask:

- Host to bind.
- Port.
- Base API path.
- Enable HTTPS?
- Certificate path.
- Key path.
- Optional CA path.
- Request body limit.

Recommended defaults:

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

Guidance:

- Use `127.0.0.1` for local-only use.
- Use `0.0.0.0` only when the user intends to expose the router on a LAN/server.
- Use a reverse proxy for public exposure unless direct HTTPS is explicitly wanted.

Validation:

- Port must be `1..65535`.
- Base path must begin with `/` after normalization.
- HTTPS requires both cert and key paths.

### 5.6. Ollama Connectivity

Detect in this order:

1. `OLLAMA_HOST`.
2. Reachable `http://127.0.0.1:11434`.
3. Reachable `http://localhost:11434`.
4. Existing config value if overwriting/editing.
5. Manual entry.

Also detect the `ollama` binary path using PATH lookup.

On macOS, check both Homebrew paths and the Ollama desktop app path. On Linux, check common system install paths and PATH lookup.

Ask only for confirmation when detection succeeds:

```text
Use Ollama at http://127.0.0.1:11434? [Y/n]
```

If detection fails or the user rejects, ask:

- Ollama base URL.
- OpenAI-compatible path.
- Native API base path.
- Request timeout.
- Keep-alive value.

Recommended defaults:

```yaml
ollama:
  baseUrl: http://127.0.0.1:11434
  openAiCompatiblePath: /v1/chat/completions
  nativeApiBasePath: /api
  keepAlive: 10m
  requestTimeoutMs: 180000
```

Validation:

- Base URL must be a valid URL.
- The wizard should optionally test `GET {baseUrl}/api/tags`.

### 5.7. GPU/VRAM Profile

Detect:

- If `nvidia-smi` exists, provider is `nvidia`.
- GPU name and memory values from `nvidia-smi`.
- On macOS, detect Apple Silicon or display hardware for summary only, but do not map it to NVIDIA VRAM config.
- If no NVIDIA GPU is detected, provider defaults to `none`.

Ask only for confirmation when detection succeeds:

```text
Use detected GPU RTX 4000 SFF Ada with 20480 MB VRAM? [Y/n]
```

If detection fails or the user rejects, ask:

- GPU provider: `none`, `nvidia`.
- GPU name.
- Total VRAM in MB.
- Safety reserve in MB.
- Max GPU utilization percent.
- Require GPU-only by default?
- Enable GPU monitor?
- Monitor interval.
- `nvidia-smi` path.

Recommended defaults:

```yaml
gpu:
  provider: nvidia
  name: <detected name>
  vramTotalMb: <detected total>
  vramSafetyReserveMb: 1536
  maxGpuUtilizationPct: 92
  requireGpuOnlyByDefault: true
  monitor:
    enabled: true
    intervalMs: 5000
    nvidiaSmiPath: nvidia-smi
```

Sizing policy:

- If total VRAM is less than 8 GB: reserve at least 1024 MB.
- If total VRAM is 8-24 GB: reserve at least 1536 MB.
- If total VRAM is more than 24 GB: reserve at least 2048 MB.

GPU-only guidance:

- Default to `true` when provider is `nvidia`.
- Warn that GPU-only can reject models if Ollama splits them across CPU/GPU.
- Recommend reducing concurrency or choosing smaller models when CPU/GPU split appears.

### 5.8. Machine Capacity Profile

Detect:

- CPU cores from `os.cpus().length`.
- System RAM from `os.totalmem()`.
- Platform and architecture.

Use these values to recommend queue and concurrency defaults:

- Small machine: less than 16 GB RAM or 4 CPU cores.
- Medium machine: 16-64 GB RAM and 4-16 CPU cores.
- Large machine: more than 64 GB RAM or more than 16 CPU cores.

The wizard should not require the user to understand these categories. It should show:

```text
Detected machine profile: medium, 16 CPU cores, 65536 MB RAM.
Use recommended queue settings for this profile? [Y/n]
```

### 5.9. Model Inventory

Detect:

- Installed Ollama models from `ollama list`.
- Loaded model processor state from `ollama ps`.
- Approximate size from `ollama list` output when available.
- Model names that imply likely roles through heuristics.

Role heuristics:

```text
name contains coder/code/deepseek/qwen-coder -> code model
name contains review -> code review model
name contains gpt-oss/oss/reason/think/vibethinker -> reasoning or triage depending on size
small size <= 4 GB -> fast/general candidate
large size >= 12 GB -> heavy reasoning/large context candidate
```

Show a proposed inventory:

```text
Detected models

1. B-A-M-N/vibethinker:1.5b
   role: fast/general, triage, summarize
   size: 3.6 GB
   maxConcurrent: 2

2. qwen2.5-coder:7b
   role: code generation/fix/tool use
   size: 4.7 GB
   maxConcurrent: 1

3. gpt-oss:20b
   role: heavy reasoning/large context
   size: 14.0 GB
   exclusive: true
```

Ask:

```text
Use this detected model inventory and roles? [Y/n]
```

Only if rejected, ask:

- Add model manually?
- For each model:
  - name
  - approximate size in GB
  - purpose tags
  - max concurrency
  - default context
  - max context
  - timeout
  - cost class
  - exclusive?
  - allow when busy?

The wizard should support two model input modes:

1. Quick mode:
   - User picks model role presets.
   - Wizard generates specs.

2. Advanced mode:
   - User edits every field.

Model role presets:

- Fast/general chat model.
- Code generation/fix model.
- Code review model.
- Heavy reasoning/large context model.
- Tool-use model.

Suggested defaults by role:

```text
Fast/general:
  costClass: low
  maxConcurrent: 2
  exclusive: false
  allowWhenBusy: true

Code model:
  costClass: medium
  maxConcurrent: 1
  exclusive: false
  allowWhenBusy: true

Heavy reasoning:
  costClass: high
  maxConcurrent: 1
  exclusive: true
  allowWhenBusy: false
```

### 5.10. Route Mapping

Generate a proposed route map from detected model roles. Then ask for confirmation:

```text
Use the proposed route map? [Y/n]
```

If rejected, ask:

- Which model should handle simple chat?
- Which model should handle summarization?
- Which model should handle code generation?
- Which model should handle code review?
- Which model should handle code fixes?
- Which model should handle agentic reasoning?
- Which model should handle large context?
- Which model should handle tool use?
- Which model should be the fallback for unknown tasks?

The wizard should allow multiple candidates per task type, ordered by preference.

Task types:

```text
triage
simple_chat
summarize
code_generate
code_review
code_fix
agentic_reasoning
large_context
tool_use
unknown
```

Default mapping policy:

- Use fastest model for `triage`, `simple_chat`, `summarize`.
- Use code model for `code_generate`, `code_fix`, `tool_use`.
- Use review model for `code_review`.
- Use heavy reasoning model first for `agentic_reasoning` and `large_context`.
- Use a medium code model as fallback after the heavy model.

### 5.11. Router and Classification Policy

Generate recommended defaults from machine profile, GPU VRAM, and model inventory. Then ask:

```text
Use recommended router policy? [Y/n]
```

If rejected, ask:

- Default router mode: `auto`, `sync`, `async`.
- Default task type.
- Sync max queue time.
- Heavy-load queue depth.
- Heavy-load GPU free VRAM threshold.
- Classification mode.
- Optional classifier model.
- Classifier timeout.

Recommended defaults:

```yaml
router:
  defaultMode: auto
  syncMaxQueueTimeMs: 250
  heavyLoadQueueDepth: 3
  heavyLoadGpuFreeMbThreshold: 3072
  defaultTaskType: unknown
  classification:
    mode: heuristic
    optionalClassifierModel:
    classifierTimeoutMs: 1500
```

V1 should default to heuristic classification. The classifier model remains optional and may be unused until a later implementation.

### 5.12. Queue and Job Policy

Generate recommended defaults from machine profile and GPU profile. Then ask:

```text
Use recommended queue/job settings? [Y/n]
```

If rejected, ask:

- Global max concurrent requests.
- Global max queued jobs.
- Per-user max queued jobs.
- Default priority.
- Queue timeout.
- Async job result TTL.
- Async job max attempts.
- Cleanup interval.

Recommended defaults:

```yaml
queue:
  globalMaxConcurrent: 3
  globalMaxQueued: 100
  perUserMaxQueued: 20
  defaultPriority: normal
  timeoutMs: 180000

jobs:
  store: memory
  resultTtlSeconds: 86400
  maxAttempts: 2
  cleanupIntervalMs: 60000
```

Concurrency policy:

- Default global concurrency should not exceed the sum of configured per-model concurrency.
- Heavy exclusive models should stay at `maxConcurrent: 1`.
- For single-GPU machines, prefer lower concurrency and async queues over parallel heavy jobs.

## 6. Generated YAML Structure

The wizard writes the same schema consumed by the router:

```yaml
server: {}
ollama: {}
gpu: {}
router: {}
jobs: {}
models: []
routes: {}
queue: {}
```

The generated file must include every required top-level section. It should avoid comments in the generated YAML unless a future config writer supports stable comment preservation.

## 7. Validation

Before writing, the wizard must run the existing config parser and validation.

Additional wizard validation:

- At least one model is configured.
- Every route references an existing model.
- Every core task type has at least one route.
- HTTPS cert/key are both present when HTTPS is enabled.
- GPU VRAM values are non-negative.
- `vramSafetyReserveMb < vramTotalMb` when provider is not `none`.
- Exclusive models must have `maxConcurrent: 1`.
- `queue.globalMaxConcurrent` must be positive.

## 8. Preview Summary

Before write, show a concise summary:

```text
Output: ./ollama-agent-router.yaml
Server: http://127.0.0.1:11435/
Ollama: http://127.0.0.1:11434
GPU: NVIDIA RTX 4000 SFF Ada, 20480 MB VRAM, reserve 1536 MB
Models: 4 configured
Heavy model: gpt-oss:20b, exclusive
Queue: global concurrency 3, max queued 100
Jobs: memory store, result TTL 86400s
```

The summary should distinguish detected values from assumed defaults:

```text
Detected:
  GPU name, VRAM, Ollama models, CPU cores, RAM

Assumed defaults:
  server host, server port, request body limit, result TTL

User overrides:
  basePath: /ollama-router
```

Then ask:

```text
Write this config? [Y/n]
```

## 9. Non-Interactive Mode

For automation, support:

```bash
ollama-agent-router configure --non-interactive --answers answers.yaml --output config.yaml
```

`answers.yaml` should use a wizard-specific schema, not the final config schema. This keeps prompts stable while allowing the final config schema to evolve.

Example:

```yaml
server:
  host: 127.0.0.1
  port: 11435
  basePath: /
  https: false
gpu:
  provider: nvidia
  name: RTX 4000 SFF Ada
  vramTotalMb: 20480
models:
  mode: manual
  items:
    - name: qwen2.5-coder:7b
      role: code
      sizeGb: 4.7
```

## 10. Dependencies

Recommended CLI prompt library:

- `@inquirer/prompts`

Existing dependencies to reuse:

- `yaml` for writing YAML.
- `zod` for answer and config validation.
- Existing `parseConfig` validation before write.
- Existing GPU and Ollama parser utilities where possible.

The wizard should keep command execution injectable for tests, especially:

- `ollama list`
- `ollama ps`
- `nvidia-smi`

## 11. Testing Plan

Unit tests:

- answer schema validation
- default derivation from detected GPU
- route generation from selected roles
- HTTPS validation
- base path normalization
- overwrite protection

Integration-style CLI tests:

- wizard generates valid YAML from mocked answers
- wizard uses detected NVIDIA GPU values
- wizard uses detected Ollama model list
- non-interactive mode generates valid config
- existing file is not overwritten without confirmation

Platform test matrix:

```text
darwin arm64, Apple Silicon, Ollama desktop app path, no nvidia-smi
darwin x64, Homebrew Ollama path, no nvidia-smi
linux x64, systemd Ollama, NVIDIA GPU with nvidia-smi
linux x64, no NVIDIA GPU, Ollama available
linux arm64, Ollama available, no NVIDIA GPU
```

Each platform test should assert:

- detected Ollama path/source is represented correctly
- generated `ollama.baseUrl` follows `OLLAMA_HOST` or default fallback
- generated GPU provider is correct for the platform
- macOS does not enable NVIDIA monitoring by accident
- Linux NVIDIA enables monitoring when `nvidia-smi` output is valid
- config validates with the existing parser

No test should require a real GPU, real Ollama process, or opening a network port.

## 12. Out of Scope for V1

- Benchmarking local models.
- Automatically pulling Ollama models.
- Editing an existing config in place.
- Persisting wizard profiles.
- Cloud model routing.
- Automatic public TLS certificate issuance.

These can be added later after the basic config generator is stable.
