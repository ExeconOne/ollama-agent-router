import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManagedAccessConfig, defaultManagedAccessConfig } from '../../src/access-config.js';
import { hashApiKey } from '../../src/access-control.js';
import { parseConfig } from '../../src/config.js';

it('bootstraps a missing managed access config file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oar-access-unit-'));
  const access = await loadManagedAccessConfig(
    {
      bootstrapIfMissing: true,
      managedConfigPath: 'access.yaml',
      managed: defaultManagedAccessConfig,
      admin: {
        enabled: false,
        allowedIps: ['127.0.0.1'],
        trustedProxy: false,
        apiKeyHashes: [],
        clientCert: { required: false, allowedFingerprints: [], allowedSubjects: [] },
        auditLog: true
      }
    },
    dir
  );
  const raw = await readFile(join(dir, 'access.yaml'), 'utf8');
  expect(access.managedConfigPath).toBe(join(dir, 'access.yaml'));
  expect(raw).toContain('standalone:');
});

it('requires persistent storage and an admin key when the admin plane is enabled', () => {
  const base = minimalConfigYaml(`
access:
  admin:
    enabled: true
    allowedIps: [127.0.0.1]
    apiKeyHashes: []
`);
  expect(() => parseConfig(base)).toThrow(/managedConfigPath/);
  expect(() =>
    parseConfig(
      minimalConfigYaml(`
access:
  managedConfigPath: ./access.yaml
  admin:
    enabled: true
    allowedIps: [127.0.0.1]
    apiKeyHashes: []
`)
    )
  ).toThrow(/apiKeyHashes/);
});

it('requires HTTPS CA configuration when admin client certificates are mandatory', () => {
  expect(() =>
    parseConfig(
      minimalConfigYaml(`
access:
  managedConfigPath: ./access.yaml
  admin:
    enabled: true
    allowedIps: [127.0.0.1]
    apiKeyHashes: [${hashApiKey('admin')}]
    clientCert:
      required: true
`)
    )
  ).toThrow(/caPath/);
});

function minimalConfigYaml(accessYaml: string): string {
  return `
server: { host: 127.0.0.1, port: 11435, basePath: /, requestBodyLimit: 1mb, https: { enabled: false } }
${accessYaml}
ollama: { baseUrl: http://127.0.0.1:11434, openAiCompatiblePath: /v1/chat/completions, nativeApiBasePath: /api, keepAlive: 5m, requestTimeoutMs: 1000 }
gpu: { provider: none, vramTotalMb: 0, vramSafetyReserveMb: 0, maxGpuUtilizationPct: 90, requireGpuOnlyByDefault: false, monitor: { enabled: false, intervalMs: 1000, nvidiaSmiPath: nvidia-smi } }
router: { defaultMode: auto, syncMaxQueueTimeMs: 1, heavyLoadQueueDepth: 1, heavyLoadGpuFreeMbThreshold: 1, defaultTaskType: unknown, classification: { mode: heuristic, classifierTimeoutMs: 1000 } }
jobs: { store: memory, resultTtlSeconds: 1, maxAttempts: 1, cleanupIntervalMs: 1000 }
models: [{ name: one, sizeGb: 1, purpose: [simple_chat], priority: 1, maxConcurrent: 1, defaultContext: 1, maxContext: 1, timeoutMs: 1, costClass: low, exclusive: false, allowWhenBusy: true, tags: [] }]
routes: { simple_chat: [one] }
queue: { globalMaxConcurrent: 1, globalMaxQueued: 1, perUserMaxQueued: 1, defaultPriority: normal, timeoutMs: 1 }
`;
}
