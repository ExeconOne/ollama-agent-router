import { requestJson, createTestRuntime, testConfig } from '../helpers.js';
import { priorityWeights } from '../../src/router-engine.js';

const baseRequest = (content: string, router: Record<string, unknown> = {}) => ({
  model: 'auto',
  messages: [{ role: 'user', content }],
  router
});

it('simple_chat routes to vibethinker', async () => {
  const runtime = createTestRuntime();
  const res = await requestJson(runtime.app, 'POST', '/v1/chat/completions', baseRequest('Hello there'));
  expect(res.status).toBe(200);
  expect(res.body.router.selectedModel).toBe('B-A-M-N/vibethinker:1.5b');
  runtime.jobs.close();
});

it('code_generate routes to qwen2.5-coder', async () => {
  const runtime = createTestRuntime();
  const res = await requestJson(runtime.app, 'POST', '/v1/chat/completions', baseRequest('Write a TypeScript function'));
  expect(res.status).toBe(200);
  expect(res.body.router.selectedModel).toBe('qwen2.5-coder:7b');
  runtime.jobs.close();
});

it('code_review routes to deepseek-coder', async () => {
  const runtime = createTestRuntime();
  const res = await requestJson(runtime.app, 'POST', '/v1/chat/completions', baseRequest('Review this TypeScript code ```const x = 1```'));
  expect(res.status).toBe(200);
  expect(res.body.router.selectedModel).toBe('deepseek-coder:6.7b');
  runtime.jobs.close();
});

it('agentic_reasoning routes to gpt-oss when available', async () => {
  const runtime = createTestRuntime();
  const res = await requestJson(
    runtime.app,
    'POST',
    '/v1/chat/completions',
    baseRequest('Plan a multi-step architecture investigation', { taskType: 'agentic_reasoning', allowAsync: false })
  );
  expect(res.status).toBe(200);
  expect(res.body.router.selectedModel).toBe('gpt-oss:20b');
  runtime.jobs.close();
});

it('agentic_reasoning falls back to qwen2.5-coder if gpt-oss is unavailable and allowAsync=false', async () => {
  const engineConfig = testConfig();
  const busyRuntime = createTestRuntime(engineConfig);
  busyRuntime.ollama.delayMs = 300;
  const busy = busyRuntime.queue.runSync({
    model: engineConfig.models.find((model) => model.name === 'gpt-oss:20b')!,
    request: baseRequest('occupy'),
    priority: priorityWeights.normal,
    timeoutMs: 1000
  }).catch(() => undefined);
  await waitFor(() => busyRuntime.queue.snapshot().byModel.find((item) => item.model === 'gpt-oss:20b')?.running === 1);
  const res = await requestJson(
    busyRuntime.app,
    'POST',
    '/v1/chat/completions',
    baseRequest('Need deep plan', { taskType: 'agentic_reasoning', allowAsync: false })
  );
  expect(res.status).toBe(200);
  expect(res.body.router.selectedModel).toBe('qwen2.5-coder:7b');
  await busy;
  busyRuntime.jobs.close();
});

it('agentic_reasoning returns async job if gpt-oss is busy and allowAsync=true', async () => {
  const runtime = createTestRuntime();
  runtime.ollama.delayMs = 120;
  const busy = runtime.queue.runSync({
    model: runtime.config.models.find((model) => model.name === 'gpt-oss:20b')!,
    request: baseRequest('occupy'),
    priority: priorityWeights.normal,
    timeoutMs: 1000
  });
  await waitFor(() => runtime.queue.snapshot().byModel.find((item) => item.model === 'gpt-oss:20b')?.running === 1);
  const res = await requestJson(
    runtime.app,
    'POST',
    '/v1/chat/completions',
    baseRequest('Need deep plan', { taskType: 'agentic_reasoning', allowAsync: true })
  );
  expect(res.status).toBe(202);
  expect(res.body.object).toBe('router.job');
  expect(res.body.router.preferredModel).toBe('gpt-oss:20b');
  await busy;
  runtime.jobs.close();
});

it('job transitions queued to running to succeeded', async () => {
  const runtime = createTestRuntime();
  let release!: () => void;
  runtime.ollama.gate = new Promise((resolve) => {
    release = resolve;
  });
  runtime.ollama.delayMs = 60;
  const model = runtime.config.models.find((item) => item.name === 'gpt-oss:20b')!;
  const busy = runtime.queue.runSync({
    model,
    request: baseRequest('occupy'),
    priority: 50,
    timeoutMs: 1000
  });
  await waitFor(() => runtime.queue.snapshot().byModel.find((item) => item.model === model.name)?.running === 1);
  const job = runtime.queue.enqueueAsync({
    model,
    request: baseRequest('hello'),
    classification: { taskType: 'agentic_reasoning', complexity: 'heavy', requiresLargeContext: false, requiresToolUse: false, confidence: 1 },
    priority: 50
  });
  expect(runtime.jobs.get(job.id)?.status).toBe('queued');
  release();
  await busy;
  await waitFor(() => runtime.jobs.get(job.id)?.status === 'running');
  await waitFor(() => runtime.jobs.get(job.id)?.status === 'succeeded');
  runtime.jobs.close();
});

it('failed Ollama call stores error_json', async () => {
  const runtime = createTestRuntime();
  runtime.ollama.fail = true;
  const job = runtime.queue.enqueueAsync({
    model: runtime.config.models[0],
    request: baseRequest('hello'),
    classification: { taskType: 'simple_chat', complexity: 'light', requiresLargeContext: false, requiresToolUse: false, confidence: 1 },
    priority: 50
  });
  await waitFor(() => runtime.jobs.get(job.id)?.status === 'failed');
  expect(runtime.jobs.get(job.id)?.error_json).toContain('mock ollama failure');
  runtime.jobs.close();
});

it('CPU/GPU split blocks model if requireGpuOnly=true', async () => {
  const runtime = createTestRuntime();
  runtime.ollama.loadedModels = [{ name: 'gpt-oss:20b', processor: '50%/50% CPU/GPU' }];
  const res = await requestJson(
    runtime.app,
    'POST',
    '/v1/chat/completions',
    baseRequest('Need deep plan', {
      taskType: 'agentic_reasoning',
      requireGpuOnly: true,
      preferredModels: ['gpt-oss:20b'],
      forbiddenModels: ['qwen2.5-coder:7b'],
      allowAsync: false
    })
  );
  expect(res.status).toBe(503);
  runtime.jobs.close();
});

it('/health and /v1/router/status return useful state', async () => {
  const runtime = createTestRuntime();
  const health = await requestJson(runtime.app, 'GET', '/health');
  const status = await requestJson(runtime.app, 'GET', '/v1/router/status');
  expect(health.body.status).toBe('ok');
  expect(status.body.nodeId).toBe('test-node');
  expect(status.body.queue).toBeDefined();
  expect(status.body.config.models).toBe(4);
  runtime.jobs.close();
});

it('/v1/router/capabilities returns Kong routing config snapshot', async () => {
  const runtime = createTestRuntime();
  const res = await requestJson(runtime.app, 'GET', '/v1/router/capabilities');
  expect(res.status).toBe(200);
  expect(res.body.nodeId).toBe('test-node');
  expect(res.body.status).toBe('ok');
  expect(res.body.version).toBeDefined();
  expect(res.body.router.defaultMode).toBe('auto');
  expect(res.body.gpu.vramSafetyReserveMb).toBe(runtime.config.gpu.vramSafetyReserveMb);
  expect(res.body.queue.defaultPriority).toBe('normal');
  expect(res.body.models).toHaveLength(4);
  expect(res.body.routes.code_review).toContain('deepseek-coder:6.7b');
  runtime.jobs.close();
});

it('/v1/router/runtime returns aggregated runtime snapshot', async () => {
  const runtime = createTestRuntime();
  runtime.ollama.loadedModels = [{ name: 'qwen2.5-coder:7b', processor: '100% GPU' }];
  const job = runtime.queue.enqueueAsync({
    model: runtime.config.models[0],
    request: baseRequest('hello'),
    classification: { taskType: 'simple_chat', complexity: 'light', requiresLargeContext: false, requiresToolUse: false, confidence: 1 },
    priority: 50
  });
  await waitFor(() => runtime.jobs.get(job.id)?.status === 'succeeded');
  const res = await requestJson(runtime.app, 'GET', '/v1/router/runtime');
  expect(res.status).toBe(200);
  expect(res.body.nodeId).toBe('test-node');
  expect(res.body.status).toBe('ok');
  expect(res.body.ollama).toMatchObject({ baseUrl: runtime.config.ollama.baseUrl, reachable: true });
  expect(res.body.loadedModels).toEqual(runtime.ollama.loadedModels);
  expect(res.body.gpu.provider).toBe('nvidia');
  expect(res.body.queues.byModel).toHaveLength(4);
  expect(res.body.jobs.succeededRetained).toBe(1);
  runtime.jobs.close();
});

it('/v1/router/execute runs the selected model without rerouting', async () => {
  const runtime = createTestRuntime();
  const selectedModel = 'B-A-M-N/vibethinker:1.5b';
  const res = await requestJson(runtime.app, 'POST', '/v1/router/execute', {
    selectedModel,
    request: baseRequest('Write a TypeScript function that would normally route to coder'),
    routerDecision: { taskType: 'code_generate', score: 12, reason: 'test-selected' }
  });
  expect(res.status).toBe(200);
  expect(res.body.nodeId).toBe('test-node');
  expect(res.body.selectedModel).toBe(selectedModel);
  expect(res.body.result.model).toBe(selectedModel);
  expect(runtime.ollama.calls.at(-1)?.model).toBe(selectedModel);
  runtime.jobs.close();
});

it('/v1/router/execute rejects stream and unknown selected models', async () => {
  const runtime = createTestRuntime();
  const stream = await requestJson(runtime.app, 'POST', '/v1/router/execute', {
    selectedModel: runtime.config.models[0].name,
    request: { ...baseRequest('hello'), stream: true }
  });
  const unknown = await requestJson(runtime.app, 'POST', '/v1/router/execute', {
    selectedModel: 'missing:model',
    request: baseRequest('hello')
  });
  expect(stream.status).toBe(400);
  expect(unknown.status).toBe(404);
  runtime.jobs.close();
});

it('/v1/router/jobs creates a selected-model async job with node-routable id', async () => {
  const runtime = createTestRuntime();
  const selectedModel = 'gpt-oss:20b';
  const res = await requestJson(runtime.app, 'POST', '/v1/router/jobs', {
    selectedModel,
    request: baseRequest('Plan a debugging strategy'),
    classification: { taskType: 'agentic_reasoning', complexity: 'heavy' },
    priority: 'high',
    routerDecision: { score: 100, reason: 'test-selected' }
  });
  expect(res.status).toBe(202);
  expect(res.body.id).toMatch(/^job_test-node_/);
  expect(res.body.nodeId).toBe('test-node');
  expect(res.body.selectedModel).toBe(selectedModel);
  expect(runtime.jobs.get(res.body.id)?.selected_model).toBe(selectedModel);
  runtime.jobs.close();
});

it('mounts every endpoint under the configured base path', async () => {
  const runtime = createTestRuntime(testConfig({ server: { ...testConfig().server, basePath: '/ollama-router' } }));
  const health = await requestJson(runtime.app, 'GET', '/ollama-router/health');
  const status = await requestJson(runtime.app, 'GET', '/ollama-router/v1/router/status');
  const capabilities = await requestJson(runtime.app, 'GET', '/ollama-router/v1/router/capabilities');
  const runtimeSnapshot = await requestJson(runtime.app, 'GET', '/ollama-router/v1/router/runtime');
  expect(health.status).toBe(200);
  expect(status.body.config.basePath).toBe('/ollama-router');
  expect(capabilities.status).toBe(200);
  expect(runtimeSnapshot.status).toBe(200);
  runtime.jobs.close();
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
