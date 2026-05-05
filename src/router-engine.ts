import { AppConfig, ModelSpec, RouteContext, RouteDecision, RouterRequestMetadata } from './types.js';

export const priorityWeights = {
  low: 10,
  normal: 50,
  high: 90
} as const;

export function normalizeRouterMetadata(config: AppConfig, metadata: RouterRequestMetadata = {}): Required<RouterRequestMetadata> {
  return {
    mode: metadata.mode ?? config.router.defaultMode,
    allowAsync: metadata.allowAsync ?? true,
    taskType: metadata.taskType ?? 'auto',
    priority: metadata.priority ?? config.queue.defaultPriority,
    preferredModels: metadata.preferredModels ?? [],
    forbiddenModels: metadata.forbiddenModels ?? [],
    maxQueueTimeMs: metadata.maxQueueTimeMs ?? config.router.syncMaxQueueTimeMs,
    maxExecutionTimeMs: metadata.maxExecutionTimeMs ?? config.queue.timeoutMs,
    requireGpuOnly: metadata.requireGpuOnly ?? config.gpu.requireGpuOnlyByDefault
  };
}

export class RoutingEngine {
  private readonly modelsByName: Map<string, ModelSpec>;

  constructor(private readonly config: AppConfig) {
    this.modelsByName = new Map(config.models.map((model) => [model.name, model]));
  }

  decide(context: RouteContext): RouteDecision {
    const candidates = this.getCandidates(context);
    if (candidates.length === 0) {
      return { type: 'reject', statusCode: 503, reason: 'No configured model can satisfy this request' };
    }

    const blocked = candidates
      .map((model) => ({ model, blockReason: this.blockReason(model, context) }))
      .filter((entry) => entry.blockReason);
    const available = candidates.filter((model) => !this.blockReason(model, context));
    const scoredAvailable = available.map((model) => this.score(model, context)).sort((a, b) => b.score - a.score);
    const fallbackModels = candidates.map((model) => model.name);

    if (context.router.mode === 'async') {
      const model = (scoredAvailable[0]?.model ?? candidates[0]) as ModelSpec;
      return {
        type: 'async',
        model,
        fallbackModels,
        reason: 'Request explicitly requested async mode',
        score: scoredAvailable[0]?.score ?? 0,
        position: (context.queueDepthByModel.get(model.name) ?? 0) + 1
      };
    }

    const preferredBusy = this.preferredBusyModel(candidates, context);
    const totalQueueDepth = [...context.queueDepthByModel.values()].reduce((sum, depth) => sum + depth, 0);
    const gpuHeavy = Boolean(
      context.gpu && context.gpu.vramFreeMb < this.config.router.heavyLoadGpuFreeMbThreshold
    );
    const heavyLoad = totalQueueDepth >= this.config.router.heavyLoadQueueDepth || gpuHeavy;

    if (context.router.mode !== 'sync' && context.router.allowAsync && (heavyLoad || preferredBusy)) {
      const model = preferredBusy ?? scoredAvailable[0]?.model ?? candidates[0];
      return {
        type: 'async',
        model,
        fallbackModels,
        reason: preferredBusy ? 'Preferred model is busy; accepted for async processing' : 'Heavy load detected',
        score: this.score(model, context).score,
        position: (context.queueDepthByModel.get(model.name) ?? 0) + 1
      };
    }

    if (scoredAvailable.length > 0) {
      return {
        type: 'sync',
        model: scoredAvailable[0].model,
        fallbackModels,
        reason: scoredAvailable[0].reason,
        score: scoredAvailable[0].score
      };
    }

    if (blocked.some((entry) => entry.blockReason === 'busy') && context.router.allowAsync && context.router.mode !== 'sync') {
      const model = blocked[0].model;
      return {
        type: 'async',
        model,
        fallbackModels,
        reason: 'Selected model is busy; accepted for async processing',
        score: 0,
        position: (context.queueDepthByModel.get(model.name) ?? 0) + 1
      };
    }

    const reason = blocked.map((entry) => `${entry.model.name}: ${entry.blockReason}`).join('; ');
    return { type: 'reject', statusCode: 503, reason: reason || 'No model available' };
  }

  score(model: ModelSpec, context: RouteContext): { model: ModelSpec; score: number; reason: string } {
    const route = this.config.routes[context.classification.taskType] ?? this.config.routes.unknown ?? [];
    const routeIndex = route.indexOf(model.name);
    const loaded = context.loadedModels.some((loadedModel) => loadedModel.name === model.name);
    const queueDepth = context.queueDepthByModel.get(model.name) ?? 0;
    const running = context.runningByModel.get(model.name) ?? 0;
    const preferredIndex = context.router.preferredModels.indexOf(model.name);
    const freeMb = context.gpu?.vramFreeMb ?? this.config.gpu.vramTotalMb;
    const requiredMb = model.sizeGb * 1024 + this.config.gpu.vramSafetyReserveMb;

    let score = 100;
    score += Math.max(0, 50 - routeIndex * 8);
    score += model.priority;
    if (model.purpose.includes(context.classification.taskType)) score += 25;
    if (model.tags.includes(context.classification.taskType)) score += 15;
    if (preferredIndex >= 0) score += 80 - preferredIndex * 10;
    if (loaded) score += 20;
    if (context.classification.complexity === 'heavy' && model.costClass === 'high') score += 20;
    if (context.classification.complexity === 'light' && model.costClass === 'low') score += 15;
    if (freeMb > requiredMb) score += Math.min(25, (freeMb - requiredMb) / 512);
    if (freeMb < requiredMb) score -= 60;
    score -= queueDepth * 18;
    score -= running * 25;
    if (model.exclusive) score -= running * 80;

    return {
      model,
      score,
      reason: `Selected ${model.name} for ${context.classification.taskType} with score ${score.toFixed(1)}`
    };
  }

  private getCandidates(context: RouteContext): ModelSpec[] {
    const routeNames = this.config.routes[context.classification.taskType] ?? this.config.routes.unknown ?? [];
    const names = new Set<string>();
    for (const name of context.router.preferredModels) names.add(name);
    for (const name of routeNames) names.add(name);
    for (const model of this.config.models) {
      if (model.purpose.includes(context.classification.taskType) || model.tags.includes(context.classification.taskType)) {
        names.add(model.name);
      }
    }

    return [...names]
      .map((name) => this.modelsByName.get(name))
      .filter((model): model is ModelSpec => Boolean(model))
      .filter((model) => !context.router.forbiddenModels.includes(model.name));
  }

  private blockReason(model: ModelSpec, context: RouteContext): 'gpu_only' | 'busy' | undefined {
    const loaded = context.loadedModels.find((loadedModel) => loadedModel.name === model.name);
    const processor = loaded?.processor?.toLowerCase() ?? '';
    if (context.router.requireGpuOnly) {
      if (!context.gpu && this.config.gpu.vramTotalMb <= 0) return 'gpu_only';
      if (processor.includes('cpu') && !processor.includes('100% gpu')) return 'gpu_only';
      const freeMb = context.gpu?.vramFreeMb ?? this.config.gpu.vramTotalMb;
      if (model.sizeGb * 1024 + this.config.gpu.vramSafetyReserveMb > freeMb && !loaded) return 'gpu_only';
    }

    const running = context.runningByModel.get(model.name) ?? 0;
    if ((model.exclusive && running > 0) || (!model.allowWhenBusy && running >= model.maxConcurrent)) {
      return 'busy';
    }
    return undefined;
  }

  private preferredBusyModel(candidates: ModelSpec[], context: RouteContext): ModelSpec | undefined {
    const preferredNames = new Set(context.router.preferredModels);
    const ordered = preferredNames.size > 0 ? candidates.filter((model) => preferredNames.has(model.name)) : candidates.slice(0, 1);
    return ordered.find((model) => this.blockReason(model, context) === 'busy');
  }
}
