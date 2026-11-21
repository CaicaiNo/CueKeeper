import { createHash } from 'node:crypto';
import { inflateSync } from 'fflate';
import { reportCheck } from './contracts.js';
import type { Flow, Report } from './contracts.js';
import { hashFlow, parseFlow, plan } from './flow.js';

/** Archive limits from the upload protocol. */
export const maxArchiveEntries = 10_000;
export const maxArchiveBytes = 2 * 1024 * 1024 * 1024;
export const maxMetadataBytes = 16 * 1024 * 1024;

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const assetRoles = new Set([
  'screenshot-before', 'screenshot-after', 'screenshot', 'assertion-baseline',
  'assertion-actual', 'log', 'snapshot', 'file',
]);
const rootFiles = new Set(['index.html', 'report.json', 'flow.json', 'manifest.json']);

export interface EntryCounts {
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  resolved: number;
}

export interface BundleSummary {
  flowId: string;
  flowSha256: string;
  startedAt: string;
  mode: 'replay' | 'dry-run';
  status: 'passed' | 'failed' | 'blocked';
  durationMs: number;
  entryCounts: EntryCounts;
  /** Verified copy of the packed static viewer. */
  viewerHtml: Uint8Array;
}

export class BundleValidationError extends Error {
  readonly status: number;
  readonly code: 'BUNDLE_INVALID' | 'PAYLOAD_TOO_LARGE';

  constructor(status: number, code: 'BUNDLE_INVALID' | 'PAYLOAD_TOO_LARGE', message: string) {
    super(message);
    this.name = 'BundleValidationError';
    this.status = status;
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new BundleValidationError(422, 'BUNDLE_INVALID', message);
}

function tooLarge(message: string): never {
  throw new BundleValidationError(413, 'PAYLOAD_TOO_LARGE', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeName(bytes: Uint8Array, start: number, length: number): string {
  const name = Buffer.from(bytes.subarray(start, start + length)).toString('utf8');
  if (!name || name.includes('\u0000')) invalid('Archive contains an invalid file name');
  return name;
}

function safePath(name: string): boolean {
  if (!name || name.endsWith('/') || name.startsWith('/') || name.includes('\\')) return false;
  if (!rootFiles.has(name) && !name.startsWith('assets/')) return false;
  const segments = name.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return false;
  return true;
}

function hasZip64Extra(extra: Uint8Array): boolean {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra[offset] | extra[offset + 1] << 8;
    const size = extra[offset + 2] | extra[offset + 3] << 8;
    if (id === 0x0001) return true;
    offset += 4 + size;
  }
  return false;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedBytes: number;
  uncompressedBytes: number;
  localOffset: number;
}

interface ParsedZip {
  files: Map<string, Uint8Array>;
}

/**
 * Read a ZIP central directory before decompressing anything. Declared sizes
 * drive the limits and each entry is inflated into a buffer of its declared
 * size, so a lying header fails instead of allocating unbounded memory.
 */
function readZip(bytes: Uint8Array): ParsedZip {
  if (bytes.length < 22) invalid('Bundle is not a ZIP archive');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);

  let eocd = -1;
  const minimum = Math.max(0, bytes.length - 65_557 - 22);
  for (let offset = bytes.length - 22; offset >= minimum; offset--) {
    if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === bytes.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) invalid('Bundle is not a complete ZIP archive');
  if (eocd >= 20 && u32(eocd - 20) === 0x07064b50) tooLarge('ZIP64 archives are not supported');

  const entryCount = u16(eocd + 10);
  const directoryBytes = u32(eocd + 12);
  const directoryOffset = u32(eocd + 16);
  if (entryCount === 0xffff || directoryOffset === 0xffffffff || directoryBytes === 0xffffffff) {
    tooLarge('ZIP64 archives are not supported');
  }
  if (directoryOffset + directoryBytes > eocd) invalid('ZIP central directory is out of bounds');
  if (entryCount > maxArchiveEntries) tooLarge(`Bundle has more than ${maxArchiveEntries} files`);

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let totalBytes = 0;
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > eocd || u32(offset) !== 0x02014b50) invalid('ZIP central directory is malformed');
    const flags = u16(offset + 8);
    const method = u16(offset + 10);
    const compressedBytes = u32(offset + 20);
    const uncompressedBytes = u32(offset + 24);
    const nameLength = u16(offset + 28);
    const extraLength = u16(offset + 30);
    const commentLength = u16(offset + 32);
    const externalAttributes = u32(offset + 38);
    const localOffset = u32(offset + 42);
    if (offset + 46 + nameLength + extraLength + commentLength > eocd) invalid('ZIP entry is out of bounds');
    const name = decodeName(bytes, offset + 46, nameLength);
    const extra = bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);

    if (flags & 0x0001 || flags & 0x0040) invalid('Encrypted archive entries are not supported');
    if (method !== 0 && method !== 8) invalid('Only stored and deflated archive entries are supported');
    if (compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff || localOffset === 0xffffffff ||
        hasZip64Extra(extra)) {
      tooLarge('ZIP64 archives are not supported');
    }
    if (((externalAttributes >>> 16) & 0o170000) === 0o120000) invalid('Symbolic links are not allowed in a bundle');
    if (!safePath(name)) invalid(`Archive contains an unsupported path: ${name}`);
    if (names.has(name)) invalid(`Archive contains a duplicate path: ${name}`);
    if ((name === 'report.json' || name === 'flow.json' || name === 'manifest.json') &&
        uncompressedBytes > maxMetadataBytes) {
      tooLarge(`${name} exceeds ${maxMetadataBytes} bytes`);
    }
    names.add(name);
    totalBytes += uncompressedBytes;
    if (totalBytes > maxArchiveBytes) tooLarge('Bundle expands beyond the archive limit');
    entries.push({ name, method, compressedBytes, uncompressedBytes, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.localOffset + 30 > directoryOffset || u32(entry.localOffset) !== 0x04034b50) {
      invalid(`ZIP entry ${entry.name} has an invalid local header`);
    }
    const nameLength = u16(entry.localOffset + 26);
    const extraLength = u16(entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const end = start + entry.compressedBytes;
    if (end > directoryOffset) invalid(`ZIP entry ${entry.name} is out of bounds`);
    if (decodeName(bytes, entry.localOffset + 30, nameLength) !== entry.name) {
      invalid(`ZIP entry ${entry.name} does not match its local header`);
    }
    const compressed = bytes.subarray(start, end);
    let contents: Uint8Array;
    if (entry.method === 0) {
      if (entry.compressedBytes !== entry.uncompressedBytes) invalid(`ZIP entry ${entry.name} has an invalid size`);
      contents = compressed;
    } else {
      try {
        contents = inflateSync(compressed, { out: new Uint8Array(entry.uncompressedBytes) });
      } catch {
        invalid(`ZIP entry ${entry.name} cannot be decompressed`);
      }
    }
    if (contents.length !== entry.uncompressedBytes) invalid(`ZIP entry ${entry.name} has an invalid size`);
    files.set(entry.name, contents);
  }
  return { files };
}

function parseJsonFile(files: Map<string, Uint8Array>, name: string): unknown {
  const bytes = files.get(name);
  if (!bytes) invalid(`Bundle is missing ${name}`);
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch {
    invalid(`${name} is not valid JSON`);
  }
}

function parseManifest(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) invalid('manifest.json must be an object');
  if (value.version !== 1) invalid('manifest.json has an unsupported version');
  if (typeof value.flowId !== 'string' || !idPattern.test(value.flowId)) invalid('manifest.json has an invalid flowId');
  if (typeof value.flowSha256 !== 'string' || !sha256Pattern.test(value.flowSha256)) {
    invalid('manifest.json has an invalid flowSha256');
  }
  if (typeof value.reportStartedAt !== 'string' || !timestampPattern.test(value.reportStartedAt)) {
    invalid('manifest.json has an invalid reportStartedAt');
  }
  if (!isRecord(value.files)) invalid('manifest.json has no files map');
  for (const [path, detail] of Object.entries(value.files)) {
    if (!isRecord(detail) || !Number.isInteger(detail.bytes) || (detail.bytes as number) < 0 ||
        typeof detail.sha256 !== 'string' || !sha256Pattern.test(detail.sha256)) {
      invalid(`manifest.json has an invalid entry for ${path}`);
    }
  }
  if (!Array.isArray(value.assets)) invalid('manifest.json has no assets list');
  for (const asset of value.assets) {
    if (!isRecord(asset) || typeof asset.path !== 'string' || !Number.isInteger(asset.bytes) ||
        (asset.bytes as number) < 0 || typeof asset.role !== 'string' || !assetRoles.has(asset.role) ||
        (asset.entryId !== undefined && (typeof asset.entryId !== 'string' || !idPattern.test(asset.entryId)))) {
      invalid('manifest.json has an invalid asset entry');
    }
  }
  return value;
}

function validateFiles(manifest: Record<string, unknown>, files: Map<string, Uint8Array>) {
  const listed = manifest.files as Record<string, { bytes: number; sha256: string }>;
  const archiveFiles = [...files.keys()].filter(name => name !== 'manifest.json');
  if (Object.keys(listed).length !== archiveFiles.length) {
    invalid('manifest.json does not match the archive file list');
  }
  for (const name of archiveFiles) {
    const detail = listed[name];
    const contents = files.get(name)!;
    if (!detail) invalid(`manifest.json does not list ${name}`);
    if (detail.bytes !== contents.length) invalid(`${name} does not match its manifest size`);
    if (detail.sha256 !== digest(contents)) invalid(`${name} does not match its manifest digest`);
  }
  for (const name of ['index.html', 'report.json', 'flow.json']) {
    if (!files.has(name)) invalid(`Bundle is missing ${name}`);
  }
}

function validateAssets(manifest: Record<string, unknown>, files: Map<string, Uint8Array>, entryIds: Set<string>) {
  const listed = manifest.files as Record<string, unknown>;
  const assets = manifest.assets as Array<{ path: string; bytes: number; entryId?: string }>;
  const seen = new Set<string>();
  for (const asset of assets) {
    if (!asset.path.startsWith('assets/')) invalid(`manifest.json asset is outside assets/: ${asset.path}`);
    if (!files.has(asset.path)) invalid(`manifest.json lists a missing asset: ${asset.path}`);
    if (!listed[asset.path]) invalid(`manifest.json does not list its asset: ${asset.path}`);
    if (seen.has(asset.path)) invalid(`manifest.json lists a duplicate asset: ${asset.path}`);
    seen.add(asset.path);
    if (asset.bytes !== files.get(asset.path)!.length) invalid(`Asset ${asset.path} does not match its size`);
    // The packer groups an asset under the longest matching step id. A hand-built
    // bundle must use the same association, so an asset cannot claim another step.
    const relative = asset.path.slice('assets/'.length);
    const owner = [...entryIds].filter(id => relative.startsWith(`${id}/`))
      .sort((left, right) => right.length - left.length)[0];
    if (owner !== asset.entryId) invalid(`Asset ${asset.path} has an inconsistent entry association`);
  }
  for (const name of files.keys()) {
    if (name.startsWith('assets/') && !seen.has(name)) invalid(`Asset ${name} is missing from manifest.json`);
  }
}

function summarize(report: Report, flow: Flow, manifest: Record<string, unknown>, viewerHtml: Uint8Array): BundleSummary {
  const flowSha256 = hashFlow(flow);
  if (report.flowId !== flow.id) invalid('report.json names a different flow');
  if (report.flowSha256 !== flowSha256) invalid('report.json does not match flow.json');
  if (manifest.flowId !== flow.id) invalid('manifest.json names a different flow');
  if (manifest.flowSha256 !== flowSha256) invalid('manifest.json does not match flow.json');
  if (manifest.reportStartedAt !== report.startedAt) invalid('manifest.json does not match the report start time');

  const steps = plan(flow);
  const actionEntries = report.entries.filter(entry => entry.kind !== 'setup');
  if (actionEntries.length !== steps.length || steps.some(({ id, action }, index) =>
    actionEntries[index].id !== id || actionEntries[index].kind !== action.kind)) {
    invalid('Report timeline does not match the flow');
  }

  const entryCounts: EntryCounts = { passed: 0, failed: 0, blocked: 0, skipped: 0, resolved: 0 };
  let durationMs = 0;
  for (const entry of report.entries) {
    entryCounts[entry.status] += 1;
    durationMs = Math.max(durationMs, entry.atMs + entry.durationMs);
  }
  return {
    flowId: flow.id,
    flowSha256,
    startedAt: report.startedAt,
    mode: report.mode,
    status: report.status,
    durationMs,
    entryCounts,
    viewerHtml,
  };
}

/** Validate every archived file, the manifest, the report and the flow. */
export function validateBundle(bytes: Uint8Array): BundleSummary {
  const { files } = readZip(bytes);
  const manifest = parseManifest(parseJsonFile(files, 'manifest.json'));
  validateFiles(manifest, files);
  const reportInput = parseJsonFile(files, 'report.json');
  if (!reportCheck.Check(reportInput)) invalid('report.json is not a valid v1 report');
  const report = reportInput as Report;
  let flow: Flow;
  try {
    flow = parseFlow(parseJsonFile(files, 'flow.json'));
  } catch (error) {
    if (error instanceof BundleValidationError) throw error;
    invalid(`flow.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateAssets(manifest, files, new Set(report.entries.map(entry => entry.id)));
  return summarize(report, flow, manifest, files.get('index.html')!);
}

export { digest as bundleDigest };
