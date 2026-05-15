import { open, readFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { AccessConfig, ManagedAccessConfig } from './types.js';

export const trafficLimitSchema = z.object({
  requests: z.number().int().positive(),
  windowSeconds: z.number().int().positive()
});

const protectedPlaneConfigSchema = z.object({
  enabled: z.boolean().default(true),
  auth: z
    .object({
      requireApiKey: z.boolean().default(false),
      anonymous: z.enum(['allow', 'reject', 'limited']).default('allow')
    })
    .default({ requireApiKey: false, anonymous: 'allow' }),
  defaultLimit: trafficLimitSchema.optional()
});

export const apiKeySchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9._:-]+$/, 'api key id may contain only letters, numbers, dots, underscores, colons, and dashes'),
  name: z.string().min(1).optional(),
  keyHash: z.string().regex(/^sha256:[a-fA-F0-9]{64}$/, 'keyHash must use sha256:<64 hex chars>'),
  enabled: z.boolean().default(true),
  scopes: z.array(z.enum(['standalone', 'runtimeAgent'])).min(1),
  limits: z
    .object({
      standalone: trafficLimitSchema.optional(),
      runtimeAgent: trafficLimitSchema.optional()
    })
    .optional()
});

export const managedAccessConfigSchema = z.object({
  version: z.number().int().nonnegative().default(1),
  updatedAt: z.string().datetime().optional(),
  planes: z
    .object({
      standalone: protectedPlaneConfigSchema.default({
        enabled: true,
        auth: { requireApiKey: false, anonymous: 'allow' }
      }),
      runtimeAgent: protectedPlaneConfigSchema.default({
        enabled: true,
        auth: { requireApiKey: false, anonymous: 'allow' }
      })
    })
    .default({
      standalone: { enabled: true, auth: { requireApiKey: false, anonymous: 'allow' } },
      runtimeAgent: { enabled: true, auth: { requireApiKey: false, anonymous: 'allow' } }
    }),
  apiKeys: z.array(apiKeySchema).default([])
});

export const defaultManagedAccessConfig: ManagedAccessConfig = managedAccessConfigSchema.parse({});

export const adminPlaneConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    allowedIps: z.array(z.string().min(1)).default(['127.0.0.1', '::1']),
    trustedProxy: z.boolean().default(false),
    apiKeyHashes: z.array(z.string().regex(/^sha256:[a-fA-F0-9]{64}$/)).default([]),
    clientCert: z
      .object({
        required: z.boolean().default(false),
        allowedFingerprints: z.array(z.string().min(1)).default([]),
        allowedSubjects: z.array(z.string().min(1)).default([])
      })
      .default({ required: false, allowedFingerprints: [], allowedSubjects: [] }),
    auditLog: z.boolean().default(true)
  })
  .default({
    enabled: false,
    allowedIps: ['127.0.0.1', '::1'],
    trustedProxy: false,
    apiKeyHashes: [],
    clientCert: { required: false, allowedFingerprints: [], allowedSubjects: [] },
    auditLog: true
  });

export const accessConfigSchema = z
  .object({
    managedConfigPath: z.preprocess((value) => (value === null ? undefined : value), z.string().min(1).optional()),
    bootstrapIfMissing: z.boolean().default(true),
    managed: managedAccessConfigSchema.default(defaultManagedAccessConfig),
    admin: adminPlaneConfigSchema
  })
  .default({
    bootstrapIfMissing: true,
    managed: defaultManagedAccessConfig,
    admin: adminPlaneConfigSchema.parse({})
  });

export async function loadManagedAccessConfig(access: AccessConfig, baseDir: string): Promise<AccessConfig> {
  if (!access.managedConfigPath) return access;

  const target = resolve(baseDir, access.managedConfigPath);
  try {
    const raw = await readFile(target, 'utf8');
    return { ...access, managedConfigPath: target, managed: managedAccessConfigSchema.parse(YAML.parse(raw)) };
  } catch (error) {
    if (!isFileMissing(error) || !access.bootstrapIfMissing) throw error;
    await writeManagedAccessConfig(target, access.managed);
    return { ...access, managedConfigPath: target };
  }
}

export async function writeManagedAccessConfig(path: string, config: ManagedAccessConfig): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(YAML.stringify(config), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, target);
  await fsyncDirectory(dirname(target));
}

function isFileMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}

async function fsyncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not available on every platform/filesystem.
  }
}
