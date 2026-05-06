import { readFile } from 'node:fs/promises';
import { parseConfig } from '../../src/config.js';

it('loads and validates the GEX44 example config', async () => {
  const raw = await readFile('examples/gex44.yaml', 'utf8');
  const config = parseConfig(raw);
  expect(config.models.map((model) => model.name)).toContain('gpt-oss:20b');
  expect(config.models.find((model) => model.name === 'gpt-oss:20b')?.exclusive).toBe(true);
});

it('rejects routes that reference unknown models', () => {
  expect(() =>
    parseConfig(`
server: { host: 127.0.0.1, port: 11435, basePath: /, requestBodyLimit: 1mb, https: { enabled: false } }
ollama: { baseUrl: http://127.0.0.1:11434, openAiCompatiblePath: /v1/chat/completions, nativeApiBasePath: /api, keepAlive: 5m, requestTimeoutMs: 1000 }
gpu: { provider: none, vramTotalMb: 0, vramSafetyReserveMb: 0, maxGpuUtilizationPct: 90, requireGpuOnlyByDefault: false, monitor: { enabled: false, intervalMs: 1000, nvidiaSmiPath: nvidia-smi } }
router: { defaultMode: auto, syncMaxQueueTimeMs: 1, heavyLoadQueueDepth: 1, heavyLoadGpuFreeMbThreshold: 1, defaultTaskType: unknown, classification: { mode: heuristic, classifierTimeoutMs: 1000 } }
jobs: { store: memory, resultTtlSeconds: 1, maxAttempts: 1, cleanupIntervalMs: 1000 }
models: [{ name: one, sizeGb: 1, purpose: [simple_chat], priority: 1, maxConcurrent: 1, defaultContext: 1, maxContext: 1, timeoutMs: 1, costClass: low, exclusive: false, allowWhenBusy: true, tags: [] }]
routes: { simple_chat: [missing] }
queue: { globalMaxConcurrent: 1, globalMaxQueued: 1, perUserMaxQueued: 1, defaultPriority: normal, timeoutMs: 1 }
`)
  ).toThrow(/unknown models/);
});

it('requires cert and key paths when HTTPS is enabled', async () => {
  const raw = await readFile('examples/gex44.yaml', 'utf8');
  expect(() => parseConfig(raw.replace('enabled: false', 'enabled: true'))).toThrow(/certPath.*keyPath/);
});

it('rejects node ids that cannot be embedded in routed job ids', async () => {
  const raw = await readFile('examples/gex44.yaml', 'utf8');
  expect(() => parseConfig(raw.replace('host: 127.0.0.1', 'nodeId: bad_node\n  host: 127.0.0.1'))).toThrow(/nodeId/);
});
