import { existsSync } from 'node:fs';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';
import { z } from 'zod';
import { AppConfig, taskTypes } from './types.js';
import { accessConfigSchema, loadManagedAccessConfig } from './access-config.js';

const taskTypeSchema = z.enum(taskTypes);
const optionalStringSchema = z.preprocess((value) => (value === null ? undefined : value), z.string().min(1).optional());

export const modelSpecSchema = z.object({
  name: z.string().min(1),
  sizeGb: z.number().positive(),
  purpose: z.array(z.string()).default([]),
  priority: z.number().default(50),
  maxConcurrent: z.number().int().positive(),
  defaultContext: z.number().int().positive(),
  maxContext: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  costClass: z.enum(['low', 'medium', 'high']).default('medium'),
  exclusive: z.boolean().default(false),
  allowWhenBusy: z.boolean().default(false)
});

export const appConfigSchema = z.object({
  server: z.object({
    nodeId: z.string().regex(/^[a-zA-Z0-9.-]+$/, 'server.nodeId may contain only letters, numbers, dots, and dashes').default('local'),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    basePath: z.string().min(1).default('/'),
    requestBodyLimit: z.string().min(1),
    https: z
      .object({
        enabled: z.boolean().default(false),
        certPath: optionalStringSchema,
        keyPath: optionalStringSchema,
        caPath: optionalStringSchema
      })
      .default({ enabled: false })
  }),
  access: accessConfigSchema,
  ollama: z.object({
    baseUrl: z.string().url(),
    openAiCompatiblePath: z.string().min(1).default('/v1/chat/completions'),
    nativeApiBasePath: z.string().min(1).default('/api'),
    keepAlive: z.string().default('5m'),
    requestTimeoutMs: z.number().int().positive()
  }),
  gpu: z.object({
    provider: z.enum(['none', 'nvidia']).default('none'),
    name: z.string().optional(),
    vramTotalMb: z.number().nonnegative(),
    vramSafetyReserveMb: z.number().nonnegative(),
    maxGpuUtilizationPct: z.number().min(1).max(100),
    requireGpuOnlyByDefault: z.boolean().default(false),
    monitor: z.object({
      enabled: z.boolean().default(false),
      intervalMs: z.number().int().positive(),
      nvidiaSmiPath: z.string().min(1).default('nvidia-smi')
    })
  }),
  router: z.object({
    defaultMode: z.enum(['auto', 'sync', 'async']).default('auto'),
    syncMaxQueueTimeMs: z.number().int().nonnegative(),
    heavyLoadQueueDepth: z.number().int().nonnegative(),
    heavyLoadGpuFreeMbThreshold: z.number().int().nonnegative(),
    defaultTaskType: taskTypeSchema.default('unknown'),
    classification: z.object({
      mode: z.enum(['heuristic', 'model']).default('heuristic'),
      optionalClassifierModel: z.string().optional(),
      classifierTimeoutMs: z.number().int().positive()
    })
  }),
  jobs: z.object({
    store: z.literal('memory').default('memory'),
    resultTtlSeconds: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    cleanupIntervalMs: z.number().int().positive()
  }),
  models: z.array(modelSpecSchema).min(1),
  routes: z.record(z.string(), z.array(z.string())),
  queue: z.object({
    globalMaxConcurrent: z.number().int().positive(),
    globalMaxQueued: z.number().int().nonnegative(),
    perUserMaxQueued: z.number().int().nonnegative(),
    defaultPriority: z.enum(['low', 'normal', 'high']).default('normal'),
    timeoutMs: z.number().int().positive()
  })
});

export const configLookupOrder = (explicitPath?: string): string[] => {
  const paths = [
    './ollama-agent-router.yaml',
    `${homedir()}/.config/ollama-agent-router/config.yaml`,
    '/etc/ollama-agent-router/config.yaml'
  ];
  return explicitPath ? [explicitPath, ...paths] : paths;
};

export async function findConfigPath(explicitPath?: string): Promise<string> {
  for (const candidate of configLookupOrder(explicitPath)) {
    const path = resolve(candidate);
    try {
      await access(path);
      return path;
    } catch {
      // Try the next lookup path.
    }
  }
  throw new Error(`No config file found. Tried: ${configLookupOrder(explicitPath).join(', ')}`);
}

export async function loadConfig(explicitPath?: string): Promise<{ path: string; config: AppConfig }> {
  const path = await findConfigPath(explicitPath);
  const raw = await readFile(path, 'utf8');
  const config = parseConfig(raw);
  config.access = await loadManagedAccessConfig(config.access, dirname(path));
  return { path, config };
}

export function parseConfig(raw: string): AppConfig {
  const parsed = YAML.parse(raw);
  const config = appConfigSchema.parse(parsed) as AppConfig;
  if (config.server.https.enabled && (!config.server.https.certPath || !config.server.https.keyPath)) {
    throw new Error('server.https.certPath and server.https.keyPath are required when HTTPS is enabled');
  }
  if (config.access.admin.enabled && !config.access.managedConfigPath) {
    throw new Error('access.managedConfigPath is required when access.admin.enabled is true');
  }
  if (config.access.admin.enabled && config.access.admin.apiKeyHashes.length === 0) {
    throw new Error('access.admin.apiKeyHashes must contain at least one hash when access.admin.enabled is true');
  }
  if (config.access.admin.enabled && config.access.admin.clientCert.required && (!config.server.https.enabled || !config.server.https.caPath)) {
    throw new Error('server.https.enabled and server.https.caPath are required when access.admin.clientCert.required is true');
  }
  const modelNames = new Set(config.models.map((model) => model.name));
  const missingRoutes = Object.entries(config.routes)
    .flatMap(([taskType, names]) => (names ?? []).map((name) => ({ taskType, name })))
    .filter(({ name }) => !modelNames.has(name));
  if (missingRoutes.length > 0) {
    const formatted = missingRoutes.map((route) => `${route.taskType}:${route.name}`).join(', ');
    throw new Error(`Routes reference unknown models: ${formatted}`);
  }
  return config;
}

export async function writeDefaultConfig(path: string): Promise<void> {
  const target = resolve(path);
  if (existsSync(target)) {
    throw new Error(`Refusing to overwrite existing config: ${target}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, defaultConfigYaml, 'utf8');
}

export const defaultConfigYaml = `server:
  nodeId: local
  host: 127.0.0.1
  port: 11435
  basePath: /
  requestBodyLimit: 4mb
  https:
    enabled: false
    certPath:
    keyPath:
    caPath:
access:
  bootstrapIfMissing: true
  managedConfigPath:
  admin:
    enabled: false
    allowedIps: [127.0.0.1, "::1"]
    trustedProxy: false
    apiKeyHashes: []
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
          requireApiKey: false
          anonymous: allow
      runtimeAgent:
        enabled: true
        auth:
          requireApiKey: false
          anonymous: allow
    apiKeys: []
ollama:
  baseUrl: http://127.0.0.1:11434
  openAiCompatiblePath: /v1/chat/completions
  nativeApiBasePath: /api
  keepAlive: 5m
  requestTimeoutMs: 120000
gpu:
  provider: none
  name: Local GPU
  vramTotalMb: 0
  vramSafetyReserveMb: 1024
  maxGpuUtilizationPct: 95
  requireGpuOnlyByDefault: false
  monitor:
    enabled: false
    intervalMs: 5000
    nvidiaSmiPath: nvidia-smi
router:
  defaultMode: auto
  syncMaxQueueTimeMs: 250
  heavyLoadQueueDepth: 4
  heavyLoadGpuFreeMbThreshold: 2048
  defaultTaskType: unknown
  classification:
    mode: heuristic
    optionalClassifierModel:
    classifierTimeoutMs: 1500
jobs:
  store: memory
  resultTtlSeconds: 86400
  maxAttempts: 2
  cleanupIntervalMs: 60000
models:
  - name: llama3.2:3b
    sizeGb: 2.0
    purpose: [simple_chat, summarize, triage]
    priority: 50
    maxConcurrent: 1
    defaultContext: 4096
    maxContext: 8192
    timeoutMs: 120000
    costClass: low
    exclusive: false
    allowWhenBusy: true
routes:
  triage: [llama3.2:3b]
  simple_chat: [llama3.2:3b]
  summarize: [llama3.2:3b]
  code_generate: [llama3.2:3b]
  code_review: [llama3.2:3b]
  code_fix: [llama3.2:3b]
  agentic_reasoning: [llama3.2:3b]
  large_context: [llama3.2:3b]
  tool_use: [llama3.2:3b]
  unknown: [llama3.2:3b]
queue:
  globalMaxConcurrent: 2
  globalMaxQueued: 100
  perUserMaxQueued: 20
  defaultPriority: normal
  timeoutMs: 120000
`;
