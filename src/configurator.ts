import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import YAML from 'yaml';
import { z } from 'zod';
import { parseConfig } from './config.js';
import { parseNvidiaSmi } from './gpu.js';
import { parseOllamaPs } from './ollama.js';
import { AppConfig, LoadedModel, ModelSpec, TaskType } from './types.js';

const execFileAsync = promisify(execFile);

export interface DetectionResult<T> {
  value?: T;
  source: 'command' | 'env' | 'default' | 'manual' | 'not_found';
  confidence: 'high' | 'medium' | 'low';
  message?: string;
}

export interface DetectedOllamaModel {
  name: string;
  id?: string;
  size?: string;
  sizeGb?: number;
  modified?: string;
}

export interface MachineProfile {
  platform: NodeJS.Platform;
  arch: string;
  cpuCores: number;
  totalMemoryMb: number;
  class: 'small' | 'medium' | 'large';
}

export interface WizardDetection {
  ollamaBinary: DetectionResult<string>;
  ollamaBaseUrl: DetectionResult<string>;
  ollamaReachable: DetectionResult<boolean>;
  ollamaModels: DetectionResult<DetectedOllamaModel[]>;
  loadedModels: DetectionResult<LoadedModel[]>;
  nvidiaSmiPath: DetectionResult<string>;
  gpu: DetectionResult<AppConfig['gpu']>;
  machine: DetectionResult<MachineProfile>;
}

export interface CommandRunner {
  (command: string, args: string[]): Promise<{ stdout: string; stderr?: string }>;
}

export interface DetectOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  commandRunner?: CommandRunner;
  fetchImpl?: typeof fetch;
  pathLookup?: (command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  totalMemoryMb?: number;
  cpuCores?: number;
}

export interface ConfigureOptions extends DetectOptions {
  outputPath: string;
  answersPath?: string;
  nonInteractive?: boolean;
  dryRun?: boolean;
  overwrite?: boolean;
  detectOnly?: boolean;
  assumeYes?: boolean;
  silent?: boolean;
}

export interface ConfigureAnswers {
  server?: Partial<AppConfig['server']> & { https?: Partial<AppConfig['server']['https']> | boolean };
  ollama?: Partial<AppConfig['ollama']>;
  gpu?: Partial<AppConfig['gpu']>;
  router?: Partial<AppConfig['router']>;
  jobs?: Partial<AppConfig['jobs']>;
  queue?: Partial<AppConfig['queue']>;
  models?: {
    mode?: 'detected' | 'manual';
    items?: Array<Partial<ModelSpec> & { role?: ModelRole }>;
  };
  routes?: Partial<Record<TaskType | string, string[]>>;
}

type ModelRole = 'fast' | 'code' | 'review' | 'heavy' | 'tool';

const answersSchema = z.object({
  server: z.record(z.unknown()).optional(),
  ollama: z.record(z.unknown()).optional(),
  gpu: z.record(z.unknown()).optional(),
  router: z.record(z.unknown()).optional(),
  jobs: z.record(z.unknown()).optional(),
  queue: z.record(z.unknown()).optional(),
  models: z
    .object({
      mode: z.enum(['detected', 'manual']).optional(),
      items: z.array(z.record(z.unknown())).optional()
    })
    .optional(),
  routes: z.record(z.array(z.string())).optional()
});

const coreTaskTypes: TaskType[] = [
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
];

export async function runConfigure(options: ConfigureOptions): Promise<void> {
  const detection = await detectEnvironment(options);

  if (options.detectOnly) {
    emit(options, `${formatDetectionSummary(detection)}\n`);
    return;
  }

  const answers = options.answersPath ? await loadAnswers(options.answersPath) : {};
  const config = options.nonInteractive
    ? generateConfigFromDetection(detection, answers)
    : await promptForConfig(detection, answers, options);
  const yaml = serializeConfig(config);
  parseConfig(yaml);

  emit(options, `${formatConfigSummary(config, detection, options.outputPath)}\n`);
  if (options.dryRun) {
    emit(options, `${yaml}\n`);
    return;
  }

  if (!options.overwrite && (await fileExists(options.outputPath))) {
    throw new Error(`Refusing to overwrite existing config: ${options.outputPath}`);
  }
  await mkdir(dirname(resolve(options.outputPath)), { recursive: true });
  await writeFile(options.outputPath, yaml, 'utf8');
  emit(options, `Wrote ${options.outputPath}\n`);
}

export async function detectEnvironment(options: DetectOptions = {}): Promise<WizardDetection> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const pathLookup = options.pathLookup ?? findExecutable;

  const machine = detectMachine(platform, arch, options);
  const ollamaBinary = await detectOllamaBinary(platform, env, pathLookup);
  const ollamaBaseUrl = detectOllamaBaseUrl(env);
  const ollamaReachable = await detectOllamaReachable(ollamaBaseUrl.value, options.fetchImpl ?? fetch);
  const ollamaModels = await detectOllamaModels(ollamaBinary.value, commandRunner);
  const loadedModels = await detectLoadedModels(ollamaBinary.value, commandRunner);
  const nvidiaSmiPath: DetectionResult<string> =
    platform === 'darwin' ? notFound<string>('nvidia-smi is normally unavailable on macOS') : await detectNvidiaSmi(platform, env, pathLookup);
  const gpu = await detectGpu(platform, arch, nvidiaSmiPath.value, commandRunner);

  return {
    ollamaBinary,
    ollamaBaseUrl,
    ollamaReachable,
    ollamaModels,
    loadedModels,
    nvidiaSmiPath,
    gpu,
    machine
  };
}

export function generateConfigFromDetection(detection: WizardDetection, answers: ConfigureAnswers = {}): AppConfig {
  const machine = detection.machine.value ?? detectMachine(process.platform, process.arch, {}).value!;
  const gpu = mergeGpu(detection.gpu.value ?? defaultGpuForPlatform(machine.platform, machine.arch), answers.gpu);
  const cpuOnly = gpu.provider === 'none';
  const detectedModels = detection.ollamaModels.value ?? [];
  const models = buildModels(detectedModels, answers.models, cpuOnly);
  if (models.length === 0) {
    throw new Error('No models detected or provided. Add at least one model to generate a config.');
  }
  const routes = ensureCoreRoutes({ ...generateRoutes(models), ...(answers.routes ?? {}) }, models);
  const queue = {
    ...defaultQueue(machine, models, cpuOnly),
    ...(answers.queue ?? {})
  };

  const httpsAnswer = answers.server?.https;
  const serverHttps =
    typeof httpsAnswer === 'boolean'
      ? { enabled: httpsAnswer }
      : { enabled: false, ...(httpsAnswer ?? {}) };

  const config: AppConfig = {
    server: {
      host: '127.0.0.1',
      port: 11435,
      basePath: '/',
      requestBodyLimit: '8mb',
      https: serverHttps,
      ...omit(answers.server ?? {}, ['https'])
    },
    ollama: {
      baseUrl: detection.ollamaBaseUrl.value ?? 'http://127.0.0.1:11434',
      openAiCompatiblePath: '/v1/chat/completions',
      nativeApiBasePath: '/api',
      keepAlive: '10m',
      requestTimeoutMs: 180000,
      ...(answers.ollama ?? {})
    },
    gpu,
    router: {
      defaultMode: 'auto',
      syncMaxQueueTimeMs: cpuOnly ? 100 : 250,
      heavyLoadQueueDepth: cpuOnly ? 1 : models.some((model) => model.exclusive) ? 3 : 4,
      heavyLoadGpuFreeMbThreshold: gpu.provider === 'nvidia' ? Math.max(2048, gpu.vramSafetyReserveMb * 2) : 1024,
      defaultTaskType: 'unknown',
      classification: {
        mode: 'heuristic',
        optionalClassifierModel: models.find((model) => model.costClass === 'low')?.name,
        classifierTimeoutMs: 1500
      },
      ...(answers.router ?? {})
    },
    jobs: {
      store: 'memory',
      resultTtlSeconds: 86400,
      maxAttempts: 2,
      cleanupIntervalMs: 60000,
      ...(answers.jobs ?? {})
    },
    models,
    routes,
    queue
  };

  return parseConfig(serializeConfig(config));
}

export function parseOllamaList(outputText: string): DetectedOllamaModel[] {
  const lines = outputText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line) => {
    const wideParts = line.split(/\s{2,}/).filter(Boolean);
    const parts = wideParts.length >= 3 ? wideParts : line.split(/\s+/).filter(Boolean);
    const [name, id] = parts;
    const size = wideParts.length >= 3 ? parts[2] : [parts[2], parts[3]].filter(Boolean).join(' ');
    const modified = wideParts.length >= 3 ? parts[3] : parts.slice(4).join(' ');
    return {
      name: name ?? line,
      id,
      size,
      sizeGb: parseSizeGb(size),
      modified: modified || undefined
    };
  });
}

export function inferModelRole(model: Pick<DetectedOllamaModel, 'name' | 'sizeGb'>): ModelRole {
  const name = model.name.toLowerCase();
  if (name.includes('review')) return 'review';
  if (name.includes('coder') || name.includes('code') || name.includes('deepseek') || name.includes('qwen')) return 'code';
  if ((model.sizeGb ?? 0) >= 12 || name.includes('gpt-oss') || name.includes('reason')) return 'heavy';
  if (name.includes('tool')) return 'tool';
  return 'fast';
}

export function serializeConfig(config: AppConfig): string {
  return YAML.stringify(config, { lineWidth: 0 });
}

export function formatDetectionSummary(detection: WizardDetection): string {
  const machine = detection.machine.value;
  const gpu = detection.gpu.value;
  return [
    'Detected environment',
    '',
    'Ollama:',
    `  binary: ${detection.ollamaBinary.value ?? 'not found'} (${detection.ollamaBinary.source}, ${detection.ollamaBinary.confidence})`,
    `  base URL: ${detection.ollamaBaseUrl.value ?? 'not detected'} (${detection.ollamaBaseUrl.source})`,
    `  reachable: ${detection.ollamaReachable.value === true ? 'yes' : 'no'}`,
    `  models: ${detection.ollamaModels.value?.length ?? 0} found`,
    '',
    'GPU:',
    `  provider: ${gpu?.provider ?? 'none'}`,
    `  name: ${gpu?.name ?? 'not detected'}`,
    `  VRAM: ${gpu?.vramTotalMb ?? 0} MB`,
    `  monitor: ${gpu?.monitor.enabled ? `enabled through ${gpu.monitor.nvidiaSmiPath}` : 'disabled'}`,
    '',
    'Machine:',
    `  OS: ${machine?.platform ?? process.platform} ${machine?.arch ?? process.arch}`,
    `  CPU cores: ${machine?.cpuCores ?? os.cpus().length}`,
    `  RAM: ${machine?.totalMemoryMb ?? Math.round(os.totalmem() / 1024 / 1024)} MB`
  ].join('\n');
}

function formatConfigSummary(config: AppConfig, detection: WizardDetection, outputPath: string): string {
  const protocol = config.server.https.enabled ? 'https' : 'http';
  const basePath = config.server.basePath === '/' ? '/' : config.server.basePath;
  return [
    '',
    'Configuration summary',
    '',
    `Output: ${outputPath}`,
    `Server: ${protocol}://${config.server.host}:${config.server.port}${basePath}`,
    `Ollama: ${config.ollama.baseUrl}`,
    `GPU: ${config.gpu.provider}${config.gpu.name ? `, ${config.gpu.name}` : ''}, ${config.gpu.vramTotalMb} MB VRAM`,
    `Models: ${config.models.length} configured`,
    `Heavy model: ${config.models.find((model) => model.exclusive)?.name ?? 'none'}`,
    `Queue: global concurrency ${config.queue.globalMaxConcurrent}, max queued ${config.queue.globalMaxQueued}`,
    `Jobs: ${config.jobs.store} store, result TTL ${config.jobs.resultTtlSeconds}s`,
    '',
    'Detected:',
    `  Ollama models: ${detection.ollamaModels.value?.length ?? 0}`,
    `  Machine: ${detection.machine.value?.platform ?? process.platform} ${detection.machine.value?.arch ?? process.arch}`,
    ''
  ].join('\n');
}

async function promptForConfig(
  detection: WizardDetection,
  answers: ConfigureAnswers,
  options: ConfigureOptions
): Promise<AppConfig> {
  const rl = createInterface({ input, output });
  try {
    output.write(`${formatDetectionSummary(detection)}\n\n`);
    const useDetected = options.assumeYes || (await confirm(rl, 'Use these detected values?', true));
    let mergedAnswers = answers;
    if (!useDetected) {
      mergedAnswers = await promptCorrections(rl, detection, answers);
    }
    const config = generateConfigFromDetection(detection, mergedAnswers);
    if (!options.assumeYes && !(await confirm(rl, 'Write this config?', true))) {
      throw new Error('Configuration cancelled');
    }
    return config;
  } finally {
    rl.close();
  }
}

async function promptCorrections(
  rl: ReturnType<typeof createInterface>,
  detection: WizardDetection,
  answers: ConfigureAnswers
): Promise<ConfigureAnswers> {
  const baseUrl = await ask(rl, 'Ollama base URL', detection.ollamaBaseUrl.value ?? 'http://127.0.0.1:11434');
  const host = await ask(rl, 'Server host', '127.0.0.1');
  const port = Number(await ask(rl, 'Server port', '11435'));
  const basePath = await ask(rl, 'Server base path', '/');
  const gpu = detection.gpu.value ?? defaultGpuForPlatform(process.platform, process.arch);
  const vramTotalMb = Number(await ask(rl, 'GPU VRAM total MB', String(gpu.vramTotalMb)));
  const models = detection.ollamaModels.value?.length
    ? undefined
    : {
        mode: 'manual' as const,
        items: [
          {
            name: await ask(rl, 'First Ollama model name', 'llama3.2:3b'),
            role: 'fast' as const,
            sizeGb: Number(await ask(rl, 'First model size GB', '2'))
          }
        ]
      };

  return {
    ...answers,
    server: { ...(answers.server ?? {}), host, port, basePath },
    ollama: { ...(answers.ollama ?? {}), baseUrl },
    gpu: { ...(answers.gpu ?? {}), vramTotalMb },
    models: answers.models ?? models
  };
}

async function loadAnswers(path: string): Promise<ConfigureAnswers> {
  const raw = await readFile(path, 'utf8');
  const parsed = answersSchema.parse(YAML.parse(raw));
  return parsed as ConfigureAnswers;
}

async function detectOllamaBinary(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  pathLookup: (command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => Promise<string | undefined>
): Promise<DetectionResult<string>> {
  const pathResult = await pathLookup('ollama', platform, env);
  if (pathResult) return { value: pathResult, source: 'command', confidence: 'high' };

  const candidates =
    platform === 'darwin'
      ? ['/opt/homebrew/bin/ollama', '/usr/local/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama']
      : ['/usr/bin/ollama', '/usr/local/bin/ollama', '/snap/bin/ollama'];
  for (const candidate of candidates) {
    if (await executableExists(candidate)) return { value: candidate, source: 'command', confidence: 'medium' };
  }
  return notFound('ollama binary not found');
}

function detectOllamaBaseUrl(env: NodeJS.ProcessEnv): DetectionResult<string> {
  if (env.OLLAMA_HOST) return { value: normalizeOllamaHost(env.OLLAMA_HOST), source: 'env', confidence: 'high' };
  return { value: 'http://127.0.0.1:11434', source: 'default', confidence: 'medium' };
}

async function detectOllamaReachable(baseUrl: string | undefined, fetchImpl: typeof fetch): Promise<DetectionResult<boolean>> {
  if (!baseUrl) return notFound('ollama base URL is unknown');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetchImpl(new URL('/api/tags', baseUrl), { signal: controller.signal });
    return { value: response.ok, source: 'command', confidence: response.ok ? 'high' : 'low' };
  } catch {
    return { value: false, source: 'not_found', confidence: 'low', message: 'Ollama API did not respond' };
  } finally {
    clearTimeout(timer);
  }
}

async function detectOllamaModels(
  ollamaBinary: string | undefined,
  commandRunner: CommandRunner
): Promise<DetectionResult<DetectedOllamaModel[]>> {
  if (!ollamaBinary) return notFound('ollama binary not found');
  try {
    const { stdout } = await commandRunner(ollamaBinary, ['list']);
    return { value: parseOllamaList(stdout), source: 'command', confidence: 'high' };
  } catch {
    return { value: [], source: 'not_found', confidence: 'low', message: 'ollama list failed' };
  }
}

async function detectLoadedModels(
  ollamaBinary: string | undefined,
  commandRunner: CommandRunner
): Promise<DetectionResult<LoadedModel[]>> {
  if (!ollamaBinary) return notFound('ollama binary not found');
  try {
    const { stdout } = await commandRunner(ollamaBinary, ['ps']);
    return { value: parseOllamaPs(stdout), source: 'command', confidence: 'high' };
  } catch {
    return { value: [], source: 'not_found', confidence: 'low', message: 'ollama ps failed' };
  }
}

async function detectNvidiaSmi(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  pathLookup: (command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => Promise<string | undefined>
): Promise<DetectionResult<string>> {
  const found = await pathLookup('nvidia-smi', platform, env);
  return found ? { value: found, source: 'command', confidence: 'high' } : notFound('nvidia-smi not found');
}

async function detectGpu(
  platform: NodeJS.Platform,
  arch: string,
  nvidiaSmiPath: string | undefined,
  commandRunner: CommandRunner
): Promise<DetectionResult<AppConfig['gpu']>> {
  if (platform === 'darwin') {
    return { value: defaultGpuForPlatform(platform, arch), source: 'default', confidence: arch === 'arm64' ? 'medium' : 'low' };
  }
  if (!nvidiaSmiPath) {
    return { value: defaultGpuForPlatform(platform, arch), source: 'not_found', confidence: 'medium' };
  }
  try {
    const { stdout } = await commandRunner(nvidiaSmiPath, [
      '--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu',
      '--format=csv,noheader,nounits'
    ]);
    const gpu = parseNvidiaSmi(stdout)[0];
    if (!gpu) return { value: defaultGpuForPlatform(platform, arch), source: 'not_found', confidence: 'low' };
    return {
      value: {
        provider: 'nvidia',
        name: gpu.name,
        vramTotalMb: gpu.vramTotalMb,
        vramSafetyReserveMb: safetyReserveMb(gpu.vramTotalMb),
        maxGpuUtilizationPct: 92,
        requireGpuOnlyByDefault: true,
        monitor: {
          enabled: true,
          intervalMs: 5000,
          nvidiaSmiPath
        }
      },
      source: 'command',
      confidence: 'high'
    };
  } catch {
    return { value: defaultGpuForPlatform(platform, arch), source: 'not_found', confidence: 'low' };
  }
}

function detectMachine(platform: NodeJS.Platform, arch: string, options: DetectOptions): DetectionResult<MachineProfile> {
  const totalMemoryMb = options.totalMemoryMb ?? Math.round(os.totalmem() / 1024 / 1024);
  const cpuCores = options.cpuCores ?? os.cpus().length;
  return {
    value: {
      platform,
      arch,
      cpuCores,
      totalMemoryMb,
      class: totalMemoryMb < 16_384 || cpuCores < 4 ? 'small' : totalMemoryMb > 65_536 || cpuCores > 16 ? 'large' : 'medium'
    },
    source: 'command',
    confidence: 'high'
  };
}

function buildModels(detectedModels: DetectedOllamaModel[], answers?: ConfigureAnswers['models'], cpuOnly = false): ModelSpec[] {
  const source = answers?.mode === 'manual' ? answers.items ?? [] : answers?.items ?? detectedModels;
  return source
    .filter((model) => Boolean(model.name))
    .map((model) =>
      buildModelSpec(
        model.name as string,
        (model as { role?: ModelRole }).role ?? inferModelRole(model as DetectedOllamaModel),
        Number(model.sizeGb ?? 2),
        cpuOnly
      )
    );
}

function buildModelSpec(name: string, role: ModelRole, sizeGb: number, cpuOnly: boolean): ModelSpec {
  const heavy = role === 'heavy';
  const code = role === 'code' || role === 'review' || role === 'tool';
  const naturalMaxConcurrent = heavy ? 1 : role === 'fast' ? 2 : 1;
  return {
    name,
    sizeGb,
    purpose: purposesForRole(role),
    priority: heavy ? 95 : code ? 70 : 50,
    maxConcurrent: cpuOnly ? 1 : naturalMaxConcurrent,
    defaultContext: heavy ? 16_384 : code ? 8192 : 4096,
    maxContext: heavy ? 65_536 : code ? 32_768 : 8192,
    timeoutMs: heavy ? 300_000 : code ? 180_000 : 90_000,
    costClass: heavy ? 'high' : code ? 'medium' : 'low',
    exclusive: heavy,
    allowWhenBusy: !heavy,
    tags: tagsForRole(role)
  };
}

function purposesForRole(role: ModelRole): string[] {
  switch (role) {
    case 'code':
      return ['code_generate', 'code_fix', 'tool_use'];
    case 'review':
      return ['code_review', 'code_generate', 'code_fix'];
    case 'heavy':
      return ['agentic_reasoning', 'large_context', 'planning', 'tool_use'];
    case 'tool':
      return ['tool_use', 'code_generate'];
    case 'fast':
    default:
      return ['triage', 'simple_chat', 'summarize'];
  }
}

function tagsForRole(role: ModelRole): string[] {
  switch (role) {
    case 'code':
      return ['code', 'fallback'];
    case 'review':
      return ['code', 'review'];
    case 'heavy':
      return ['reasoning', 'large_context'];
    case 'tool':
      return ['tool_use'];
    case 'fast':
    default:
      return ['fast', 'chat'];
  }
}

function generateRoutes(models: ModelSpec[]): Record<string, string[]> {
  const fast = models.filter((model) => model.costClass === 'low').map((model) => model.name);
  const code = models.filter((model) => model.purpose.includes('code_generate')).map((model) => model.name);
  const review = models.filter((model) => model.purpose.includes('code_review')).map((model) => model.name);
  const heavy = models.filter((model) => model.exclusive || model.costClass === 'high').map((model) => model.name);
  const tool = models.filter((model) => model.purpose.includes('tool_use')).map((model) => model.name);
  const fallback = [...fast, ...code, ...models.map((model) => model.name)];
  return {
    triage: firstNonEmpty(fast, fallback),
    simple_chat: firstNonEmpty(fast, fallback),
    summarize: firstNonEmpty(fast, fallback),
    code_generate: firstNonEmpty(code, fallback),
    code_review: firstNonEmpty(review, code, fallback),
    code_fix: firstNonEmpty(code, review, fallback),
    agentic_reasoning: firstNonEmpty(heavy, code, fallback),
    large_context: firstNonEmpty(heavy, code, fallback),
    tool_use: firstNonEmpty(tool, code, heavy, fallback),
    unknown: firstNonEmpty(fast, code, fallback)
  };
}

function ensureCoreRoutes(routes: Partial<Record<string, string[]>>, models: ModelSpec[]): Record<string, string[]> {
  const fallback = [models[0].name];
  return Object.fromEntries(coreTaskTypes.map((taskType) => [taskType, routes[taskType]?.length ? routes[taskType] : fallback]));
}

function defaultQueue(machine: MachineProfile, models: ModelSpec[], cpuOnly = false): AppConfig['queue'] {
  const maxByModels = models.reduce((sum, model) => sum + model.maxConcurrent, 0);
  const suggested = cpuOnly ? 1 : machine.class === 'small' ? 1 : machine.class === 'large' ? 4 : 3;
  return {
    globalMaxConcurrent: Math.max(1, Math.min(maxByModels, suggested)),
    globalMaxQueued: cpuOnly || machine.class === 'small' ? 50 : 100,
    perUserMaxQueued: cpuOnly || machine.class === 'small' ? 10 : 20,
    defaultPriority: 'normal',
    timeoutMs: 180_000
  };
}

function mergeGpu(base: AppConfig['gpu'], override: Partial<AppConfig['gpu']> | undefined): AppConfig['gpu'] {
  return {
    ...base,
    ...(override ?? {}),
    monitor: {
      ...base.monitor,
      ...(override?.monitor ?? {})
    }
  };
}

function defaultGpuForPlatform(platform: NodeJS.Platform, arch: string): AppConfig['gpu'] {
  const mac = platform === 'darwin';
  return {
    provider: 'none',
    name: mac && arch === 'arm64' ? 'Apple Silicon / macOS GPU' : mac ? 'macOS GPU' : 'No NVIDIA GPU detected',
    vramTotalMb: 0,
    vramSafetyReserveMb: 1024,
    maxGpuUtilizationPct: 95,
    requireGpuOnlyByDefault: false,
    monitor: {
      enabled: false,
      intervalMs: 5000,
      nvidiaSmiPath: 'nvidia-smi'
    }
  };
}

function safetyReserveMb(totalMb: number): number {
  if (totalMb < 8192) return 1024;
  if (totalMb <= 24_576) return 1536;
  return 2048;
}

function firstNonEmpty(...lists: string[][]): string[] {
  return lists.find((list) => list.length > 0) ?? [];
}

function parseSizeGb(size: string | undefined): number | undefined {
  if (!size) return undefined;
  const match = size.match(/([\d.]+)\s*([kmgt]i?b|[kmgt]b)?/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = (match[2] ?? 'GB').toLowerCase();
  if (!Number.isFinite(value)) return undefined;
  if (unit.startsWith('m')) return value / 1024;
  if (unit.startsWith('k')) return value / 1024 / 1024;
  if (unit.startsWith('t')) return value * 1024;
  return value;
}

function normalizeOllamaHost(host: string): string {
  if (host.startsWith('http://') || host.startsWith('https://')) return host;
  return `http://${host}`;
}

async function findExecutable(command: string, _platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pathValue = env.PATH ?? '';
  for (const entry of pathValue.split(':').filter(Boolean)) {
    const candidate = resolve(entry, command);
    if (await executableExists(candidate)) return candidate;
  }
  return undefined;
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultCommandRunner(command: string, args: string[]): Promise<{ stdout: string; stderr?: string }> {
  const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5000 });
  return { stdout, stderr };
}

function notFound<T>(message: string): DetectionResult<T> {
  return { source: 'not_found', confidence: 'low', message };
}

async function confirm(rl: ReturnType<typeof createInterface>, question: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? '[Y/n]' : '[y/N]';
  const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return answer === 'y' || answer === 'yes';
}

async function ask(rl: ReturnType<typeof createInterface>, question: string, defaultValue: string): Promise<string> {
  const answer = await rl.question(`${question} (${defaultValue}): `);
  return answer.trim() || defaultValue;
}

function omit<T extends Record<string, unknown>, K extends keyof T>(value: T, keys: K[]): Omit<T, K> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key as K))) as Omit<T, K>;
}

function emit(options: ConfigureOptions, text: string): void {
  if (!options.silent) output.write(text);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
