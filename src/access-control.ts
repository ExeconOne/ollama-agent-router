import crypto from 'node:crypto';
import net from 'node:net';
import { TLSSocket } from 'node:tls';
import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { apiKeySchema, managedAccessConfigSchema, writeManagedAccessConfig } from './access-config.js';
import { AccessConfig, AccessPlane, AdminPlaneConfig, ApiKeyAccessConfig, ManagedAccessConfig, TrafficLimit } from './types.js';
import { logger } from './logger.js';

type Principal = { type: 'apiKey'; id: string } | { type: 'anonymous'; id: 'anonymous' };

interface RateCheck {
  allowed: boolean;
  limit?: number;
  remaining?: number;
  resetAt?: number;
  retryAfterSeconds?: number;
}

export class AccessHttpError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export class AccessControlStore {
  private managed: ManagedAccessConfig;
  private writeQueue: Promise<void> = Promise.resolve();
  private limiter = new FixedWindowTrafficLimiter();

  constructor(private access: AccessConfig) {
    this.managed = access.managed;
  }

  getConfig(): ManagedAccessConfig {
    return structuredClone(this.managed);
  }

  async replaceConfig(input: unknown, expectedVersion?: number): Promise<ManagedAccessConfig> {
    const next = managedAccessConfigSchema.parse(input);
    let updated!: ManagedAccessConfig;
    await this.enqueueWrite(async () => {
      if (expectedVersion !== undefined && expectedVersion !== this.managed.version) {
        throw new AccessHttpError(409, `Access config version mismatch: expected ${expectedVersion}, current ${this.managed.version}`);
      }
      updated = {
        ...next,
        version: this.managed.version + 1,
        updatedAt: new Date().toISOString()
      };
      if (!this.access.managedConfigPath) {
        throw new AccessHttpError(500, 'access.managedConfigPath is not configured');
      }
      await writeManagedAccessConfig(this.access.managedConfigPath, updated);
      this.managed = updated;
      this.access.managed = updated;
      this.limiter.clear();
    });
    return structuredClone(updated);
  }

  async addApiKey(input: unknown): Promise<ApiKeyAccessConfig> {
    const key = apiKeySchema.parse(input);
    await this.enqueueWrite(async () => {
      if (this.managed.apiKeys.some((k) => k.id === key.id)) {
        throw new AccessHttpError(409, `API key with id '${key.id}' already exists`);
      }
      if (!this.access.managedConfigPath) {
        throw new AccessHttpError(500, 'access.managedConfigPath is not configured');
      }
      const next: ManagedAccessConfig = {
        ...this.managed,
        version: this.managed.version + 1,
        updatedAt: new Date().toISOString(),
        apiKeys: [...this.managed.apiKeys, key]
      };
      await writeManagedAccessConfig(this.access.managedConfigPath, next);
      this.managed = next;
      this.access.managed = next;
    });
    return structuredClone(key);
  }

  async revokeApiKey(id: string): Promise<ApiKeyAccessConfig> {
    let removed!: ApiKeyAccessConfig;
    await this.enqueueWrite(async () => {
      const idx = this.managed.apiKeys.findIndex((k) => k.id === id);
      if (idx === -1) {
        throw new AccessHttpError(404, `API key '${id}' not found`);
      }
      if (!this.access.managedConfigPath) {
        throw new AccessHttpError(500, 'access.managedConfigPath is not configured');
      }
      removed = this.managed.apiKeys[idx];
      const next: ManagedAccessConfig = {
        ...this.managed,
        version: this.managed.version + 1,
        updatedAt: new Date().toISOString(),
        apiKeys: this.managed.apiKeys.filter((_, i) => i !== idx)
      };
      await writeManagedAccessConfig(this.access.managedConfigPath, next);
      this.managed = next;
      this.access.managed = next;
      this.limiter.clear();
    });
    return structuredClone(removed);
  }

  publicMiddleware(planeOrPlanes: AccessPlane | AccessPlane[]) {
    return (req: Request, res: Response, next: NextFunction) => {
      const planes = Array.isArray(planeOrPlanes) ? planeOrPlanes : [planeOrPlanes];
      const enabledPlanes = planes.filter((plane) => this.managed.planes[plane].enabled);
      if (enabledPlanes.length === 0) {
        auditPlaneDenied(planes[0], req, 'plane_disabled');
        return res.status(404).json({ error: { message: 'Not found' } });
      }

      const rawKey = extractBearerOrApiKey(req);
      const auth = rawKey ? this.authenticateApiKey(enabledPlanes, rawKey, req, res) : this.authenticateAnonymous(enabledPlanes, req, res);
      if (!auth) return undefined;

      const { plane, principal, apiKey } = auth;
      const config = this.managed.planes[plane];
      const limit = principal.type === 'apiKey' ? apiKey?.limits?.[plane] ?? config.defaultLimit : config.defaultLimit;
      const rate = this.limiter.check(`${plane}:${principal.id}`, limit);
      applyRateHeaders(res, rate);
      if (!rate.allowed) {
        auditPlaneDenied(plane, req, 'rate_limited', principal.id);
        return res.status(429).json({ error: { message: 'Rate limit exceeded' } });
      }

      res.locals.access = { plane, principal };
      return next();
    };
  }

  adminMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const config = this.access.admin;
      if (!config.enabled) {
        return res.status(404).json({ error: { message: 'Not found' } });
      }
      const remoteIp = getRemoteIp(req, config);
      if (!remoteIp || !isIpAllowed(remoteIp, config.allowedIps)) {
        auditAdmin(config, req, 'denied', 'ip_not_allowed', remoteIp);
        return res.status(403).json({ error: { message: 'Admin plane access denied' } });
      }
      const key = extractBearerOrApiKey(req);
      if (!key || !config.apiKeyHashes.some((hash) => verifySecretHash(key, hash))) {
        auditAdmin(config, req, 'denied', 'invalid_admin_key', remoteIp);
        return res.status(401).json({ error: { message: 'Admin authentication required' } });
      }
      if (!verifyClientCertificate(req, config)) {
        auditAdmin(config, req, 'denied', 'client_cert_required_or_untrusted', remoteIp);
        return res.status(403).json({ error: { message: 'Trusted client certificate required' } });
      }
      res.locals.admin = { remoteIp };
      return next();
    };
  }

  private authenticateAnonymous(
    planes: AccessPlane[],
    req: Request,
    res: Response
  ): { plane: AccessPlane; principal: Principal; apiKey?: ApiKeyAccessConfig } | undefined {
    const plane = planes.find((candidate) => {
      const config = this.managed.planes[candidate];
      return !config.auth.requireApiKey && config.auth.anonymous !== 'reject';
    });
    if (!plane) {
      auditPlaneDenied(planes[0], req, 'api_key_required');
      res.status(401).json({ error: { message: 'API key required' } });
      return undefined;
    }
    const planeConfig = this.managed.planes[plane];
    if (planeConfig.auth.requireApiKey || planeConfig.auth.anonymous === 'reject') {
      auditPlaneDenied(plane, req, 'api_key_required');
      res.status(401).json({ error: { message: 'API key required' } });
      return undefined;
    }
    return { plane, principal: { type: 'anonymous', id: 'anonymous' } };
  }

  private authenticateApiKey(
    planes: AccessPlane[],
    rawKey: string,
    req: Request,
    res: Response
  ): { plane: AccessPlane; principal: Principal; apiKey: ApiKeyAccessConfig } | undefined {
    const apiKey = this.managed.apiKeys.find((candidate) => candidate.enabled && verifySecretHash(rawKey, candidate.keyHash));
    if (!apiKey) {
      auditPlaneDenied(planes[0], req, 'invalid_api_key');
      res.status(401).json({ error: { message: 'Invalid API key' } });
      return undefined;
    }
    const plane = planes.find((candidate) => apiKey.scopes.includes(candidate));
    if (!plane) {
      auditPlaneDenied(planes[0], req, 'scope_denied', apiKey.id);
      res.status(403).json({ error: { message: 'API key is not allowed for this plane' } });
      return undefined;
    }
    return { plane, principal: { type: 'apiKey', id: apiKey.id }, apiKey };
  }

  private async enqueueWrite(fn: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }
}

class FixedWindowTrafficLimiter {
  private counters = new Map<string, { count: number; resetAt: number }>();

  check(key: string, limit?: TrafficLimit): RateCheck {
    if (!limit) return { allowed: true };
    const now = Date.now();
    const windowMs = limit.windowSeconds * 1000;
    const current = this.counters.get(key);
    const counter = current && current.resetAt > now ? current : { count: 0, resetAt: now + windowMs };
    counter.count += 1;
    this.counters.set(key, counter);
    const remaining = Math.max(0, limit.requests - counter.count);
    if (counter.count > limit.requests) {
      return {
        allowed: false,
        limit: limit.requests,
        remaining: 0,
        resetAt: counter.resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((counter.resetAt - now) / 1000))
      };
    }
    return { allowed: true, limit: limit.requests, remaining, resetAt: counter.resetAt };
  }

  clear(): void {
    this.counters.clear();
  }
}

export function hashApiKey(secret: string): string {
  return `sha256:${crypto.createHash('sha256').update(secret).digest('hex')}`;
}

export function getAccessErrorStatus(error: unknown): number | undefined {
  if (error instanceof AccessHttpError) return error.statusCode;
  if (error instanceof ZodError) return 400;
  return undefined;
}

function extractBearerOrApiKey(req: Request): string | undefined {
  const authorization = req.header('authorization');
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }
  const apiKey = req.header('x-api-key');
  return apiKey?.trim() || undefined;
}

function verifySecretHash(secret: string, expectedHash: string): boolean {
  const actual = hashApiKey(secret);
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expectedHash.toLowerCase());
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function applyRateHeaders(res: Response, rate: RateCheck): void {
  if (rate.limit !== undefined) res.setHeader('X-RateLimit-Limit', String(rate.limit));
  if (rate.remaining !== undefined) res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
  if (rate.resetAt !== undefined) res.setHeader('X-RateLimit-Reset', String(Math.ceil(rate.resetAt / 1000)));
  if (rate.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(rate.retryAfterSeconds));
}

function getRemoteIp(req: Request, config: AdminPlaneConfig): string | undefined {
  if (config.trustedProxy) {
    const forwarded = req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return normalizeIp(forwarded);
  }
  return normalizeIp(req.socket.remoteAddress ?? req.ip);
}

function normalizeIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  if (ip.startsWith('::ffff:')) return ip.slice('::ffff:'.length);
  return ip;
}

function isIpAllowed(ip: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => {
    const [network, prefix] = entry.split('/');
    if (!prefix) return normalizeIp(network) === ip;
    return isCidrMatch(ip, network, Number(prefix));
  });
}

function isCidrMatch(ip: string, network: string, prefix: number): boolean {
  if (net.isIP(ip) !== 4 || net.isIP(network) !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const ipNumber = ipv4ToNumber(ip);
  const networkNumber = ipv4ToNumber(network);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNumber & mask) === (networkNumber & mask);
}

function ipv4ToNumber(ip: string): number {
  return ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function verifyClientCertificate(req: Request, config: AdminPlaneConfig): boolean {
  if (!config.clientCert.required) return true;
  const socket = req.socket as TLSSocket;
  if (typeof socket.getPeerCertificate !== 'function' || !socket.authorized) return false;
  const cert = socket.getPeerCertificate();
  if (!cert || Object.keys(cert).length === 0) return false;
  if (config.clientCert.allowedFingerprints.length > 0) {
    const fingerprint = normalizeFingerprint(cert.fingerprint256 ?? cert.fingerprint);
    const allowed = config.clientCert.allowedFingerprints.map(normalizeFingerprint);
    if (!fingerprint || !allowed.includes(fingerprint)) return false;
  }
  if (config.clientCert.allowedSubjects.length > 0) {
    const subject = cert.subject ? Object.entries(cert.subject).map(([key, value]) => `${key}=${value}`).join(',') : '';
    if (!config.clientCert.allowedSubjects.some((allowed) => subject.includes(allowed))) return false;
  }
  return true;
}

function normalizeFingerprint(value: string | undefined): string {
  return (value ?? '').replaceAll(':', '').toLowerCase();
}

function auditPlaneDenied(plane: AccessPlane, req: Request, reason: string, principal?: string): void {
  logger.warn({ event: 'plane_access_denied', plane, method: req.method, path: req.originalUrl, reason, principal }, 'plane access denied');
}

export function auditAdmin(config: AdminPlaneConfig, req: Request, outcome: string, reason: string, remoteIp?: string, target?: string): void {
  if (!config.auditLog) return;
  logger.info(
    { event: 'admin_access_audit', method: req.method, path: req.originalUrl, outcome, reason, remoteIp, target },
    'admin access audit'
  );
}
