import { AppConfig, ChatCompletionRequest, GpuSnapshot, LoadedModel } from '../src/types.js';
import { createRequest, createResponse } from 'node-mocks-http';
import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { OllamaClient } from '../src/ollama.js';
import { GpuMonitor } from '../src/gpu.js';
import { InMemoryJobStore } from '../src/job-store.js';
import { QueueManager } from '../src/queue-manager.js';
import { createApp } from '../src/server.js';
import { adminPlaneConfigSchema, defaultManagedAccessConfig } from '../src/access-config.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    server: {
      nodeId: 'test-node',
      host: '127.0.0.1',
      port: 0,
      basePath: '/',
      requestBodyLimit: '2mb',
      https: { enabled: false }
    },
    access: {
      bootstrapIfMissing: true,
      managed: defaultManagedAccessConfig,
      admin: adminPlaneConfigSchema.parse({})
    },
    ollama: {
      baseUrl: 'http://127.0.0.1:11434',
      openAiCompatiblePath: '/v1/chat/completions',
      nativeApiBasePath: '/api',
      keepAlive: '5m',
      requestTimeoutMs: 10000
    },
    gpu: {
      provider: 'nvidia',
      name: 'Test GPU',
      vramTotalMb: 20480,
      vramSafetyReserveMb: 512,
      maxGpuUtilizationPct: 95,
      requireGpuOnlyByDefault: false,
      monitor: { enabled: false, intervalMs: 1000, nvidiaSmiPath: 'nvidia-smi' }
    },
    router: {
      defaultMode: 'auto',
      syncMaxQueueTimeMs: 50,
      heavyLoadQueueDepth: 5,
      heavyLoadGpuFreeMbThreshold: 1024,
      defaultTaskType: 'unknown',
      classification: { mode: 'heuristic', classifierTimeoutMs: 1000 }
    },
    jobs: {
      store: 'memory',
      resultTtlSeconds: 3600,
      maxAttempts: 1,
      cleanupIntervalMs: 1000
    },
    models: [
      {
        name: 'B-A-M-N/vibethinker:1.5b',
        sizeGb: 3.6,
        purpose: ['triage', 'simple_chat', 'summarize'],
        priority: 50,
        maxConcurrent: 2,
        defaultContext: 4096,
        maxContext: 8192,
        timeoutMs: 10000,
        costClass: 'low',
        exclusive: false,
        allowWhenBusy: true
      },
      {
        name: 'qwen2.5-coder:7b',
        sizeGb: 4.7,
        purpose: ['code_generate', 'code_fix', 'tool_use', 'agentic_reasoning'],
        priority: 70,
        maxConcurrent: 1,
        defaultContext: 8192,
        maxContext: 32768,
        timeoutMs: 10000,
        costClass: 'medium',
        exclusive: false,
        allowWhenBusy: true
      },
      {
        name: 'deepseek-coder:6.7b',
        sizeGb: 3.8,
        purpose: ['code_review', 'code_generate', 'code_fix'],
        priority: 68,
        maxConcurrent: 1,
        defaultContext: 8192,
        maxContext: 16384,
        timeoutMs: 10000,
        costClass: 'medium',
        exclusive: false,
        allowWhenBusy: true
      },
      {
        name: 'gpt-oss:20b',
        sizeGb: 14,
        purpose: ['agentic_reasoning', 'large_context', 'tool_use'],
        priority: 95,
        maxConcurrent: 1,
        defaultContext: 16384,
        maxContext: 65536,
        timeoutMs: 10000,
        costClass: 'high',
        exclusive: true,
        allowWhenBusy: false
      }
    ],
    routes: {
      triage: ['B-A-M-N/vibethinker:1.5b'],
      simple_chat: ['B-A-M-N/vibethinker:1.5b', 'qwen2.5-coder:7b'],
      summarize: ['B-A-M-N/vibethinker:1.5b'],
      code_generate: ['qwen2.5-coder:7b', 'deepseek-coder:6.7b'],
      code_review: ['deepseek-coder:6.7b', 'qwen2.5-coder:7b'],
      code_fix: ['qwen2.5-coder:7b', 'deepseek-coder:6.7b'],
      agentic_reasoning: ['gpt-oss:20b', 'qwen2.5-coder:7b'],
      large_context: ['gpt-oss:20b', 'qwen2.5-coder:7b'],
      tool_use: ['qwen2.5-coder:7b', 'gpt-oss:20b'],
      unknown: ['B-A-M-N/vibethinker:1.5b']
    },
    queue: { globalMaxConcurrent: 4, globalMaxQueued: 50, perUserMaxQueued: 10, defaultPriority: 'normal', timeoutMs: 10000 }
  };
  return { ...base, ...overrides };
}

export class MockOllamaClient implements OllamaClient {
  calls: Array<{ model: string; request: ChatCompletionRequest }> = [];
  loadedModels: LoadedModel[] = [];
  fail = false;
  delayMs = 0;
  gate: Promise<void> | undefined;

  async chat(request: ChatCompletionRequest, model: string): Promise<unknown> {
    this.calls.push({ model, request });
    if (this.gate) await this.gate;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.fail) throw new Error('mock ollama failure');
    return {
      id: `chatcmpl_${model}`,
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
    };
  }

  async tags(): Promise<unknown> {
    return { models: [] };
  }

  async ps(): Promise<LoadedModel[]> {
    return this.loadedModels;
  }

  async health(): Promise<boolean> {
    return !this.fail;
  }
}

export class MockGpuMonitor implements GpuMonitor {
  constructor(
    public gpu: GpuSnapshot | undefined = {
      provider: 'nvidia',
      name: 'Test GPU',
      vramTotalMb: 20480,
      vramUsedMb: 1000,
      vramFreeMb: 19000,
      utilizationPct: 10,
      snapshotAgeMs: 0
    }
  ) {}

  async snapshot(): Promise<GpuSnapshot | undefined> {
    return this.gpu;
  }
}

export function createTestRuntime(config = testConfig()) {
  const ollama = new MockOllamaClient();
  const gpu = new MockGpuMonitor();
  const jobs = new InMemoryJobStore(config.jobs, config.server.nodeId);
  const queue = new QueueManager(config, ollama, jobs);
  const app = createApp(config, { ollama, gpu, jobs, queue });
  return { app, ollama, gpu, jobs, queue, config };
}

export async function requestJson(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
  options: { headers?: Record<string, string>; remoteAddress?: string } = {}
) {
  const req = createRequest<Request>({
    method: method as 'GET' | 'POST' | 'DELETE',
    url: path,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) },
    body: body as Record<string, unknown> | undefined,
    connection: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' }
  });
  const res = createResponse<Response>({ eventEmitter: EventEmitter });
  await new Promise<void>((resolve, reject) => {
    res.on('end', resolve);
    res.on('error', reject);
    (app as unknown as { handle: (req: Request, res: Response) => void }).handle(req, res);
  });
  const data = res._getData();
  const contentType = String(res.getHeader('content-type') ?? '');
  return {
    status: res.statusCode,
    body: contentType.includes('application/json') ? parseJsonPayload(String(data)) : data
  };
}

function parseJsonPayload(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return JSON.parse(firstJsonValue(data));
  }
}

function firstJsonValue(data: string): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;
  for (let index = 0; index < data.length; index += 1) {
    const char = data[index];
    if (!started) {
      if (char === '{' || char === '[') {
        started = true;
        depth = 1;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{' || char === '[') depth += 1;
    if (char === '}' || char === ']') depth -= 1;
    if (depth === 0) return data.slice(0, index + 1);
  }
  return data;
}
