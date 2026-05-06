import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppConfig, GpuSnapshot } from './types.js';

const execFileAsync = promisify(execFile);

export interface GpuMonitor {
  snapshot(): Promise<GpuSnapshot | undefined>;
}

export class StaticGpuMonitor implements GpuMonitor {
  constructor(private readonly config: AppConfig['gpu']) {}

  async snapshot(): Promise<GpuSnapshot | undefined> {
    if (this.config.provider === 'none') return undefined;
    return {
      provider: this.config.provider,
      name: this.config.name ?? 'Configured GPU',
      vramTotalMb: this.config.vramTotalMb,
      vramUsedMb: 0,
      vramFreeMb: this.config.vramTotalMb,
      utilizationPct: 0,
      snapshotAgeMs: 0
    };
  }
}

export class NvidiaGpuMonitor implements GpuMonitor {
  constructor(
    private readonly config: AppConfig['gpu'],
    private readonly commandRunner: (command: string, args: string[]) => Promise<{ stdout: string }> = defaultCommandRunner
  ) {}

  async snapshot(): Promise<GpuSnapshot | undefined> {
    if (!this.config.monitor.enabled || this.config.provider !== 'nvidia') {
      return new StaticGpuMonitor(this.config).snapshot();
    }

    const args = [
      '--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu',
      '--format=csv,noheader,nounits'
    ];
    const { stdout } = await this.commandRunner(this.config.monitor.nvidiaSmiPath, args);
    return parseNvidiaSmi(stdout)[0];
  }
}

export function parseNvidiaSmi(output: string): GpuSnapshot[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, total, used, free, utilization] = line.split(',').map((part) => part.trim());
      return {
        provider: 'nvidia' as const,
        name,
        vramTotalMb: Number(total),
        vramUsedMb: Number(used),
        vramFreeMb: Number(free),
        utilizationPct: Number(utilization),
        snapshotAgeMs: 0
      };
    })
    .filter((gpu) => gpu.name && Number.isFinite(gpu.vramTotalMb));
}

async function defaultCommandRunner(command: string, args: string[]): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(command, args, { timeout: 5000 });
  return { stdout };
}
