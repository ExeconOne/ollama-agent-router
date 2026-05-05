import { RoutingEngine, normalizeRouterMetadata } from '../../src/router-engine.js';
import { testConfig } from '../helpers.js';
import { Classification, RouteContext } from '../../src/types.js';

function context(taskType: Classification['taskType'], extra: Partial<RouteContext> = {}): RouteContext {
  const config = testConfig();
  return {
    request: { messages: [{ role: 'user', content: 'hello' }] },
    router: normalizeRouterMetadata(config, {}),
    classification: {
      taskType,
      complexity: taskType === 'agentic_reasoning' ? 'heavy' : 'medium',
      requiresLargeContext: false,
      requiresToolUse: false,
      confidence: 1
    },
    gpu: { name: 'Test GPU', vramTotalMb: 20480, vramUsedMb: 1000, vramFreeMb: 19000, utilizationPct: 10 },
    loadedModels: [],
    queueDepthByModel: new Map(),
    runningByModel: new Map(),
    ...extra
  };
}

it('scores code generation toward qwen', () => {
  const config = testConfig();
  const engine = new RoutingEngine(config);
  const decision = engine.decide(context('code_generate'));
  expect(decision.type).toBe('sync');
  if (decision.type === 'sync') expect(decision.model.name).toBe('qwen2.5-coder:7b');
});

it('falls back when exclusive reasoning model is busy and async is not allowed', () => {
  const config = testConfig();
  const engine = new RoutingEngine(config);
  const decision = engine.decide(
    context('agentic_reasoning', {
      router: normalizeRouterMetadata(config, { allowAsync: false }),
      runningByModel: new Map([['gpt-oss:20b', 1]])
    })
  );
  expect(decision.type).toBe('sync');
  if (decision.type === 'sync') expect(decision.model.name).toBe('qwen2.5-coder:7b');
});

it('returns async when exclusive reasoning model is busy and async is allowed', () => {
  const config = testConfig();
  const engine = new RoutingEngine(config);
  const decision = engine.decide(
    context('agentic_reasoning', {
      router: normalizeRouterMetadata(config, { allowAsync: true }),
      runningByModel: new Map([['gpt-oss:20b', 1]])
    })
  );
  expect(decision.type).toBe('async');
  if (decision.type === 'async') expect(decision.model.name).toBe('gpt-oss:20b');
});

it('blocks CPU/GPU split models when GPU-only is required', () => {
  const config = testConfig();
  const engine = new RoutingEngine(config);
  const decision = engine.decide(
    context('agentic_reasoning', {
      router: normalizeRouterMetadata(config, {
        requireGpuOnly: true,
        preferredModels: ['gpt-oss:20b'],
        forbiddenModels: ['qwen2.5-coder:7b']
      }),
      loadedModels: [{ name: 'gpt-oss:20b', processor: '63%/37% CPU/GPU' }]
    })
  );
  expect(decision.type).toBe('reject');
});
