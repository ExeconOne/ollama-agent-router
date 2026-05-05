import { nanoid } from 'nanoid';
import { AppConfig, ChatCompletionRequest, JobRecord, JobStatus, TaskType } from './types.js';

export class InMemoryJobStore {
  private readonly jobs = new Map<string, JobRecord>();

  constructor(private readonly config: AppConfig['jobs']) {}

  create(input: {
    taskType: TaskType;
    selectedModel: string;
    request: ChatCompletionRequest;
    priority: number;
  }): JobRecord {
    const now = new Date();
    const record: JobRecord = {
      id: `job_${nanoid(16)}`,
      status: 'queued',
      task_type: input.taskType,
      selected_model: input.selectedModel,
      request_json: JSON.stringify(input.request),
      result_json: null,
      error_json: null,
      attempts: 0,
      priority: input.priority,
      created_at: now.toISOString(),
      started_at: null,
      finished_at: null,
      expires_at: new Date(now.getTime() + this.config.resultTtlSeconds * 1000).toISOString()
    };
    this.jobs.set(record.id, record);
    return { ...record };
  }

  get(id: string): JobRecord | undefined {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  list(limit = 50): JobRecord[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((job) => ({ ...job }));
  }

  markRunning(id: string): JobRecord | undefined {
    const job = this.jobs.get(id);
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return this.get(id);
    const now = new Date().toISOString();
    job.status = 'running';
    job.started_at ??= now;
    job.attempts += 1;
    return this.get(id);
  }

  markSucceeded(id: string, result: unknown): JobRecord | undefined {
    this.finish(id, 'succeeded', JSON.stringify(result), null);
    return this.get(id);
  }

  markFailed(id: string, error: unknown): JobRecord | undefined {
    this.finish(id, 'failed', null, JSON.stringify(normalizeError(error)));
    return this.get(id);
  }

  cancel(id: string): JobRecord | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'cancelled';
      job.finished_at = new Date().toISOString();
    }
    return this.get(id);
  }

  cleanupExpired(now = new Date()): number {
    let changed = 0;
    for (const job of this.jobs.values()) {
      if (
        job.expires_at &&
        job.expires_at < now.toISOString() &&
        ['queued', 'running', 'succeeded', 'failed'].includes(job.status)
      ) {
        job.status = 'expired';
        changed += 1;
      }
    }
    return changed;
  }

  close(): void {
    this.jobs.clear();
  }

  private finish(id: string, status: JobStatus, resultJson: string | null, errorJson: string | null): void {
    const job = this.jobs.get(id);
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return;
    job.status = status;
    job.result_json = resultJson;
    job.error_json = errorJson;
    job.finished_at = new Date().toISOString();
  }
}

export function parseJobResult(job: JobRecord): unknown {
  if (!job.result_json) return undefined;
  return JSON.parse(job.result_json);
}

export function parseJobError(job: JobRecord): unknown {
  if (!job.error_json) return undefined;
  return JSON.parse(job.error_json);
}

function normalizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message, name: error.name, stack: error.stack };
  }
  return { message: String(error), value: error };
}
