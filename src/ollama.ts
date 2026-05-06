import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppConfig, ChatCompletionRequest, LoadedModel } from './types.js';

const execFileAsync = promisify(execFile);

export interface OllamaClient {
  chat(request: ChatCompletionRequest, model: string, timeoutMs?: number): Promise<unknown>;
  tags(): Promise<unknown>;
  ps(): Promise<LoadedModel[]>;
  health(): Promise<boolean>;
}

export class HttpOllamaClient implements OllamaClient {
  constructor(
    private readonly config: AppConfig['ollama'],
    private readonly commandRunner: (command: string, args: string[]) => Promise<{ stdout: string }> = defaultCommandRunner
  ) {}

  async chat(request: ChatCompletionRequest, model: string, timeoutMs = this.config.requestTimeoutMs): Promise<unknown> {
    const url = new URL(this.config.openAiCompatiblePath, this.config.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const body = { ...request, model };
    delete body.router;
    if (!('stream' in body)) body.stream = false;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const payload = await safeJson(response);
      if (!response.ok) {
        throw new OllamaHttpError(response.status, payload);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async tags(): Promise<unknown> {
    const response = await fetch(new URL(`${this.config.nativeApiBasePath}/tags`, this.config.baseUrl));
    const payload = await safeJson(response);
    if (!response.ok) throw new OllamaHttpError(response.status, payload);
    return payload;
  }

  async ps(): Promise<LoadedModel[]> {
    try {
      const { stdout } = await this.commandRunner('ollama', ['ps']);
      return parseOllamaPs(stdout);
    } catch {
      return [];
    }
  }

  async health(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(new URL(`${this.config.nativeApiBasePath}/tags`, this.config.baseUrl), {
        signal: controller.signal
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class OllamaHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly payload: unknown
  ) {
    super(`Ollama HTTP request failed with status ${statusCode}`);
  }
}

export function parseOllamaPs(output: string): LoadedModel[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return [];

  return lines.slice(1).map((line) => {
    const parts = line.split(/\s{2,}/).filter(Boolean);
    if (parts.length >= 5) {
      return {
        name: parts[0],
        id: parts[1],
        size: parts[2],
        processor: parts[3],
        until: parts.slice(4).join(' ')
      };
    }

    const fallback = line.match(/^(\S+)\s+(\S+)\s+(.+?)\s+((?:\d+%\s+)?(?:GPU|CPU)(?:\/GPU)?)\s+(.+)$/i);
    if (fallback) {
      return {
        name: fallback[1],
        id: fallback[2],
        size: fallback[3].trim(),
        processor: fallback[4].trim(),
        until: fallback[5].trim()
      };
    }

    return { name: parts[0] ?? line };
  });
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function defaultCommandRunner(command: string, args: string[]): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(command, args, { timeout: 5000 });
  return { stdout };
}
