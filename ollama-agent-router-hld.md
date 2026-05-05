# HLD: Ollama Intelligent Agent Router

## 1. Cel systemu

Projekt: **`ollama-agent-router`**

Router działa jako lokalny lub serwerowy gateway przed Ollamą. Jego zadaniem jest inteligentne kierowanie żądań do dostępnych modeli lokalnych, zarządzanie kolejkami, kontrola obciążenia GPU/VRAM i udostępnienie klientom dwóch trybów pracy: odpowiedź natychmiastowa albo asynchroniczne przyjęcie zadania z identyfikatorem procesu.

Główne cele:

```text
1. Przyjmować żądania od klientów w stylu OpenAI-compatible API.
2. Rozpoznawać typ zadania.
3. Dobierać najlepszy model na podstawie:
   - przeznaczenia modeli,
   - aktualnego obciążenia,
   - parametrów GPU/VRAM,
   - modeli aktualnie załadowanych w Ollama,
   - stanu kolejek,
   - wymaganego kontekstu,
   - trybu sync/async.
4. Kierować request do odpowiedniego modelu Ollama.
5. Kolejkować zadania, gdy system jest zajęty.
6. Obsługiwać tryb async z process/job id.
7. Umożliwiać pobranie statusu i wyniku zadania.
8. Działać jako CLI/daemon.
9. Dać się opublikować jako:
   - npm package,
   - standalone CLI,
   - Homebrew formula,
   - apt/deb package.
```

---

## 2. Architektura wysokopoziomowa

```text
Client / Agent / App
        |
        v
OpenAI-compatible HTTP API
        |
        v
Ollama Agent Router
        |
        +--> Task Classifier
        |
        +--> Model Registry
        |
        +--> GPU / Ollama Monitor
        |
        +--> Routing Engine
        |
        +--> Queue Manager
        |
        +--> In-Memory Job Manager
        |
        +--> Ollama Client
        |
        v
Ollama Runtime
        |
        v
GPU / CPU
```

System jest procesem Node.js/TypeScript uruchamianym jako serwer HTTP i CLI. Stan zadań asynchronicznych jest trzymany **wyłącznie w pamięci procesu**. Restart procesu kasuje historię zadań i wyniki.

---

## 3. Tryby działania

Router obsługuje dwa tryby.

### 3.1. Tryb synchronous

Jeżeli router oceni, że zadanie może być obsłużone od razu, endpoint:

```http
POST /v1/chat/completions
```

zwraca standardową odpowiedź OpenAI-compatible z dodatkową sekcją `router`.

Przykład:

```json
{
  "id": "chatcmpl_router_123",
  "object": "chat.completion",
  "model": "qwen2.5-coder:7b",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "..."
      },
      "finish_reason": "stop"
    }
  ],
  "router": {
    "mode": "sync",
    "taskType": "code_generate",
    "selectedModel": "qwen2.5-coder:7b",
    "queueTimeMs": 12,
    "executionTimeMs": 3200,
    "decisionReason": "Selected best available code generation model"
  }
}
```

### 3.2. Tryb asynchronous

Jeżeli router oceni, że system jest obciążony albo zadanie powinno wejść do kolejki, zwraca job/process id.

Warunki przejścia do async:

```text
- wybrany model jest zajęty,
- system ma heavy load,
- GPU/VRAM jest blisko limitu,
- request jest ciężki lub wymaga dużego modelu,
- kolejka jest akceptowalna,
- klient pozwala na async.
```

Przykład odpowiedzi:

```json
{
  "id": "job_01JABCDEF123",
  "object": "router.job",
  "status": "queued",
  "message": "Heavy load. Job accepted for asynchronous processing.",
  "router": {
    "mode": "async",
    "taskType": "agentic_reasoning",
    "preferredModel": "gpt-oss:20b",
    "position": 3,
    "estimatedClass": "heavy"
  }
}
```

Klient sprawdza status:

```http
GET /v1/jobs/job_01JABCDEF123
```

Klient pobiera wynik:

```http
GET /v1/jobs/job_01JABCDEF123/result
```

---

## 4. API

### 4.1. OpenAI-compatible endpoint

```http
POST /v1/chat/completions
```

Router akceptuje standardowy format:

```json
{
  "model": "auto",
  "messages": [
    {
      "role": "user",
      "content": "Write a Node.js function..."
    }
  ],
  "temperature": 0.2,
  "max_tokens": 2048,
  "stream": false
}
```

Dodatkowe pole routera:

```json
{
  "router": {
    "mode": "auto",
    "taskType": "auto",
    "priority": "normal",
    "allowAsync": true,
    "preferredModels": [],
    "forbiddenModels": [],
    "maxQueueTimeMs": 3000,
    "maxExecutionTimeMs": 120000,
    "requireGpuOnly": true
  }
}
```

### 4.2. Job endpoints

```http
GET /v1/jobs/:jobId
GET /v1/jobs/:jobId/result
DELETE /v1/jobs/:jobId
```

Statusy jobów:

```text
queued
running
succeeded
failed
cancelled
expired
```

Przykład statusu:

```json
{
  "id": "job_01JABCDEF123",
  "status": "running",
  "taskType": "code_review",
  "selectedModel": "deepseek-coder:6.7b",
  "createdAt": "2026-05-04T12:00:00.000Z",
  "startedAt": "2026-05-04T12:00:05.000Z",
  "finishedAt": null,
  "attempts": 1,
  "queuePosition": 0
}
```

Przykład wyniku:

```json
{
  "id": "job_01JABCDEF123",
  "status": "succeeded",
  "result": {
    "id": "chatcmpl_router_456",
    "object": "chat.completion",
    "model": "deepseek-coder:6.7b",
    "choices": []
  },
  "router": {
    "taskType": "code_review",
    "selectedModel": "deepseek-coder:6.7b",
    "queueTimeMs": 5021,
    "executionTimeMs": 23190
  }
}
```

### 4.3. Health and status endpoints

```http
GET /health
GET /metrics
GET /v1/router/status
GET /v1/router/models
GET /v1/router/gpu
```

`/v1/router/status` powinien zwracać:

```json
{
  "status": "ok",
  "mode": "multi-small",
  "ollama": {
    "baseUrl": "http://127.0.0.1:11434",
    "reachable": true
  },
  "gpu": {
    "name": "RTX 4000 SFF Ada",
    "vramTotalMb": 20480,
    "vramUsedMb": 12600,
    "vramFreeMb": 7880,
    "utilizationPct": 62
  },
  "loadedModels": [
    {
      "name": "qwen2.5-coder:7b",
      "sizeGb": 4.7,
      "processor": "100% GPU"
    }
  ],
  "queues": {
    "qwen2.5-coder:7b": {
      "pending": 1,
      "queued": 2
    }
  },
  "jobs": {
    "queued": 3,
    "running": 1,
    "succeededRetained": 12,
    "failedRetained": 1
  }
}
```

---

## 5. Konfiguracja

Router używa pliku:

```text
ollama-agent-router.yaml
```

Domyślne ścieżki:

```text
./ollama-agent-router.yaml
~/.config/ollama-agent-router/config.yaml
/etc/ollama-agent-router/config.yaml
```

Możliwość nadpisania:

```bash
ollama-agent-router serve --config ./router.yaml
```

---

## 6. Przykładowa konfiguracja dla Hetzner GEX44

```yaml
server:
  host: "0.0.0.0"
  port: 3000
  publicBaseUrl: "http://localhost:3000"
  requestBodyLimit: "20mb"

ollama:
  baseUrl: "http://127.0.0.1:11434"
  openAiCompatiblePath: "/v1/chat/completions"
  nativeApiBasePath: "/api"
  keepAlive: "30m"
  requestTimeoutMs: 300000

gpu:
  provider: "nvidia"
  name: "RTX 4000 SFF Ada"
  vramTotalMb: 20480
  vramSafetyReserveMb: 1536
  maxGpuUtilizationPct: 95
  requireGpuOnlyByDefault: true
  monitor:
    enabled: true
    intervalMs: 3000
    nvidiaSmiPath: "nvidia-smi"

router:
  defaultMode: "auto"
  syncMaxQueueTimeMs: 2500
  heavyLoadQueueDepth: 4
  heavyLoadGpuFreeMbThreshold: 2048
  defaultTaskType: "simple_chat"
  classification:
    mode: "heuristic"
    optionalClassifierModel: "B-A-M-N/vibethinker:1.5b"
    classifierTimeoutMs: 5000

jobs:
  store: "memory"
  resultTtlSeconds: 86400
  maxRetainedJobs: 1000
  maxAttempts: 2
  cleanupIntervalMs: 60000

models:
  - name: "B-A-M-N/vibethinker:1.5b"
    sizeGb: 3.6
    purpose:
      - "triage"
      - "simple_chat"
      - "summarize"
      - "classification"
    priority: 10
    maxConcurrent: 4
    defaultContext: 4096
    maxContext: 8192
    timeoutMs: 60000
    costClass: "small"
    allowWhenBusy: true
    tags:
      - "fast"
      - "router"
      - "cheap"

  - name: "qwen2.5-coder:7b"
    sizeGb: 4.7
    purpose:
      - "code_generate"
      - "code_fix"
      - "tool_use"
      - "simple_agent"
    priority: 20
    maxConcurrent: 2
    defaultContext: 4096
    maxContext: 8192
    timeoutMs: 180000
    costClass: "medium"
    allowWhenBusy: true
    tags:
      - "code"
      - "fast"

  - name: "deepseek-coder:6.7b"
    sizeGb: 3.8
    purpose:
      - "code_review"
      - "code_generate"
      - "code_fix"
      - "second_opinion"
    priority: 30
    maxConcurrent: 2
    defaultContext: 4096
    maxContext: 8192
    timeoutMs: 180000
    costClass: "medium"
    allowWhenBusy: true
    tags:
      - "code"
      - "review"

  - name: "gpt-oss:20b"
    sizeGb: 14.0
    purpose:
      - "agentic_reasoning"
      - "large_context"
      - "planning"
      - "tool_use"
      - "complex_debugging"
    priority: 100
    maxConcurrent: 1
    defaultContext: 8192
    maxContext: 16384
    timeoutMs: 300000
    costClass: "large"
    exclusive: true
    allowWhenBusy: false
    tags:
      - "heavy"
      - "reasoning"
      - "agentic"

routes:
  triage:
    candidates:
      - "B-A-M-N/vibethinker:1.5b"

  simple_chat:
    candidates:
      - "B-A-M-N/vibethinker:1.5b"
      - "qwen2.5-coder:7b"

  summarize:
    candidates:
      - "B-A-M-N/vibethinker:1.5b"
      - "qwen2.5-coder:7b"

  code_generate:
    candidates:
      - "qwen2.5-coder:7b"
      - "deepseek-coder:6.7b"

  code_review:
    candidates:
      - "deepseek-coder:6.7b"
      - "qwen2.5-coder:7b"

  code_fix:
    candidates:
      - "qwen2.5-coder:7b"
      - "deepseek-coder:6.7b"

  agentic_reasoning:
    candidates:
      - "gpt-oss:20b"
      - "qwen2.5-coder:7b"

  large_context:
    candidates:
      - "gpt-oss:20b"

queue:
  globalMaxConcurrent: 6
  globalMaxQueued: 128
  perUserMaxQueued: 16
  defaultPriority: 50
  timeoutMs: 600000

logging:
  level: "info"
  format: "pretty"

telemetry:
  prometheus:
    enabled: true
    path: "/metrics"
```

---

## 7. Model Registry

Każdy model jest opisany w konfiguracji.

```ts
type ModelSpec = {
  name: string;
  sizeGb: number;
  purpose: TaskType[];
  priority: number;
  maxConcurrent: number;
  defaultContext: number;
  maxContext: number;
  timeoutMs: number;
  costClass: "small" | "medium" | "large";
  exclusive?: boolean;
  allowWhenBusy?: boolean;
  tags?: string[];
};
```

Router nie hardkoduje modeli. Wszystkie nazwy, rozmiary, przeznaczenia, limity i trasy pochodzą z configu.

---

## 8. GPU Spec

```ts
type GpuSpec = {
  provider: "nvidia" | "amd" | "apple" | "cpu" | "custom";
  name: string;
  vramTotalMb: number;
  vramSafetyReserveMb: number;
  maxGpuUtilizationPct: number;
  requireGpuOnlyByDefault: boolean;
};
```

Dla v1 wystarczy NVIDIA przez `nvidia-smi`.

Monitor pobiera:

```text
vram total
vram used
vram free
gpu utilization
processes
```

Przykładowa komenda:

```bash
nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits
```

---

## 9. Ollama Monitor

Router cyklicznie odpytuje:

```bash
ollama ps
```

oraz opcjonalnie:

```http
GET /api/tags
```

Stan modeli:

```ts
type LoadedModelState = {
  name: string;
  id?: string;
  size?: string;
  sizeGb?: number;
  processor?: "100% GPU" | "100% CPU" | "CPU/GPU" | string;
  until?: string;
};
```

Jeżeli `processor` zawiera `CPU/GPU` albo `100% CPU`, a config wymaga GPU-only, router powinien:

```text
1. przestać kierować nowe zadania do tego modelu,
2. oznaczyć runtime jako degraded,
3. próbować fallbacku do mniejszego modelu,
4. dla heavy tasków zwracać async albo 503, zależnie od policy.
```

---

## 10. Klasyfikacja zadań

### 10.1. Task types

```ts
type TaskType =
  | "triage"
  | "simple_chat"
  | "summarize"
  | "code_generate"
  | "code_review"
  | "code_fix"
  | "agentic_reasoning"
  | "large_context"
  | "tool_use"
  | "unknown";
```

### 10.2. Klasyfikator v1

Na start: deterministyczne heurystyki.

Przykłady:

```text
- zawiera "review", "sprawdź kod", "PR", "pull request" => code_review
- zawiera "napisz funkcję", "implement", "fix bug", stack trace => code_generate/code_fix
- długi prompt > X znaków => large_context albo agentic_reasoning
- zawiera "plan", "agent", "tools", "repo", "execute" => agentic_reasoning
- zawiera "podsumuj", "summarize" => summarize
- fallback => simple_chat
```

### 10.3. Klasyfikator v2

Opcjonalnie: mały model klasyfikujący.

Prompt klasyfikatora zwraca JSON:

```json
{
  "taskType": "code_generate",
  "complexity": "medium",
  "requiresLargeContext": false,
  "requiresToolUse": false,
  "confidence": 0.84
}
```

Router musi mieć fallback do heurystyk, jeżeli klasyfikator timeoutuje.

---

## 11. Routing Engine

### 11.1. Dane wejściowe

```ts
type RoutingInput = {
  taskType: TaskType;
  messages: ChatMessage[];
  requestedModel?: string;
  preferredModels?: string[];
  forbiddenModels?: string[];
  allowAsync: boolean;
  priority: "low" | "normal" | "high";
  maxQueueTimeMs?: number;
  maxExecutionTimeMs?: number;
  requireGpuOnly?: boolean;
};
```

### 11.2. Decyzja routingowa

```ts
type RoutingDecision = {
  mode: "sync" | "async" | "reject";
  selectedModel?: string;
  fallbackModels: string[];
  reason: string;
  estimatedLoad: "light" | "medium" | "heavy";
  queueName?: string;
};
```

### 11.3. Algorytm

Pseudokod:

```ts
function route(input: RoutingInput): RoutingDecision {
  const taskType = classify(input.messages);

  const candidates = getCandidates(taskType)
    .filter(model => !input.forbiddenModels.includes(model.name))
    .filter(model => modelIsAvailable(model))
    .filter(model => fitsGpuBudget(model))
    .sort(byScore);

  if (candidates.length === 0) {
    if (input.allowAsync) {
      return asyncDecision("No immediate candidate, queued for later");
    }

    return rejectDecision("No available model");
  }

  const best = candidates[0];

  if (canRunImmediately(best, input)) {
    return syncDecision(best);
  }

  if (input.allowAsync) {
    return asyncDecision(best);
  }

  const fallback = findLightFallback(candidates);

  if (fallback && canRunImmediately(fallback, input)) {
    return syncDecision(fallback);
  }

  return rejectDecision("Heavy load");
}
```

### 11.4. Scoring modelu

Model score:

```text
score =
  purpose_match_score
  - queue_penalty
  - vram_pressure_penalty
  - cpu_gpu_split_penalty
  - timeout_risk_penalty
  + priority_bonus
  + freshness_loaded_bonus
```

Przykład:

```ts
function scoreModel(model, task, runtime) {
  let score = 0;

  if (model.purpose.includes(task.type)) score += 100;
  if (runtime.loadedModels.has(model.name)) score += 15;
  if (model.costClass === "small") score += 5;

  score -= queueDepth(model.name) * 10;
  score -= runtime.gpu.vramFreeMb < 2048 ? 40 : 0;
  score -= runtime.modelProcessor(model.name)?.includes("CPU") ? 100 : 0;

  if (model.exclusive && runtime.totalPending > 0) score -= 50;

  return score;
}
```

---

## 12. Queue Manager

Wymagania:

```text
- osobna kolejka per model,
- globalny limit zadań,
- priorytety,
- timeouty,
- retry,
- cancellation,
- status,
- integracja z In-Memory Job Managerem dla zadań async.
```

Rekomendowana biblioteka Node:

```text
p-queue
```

Założenia:

```text
- kolejka istnieje tylko w pamięci procesu,
- po restarcie routera znikają zadania oczekujące i wyniki,
- klient musi traktować job id jako nietrwałe,
- brak gwarancji przetrwania restartu procesu,
- v1 nie wymaga Redis, SQLite ani innego trwałego storage.
```

---

## 13. In-Memory Job Manager

Nie używamy SQLite ani żadnego trwałego Job Store. Stan zadań jest trzymany w pamięci.

### 13.1. Odpowiedzialności

```text
1. Tworzenie jobów async.
2. Przechowywanie statusu jobów.
3. Przechowywanie wyniku albo błędu.
4. Czyszczenie starych jobów po TTL.
5. Limitowanie liczby przechowywanych jobów.
6. Anulowanie jobów, jeżeli jeszcze nie wystartowały albo jeżeli worker obsługuje AbortController.
```

### 13.2. Typ joba

```ts
type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

type InMemoryJob = {
  id: string;
  status: JobStatus;
  taskType: TaskType;
  selectedModel?: string;
  request: unknown;
  result?: unknown;
  error?: {
    message: string;
    code?: string;
    stack?: string;
  };
  attempts: number;
  priority: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  expiresAt: string;
  abortController?: AbortController;
};
```

### 13.3. Struktura danych

```ts
type JobManagerState = {
  jobsById: Map<string, InMemoryJob>;
  jobOrder: string[];
};
```

`jobOrder` służy do czyszczenia najstarszych wpisów przy przekroczeniu `maxRetainedJobs`.

### 13.4. Cleanup

Mechanizm cleanup działa cyklicznie:

```text
- usuwa joby po `resultTtlSeconds`,
- usuwa najstarsze joby, jeśli liczba wpisów > `maxRetainedJobs`,
- oznacza jako expired joby, których wynik nie został pobrany w czasie TTL,
- usuwa stare joby failed/succeeded/cancelled.
```

Config:

```yaml
jobs:
  store: "memory"
  resultTtlSeconds: 86400
  maxRetainedJobs: 1000
  maxAttempts: 2
  cleanupIntervalMs: 60000
```

### 13.5. Ograniczenia

```text
- Stan nie jest trwały.
- Po restarcie procesu job id przestaje istnieć.
- Nie ma obsługi wielu instancji routera z dzielonym stanem.
- W deploymentach multi-instance wymagany byłby zewnętrzny store, ale nie jest częścią v1.
```

---

## 14. CLI

Nazwa komendy:

```bash
ollama-agent-router
```

Alias:

```bash
oar
```

### 14.1. Komendy

```bash
ollama-agent-router serve
ollama-agent-router init
ollama-agent-router validate-config
ollama-agent-router status
ollama-agent-router models
ollama-agent-router gpu
ollama-agent-router jobs
ollama-agent-router job <jobId>
ollama-agent-router result <jobId>
ollama-agent-router cancel <jobId>
```

### 14.2. Przykłady

```bash
ollama-agent-router init --preset gex44
```

```bash
ollama-agent-router serve --config ./router.yaml
```

```bash
ollama-agent-router status
```

```bash
ollama-agent-router models
```

---

## 15. npm package

`package.json` powinien zawierać:

```json
{
  "name": "ollama-agent-router",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "ollama-agent-router": "./dist/cli.js",
    "oar": "./dist/cli.js"
  }
}
```

Skrypty:

```json
{
  "scripts": {
    "dev": "tsx src/cli.ts serve --config examples/gex44.yaml",
    "build": "tsup src/cli.ts --format esm --dts --clean",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "start": "node dist/cli.js serve",
    "package:deb": "nfpm package --packager deb --config packaging/nfpm.yaml"
  }
}
```

---

## 16. Homebrew

W repo należy dodać:

```text
packaging/homebrew/ollama-agent-router.rb
```

Template:

```ruby
class OllamaAgentRouter < Formula
  desc "Intelligent model router and queue manager for Ollama"
  homepage "https://github.com/YOUR_ORG/ollama-agent-router"
  url "https://registry.npmjs.org/ollama-agent-router/-/ollama-agent-router-0.1.0.tgz"
  sha256 "TO_BE_FILLED"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink libexec/"bin/ollama-agent-router"
    bin.install_symlink libexec/"bin/oar"
  end

  test do
    system "#{bin}/ollama-agent-router", "--version"
  end
end
```

---

## 17. apt/deb

Najprościej przygotować packaging przez `nfpm`.

Plik:

```text
packaging/nfpm.yaml
```

Template:

```yaml
name: ollama-agent-router
arch: amd64
platform: linux
version: 0.1.0
section: utils
priority: optional
maintainer: YOUR_NAME <you@example.com>
description: Intelligent model router and queue manager for Ollama
license: MIT
homepage: https://github.com/YOUR_ORG/ollama-agent-router
contents:
  - src: ./dist/bin/ollama-agent-router-linux-x64
    dst: /usr/bin/ollama-agent-router
  - src: ./packaging/systemd/ollama-agent-router.service
    dst: /lib/systemd/system/ollama-agent-router.service
  - src: ./examples/gex44.yaml
    dst: /etc/ollama-agent-router/config.yaml
config_files:
  - /etc/ollama-agent-router/config.yaml
```

Systemd service:

```ini
[Unit]
Description=Ollama Agent Router
After=network.target ollama.service

[Service]
Type=simple
ExecStart=/usr/bin/ollama-agent-router serve --config /etc/ollama-agent-router/config.yaml
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

---

## 18. Testy

### 18.1. Unit tests

Użyć:

```text
vitest
```

Testować:

```text
- config loading,
- config validation,
- task classification,
- model scoring,
- route decision,
- queue behavior,
- in-memory job lifecycle,
- job cleanup TTL,
- job cancellation,
- Ollama ps parser,
- nvidia-smi parser.
```

### 18.2. Integration tests

Mock Ollama server:

```text
- fake /v1/chat/completions,
- fake /api/tags,
- fake ollama ps output,
- fake nvidia-smi output.
```

Scenariusze:

```text
1. simple_chat idzie do vibethinker.
2. code_generate idzie do qwen2.5-coder.
3. code_review idzie do deepseek-coder.
4. agentic_reasoning idzie do gpt-oss, jeśli wolny.
5. agentic_reasoning fallbackuje do qwen2.5-coder, jeśli gpt-oss jest niedostępny i allowAsync=false.
6. agentic_reasoning zwraca async job, jeśli gpt-oss jest zajęty i allowAsync=true.
7. job przechodzi queued -> running -> succeeded.
8. failed Ollama call zapisuje error w pamięci.
9. CPU/GPU split blokuje model, jeśli requireGpuOnly=true.
10. /health i /v1/router/status zwracają użyteczny stan.
11. restart procesu nie musi zachowywać jobów; to jawne ograniczenie v1.
```

### 18.3. CLI tests

```text
- init tworzy config,
- validate-config wykrywa błędy,
- status działa z mockowanym routerem,
- jobs pokazuje listę jobów,
- job <jobId> pokazuje status,
- result <jobId> pokazuje wynik albo informację o braku wyniku.
```

---

## 19. Repo structure

```text
ollama-agent-router/
  package.json
  tsconfig.json
  README.md
  LICENSE
  .gitignore
  .env.example

  src/
    cli.ts
    server.ts
    config/
      loadConfig.ts
      schema.ts
      presets.ts
    router/
      classifyTask.ts
      scoreModel.ts
      routeRequest.ts
      types.ts
    queue/
      queueManager.ts
      inMemoryJobManager.ts
      jobRunner.ts
    ollama/
      ollamaClient.ts
      parseOllamaPs.ts
      monitorOllama.ts
    gpu/
      nvidiaSmi.ts
      gpuMonitor.ts
    api/
      chatCompletions.ts
      jobs.ts
      health.ts
      metrics.ts
    utils/
      logger.ts
      ids.ts
      time.ts

  tests/
    unit/
    integration/
    fixtures/
      ollama-ps.txt
      nvidia-smi.csv

  examples/
    gex44.yaml
    multi-small.yaml
    big-agent.yaml

  packaging/
    homebrew/
      ollama-agent-router.rb
    nfpm.yaml
    systemd/
      ollama-agent-router.service

  scripts/
    build.ts
    release.ts
```

---

## 20. Najważniejsze decyzje projektowe

### 20.1. Brak trwałego Job Store

W v1 nie używamy SQLite, Redis ani innego trwałego storage.

Konsekwencje:

```text
- joby async są nietrwałe,
- restart procesu usuwa kolejkę i wyniki,
- deployment multi-instance nie jest wspierany dla async jobów,
- prostota i niskie wymagania operacyjne są ważniejsze niż trwałość.
```

### 20.2. Router nie powinien sam agresywnie ubijać modeli

V1 steruje systemem przez:

```text
- kolejki,
- routing,
- fallback,
- limity concurrency,
- `OLLAMA_MAX_LOADED_MODELS`,
- `OLLAMA_NUM_PARALLEL`,
- `OLLAMA_KEEP_ALIVE`,
- wykrywanie CPU/GPU split.
```

### 20.3. `gpt-oss:20b` jako exclusive heavy worker

W konfiguracji:

```yaml
exclusive: true
maxConcurrent: 1
allowWhenBusy: false
```

Jeżeli heavy model jest zajęty, router:

```text
- dla allowAsync=true: tworzy job,
- dla allowAsync=false: fallbackuje do qwen2.5-coder albo zwraca 503.
```

### 20.4. Sync vs async

Logika:

```text
Jeżeli przewidywany queue wait <= syncMaxQueueTimeMs:
  obsłuż sync.

Jeżeli allowAsync=true:
  zapisz job w pamięci i zwróć job id.

Jeżeli allowAsync=false:
  spróbuj fallback.

Jeżeli fallback niedostępny:
  zwróć 503.
```

---

## 21. Prompt dla agenta programistycznego

Poniższy prompt można wkleić do agenta kodującego.

```text
You are a senior TypeScript/Node.js engineer. Build a production-ready open-source project called `ollama-agent-router`.

Goal:
Create an intelligent HTTP/CLI router for Ollama that sits in front of an Ollama server and routes OpenAI-compatible chat completion requests to the most appropriate local model. The router must manage model selection, task classification, queues, async jobs, GPU/VRAM awareness, loaded model state, fallback behavior, and packaging for npm, Homebrew, and apt/deb.

Important architectural constraint:
Do NOT use SQLite, Redis, Postgres, or any persistent job store in v1. Async job state must be kept only in memory. Restarting the process is allowed to lose queued/running/completed jobs. This limitation must be clearly documented in README.

Core requirements:
1. Use Node.js + TypeScript.
2. Expose an OpenAI-compatible endpoint:
   POST /v1/chat/completions
3. Support extra router metadata in requests:
   router.mode: "auto" | "sync" | "async"
   router.allowAsync: boolean
   router.taskType: optional explicit task type
   router.priority: "low" | "normal" | "high"
   router.preferredModels: string[]
   router.forbiddenModels: string[]
   router.maxQueueTimeMs: number
   router.maxExecutionTimeMs: number
   router.requireGpuOnly: boolean
4. If the router can answer immediately, return a standard OpenAI-compatible chat completion response.
5. If the router detects heavy load and allowAsync=true, create an async in-memory job and return a job id.
6. Implement:
   GET /v1/jobs/:jobId
   GET /v1/jobs/:jobId/result
   DELETE /v1/jobs/:jobId
7. Implement:
   GET /health
   GET /metrics
   GET /v1/router/status
   GET /v1/router/models
   GET /v1/router/gpu
8. Implement a CLI binary:
   ollama-agent-router
   alias: oar
9. CLI commands:
   ollama-agent-router serve
   ollama-agent-router init
   ollama-agent-router validate-config
   ollama-agent-router status
   ollama-agent-router models
   ollama-agent-router gpu
   ollama-agent-router jobs
   ollama-agent-router job <jobId>
   ollama-agent-router result <jobId>
   ollama-agent-router cancel <jobId>

Configuration:
Use YAML config. Default lookup order:
1. --config path
2. ./ollama-agent-router.yaml
3. ~/.config/ollama-agent-router/config.yaml
4. /etc/ollama-agent-router/config.yaml

Config must include:
server:
  host
  port
  requestBodyLimit

ollama:
  baseUrl
  openAiCompatiblePath
  nativeApiBasePath
  keepAlive
  requestTimeoutMs

gpu:
  provider
  name
  vramTotalMb
  vramSafetyReserveMb
  maxGpuUtilizationPct
  requireGpuOnlyByDefault
  monitor.enabled
  monitor.intervalMs
  monitor.nvidiaSmiPath

router:
  defaultMode
  syncMaxQueueTimeMs
  heavyLoadQueueDepth
  heavyLoadGpuFreeMbThreshold
  defaultTaskType
  classification.mode
  classification.optionalClassifierModel
  classification.classifierTimeoutMs

jobs:
  store must be "memory"
  resultTtlSeconds
  maxRetainedJobs
  maxAttempts
  cleanupIntervalMs

models:
  list of model specs:
    name
    sizeGb
    purpose
    priority
    maxConcurrent
    defaultContext
    maxContext
    timeoutMs
    costClass
    exclusive
    allowWhenBusy
    tags

routes:
  map taskType -> candidate model names

queue:
  globalMaxConcurrent
  globalMaxQueued
  perUserMaxQueued
  defaultPriority
  timeoutMs

Task types:
- triage
- simple_chat
- summarize
- code_generate
- code_review
- code_fix
- agentic_reasoning
- large_context
- tool_use
- unknown

Implement task classification:
V1 must use deterministic heuristics.
Optional model-based classifier can be stubbed behind config, but heuristics must work without any model.
Classifier output:
{
  taskType,
  complexity: "light" | "medium" | "heavy",
  requiresLargeContext: boolean,
  requiresToolUse: boolean,
  confidence: number
}

Routing engine:
Implement a scoring-based routing engine. It should:
1. Select candidate models from config routes.
2. Filter forbidden models.
3. Respect preferred models where possible.
4. Respect requireGpuOnly.
5. Avoid models that are CPU/GPU split if requireGpuOnly=true.
6. Prefer already loaded models when appropriate.
7. Penalize deep queues.
8. Penalize low free VRAM.
9. Respect exclusive models.
10. Return either:
   - sync decision,
   - async decision,
   - reject decision.

Queue manager:
Use p-queue.
Create one queue per model.
Respect maxConcurrent per model.
Respect global queue limits.
Support priorities.
Support timeout.
Support retries for async jobs.

In-memory job manager:
Do not use SQLite. Implement an InMemoryJobManager using Map<string, Job>.
It must support:
- createJob
- getJob
- getResult
- cancelJob
- markRunning
- markSucceeded
- markFailed
- cleanupExpiredJobs
- maxRetainedJobs
- resultTtlSeconds

Job type:
{
  id,
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired",
  taskType,
  selectedModel,
  request,
  result,
  error,
  attempts,
  priority,
  createdAt,
  startedAt,
  finishedAt,
  expiresAt
}

Ollama client:
Implement calls to:
- POST {ollama.baseUrl}/v1/chat/completions
- GET {ollama.baseUrl}/api/tags
Also implement parser for `ollama ps` output. The command should be injectable/mocked for tests. Parse:
- model name
- id
- size
- processor
- until

GPU monitor:
For NVIDIA, call:
nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits
Command path must be configurable.
The monitor should be injectable/mocked for tests.
Return:
{
  name,
  vramTotalMb,
  vramUsedMb,
  vramFreeMb,
  utilizationPct
}

OpenAI-compatible response:
For sync responses, proxy Ollama response and add a top-level `router` object with:
{
  mode,
  taskType,
  selectedModel,
  fallbackModels,
  queueTimeMs,
  executionTimeMs,
  decisionReason
}

Async response:
When heavy load or selected model is busy and allowAsync=true, return:
{
  id: "job_xxx",
  object: "router.job",
  status: "queued",
  message: "Heavy load. Job accepted for asynchronous processing.",
  router: {
    mode: "async",
    taskType,
    preferredModel,
    position,
    estimatedClass
  }
}

Config preset:
Create examples/gex44.yaml for:
- RTX 4000 SFF Ada
- 20 GB VRAM
- B-A-M-N/vibethinker:1.5b, size 3.6 GB
- qwen2.5-coder:7b, size 4.7 GB
- deepseek-coder:6.7b, size 3.8 GB
- gpt-oss:20b, size 14.0 GB

Recommended routing:
- vibethinker: triage, simple_chat, summarize, classification
- qwen2.5-coder: code_generate, code_fix, tool_use, simple_agent
- deepseek-coder: code_review, code_generate, code_fix, second_opinion
- gpt-oss: agentic_reasoning, large_context, planning, tool_use, complex_debugging
gpt-oss must be exclusive with maxConcurrent=1.

Implementation details:
- Use Express or Fastify. Prefer Fastify if convenient, but Express is acceptable.
- Use zod for config and request validation.
- Use pino for logging.
- Use p-queue for queues.
- Do not use better-sqlite3 or any database package.
- Use nanoid or ulid for job ids.
- Use vitest for tests.
- Use tsup or tsx/tsc for build.
- Use ESM.
- Code must be clean, modular, and documented.

Packaging:
Prepare package.json for npm publication:
- package name: ollama-agent-router
- bin:
  ollama-agent-router -> dist/cli.js
  oar -> dist/cli.js
- scripts:
  dev
  build
  test
  lint
  typecheck
  start
  package:deb
- include files:
  dist
  examples
  README.md
  LICENSE

Prepare Homebrew formula template:
packaging/homebrew/ollama-agent-router.rb

Prepare nfpm config for deb packaging:
packaging/nfpm.yaml

Prepare systemd service:
packaging/systemd/ollama-agent-router.service

README:
Write a complete README with:
1. What the project does.
2. Architecture.
3. Quick start.
4. Ollama setup.
5. GEX44 example.
6. Config file reference.
7. API examples.
8. Async jobs examples.
9. CLI usage.
10. npm install instructions.
11. Homebrew install instructions.
12. apt/deb install instructions.
13. Development guide.
14. Test guide.
15. Release guide.
16. Safety notes about VRAM, GPU-only, CPU/GPU split, and concurrency.
17. Explicit limitation: async jobs are in-memory only and are lost on process restart.

Tests:
Create unit tests for:
- config loading and validation
- task classification
- model scoring
- route decision
- queue behavior
- in-memory job lifecycle
- job TTL cleanup
- job cancellation
- ollama ps parser
- nvidia-smi parser

Create integration tests with mocked Ollama server:
1. simple_chat routes to vibethinker.
2. code_generate routes to qwen2.5-coder.
3. code_review routes to deepseek-coder.
4. agentic_reasoning routes to gpt-oss if available.
5. agentic_reasoning falls back to qwen2.5-coder if gpt-oss is unavailable and allowAsync=false.
6. agentic_reasoning returns async job if gpt-oss is busy and allowAsync=true.
7. job transitions queued -> running -> succeeded.
8. failed Ollama call stores error in memory.
9. CPU/GPU split blocks model if requireGpuOnly=true.
10. /health and /v1/router/status return useful state.

Quality bar:
- The project must compile with npm run build.
- Tests must pass with npm test.
- README must be sufficient for a new user to run it locally.
- The CLI must work after npm link.
- The server must start with `ollama-agent-router serve --config examples/gex44.yaml`.
- The project must not hardcode the user's models except in the example config.
- All model behavior must be configurable.
- Avoid overengineering, but keep the code modular enough to extend later.
- Do not add persistent storage in v1.

Generate the complete repository contents.
```

---

## 22. Minimalny backlog dla agenta

Kolejność implementacji:

```text
1. Repo bootstrap: package.json, tsconfig, build/test tooling.
2. Config schema + example gex44.yaml.
3. Task classifier.
4. Model scoring + route decision.
5. In-memory job manager.
6. Queue manager.
7. Ollama client.
8. GPU monitor + ollama ps parser.
9. HTTP API.
10. CLI.
11. Tests.
12. README.
13. Packaging npm/brew/deb.
```

---

## 23. MVP

MVP powinien mieć:

```text
- HTTP server,
- YAML config,
- POST /v1/chat/completions,
- GET /health,
- GET /v1/router/status,
- task classifier heuristic,
- model routing,
- p-queue,
- async job id,
- in-memory job manager,
- mockable Ollama client,
- tests.
```

Później można dodać:

```text
- Prometheus metrics,
- Homebrew formula,
- deb packaging,
- systemd,
- model-based classifier,
- advanced VRAM estimator,
- optional persistent backend w v2, jeśli będzie potrzebny.
```

---

## 24. Najważniejsze ryzyko

Największe ryzyko to błędna decyzja, że model zmieści się w VRAM albo że można dołożyć kolejne zadanie bez degradacji do CPU/GPU split.

Dlatego v1 powinien być konserwatywny:

```text
- ufać configowi,
- monitorować nvidia-smi,
- monitorować ollama ps,
- blokować CPU/GPU split przy requireGpuOnly,
- traktować gpt-oss jako exclusive,
- preferować async zamiast dobijać runtime,
- nie obiecywać trwałości jobów.
```

Dla GEX44 finalna polityka:

```text
multi-small:
  vibethinker + qwen2.5-coder + deepseek-coder
  kilka równoległych requestów

big-agent:
  gpt-oss:20b
  max 1 ciężki request
  async przy obciążeniu
```
