import PQueue from 'p-queue';
import { AppConfig, ChatCompletionRequest, Classification, ModelSpec } from './types.js';
import { OllamaClient } from './ollama.js';
import { InMemoryJobStore } from './job-store.js';

export interface QueueSnapshot {
  globalQueued: number;
  globalRunning: number;
  byModel: Array<{ model: string; queued: number; running: number; concurrency: number }>;
}

export class QueueManager {
  private readonly queues = new Map<string, PQueue>();

  constructor(
    private readonly config: AppConfig,
    private readonly ollama: OllamaClient,
    private readonly jobs: InMemoryJobStore
  ) {
    for (const model of config.models) {
      this.queues.set(model.name, new PQueue({ concurrency: model.maxConcurrent }));
    }
  }

  async runSync(input: {
    model: ModelSpec;
    request: ChatCompletionRequest;
    priority: number;
    timeoutMs: number;
  }): Promise<{ result: unknown; queueTimeMs: number; executionTimeMs: number }> {
    this.ensureQueueCapacity();
    const queuedAt = Date.now();
    const result = await this.queueFor(input.model.name).add(
      async () => {
        const startedAt = Date.now();
        const result = await this.ollama.chat(input.request, input.model.name, Math.min(input.timeoutMs, input.model.timeoutMs));
        return { result, queueTimeMs: startedAt - queuedAt, executionTimeMs: Date.now() - startedAt };
      },
      { priority: input.priority, timeout: input.timeoutMs, throwOnTimeout: true }
    );
    return result;
  }

  enqueueAsync(input: {
    model: ModelSpec;
    request: ChatCompletionRequest;
    classification: Classification;
    priority: number;
  }): { id: string; position: number } {
    this.ensureQueueCapacity();
    const job = this.jobs.create({
      taskType: input.classification.taskType,
      selectedModel: input.model.name,
      request: input.request,
      priority: input.priority
    });

    const queue = this.queueFor(input.model.name);
    const position = queue.size + 1;
    void queue.add(() => this.runJob(job.id), {
      priority: input.priority,
      timeout: input.model.timeoutMs,
      throwOnTimeout: true
    });

    return { id: job.id, position };
  }

  snapshot(): QueueSnapshot {
    const byModel = [...this.queues.entries()].map(([model, queue]) => ({
      model,
      queued: queue.size,
      running: queue.pending,
      concurrency: this.config.models.find((spec) => spec.name === model)?.maxConcurrent ?? 1
    }));
    return {
      globalQueued: byModel.reduce((sum, item) => sum + item.queued, 0),
      globalRunning: byModel.reduce((sum, item) => sum + item.running, 0),
      byModel
    };
  }

  queueDepthByModel(): Map<string, number> {
    return new Map([...this.queues.entries()].map(([model, queue]) => [model, queue.size]));
  }

  runningByModel(): Map<string, number> {
    return new Map([...this.queues.entries()].map(([model, queue]) => [model, queue.pending]));
  }

  private async runJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'cancelled') return;
    const modelName = job.selected_model;
    const model = this.config.models.find((spec) => spec.name === modelName);
    if (!model) {
      this.jobs.markFailed(jobId, new Error(`Configured model disappeared: ${modelName}`));
      return;
    }

    this.jobs.markRunning(jobId);
    try {
      const request = JSON.parse(job.request_json) as ChatCompletionRequest;
      const result = await this.ollama.chat(request, model.name, model.timeoutMs);
      this.jobs.markSucceeded(jobId, result);
    } catch (error) {
      const latest = this.jobs.get(jobId);
      if (latest && latest.attempts < this.config.jobs.maxAttempts && latest.status !== 'cancelled') {
        const queue = this.queueFor(model.name);
        void queue.add(() => this.runJob(jobId), {
          priority: latest.priority,
          timeout: model.timeoutMs,
          throwOnTimeout: true
        });
      } else {
        this.jobs.markFailed(jobId, error);
      }
    }
  }

  private ensureQueueCapacity(): void {
    const snapshot = this.snapshot();
    if (snapshot.globalQueued >= this.config.queue.globalMaxQueued) {
      throw new Error(`Global queue limit exceeded: ${this.config.queue.globalMaxQueued}`);
    }
  }

  private queueFor(model: string): PQueue {
    const queue = this.queues.get(model);
    if (!queue) throw new Error(`No queue configured for model: ${model}`);
    return queue;
  }
}
