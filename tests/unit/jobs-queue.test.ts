import { InMemoryJobStore, parseJobError, parseJobResult } from '../../src/job-store.js';
import { QueueManager } from '../../src/queue-manager.js';
import { MockOllamaClient, testConfig } from '../helpers.js';

it('keeps job lifecycle transitions in memory', () => {
  const config = testConfig();
  const store = new InMemoryJobStore(config.jobs, config.server.nodeId);
  const job = store.create({
    taskType: 'simple_chat',
    selectedModel: 'B-A-M-N/vibethinker:1.5b',
    request: { messages: [{ role: 'user', content: 'hi' }] },
    priority: 50
  });
  expect(job.id).toMatch(/^job_test-node_/);
  expect(store.get(job.id)?.status).toBe('queued');
  expect(store.summary()).toMatchObject({ queued: 1, running: 0 });
  store.markRunning(job.id);
  expect(store.get(job.id)?.status).toBe('running');
  expect(store.summary()).toMatchObject({ queued: 0, running: 1 });
  store.markSucceeded(job.id, { ok: true });
  expect(parseJobResult(store.get(job.id)!)).toEqual({ ok: true });
  expect(store.summary()).toMatchObject({ succeededRetained: 1 });
  store.close();
});

it('stores failed async job errors', async () => {
  const config = testConfig();
  const store = new InMemoryJobStore(config.jobs);
  const ollama = new MockOllamaClient();
  ollama.fail = true;
  const queue = new QueueManager(config, ollama, store);
  const model = config.models[0];
  const job = queue.enqueueAsync({
    model,
    request: { messages: [{ role: 'user', content: 'hi' }] },
    classification: { taskType: 'simple_chat', complexity: 'light', requiresLargeContext: false, requiresToolUse: false, confidence: 1 },
    priority: 50
  });
  await waitFor(() => store.get(job.id)?.status === 'failed');
  expect(parseJobError(store.get(job.id)!) as { message: string }).toMatchObject({ message: 'mock ollama failure' });
  store.close();
});

it('runs sync work through model queues', async () => {
  const config = testConfig();
  const store = new InMemoryJobStore(config.jobs);
  const ollama = new MockOllamaClient();
  const queue = new QueueManager(config, ollama, store);
  const output = await queue.runSync({
    model: config.models[0],
    request: { messages: [{ role: 'user', content: 'hello' }] },
    priority: 50,
    timeoutMs: 1000
  });
  expect(output.result).toMatchObject({ model: config.models[0].name });
  expect(queue.snapshot().globalQueued).toBe(0);
  store.close();
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
