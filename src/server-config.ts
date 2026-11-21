import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Protocol hard limit for a bundle (1 GiB). */
export const protocolMaxBundleBytes = 1_073_741_824;
export const defaultArtifactTtlDays = 30;
export const defaultMaxBundleBytes = 256 * 1024 * 1024;

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

export type TokenScope = 'runs:write' | 'runs:read';

export interface ServerProject {
  id: string;
  name: string;
  /** Days the bundle and viewer stay downloadable after completion. */
  artifactTtlDays: number;
  maxBundleBytes: number;
}

export interface ServerToken {
  /** Admin-facing label; never sent in responses or logs with the token value. */
  id: string;
  /** SHA-256 of the bearer token, lowercase hex. The token itself is not stored. */
  sha256: string;
  scopes: TokenScope[];
  /** Absent for a workspace token; set for a project token. */
  projectId?: string;
}

export interface ServerConfig {
  version: 1;
  host: string;
  port: number;
  projects: ServerProject[];
  tokens: ServerToken[];
}

export class ServerConfigError extends Error {
  readonly code = 'SERVER_CONFIG';

  constructor(message: string) {
    super(message);
    this.name = 'ServerConfigError';
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], where: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ServerConfigError(`Unknown ${where} field: ${key}`);
  }
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new ServerConfigError(`Server config ${field} is required`);
  return value;
}

function parseHost(value: unknown): string {
  if (value === undefined) return '127.0.0.1';
  if (typeof value !== 'string' || !value.trim()) throw new ServerConfigError('Server config host is invalid');
  const host = value.trim();
  // A host only: no scheme, path, credentials or port. IPv6 literals keep their brackets.
  if (/[\s/@?#]/.test(host) || host.includes('://')) {
    throw new ServerConfigError('Server config host must be a bare host name or IP address');
  }
  if (host.includes(':') && !/^\[[0-9a-fA-F:.]+\]$/.test(host)) {
    throw new ServerConfigError('Server config host must not include a port');
  }
  return host;
}

export function parseServerHost(value: string): string {
  return parseHost(value);
}

function integerInRange(value: unknown, field: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ServerConfigError(`Server config ${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function parseProject(value: unknown, index: number): ServerProject {
  if (!isRecord(value)) throw new ServerConfigError(`Server config projects[${index}] must be an object`);
  rejectUnknown(value, ['id', 'name', 'artifactTtlDays', 'maxBundleBytes'], `projects[${index}]`);
  const id = stringField(value.id, `projects[${index}].id`);
  if (!idPattern.test(id)) {
    throw new ServerConfigError(`Server config projects[${index}].id must match ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`);
  }
  const name = value.name === undefined ? id : stringField(value.name, `projects[${index}].name`);
  return {
    id,
    name,
    artifactTtlDays: integerInRange(value.artifactTtlDays, 'projects[].artifactTtlDays', 0, 3650, defaultArtifactTtlDays),
    maxBundleBytes: integerInRange(value.maxBundleBytes, 'projects[].maxBundleBytes', 1, protocolMaxBundleBytes,
      defaultMaxBundleBytes),
  };
}

function parseToken(value: unknown, index: number, projects: Set<string>): ServerToken {
  if (!isRecord(value)) throw new ServerConfigError(`Server config tokens[${index}] must be an object`);
  rejectUnknown(value, ['id', 'tokenSha256', 'scopes', 'projectId'], `tokens[${index}]`);
  const id = stringField(value.id, `tokens[${index}].id`);
  if (!idPattern.test(id)) {
    throw new ServerConfigError(`Server config tokens[${index}].id must match ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`);
  }
  const sha256 = stringField(value.tokenSha256, `tokens[${index}].tokenSha256`);
  if (!sha256Pattern.test(sha256)) {
    throw new ServerConfigError(`Server config tokens[${index}].tokenSha256 must be a lowercase SHA-256`);
  }
  if (!Array.isArray(value.scopes) || value.scopes.length === 0) {
    throw new ServerConfigError(`Server config tokens[${index}].scopes must list runs:read and/or runs:write`);
  }
  const scopes = [...new Set(value.scopes)];
  for (const scope of scopes) {
    if (scope !== 'runs:read' && scope !== 'runs:write') {
      throw new ServerConfigError(`Server config tokens[${index}].scopes has unknown scope: ${String(scope)}`);
    }
  }
  const token: ServerToken = { id, sha256, scopes: scopes as TokenScope[] };
  if (value.projectId !== undefined) {
    const projectId = stringField(value.projectId, `tokens[${index}].projectId`);
    if (!projects.has(projectId)) {
      throw new ServerConfigError(`Server config tokens[${index}].projectId does not name a configured project`);
    }
    token.projectId = projectId;
  }
  return token;
}

/**
 * Validate the admin-provided server config. Tokens are configured only by
 * digest, so a plaintext `token` field is rejected instead of being silently
 * ignored.
 */
export function parseServerConfig(value: unknown): ServerConfig {
  if (!isRecord(value)) throw new ServerConfigError('Server config must be a JSON object');
  rejectUnknown(value, ['version', 'host', 'port', 'projects', 'tokens'], 'server config');
  if (value.version !== 1) throw new ServerConfigError('Unsupported server config version');
  if (!Array.isArray(value.projects) || value.projects.length === 0) {
    throw new ServerConfigError('Server config projects must be a non-empty array');
  }
  const projects = value.projects.map(parseProject);
  const ids = new Set<string>();
  for (const project of projects) {
    if (ids.has(project.id)) throw new ServerConfigError(`Duplicate server project id: ${project.id}`);
    ids.add(project.id);
  }
  if (!Array.isArray(value.tokens) || value.tokens.length === 0) {
    throw new ServerConfigError('Server config tokens must be a non-empty array');
  }
  const tokens = value.tokens.map((token, index) => parseToken(token, index, ids));
  const tokenIds = new Set<string>();
  for (const token of tokens) {
    if (tokenIds.has(token.id)) throw new ServerConfigError(`Duplicate server token id: ${token.id}`);
    tokenIds.add(token.id);
  }
  return {
    version: 1,
    host: parseHost(value.host),
    port: integerInRange(value.port, 'port', 1, 65535, 8787),
    projects,
    tokens,
  };
}

export async function loadServerConfig(path: string): Promise<ServerConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ServerConfigError(`Cannot read server config ${path}: ${reason}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ServerConfigError(`Server config ${path} is not valid JSON`);
  }
  return parseServerConfig(value);
}
