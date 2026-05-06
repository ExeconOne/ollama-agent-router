# Plan zmian: kontrakt dla kong-ollama-router

Ten dokument rozpisuje zmiany po stronie `ollama-node-router`, ktore sa potrzebne,
zeby `kong-ollama-router` mogl uzywac go jako lokalnego runtime agenta zgodnie z
`kong-ollama-router/HLD.md`.

## 1. Cel

`ollama-node-router` ma pozostac procesem uruchamianym przy lokalnej Ollamie.
Kong ma podejmowac decyzje routingu, ale dane runtime i wykonanie lokalne maja
pochodzic z node-routera:

- snapshot konfiguracji routingu,
- snapshot GPU/Ollama/kolejek/jobow,
- sync wykonanie requestu na modelu wybranym przez Kong,
- async utworzenie joba na modelu wybranym przez Kong,
- status/result/cancel jobow.

## 2. Stan wyjsciowy przed implementacja

Obecne API w `src/server.ts` juz dostarcza czesc potrzebnych elementow:

- `GET /health`,
- `GET /metrics`,
- `GET /v1/router/status`,
- `GET /v1/router/models`,
- `GET /v1/router/gpu`,
- `GET /v1/jobs`,
- `GET /v1/jobs/:jobId`,
- `GET /v1/jobs/:jobId/result`,
- `DELETE /v1/jobs/:jobId`,
- `POST /v1/chat/completions`.

Braki wzgledem HLD:

- brak stabilnego `nodeId`,
- brak `GET /v1/router/capabilities`,
- brak agregatu `GET /v1/router/runtime`,
- brak `POST /v1/router/execute`, ktory wykonuje juz wybrany model bez ponownego routingu,
- brak `POST /v1/router/jobs`, ktory tworzy async job dla juz wybranego modelu,
- job id nie zawiera `nodeId`, wiec Kong nie moze deterministycznie routowac statusu joba do konkretnego node-routera,
- obecny `POST /v1/chat/completions` nadal klasyfikuje i wybiera model lokalnie; dla architektury z Kongiem zostaje przydatny jako standalone endpoint, ale nie powinien byc glownym kontraktem pluginu.

## 3. Kontrakt docelowy

### 3.1. Konfiguracja node id

Dodac pole konfiguracyjne identyfikujace instancje node-routera.

Proponowane miejsce:

```yaml
server:
  nodeId: gex44-a
```

Alternatywa: top-level `nodeId`. Pole w `server` ma mniejszy blast radius,
bo dotyczy tozsamosci procesu HTTP.

Wymagania:

- default generowany konserwatywnie, np. hostname albo `local`,
- walidacja znakow pod job id: `[a-zA-Z0-9.-]+`,
- widoczne w `capabilities`, `runtime`, async create job response i statusie.

### 3.2. GET /v1/router/capabilities

Endpoint dla statyczno-polstatycznej konfiguracji routingu. Kong moze cache'owac
odpowiedz dluzej niz runtime snapshot.

Minimalna odpowiedz:

```json
{
  "nodeId": "gex44-a",
  "status": "ok",
  "version": "0.1.5",
  "router": {
    "defaultMode": "auto",
    "syncMaxQueueTimeMs": 250,
    "heavyLoadQueueDepth": 4,
    "heavyLoadGpuFreeMbThreshold": 2048,
    "defaultTaskType": "unknown",
    "classification": {
      "mode": "heuristic",
      "classifierTimeoutMs": 1500
    }
  },
  "gpu": {
    "requireGpuOnlyByDefault": true,
    "vramSafetyReserveMb": 1024
  },
  "queue": {
    "defaultPriority": "normal",
    "timeoutMs": 120000
  },
  "models": [],
  "routes": {}
}
```

Implementacja:

- nowy helper `buildCapabilities(config, nodeId, packageVersion)`,
- nie pobierac tu Ollamy ani GPU,
- status `ok` jesli config jest zaladowany; `degraded` tylko jesli pozniej dojdzie lokalna walidacja zaleznosci.

### 3.3. GET /v1/router/runtime

Agregat runtime do szybkich decyzji Konga.

Minimalna odpowiedz:

```json
{
  "nodeId": "gex44-a",
  "status": "ok",
  "timestamp": "2026-05-06T10:00:00.000Z",
  "ollama": {
    "baseUrl": "http://127.0.0.1:11434",
    "reachable": true
  },
  "gpu": {
    "provider": "nvidia",
    "name": "RTX 4000 SFF Ada",
    "vramTotalMb": 20480,
    "vramUsedMb": 12600,
    "vramFreeMb": 7880,
    "utilizationPct": 62,
    "snapshotAgeMs": 400
  },
  "loadedModels": [],
  "queues": {
    "globalQueued": 0,
    "globalRunning": 0,
    "byModel": []
  },
  "jobs": {
    "queued": 0,
    "running": 0,
    "succeededRetained": 0,
    "failedRetained": 0
  }
}
```

Implementacja:

- uzyc `deps.queue.snapshot()`,
- uzyc `safeLoadedModels(deps.ollama)`,
- uzyc `safeGpu(deps.gpu)`,
- dodac lekki probe Ollamy, najlepiej przez nowa metode `ollama.health()` albo tanie `tags()` z timeoutem,
- policzyc status:
  - `ok`: Ollama reachable i brak krytycznych brakow runtime,
  - `degraded`: GPU snapshot missing/stale przy wlaczonym monitoringu albo Ollama probe niepewny,
  - `unavailable`: Ollama niedostepna.

Uwaga: aktualny `GpuSnapshot` nie niesie wieku snapshotu ani providera. Trzeba albo:

- rozszerzyc `GpuSnapshot` o `provider` i `snapshotAgeMs`, albo
- opakowac odpowiedz w `server.ts` wartosciami z configu i `Date.now()`.

Lepsze jest rozszerzenie typu, bo runtime contract bedzie jawny.

### 3.4. POST /v1/router/execute

Endpoint do sync wykonania requestu na modelu wybranym przez Kong. Node-router
nie klasyfikuje i nie wybiera modelu ponownie.

Request:

```json
{
  "selectedModel": "deepseek-coder:6.7b",
  "request": {
    "model": "deepseek-coder:6.7b",
    "messages": [{ "role": "user", "content": "Review code" }],
    "stream": false
  },
  "routerDecision": {
    "taskType": "code_review",
    "score": 250,
    "reason": "Selected by Kong"
  }
}
```

Response:

```json
{
  "result": {},
  "nodeId": "gex44-a",
  "selectedModel": "deepseek-coder:6.7b",
  "queueTimeMs": 4,
  "executionTimeMs": 1200
}
```

Implementacja:

- nowy `executeRequestSchema`,
- sprawdzic, czy `selectedModel` istnieje w `config.models`,
- wymusic `stream=false` albo zwrocic 400 dla `stream=true`,
- wywolac `deps.queue.runSync({ model, request, priority, timeoutMs })`,
- priorytet brac z `routerDecision.priority` albo default `config.queue.defaultPriority`,
- nie dodawac top-level `router` do wyniku; wzbogacenie publicznej odpowiedzi zostaje po stronie Konga,
- przy bledzie Ollamy zwracac kontrolowany blad z kodem upstream, jezeli `OllamaHttpError` go niesie.

### 3.5. POST /v1/router/jobs

Endpoint do async utworzenia joba na modelu wybranym przez Kong.

Request:

```json
{
  "selectedModel": "gpt-oss:20b",
  "request": {
    "model": "gpt-oss:20b",
    "messages": [{ "role": "user", "content": "Plan debugging" }]
  },
  "classification": {
    "taskType": "agentic_reasoning",
    "complexity": "heavy"
  },
  "priority": "high",
  "routerDecision": {
    "score": 281,
    "reason": "Heavy load detected"
  }
}
```

Response:

```json
{
  "id": "job_gex44-a_01JABCDEF123",
  "status": "queued",
  "position": 3,
  "nodeId": "gex44-a",
  "selectedModel": "gpt-oss:20b"
}
```

Implementacja:

- nowy `createRouterJobSchema`,
- sprawdzic `selectedModel` w `config.models`,
- znormalizowac brakujace pola `classification` do bezpiecznych defaultow,
- wywolac `deps.queue.enqueueAsync`,
- zwrocic position z queue managera,
- job store ma generowac id z node id.

### 3.6. Job id z nodeId

Zmienic `InMemoryJobStore` tak, zeby przyjmowal `nodeId` albo generator id.

Docelowy format:

```text
job_<nodeId>_<nanoid>
```

Wymagania kompatybilnosci:

- stare job id `job_<nanoid>` moga zostac wspierane w pamieci do restartu, ale nowe joby powinny miec node id,
- `GET /v1/jobs/:jobId` nie musi parsowac node id lokalnie; Kong bedzie to robil po swojej stronie,
- testy powinny sprawdzac prefiks.

## 4. Zmiany w kodzie

### 4.1. `src/types.ts`

Dodac typy:

- `NodeStatus = "ok" | "degraded" | "unavailable"`,
- `NodeCapabilities`,
- `RuntimeSnapshot`,
- `ExecuteSelectedModelRequest`,
- `ExecuteSelectedModelResponse`,
- `CreateRouterJobRequest`,
- `CreateRouterJobResponse`.

Rozszerzyc:

- `AppConfig.server.nodeId`,
- `GpuSnapshot.provider?`,
- `GpuSnapshot.snapshotAgeMs?`.

### 4.2. `src/config.ts`

Zmiany:

- dodac `server.nodeId` do schematu z defaultem,
- walidowac znaki node id,
- dodac pole do `defaultConfigYaml`,
- uwzglednic w wizard/configurator, jesli generuje kompletny config.

### 4.3. `src/server.ts`

Dodac endpointy:

- `GET /v1/router/capabilities`,
- `GET /v1/router/runtime`,
- `POST /v1/router/execute`,
- `POST /v1/router/jobs`.

Zachowac istniejacy `POST /v1/chat/completions` jako standalone router endpoint.
Nie przenosic logiki Konga do node-routera.

### 4.4. `src/queue-manager.ts`

Zmiany:

- dodac metode `enqueueSelectedAsync`, jesli obecne `enqueueAsync` bedzie za mocno zwiazane z lokalna klasyfikacja,
- upewnic sie, ze `runSync` zawsze aktualizuje `pending` dla selected-model execution,
- dodac czytelne bledy dla nieznanego modelu i limitu kolejki.

### 4.5. `src/job-store.ts`

Zmiany:

- przyjmowac `nodeId` w konstruktorze albo `create`,
- generowac `job_<nodeId>_<id>`,
- dodac `summary()` dla runtime jobs counters:
  - queued,
  - running,
  - succeededRetained,
  - failedRetained,
  - cancelledRetained,
  - expiredRetained.

### 4.6. `src/ollama.ts`

Zmiany:

- dodac `health(): Promise<boolean>` albo `reachable(): Promise<boolean>`,
- rozpoznawac `OllamaHttpError` w server error handlerze,
- utrzymac `chat()` jako jedyne miejsce, ktore usuwa `request.router` i wymusza model.

### 4.7. `src/gpu.ts`

Zmiany:

- jesli monitor cache'uje snapshot, przechowywac timestamp odczytu,
- zwracac `provider` i `snapshotAgeMs`,
- dla provider `none` zwracac jawny brak GPU zamiast niejednoznacznego `undefined`, jesli to uprosciloby runtime status.

## 5. Testy

### 5.1. Integration API

Dodac testy:

- `GET /v1/router/capabilities` zwraca nodeId, modele, routes i router defaults,
- `GET /v1/router/runtime` zwraca queue snapshot, loaded models, gpu, jobs summary i ollama reachability,
- `POST /v1/router/execute` wykonuje dokladnie `selectedModel` i nie robi lokalnego routingu,
- `POST /v1/router/execute` odrzuca `stream=true`,
- `POST /v1/router/execute` odrzuca nieznany model,
- `POST /v1/router/jobs` tworzy job z id zawierajacym nodeId,
- `POST /v1/router/jobs` odrzuca nieznany model,
- basePath obejmuje nowe endpointy.

### 5.2. Unit

Dodac testy:

- walidacja `server.nodeId`,
- `InMemoryJobStore` generuje id w formacie `job_<nodeId>_<id>`,
- `jobs.summary()` liczy statusy,
- parser/mapper runtime snapshotu poprawnie obsluguje brak GPU i brak Ollamy.

### 5.3. Backward compatibility

Istniejace testy `POST /v1/chat/completions` powinny zostac zielone. Ten endpoint
jest nadal uzyteczny jako tryb standalone bez Konga.

## 6. Kolejnosc implementacji

1. Dodac `server.nodeId` w typach, config schema, default config i testach.
2. Dodac typy kontraktu oraz helpery `buildCapabilities` i `buildRuntimeSnapshot`.
3. Dodac `GET /v1/router/capabilities`.
4. Dodac `jobs.summary()` i `GET /v1/router/runtime`.
5. Dodac generowanie job id z `nodeId`.
6. Dodac `POST /v1/router/execute`.
7. Dodac `POST /v1/router/jobs`.
8. Rozszerzyc `/metrics` o runtime metryki wymagane przez HLD:
   - `oar_jobs_total{status,model}`,
   - `oar_gpu_vram_free_mb`,
   - `oar_gpu_utilization_pct`,
   - `oar_ollama_reachable`.
9. Uzupelnic README o sekcje "Kong runtime agent API".
10. Uruchomic `npm test`, `npm run typecheck`, `npm run build`.

## 7. Kryteria akceptacji

- Kong moze pobrac `GET /v1/router/capabilities` bez dotykania GPU/Ollamy.
- Kong moze pobrac `GET /v1/router/runtime` jednym requestem i dostac GPU, loaded models, queue/running oraz jobs summary.
- Kong moze wykonac sync request przez `POST /v1/router/execute` bez drugiej decyzji routingowej w node-routerze.
- Kong moze utworzyc async job przez `POST /v1/router/jobs` bez drugiej decyzji routingowej w node-routerze.
- Nowe job id zawiera node id i nadaje sie do routingu status/result przez Kong.
- Standalone `POST /v1/chat/completions` nadal dziala jak dotychczas.
- Wszystkie nowe endpointy dzialaja pod `server.basePath`.
- Testy integracyjne pokrywaja kontrakt plugin <-> node-router.

## 8. Ryzyka i decyzje do zamkniecia

- Czy `nodeId` ma byc w `server.nodeId`, czy top-level `nodeId`.
- Czy `POST /v1/router/execute` ma zwracac surowy wynik Ollamy plus metadane, czy wrapper `{ result, ... }`.
  Dla Konga praktyczniejszy jest wrapper, bo jednoznacznie oddziela wynik modelu od telemetryki wykonania.
- Czy runtime `ollama.reachable` ma uzywac `GET /api/tags`, czy osobnego taniego probe.
- Jak ostro mapowac bledy Ollamy: 502 dla upstream HTTP error, 504 dla timeout, 500 dla bugow lokalnych.
- Czy `job_<nodeId>_<id>` wystarcza, jesli `nodeId` zawiera `_`. Najprosciej zakazac `_` w `nodeId` albo parsowac od konca po drugim separatorze. Rekomendacja: dopuscic tylko `[a-zA-Z0-9.-]+`.
