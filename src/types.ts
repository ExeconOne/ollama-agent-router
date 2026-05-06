export const taskTypes = [
  'triage',
  'simple_chat',
  'summarize',
  'code_generate',
  'code_review',
  'code_fix',
  'agentic_reasoning',
  'large_context',
  'tool_use',
  'unknown'
] as const;

export type TaskType = (typeof taskTypes)[number];
export type RouterMode = 'auto' | 'sync' | 'async';
export type PriorityName = 'low' | 'normal' | 'high';
export type Complexity = 'light' | 'medium' | 'heavy';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
export type NodeStatus = 'ok' | 'degraded' | 'unavailable';

export interface RouterRequestMetadata {
  mode?: RouterMode;
  allowAsync?: boolean;
  taskType?: TaskType | 'auto';
  priority?: PriorityName;
  preferredModels?: string[];
  forbiddenModels?: string[];
  maxQueueTimeMs?: number;
  maxExecutionTimeMs?: number;
  requireGpuOnly?: boolean;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: Array<{ role: string; content: unknown }>;
  stream?: boolean;
  router?: RouterRequestMetadata;
  [key: string]: unknown;
}

export interface Classification {
  taskType: TaskType;
  complexity: Complexity;
  requiresLargeContext: boolean;
  requiresToolUse: boolean;
  confidence: number;
}

export interface GpuSnapshot {
  provider?: AppConfig['gpu']['provider'];
  name: string;
  vramTotalMb: number;
  vramUsedMb: number;
  vramFreeMb: number;
  utilizationPct: number;
  snapshotAgeMs?: number;
}

export interface LoadedModel {
  name: string;
  id?: string;
  size?: string;
  processor?: string;
  until?: string;
}

export interface ModelSpec {
  name: string;
  sizeGb: number;
  purpose: string[];
  priority: number;
  maxConcurrent: number;
  defaultContext: number;
  maxContext: number;
  timeoutMs: number;
  costClass: 'low' | 'medium' | 'high';
  exclusive: boolean;
  allowWhenBusy: boolean;
  tags: string[];
}

export interface AppConfig {
  server: {
    nodeId: string;
    host: string;
    port: number;
    basePath: string;
    requestBodyLimit: string;
    https: {
      enabled: boolean;
      certPath?: string;
      keyPath?: string;
      caPath?: string;
    };
  };
  ollama: {
    baseUrl: string;
    openAiCompatiblePath: string;
    nativeApiBasePath: string;
    keepAlive: string;
    requestTimeoutMs: number;
  };
  gpu: {
    provider: 'none' | 'nvidia';
    name?: string;
    vramTotalMb: number;
    vramSafetyReserveMb: number;
    maxGpuUtilizationPct: number;
    requireGpuOnlyByDefault: boolean;
    monitor: {
      enabled: boolean;
      intervalMs: number;
      nvidiaSmiPath: string;
    };
  };
  router: {
    defaultMode: RouterMode;
    syncMaxQueueTimeMs: number;
    heavyLoadQueueDepth: number;
    heavyLoadGpuFreeMbThreshold: number;
    defaultTaskType: TaskType;
    classification: {
      mode: 'heuristic' | 'model';
      optionalClassifierModel?: string;
      classifierTimeoutMs: number;
    };
  };
  jobs: {
    store: 'memory';
    resultTtlSeconds: number;
    maxAttempts: number;
    cleanupIntervalMs: number;
  };
  models: ModelSpec[];
  routes: Partial<Record<TaskType | string, string[]>>;
  queue: {
    globalMaxConcurrent: number;
    globalMaxQueued: number;
    perUserMaxQueued: number;
    defaultPriority: PriorityName;
    timeoutMs: number;
  };
}

export interface NodeCapabilities {
  nodeId: string;
  status: NodeStatus;
  version: string;
  router: AppConfig['router'];
  gpu: {
    requireGpuOnlyByDefault: boolean;
    vramSafetyReserveMb: number;
  };
  queue: {
    defaultPriority: PriorityName;
    timeoutMs: number;
  };
  models: ModelSpec[];
  routes: Partial<Record<TaskType | string, string[]>>;
}

export interface RuntimeSnapshot {
  nodeId: string;
  status: NodeStatus;
  timestamp: string;
  ollama: {
    baseUrl: string;
    reachable: boolean;
  };
  gpu?: GpuSnapshot;
  loadedModels: LoadedModel[];
  queues: {
    globalQueued: number;
    globalRunning: number;
    byModel: Array<{
      model: string;
      queued: number;
      running: number;
      concurrency: number;
    }>;
  };
  jobs: {
    queued: number;
    running: number;
    succeededRetained: number;
    failedRetained: number;
    cancelledRetained: number;
    expiredRetained: number;
  };
}

export interface RouteContext {
  request: ChatCompletionRequest;
  router: Required<RouterRequestMetadata>;
  classification: Classification;
  gpu?: GpuSnapshot;
  loadedModels: LoadedModel[];
  queueDepthByModel: Map<string, number>;
  runningByModel: Map<string, number>;
}

export type RouteDecision =
  | {
      type: 'sync';
      model: ModelSpec;
      fallbackModels: string[];
      reason: string;
      score: number;
    }
  | {
      type: 'async';
      model: ModelSpec;
      fallbackModels: string[];
      reason: string;
      score: number;
      position: number;
    }
  | {
      type: 'reject';
      reason: string;
      statusCode: number;
    };

export interface JobRecord {
  id: string;
  status: JobStatus;
  task_type: TaskType;
  selected_model: string | null;
  request_json: string;
  result_json: string | null;
  error_json: string | null;
  attempts: number;
  priority: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string | null;
}
