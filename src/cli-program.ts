import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { loadConfig, parseConfig, writeDefaultConfig } from './config.js';
import { runConfigure } from './configurator.js';
import { NvidiaGpuMonitor } from './gpu.js';
import { InMemoryJobStore } from './job-store.js';
import { HttpOllamaClient } from './ollama.js';
import { QueueManager } from './queue-manager.js';
import { startServer } from './server.js';
import { logger } from './logger.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export function createProgram(): Command {
  const program = new Command();

  program
    .name('ollama-agent-router')
    .alias('oar')
    .description('Intelligent HTTP/CLI router for Ollama')
    .version(packageJson.version, '-v, --version', 'display version')
    .option('-c, --config <path>', 'config file path')
    .option('-u, --url <url>', 'router URL for client commands', 'http://127.0.0.1:11435')
    .option('--base-path <path>', 'router API base path for client commands', '/');

  program
    .command('serve')
    .description('start the router server')
    .option('-c, --config <path>', 'config file path')
    .action(async (options) => {
      const { config, path } = await loadConfig(options.config ?? program.opts().config);
      const jobs = new InMemoryJobStore(config.jobs);
      const ollama = new HttpOllamaClient(config.ollama);
      const gpu = new NvidiaGpuMonitor(config.gpu);
      const queue = new QueueManager(config, ollama, jobs);
      const cleanup = setInterval(() => jobs.cleanupExpired(), config.jobs.cleanupIntervalMs);
      const server = await startServer(config, { ollama, gpu, jobs, queue });
      logger.info({ configPath: path }, 'loaded config');

      const shutdown = async () => {
        clearInterval(cleanup);
        await server.close();
        jobs.close();
        process.exit(0);
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });

  program
    .command('init')
    .description('write a starter config')
    .option('-o, --output <path>', 'output path', './ollama-agent-router.yaml')
    .option('--wizard', 'run the detect-first configuration wizard')
    .action(async (options) => {
      if (options.wizard) {
        await runConfigure({ outputPath: options.output });
        return;
      }
      await writeDefaultConfig(options.output);
      console.log(`Wrote ${options.output}`);
    });

  program
    .command('configure')
    .description('run the detect-first configuration wizard')
    .option('-o, --output <path>', 'output path', './ollama-agent-router.yaml')
    .option('--answers <path>', 'answers YAML for non-interactive mode')
    .option('--non-interactive', 'generate config without interactive prompts')
    .option('--detect', 'print detected environment and exit')
    .option('--dry-run', 'print generated YAML without writing')
    .option('--overwrite', 'overwrite output if it already exists')
    .option('-y, --yes', 'accept detected values and write without confirmation')
    .action(async (options) => {
      await runConfigure({
        outputPath: options.output,
        answersPath: options.answers,
        nonInteractive: options.nonInteractive || options.yes,
        detectOnly: options.detect,
        dryRun: options.dryRun,
        overwrite: options.overwrite,
        assumeYes: options.yes
      });
    });

  program
    .command('validate-config')
    .description('validate YAML configuration')
    .option('-c, --config <path>', 'config file path')
    .action(async (options) => {
      const path = options.config ?? program.opts().config;
      if (path) {
        parseConfig(await readFile(path, 'utf8'));
        console.log(`Config is valid: ${path}`);
        return;
      }
      const found = await loadConfig();
      console.log(`Config is valid: ${found.path}`);
    });

  program.command('status').description('show router status').action(() => printJson(program, '/v1/router/status'));
  program.command('models').description('show configured and Ollama models').action(() => printJson(program, '/v1/router/models'));
  program.command('gpu').description('show GPU state').action(() => printJson(program, '/v1/router/gpu'));
  program.command('jobs').description('list jobs').action(() => printJson(program, '/v1/jobs'));
  program.command('job <jobId>').description('show job').action((jobId) => printJson(program, `/v1/jobs/${jobId}`));
  program.command('result <jobId>').description('show job result').action((jobId) => printJson(program, `/v1/jobs/${jobId}/result`));
  program
    .command('cancel <jobId>')
    .description('cancel a job')
    .action((jobId) => printJson(program, `/v1/jobs/${jobId}`, { method: 'DELETE' }));

  return program;
}

async function printJson(program: Command, path: string, init?: RequestInit): Promise<void> {
  const response = await fetch(buildClientUrl(program, path), init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `HTTP ${response.status}`);
  }
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

function buildClientUrl(program: Command, path: string): URL {
  const options = program.opts() as { url: string; basePath: string };
  const url = new URL(options.url);
  const basePath = normalizeBasePath(options.basePath);
  const pieces = [url.pathname, basePath, path].map((piece) => piece.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  url.pathname = `/${pieces.join('/')}`;
  return url;
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}
