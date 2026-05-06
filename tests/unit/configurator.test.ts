import {
  detectEnvironment,
  generateConfigFromDetection,
  inferModelRole,
  parseOllamaList,
  serializeConfig,
  runConfigure
} from '../../src/configurator.js';
import { parseConfig } from '../../src/config.js';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

it('parses ollama list output with model sizes', () => {
  const models = parseOllamaList(`NAME                       ID              SIZE      MODIFIED
qwen2.5-coder:7b           abc123          4.7 GB    2 days ago
gpt-oss:20b                def456          14 GB     1 week ago`);
  expect(models).toEqual([
    { name: 'qwen2.5-coder:7b', id: 'abc123', size: '4.7 GB', sizeGb: 4.7, modified: '2 days ago' },
    { name: 'gpt-oss:20b', id: 'def456', size: '14 GB', sizeGb: 14, modified: '1 week ago' }
  ]);
});

it('infers useful model roles from names and size', () => {
  expect(inferModelRole({ name: 'qwen2.5-coder:7b', sizeGb: 4.7 })).toBe('code');
  expect(inferModelRole({ name: 'gpt-oss:20b', sizeGb: 14 })).toBe('heavy');
  expect(inferModelRole({ name: 'llama3.2:3b', sizeGb: 2 })).toBe('fast');
});

it('detects Linux NVIDIA GPU and generates valid config', async () => {
  const detection = await detectEnvironment({
    platform: 'linux',
    arch: 'x64',
    totalMemoryMb: 65_536,
    cpuCores: 16,
    env: { PATH: '/usr/bin' },
    pathLookup: async (command) => `/usr/bin/${command}`,
    fetchImpl: okFetch,
    commandRunner: async (command, args) => {
      if (command.endsWith('ollama') && args[0] === 'list') {
        return {
          stdout: `NAME                       ID              SIZE      MODIFIED
B-A-M-N/vibethinker:1.5b   aaa111          3.6 GB    today
qwen2.5-coder:7b           bbb222          4.7 GB    today
deepseek-coder:6.7b        ccc333          3.8 GB    today
gpt-oss:20b                ddd444          14 GB     today`
        };
      }
      if (command.endsWith('ollama') && args[0] === 'ps') {
        return { stdout: 'NAME ID SIZE PROCESSOR UNTIL\n' };
      }
      if (command.endsWith('nvidia-smi')) {
        return { stdout: 'RTX 4000 SFF Ada, 20480, 1024, 19456, 12' };
      }
      throw new Error('unexpected command');
    }
  });

  expect(detection.gpu.value?.provider).toBe('nvidia');
  expect(detection.gpu.value?.monitor.enabled).toBe(true);
  const config = generateConfigFromDetection(detection);
  expect(config.gpu.requireGpuOnlyByDefault).toBe(true);
  expect(config.routes.agentic_reasoning?.[0]).toBe('gpt-oss:20b');
  expect(parseConfig(serializeConfig(config)).models).toHaveLength(4);
});

it('uses macOS defaults without enabling NVIDIA monitoring', async () => {
  const detection = await detectEnvironment({
    platform: 'darwin',
    arch: 'arm64',
    totalMemoryMb: 32_768,
    cpuCores: 10,
    env: { PATH: '/opt/homebrew/bin' },
    pathLookup: async (command) => (command === 'ollama' ? '/opt/homebrew/bin/ollama' : undefined),
    fetchImpl: okFetch,
    commandRunner: async (_command, args) => {
      if (args[0] === 'list') {
        return { stdout: 'NAME ID SIZE MODIFIED\nllama3.2:3b abc 2 GB today\n' };
      }
      return { stdout: 'NAME ID SIZE PROCESSOR UNTIL\n' };
    }
  });

  const config = generateConfigFromDetection(detection);
  expect(config.gpu.provider).toBe('none');
  expect(config.gpu.monitor.enabled).toBe(false);
  expect(config.gpu.requireGpuOnlyByDefault).toBe(false);
  expect(config.models[0].name).toBe('llama3.2:3b');
});

it('prefers low concurrency and early async queueing for CPU-only machines', async () => {
  const detection = await detectEnvironment({
    platform: 'linux',
    arch: 'x64',
    totalMemoryMb: 65_536,
    cpuCores: 16,
    env: { PATH: '/usr/bin' },
    pathLookup: async (command) => (command === 'ollama' ? '/usr/bin/ollama' : undefined),
    fetchImpl: okFetch,
    commandRunner: async (_command, args) => {
      if (args[0] === 'list') {
        return {
          stdout: `NAME                       ID              SIZE      MODIFIED
llama3.2:3b                aaa111          2 GB      today
qwen2.5-coder:7b           bbb222          4.7 GB    today`
        };
      }
      return { stdout: 'NAME ID SIZE PROCESSOR UNTIL\n' };
    }
  });

  const config = generateConfigFromDetection(detection);
  expect(config.gpu.provider).toBe('none');
  expect(config.queue.globalMaxConcurrent).toBe(1);
  expect(config.queue.globalMaxQueued).toBe(50);
  expect(config.queue.perUserMaxQueued).toBe(10);
  expect(config.router.defaultMode).toBe('auto');
  expect(config.router.syncMaxQueueTimeMs).toBe(100);
  expect(config.router.heavyLoadQueueDepth).toBe(1);
  expect(config.models.every((model) => model.maxConcurrent === 1)).toBe(true);
});

it('honors OLLAMA_HOST during detection', async () => {
  const detection = await detectEnvironment({
    platform: 'linux',
    arch: 'x64',
    env: { PATH: '', OLLAMA_HOST: 'http://10.0.0.5:11434' },
    pathLookup: async () => undefined,
    fetchImpl: okFetch,
    commandRunner: async () => ({ stdout: '' })
  });
  expect(detection.ollamaBaseUrl.value).toBe('http://10.0.0.5:11434');
});

it('generates valid YAML in non-interactive mode from answers', async () => {
  const testId = `${process.pid}-${Date.now()}`;
  const outputPath = join(tmpdir(), `oar-configurator-test-${testId}.yaml`);
  const answersPath = join(tmpdir(), `oar-configurator-answers-${testId}.yaml`);
  await writeFile(
    answersPath,
    `models:
  mode: manual
  items:
    - name: qwen2.5-coder:7b
      role: code
      sizeGb: 4.7
`,
    'utf8'
  );
  await runConfigure({
    outputPath,
    nonInteractive: true,
    overwrite: true,
    platform: 'linux',
    arch: 'x64',
    env: { PATH: '' },
    pathLookup: async () => undefined,
    fetchImpl: okFetch,
    commandRunner: async () => ({ stdout: '' }),
    totalMemoryMb: 16_384,
    cpuCores: 4,
    answersPath,
    silent: true
  });
  const config = parseConfig(await readFile(outputPath, 'utf8'));
  expect(config.models[0].name).toBe('qwen2.5-coder:7b');
  await rm(outputPath, { force: true });
  await rm(answersPath, { force: true });
});

const okFetch = async () =>
  ({
    ok: true
  }) as Response;
