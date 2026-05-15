import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import express, { NextFunction, Request, Response } from 'express';
import { pinoHttp } from 'pino-http';
import { z } from 'zod';
import { classifyTask } from './classifier.js';
import { AppConfig, ChatCompletionRequest, Classification, ModelSpec, NodeCapabilities, RuntimeSnapshot, taskTypes } from './types.js';
import { GpuMonitor } from './gpu.js';
import { OllamaClient, OllamaHttpError } from './ollama.js';
import { RoutingEngine, normalizeRouterMetadata, priorityWeights } from './router-engine.js';
import { QueueManager } from './queue-manager.js';
import { InMemoryJobStore, parseJobError, parseJobResult } from './job-store.js';
import { logger } from './logger.js';
import { AccessControlStore, auditAdmin, getAccessErrorStatus } from './access-control.js';
import { managedAccessConfigSchema } from './access-config.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const chatRequestSchema = z
  .object({
    model: z.string().optional(),
    messages: z.array(z.object({ role: z.string(), content: z.unknown() })).min(1),
    stream: z.boolean().optional(),
    router: z
      .object({
        mode: z.enum(['auto', 'sync', 'async']).optional(),
        allowAsync: z.boolean().optional(),
        taskType: z.string().optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
        preferredModels: z.array(z.string()).optional(),
        forbiddenModels: z.array(z.string()).optional(),
        maxQueueTimeMs: z.number().int().nonnegative().optional(),
        maxExecutionTimeMs: z.number().int().positive().optional(),
        requireGpuOnly: z.boolean().optional()
      })
      .optional()
  })
  .passthrough();

const classificationSchema = z
  .object({
    taskType: z.enum(taskTypes).optional(),
    complexity: z.enum(['light', 'medium', 'heavy']).optional(),
    requiresLargeContext: z.boolean().optional(),
    requiresToolUse: z.boolean().optional(),
    confidence: z.number().min(0).max(1).optional()
  })
  .optional();

const routerDecisionSchema = z
  .object({
    taskType: z.enum(taskTypes).optional(),
    score: z.number().optional(),
    reason: z.string().optional(),
    priority: z.enum(['low', 'normal', 'high']).optional()
  })
  .passthrough()
  .optional();

const executeRequestSchema = z.object({
  selectedModel: z.string().min(1),
  request: chatRequestSchema,
  priority: z.enum(['low', 'normal', 'high']).optional(),
  routerDecision: routerDecisionSchema
});

const createRouterJobSchema = z.object({
  selectedModel: z.string().min(1),
  request: chatRequestSchema,
  classification: classificationSchema,
  priority: z.enum(['low', 'normal', 'high']).optional(),
  routerDecision: routerDecisionSchema
});

export interface ServerDependencies {
  ollama: OllamaClient;
  gpu: GpuMonitor;
  jobs: InMemoryJobStore;
  queue: QueueManager;
  access?: AccessControlStore;
}

export function createApp(config: AppConfig, deps: ServerDependencies): express.Express {
  const app = express();
  const api = express.Router();
  const routing = new RoutingEngine(config);
  const access = deps.access ?? new AccessControlStore(config.access);
  const standaloneAccess = access.publicMiddleware('standalone');
  const runtimeAgentAccess = access.publicMiddleware('runtimeAgent');
  const sharedJobAccess = access.publicMiddleware(['standalone', 'runtimeAgent']);
  const adminAccess = access.adminMiddleware();

  if (process.env.NODE_ENV !== 'test') {
    app.use(pinoHttp({ logger }));
  }
  app.use(express.json({ limit: config.server.requestBodyLimit }));

  api.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'ollama-agent-router' });
  });

  api.get('/metrics', async (_req, res) => {
    const snapshot = deps.queue.snapshot();
    const jobSummary = deps.jobs.summary();
    const jobsByStatusAndModel = countJobsByStatusAndModel(deps.jobs.list(Number.MAX_SAFE_INTEGER));
    const [gpu, ollamaReachable] = await Promise.all([safeGpu(deps.gpu), safeOllamaReachable(deps.ollama)]);
    res.type('text/plain').send(
      [
        `oar_queue_global_queued ${snapshot.globalQueued}`,
        `oar_queue_global_running ${snapshot.globalRunning}`,
        `oar_ollama_reachable ${ollamaReachable ? 1 : 0}`,
        ...(gpu
          ? [
              `oar_gpu_vram_free_mb ${gpu.vramFreeMb}`,
              `oar_gpu_utilization_pct ${gpu.utilizationPct}`
            ]
          : []),
        `oar_jobs_total{status="queued"} ${jobSummary.queued}`,
        `oar_jobs_total{status="running"} ${jobSummary.running}`,
        `oar_jobs_total{status="succeeded"} ${jobSummary.succeededRetained}`,
        `oar_jobs_total{status="failed"} ${jobSummary.failedRetained}`,
        `oar_jobs_total{status="cancelled"} ${jobSummary.cancelledRetained}`,
        `oar_jobs_total{status="expired"} ${jobSummary.expiredRetained}`,
        ...jobsByStatusAndModel.map(
          (item) =>
            `oar_jobs_total{status="${escapeMetricLabel(item.status)}",model="${escapeMetricLabel(item.model)}"} ${item.count}`
        ),
        ...snapshot.byModel.flatMap((item) => [
          `oar_model_queue_depth{model="${escapeMetricLabel(item.model)}"} ${item.queued}`,
          `oar_model_running{model="${escapeMetricLabel(item.model)}"} ${item.running}`
        ])
      ].join('\n')
    );
  });

  api.get('/v1/admin/access/config', adminAccess, (req, res) => {
    auditAdmin(config.access.admin, req, 'success', 'config_read', res.locals.admin?.remoteIp);
    res.json(access.getConfig());
  });

  api.put('/v1/admin/access/config', adminAccess, async (req, res, next) => {
    try {
      const payload = z
        .object({
          expectedVersion: z.number().int().nonnegative().optional(),
          config: managedAccessConfigSchema
        })
        .parse(req.body);
      const updated = await access.replaceConfig(payload.config, payload.expectedVersion);
      auditAdmin(config.access.admin, req, 'success', 'config_updated', res.locals.admin?.remoteIp);
      res.json(updated);
    } catch (error) {
      auditAdmin(config.access.admin, req, 'failure', error instanceof Error ? error.message : String(error), res.locals.admin?.remoteIp);
      next(error);
    }
  });

  api.post('/v1/admin/access/keys', adminAccess, async (req, res, next) => {
    try {
      const key = await access.addApiKey(req.body);
      auditAdmin(config.access.admin, req, 'success', 'key_added', res.locals.admin?.remoteIp, key.id);
      res.status(201).json(key);
    } catch (error) {
      auditAdmin(config.access.admin, req, 'failure', error instanceof Error ? error.message : String(error), res.locals.admin?.remoteIp);
      next(error);
    }
  });

  api.delete('/v1/admin/access/keys/:id', adminAccess, async (req, res, next) => {
    try {
      const revoked = await access.revokeApiKey(req.params.id);
      auditAdmin(config.access.admin, req, 'success', 'key_revoked', res.locals.admin?.remoteIp, revoked.id);
      res.json({ revoked });
    } catch (error) {
      auditAdmin(config.access.admin, req, 'failure', error instanceof Error ? error.message : String(error), res.locals.admin?.remoteIp);
      next(error);
    }
  });

  api.get('/v1/router/capabilities', runtimeAgentAccess, (_req, res) => {
    res.json(buildCapabilities(config));
  });

  api.get('/v1/router/runtime', runtimeAgentAccess, async (_req, res, next) => {
    try {
      res.json(await buildRuntimeSnapshot(config, deps));
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/router/status', runtimeAgentAccess, async (_req, res, next) => {
    try {
      res.json({
        nodeId: config.server.nodeId,
        service: 'ollama-agent-router',
        queue: deps.queue.snapshot(),
        gpu: await safeGpu(deps.gpu),
        loadedModels: await safeLoadedModels(deps.ollama),
        config: {
          models: config.models.length,
          routes: Object.keys(config.routes),
          basePath: normalizeBasePath(config.server.basePath),
          protocol: config.server.https.enabled ? 'https' : 'http'
        }
      });
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/router/models', runtimeAgentAccess, async (_req, res, next) => {
    try {
      res.json({
        configured: config.models,
        ollama: await deps.ollama.tags(),
        loaded: await safeLoadedModels(deps.ollama)
      });
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/router/gpu', runtimeAgentAccess, async (_req, res, next) => {
    try {
      res.json((await safeGpu(deps.gpu)) ?? { provider: config.gpu.provider, available: false });
    } catch (error) {
      next(error);
    }
  });

  api.get('/v1/jobs', sharedJobAccess, (_req, res) => {
    res.json({ jobs: deps.jobs.list() });
  });

  api.get('/v1/jobs/:jobId', sharedJobAccess, (req, res) => {
    const job = deps.jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: { message: 'Job not found' } });
    return res.json(job);
  });

  api.get('/v1/jobs/:jobId/result', sharedJobAccess, (req, res) => {
    const job = deps.jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: { message: 'Job not found' } });
    if (job.status === 'failed') return res.status(500).json({ status: job.status, error: parseJobError(job) });
    if (job.status !== 'succeeded') return res.status(202).json({ status: job.status });
    return res.json(parseJobResult(job));
  });

  api.delete('/v1/jobs/:jobId', sharedJobAccess, (req, res) => {
    const job = deps.jobs.cancel(req.params.jobId);
    if (!job) return res.status(404).json({ error: { message: 'Job not found' } });
    return res.json(job);
  });

  api.post('/v1/router/execute', runtimeAgentAccess, async (req, res, next) => {
    try {
      const payload = executeRequestSchema.parse(req.body);
      if (payload.request.stream) {
        return res.status(400).json({ error: { message: 'Streaming is not supported by ollama-agent-router v1' } });
      }
      const model = findConfiguredModel(config, payload.selectedModel);
      if (!model) {
        return res.status(404).json({ error: { message: `Unknown configured model: ${payload.selectedModel}` } });
      }

      const priorityName = payload.priority ?? payload.routerDecision?.priority ?? config.queue.defaultPriority;
      const output = await deps.queue.runSync({
        model,
        request: payload.request as ChatCompletionRequest,
        priority: priorityWeights[priorityName],
        timeoutMs: payload.request.router?.maxExecutionTimeMs ?? config.queue.timeoutMs
      });
      return res.json({
        result: output.result,
        nodeId: config.server.nodeId,
        selectedModel: model.name,
        queueTimeMs: output.queueTimeMs,
        executionTimeMs: output.executionTimeMs
      });
    } catch (error) {
      next(error);
    }
  });

  api.post('/v1/router/jobs', runtimeAgentAccess, (req, res, next) => {
    try {
      const payload = createRouterJobSchema.parse(req.body);
      if (payload.request.stream) {
        return res.status(400).json({ error: { message: 'Streaming is not supported by ollama-agent-router v1' } });
      }
      const model = findConfiguredModel(config, payload.selectedModel);
      if (!model) {
        return res.status(404).json({ error: { message: `Unknown configured model: ${payload.selectedModel}` } });
      }

      const classification = normalizeClassification(config, payload.classification);
      const priorityName = payload.priority ?? payload.routerDecision?.priority ?? config.queue.defaultPriority;
      const job = deps.queue.enqueueAsync({
        model,
        request: payload.request as ChatCompletionRequest,
        classification,
        priority: priorityWeights[priorityName]
      });
      return res.status(202).json({
        id: job.id,
        status: 'queued',
        position: job.position,
        nodeId: config.server.nodeId,
        selectedModel: model.name
      });
    } catch (error) {
      next(error);
    }
  });

  api.post('/v1/chat/completions', standaloneAccess, async (req, res, next) => {
    try {
      const request = chatRequestSchema.parse(req.body) as ChatCompletionRequest;
      if (request.stream) {
        return res.status(400).json({ error: { message: 'Streaming is not supported by ollama-agent-router v1' } });
      }

      const router = normalizeRouterMetadata(config, request.router);
      const classification = classifyTask(request, router.taskType);
      const loadedModels = await safeLoadedModels(deps.ollama);
      const gpu = await safeGpu(deps.gpu);
      const decision = routing.decide({
        request,
        router,
        classification,
        loadedModels,
        gpu,
        queueDepthByModel: deps.queue.queueDepthByModel(),
        runningByModel: deps.queue.runningByModel()
      });

      if (decision.type === 'reject') {
        return res.status(decision.statusCode).json({ error: { message: decision.reason } });
      }

      const priority = priorityWeights[router.priority];
      if (decision.type === 'async') {
        const job = deps.queue.enqueueAsync({
          model: decision.model,
          request,
          classification,
          priority
        });
        return res.status(202).json({
          id: job.id,
          object: 'router.job',
          status: 'queued',
          message: 'Heavy load. Job accepted for asynchronous processing.',
          router: {
            mode: 'async',
            taskType: classification.taskType,
            preferredModel: decision.model.name,
            position: job.position,
            estimatedClass: classification.complexity
          }
        });
      }

      const output = await deps.queue.runSync({
        model: decision.model,
        request,
        priority,
        timeoutMs: router.maxExecutionTimeMs
      });
      return res.json(
        withRouterMetadata(output.result, {
          mode: 'sync',
          taskType: classification.taskType,
          selectedModel: decision.model.name,
          fallbackModels: decision.fallbackModels.filter((name) => name !== decision.model.name),
          queueTimeMs: output.queueTimeMs,
          executionTimeMs: output.executionTimeMs,
          decisionReason: decision.reason
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.use(normalizeBasePath(config.server.basePath), api);

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = getAccessErrorStatus(error) ?? (error instanceof z.ZodError ? 400 : error instanceof OllamaHttpError ? 502 : 500);
    res.status(status).json({ error: { message } });
  });

  return app;
}

function buildCapabilities(config: AppConfig): NodeCapabilities {
  return {
    nodeId: config.server.nodeId,
    status: 'ok',
    version: packageJson.version,
    router: config.router,
    gpu: {
      requireGpuOnlyByDefault: config.gpu.requireGpuOnlyByDefault,
      vramSafetyReserveMb: config.gpu.vramSafetyReserveMb
    },
    queue: {
      defaultPriority: config.queue.defaultPriority,
      timeoutMs: config.queue.timeoutMs
    },
    models: config.models,
    routes: config.routes
  };
}

async function buildRuntimeSnapshot(config: AppConfig, deps: ServerDependencies): Promise<RuntimeSnapshot> {
  const [ollamaReachable, loadedModels, gpu] = await Promise.all([
    safeOllamaReachable(deps.ollama),
    safeLoadedModels(deps.ollama),
    safeGpu(deps.gpu)
  ]);
  const status = ollamaReachable ? (config.gpu.monitor.enabled && config.gpu.provider !== 'none' && !gpu ? 'degraded' : 'ok') : 'unavailable';
  return {
    nodeId: config.server.nodeId,
    status,
    timestamp: new Date().toISOString(),
    ollama: {
      baseUrl: config.ollama.baseUrl,
      reachable: ollamaReachable
    },
    gpu: gpu ? { provider: config.gpu.provider, snapshotAgeMs: 0, ...gpu } : undefined,
    loadedModels,
    queues: deps.queue.snapshot(),
    jobs: deps.jobs.summary()
  };
}

function findConfiguredModel(config: AppConfig, selectedModel: string): ModelSpec | undefined {
  return config.models.find((model) => model.name === selectedModel);
}

function normalizeClassification(config: AppConfig, classification: Partial<Classification> | undefined): Classification {
  return {
    taskType: classification?.taskType ?? config.router.defaultTaskType,
    complexity: classification?.complexity ?? 'medium',
    requiresLargeContext: classification?.requiresLargeContext ?? false,
    requiresToolUse: classification?.requiresToolUse ?? false,
    confidence: classification?.confidence ?? 1
  };
}

function countJobsByStatusAndModel(jobs: ReturnType<InMemoryJobStore['list']>): Array<{ status: string; model: string; count: number }> {
  const counts = new Map<string, { status: string; model: string; count: number }>();
  for (const job of jobs) {
    const status = job.status;
    const model = job.selected_model ?? 'unknown';
    const key = `${status}\0${model}`;
    const current = counts.get(key) ?? { status, model, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  return [...counts.values()];
}

export async function startServer(config: AppConfig, deps: ServerDependencies): Promise<{ close: () => Promise<void> }> {
  const app = createApp(config, deps);
  const server = await createHttpServer(config, app);
  server.listen(config.server.port, config.server.host);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  logger.info(
    {
      host: config.server.host,
      port: config.server.port,
      basePath: normalizeBasePath(config.server.basePath),
      protocol: config.server.https.enabled ? 'https' : 'http'
    },
    'ollama-agent-router listening'
  );
  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

export function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

async function createHttpServer(config: AppConfig, app: express.Express): Promise<http.Server | https.Server> {
  if (!config.server.https.enabled) {
    return http.createServer(app);
  }
  if (!config.server.https.certPath || !config.server.https.keyPath) {
    throw new Error('server.https.certPath and server.https.keyPath are required when HTTPS is enabled');
  }
  return https.createServer(
    {
      cert: await readFile(config.server.https.certPath),
      key: await readFile(config.server.https.keyPath),
      ca: config.server.https.caPath ? await readFile(config.server.https.caPath) : undefined,
      requestCert: Boolean(config.server.https.caPath && config.access.admin.clientCert.required),
      rejectUnauthorized: false
    },
    app
  );
}

function withRouterMetadata(result: unknown, router: Record<string, unknown>): unknown {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), router };
  }
  return { result, router };
}

async function safeLoadedModels(ollama: OllamaClient) {
  try {
    return await ollama.ps();
  } catch {
    return [];
  }
}

async function safeGpu(gpu: GpuMonitor) {
  try {
    return await gpu.snapshot();
  } catch {
    return undefined;
  }
}

async function safeOllamaReachable(ollama: OllamaClient): Promise<boolean> {
  try {
    return await ollama.health();
  } catch {
    return false;
  }
}

function escapeMetricLabel(label: string): string {
  return label.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
