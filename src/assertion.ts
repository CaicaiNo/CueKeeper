import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInContext, createContext } from 'node:vm';
import type {
  AssertCheck, ElementAssertCheck, Normalize, ScreenshotActual, ScreenshotExpectation,
  StringExpectation, WindowAssertCheck,
} from './contracts.js';
import type { Desktop, WindowInfo } from './desktop.js';
import { Fault, resolve } from './locator.js';
import type { Snapshot } from './locator.js';
import { crop, decodePng, encodePng, PngError } from './png.js';

type Comparator = 'equals' | 'contains' | 'matches';

export class AssertionConfigFault extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface AssertionObservation {
  passed: boolean;
  actual?: boolean | string | ScreenshotActual;
  code?: string;
  message?: string;
  evidence?: { baseline: Uint8Array; actual: Uint8Array };
}

export interface AssertionContext {
  desktop: Desktop;
  snapshot: () => Promise<Snapshot>;
  baselineDir?: string;
  timeoutMs?: number;
  secretTexts?: ReadonlyMap<string, string>;
  /** Identity-scoped inventory; a path-fixed target only exposes its bound instance. */
  windowsFor?: (app: string) => Promise<WindowInfo[]>;
  /** Window-only capture for a bound instance; receives the assertion's app. */
  screenshotWindow?: (app: string, windowId: string) => Promise<Uint8Array>;
}

const regionPixelLimit = 16_777_216;
const framePixelLimit = 33_554_432;
const matchBudgetMs = 500;

export function normalizeWhitespace(value: string, whitespace?: 'trim' | 'collapse') {
  if (whitespace === 'collapse') return value.replace(/\s+/g, ' ').trim();
  if (whitespace === 'trim') return value.trim();
  return value;
}

export function normalizeText(value: string, normalize?: Normalize) {
  if (normalize?.ignoreCase) return normalizeWhitespace(value, normalize.whitespace).toLowerCase();
  return normalizeWhitespace(value, normalize?.whitespace);
}

function isStringExpectation(expect: AssertCheck['expect']): boolean {
  return expect.property !== 'exists' && expect.property !== 'visible' && expect.property !== 'screenshot';
}

class RegexBudget {
  private remaining = matchBudgetMs;

  constructor(private readonly now: () => number = () => performance.now()) {}

  test(source: string, value: string, ignoreCase: boolean) {
    if (this.remaining <= 0) throw new Fault('ASSERTION_MATCH_TIMEOUT', 'The assertion regex budget was exhausted');
    const timeout = Math.max(1, Math.ceil(this.remaining));
    const started = this.now();
    try {
      const context = createContext({ source, value, flags: ignoreCase ? 'iu' : 'u' });
      return runInContext('new RegExp(source, flags).test(value)', context, { timeout }) === true;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || (error instanceof Error && /timed out/i.test(error.message))) {
        throw new Fault('ASSERTION_MATCH_TIMEOUT', 'The assertion regex exceeded its execution budget');
      }
      throw new Fault('ASSERTION_INVALID_MATCH', 'The assertion regex is not a valid ECMAScript Unicode expression');
    } finally {
      this.remaining -= this.now() - started;
    }
  }
}

function compare(actual: string, expected: StringExpectation, budget: RegexBudget) {
  const normalize = expected.normalize;
  if ('matches' in expected) {
    return budget.test(expected.matches, normalizeWhitespace(actual, normalize?.whitespace), normalize?.ignoreCase === true);
  }
  const observed = normalizeText(actual, normalize);
  if ('equals' in expected) return observed === normalizeText(expected.equals, normalize);
  return observed.includes(normalizeText(expected.contains, normalize));
}

function compareTitle(actual: string, wanted: string, comparator: Comparator, budget: RegexBudget) {
  switch (comparator) {
    case 'equals': return actual === wanted;
    case 'contains': return actual.includes(wanted);
    case 'matches': return budget.test(wanted, actual, false);
  }
}

/** Validates assertion rules that JSON schema cannot express. */
export function validateAssertCheck(check: AssertCheck, where: string) {
  const expect = check.expect;
  const labeled = (message: string) => `${where}: ${message}`;
  const string = isStringExpectation(expect) ? expect as StringExpectation : undefined;
  if (string) {
    if (string.normalize && Object.keys(string.normalize).length === 0) {
      throw new AssertionConfigFault('ASSERTION_INVALID_MATCH', labeled('normalize needs at least one option'));
    }
    if ('matches' in string) {
      if (!string.matches.length) {
        throw new AssertionConfigFault('ASSERTION_INVALID_MATCH', labeled('matches needs a regular expression'));
      }
      try {
        new RegExp(string.matches, 'u');
      } catch {
        throw new AssertionConfigFault('ASSERTION_INVALID_MATCH', labeled('matches is not a valid ECMAScript Unicode regular expression'));
      }
    }
    if ('contains' in string && !normalizeWhitespace(string.contains, string.normalize?.whitespace).trim()) {
      throw new AssertionConfigFault('ASSERTION_INVALID_MATCH', labeled('contains becomes empty after whitespace normalization'));
    }
  }
  if (expect.property === 'screenshot') {
    const { region, baseline } = expect as ScreenshotExpectation;
    if (region.x + region.width > baseline.frameWidth || region.y + region.height > baseline.frameHeight) {
      throw new AssertionConfigFault('ASSERTION_REGION_INVALID', labeled('region extends beyond the baseline frame'));
    }
    if (region.width * region.height > regionPixelLimit || baseline.frameWidth * baseline.frameHeight > framePixelLimit) {
      throw new AssertionConfigFault('ASSERTION_REGION_INVALID', labeled('region or baseline frame exceeds the pixel limit'));
    }
  }
}

function secretIn(value: string, secrets?: ReadonlyMap<string, string>) {
  if (!secrets) return false;
  for (const secret of secrets.values()) if (secret && value.includes(secret)) return true;
  return false;
}

function observedString(actual: string, secrets?: ReadonlyMap<string, string>) {
  if (!secretIn(actual, secrets)) return { actual };
  return { message: '实际值包含本次注入的受保护文本，已省略' };
}

async function evaluateElement(
  check: ElementAssertCheck, context: AssertionContext, budget: RegexBudget,
): Promise<AssertionObservation> {
  const expect = check.expect;
  let found;
  try {
    found = resolve(await context.snapshot(), check.target);
  } catch (error) {
    if (error instanceof Fault && error.code === 'NOT_FOUND' && expect.property === 'exists') {
      found = undefined;
    } else {
      throw error;
    }
  }
  if (expect.property === 'exists') {
    const actual = Boolean(found);
    return { passed: actual === (expect as { equals: boolean }).equals, actual };
  }
  if (!found) throw new Fault('PROPERTY_UNAVAILABLE', 'Property unavailable because the element is missing');
  if (found.node.secure) throw new Fault('PROPERTY_UNAVAILABLE', 'Property unavailable for this control');
  if (expect.property === 'visible') {
    const actual = await context.desktop.property(found.node, 'visible', context.timeoutMs);
    if (typeof actual !== 'boolean') throw new Fault('PROPERTY_UNAVAILABLE', 'Property could not be read');
    return { passed: actual === (expect as { equals: boolean }).equals, actual };
  }
  const string = expect as StringExpectation & { property: 'text' | 'value' };
  const actual = await context.desktop.property(found.node, string.property, context.timeoutMs);
  if (typeof actual !== 'string') throw new Fault('PROPERTY_UNAVAILABLE', 'Property could not be read');
  try {
    return { passed: compare(actual, string, budget), ...observedString(actual, context.secretTexts) };
  } catch (error) {
    // A property match timeout keeps the string it already read; window selection cannot.
    if (error instanceof Fault && error.code === 'ASSERTION_MATCH_TIMEOUT') {
      return {
        passed: false, code: 'ASSERTION_MATCH_TIMEOUT', message: error.message,
        ...observedString(actual, context.secretTexts),
      };
    }
    throw error;
  }
}

async function windowInventory(check: WindowAssertCheck, context: AssertionContext) {
  try {
    return context.windowsFor
      ? await context.windowsFor(check.target.app)
      : await context.desktop.listWindows(check.target.app, context.timeoutMs);
  } catch (error) {
    // A confirmed app-not-running is an empty inventory; `exists: false` needs it.
    if (error instanceof Fault && ['APP_NOT_FOUND', 'WINDOW_NOT_FOUND'].includes(error.code)) return [];
    throw error;
  }
}

function matchingWindows(check: WindowAssertCheck, windows: WindowInfo[], budget: RegexBudget) {
  const { target } = check;
  if (!('window' in target) || target.window === undefined) return windows;
  const wanted = target.window;
  const comparator = (target.match ?? 'equals') as Comparator;
  return windows.filter(window => compareTitle(window.title, wanted, comparator, budget));
}

/** Reads and validates the saved baseline crop next to the flow file. */
export async function loadBaseline(directory: string | undefined, expect: ScreenshotExpectation) {
  const { region, baseline } = expect;
  if (!directory) throw new Fault('ASSERTION_BASELINE_MISSING', 'No baseline directory is available');
  const path = join(directory, `${baseline.sha256}.png`);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Fault('ASSERTION_BASELINE_MISSING', `Baseline ${baseline.sha256}.png was not found`);
    }
    throw new Fault('ASSERTION_BASELINE_INVALID', 'The baseline file could not be read');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== baseline.sha256) {
    throw new Fault('ASSERTION_BASELINE_INVALID', 'The baseline file digest does not match the flow');
  }
  let image;
  try {
    image = decodePng(bytes, regionPixelLimit);
  } catch (error) {
    throw new Fault('ASSERTION_BASELINE_INVALID', error instanceof PngError ? error.message : 'The baseline is not a usable PNG');
  }
  if (image.width !== region.width || image.height !== region.height) {
    throw new Fault('ASSERTION_BASELINE_INVALID', 'The baseline crop size does not match the configured region');
  }
  return { bytes, image };
}

async function evaluateScreenshot(
  check: WindowAssertCheck, window: WindowInfo, expect: ScreenshotExpectation, context: AssertionContext,
): Promise<AssertionObservation> {
  const { region, baseline } = expect;
  if (region.x + region.width > baseline.frameWidth || region.y + region.height > baseline.frameHeight ||
      region.width * region.height > regionPixelLimit || baseline.frameWidth * baseline.frameHeight > framePixelLimit) {
    throw new Fault('ASSERTION_REGION_INVALID', 'The screenshot region is outside the baseline or exceeds the pixel limit');
  }
  const { bytes: baselineBytes, image: baselineImage } = await loadBaseline(context.baselineDir, expect);

  let actualBytes: Uint8Array;
  try {
    actualBytes = context.screenshotWindow
      ? await context.screenshotWindow(check.target.app, window.id)
      : await context.desktop.screenshot(check.target.app, window.id, context.timeoutMs);
  } catch (error) {
    const code = error instanceof Fault ? error.code : 'ASSERTION_CAPTURE_FAILED';
    if (code === 'WINDOW_NOT_FOUND' || code === 'APP_NOT_FOUND' || code === 'WINDOW_CHANGED') {
      throw new Fault('WINDOW_CHANGED', 'The asserted window disappeared before it could be captured');
    }
    if (code === 'TIMEOUT' || code === 'COMMAND_TIMEOUT') {
      throw new Fault('COMMAND_TIMEOUT', 'The window screenshot command timed out');
    }
    if (code === 'PERM_DENIED' || code === 'DESKTOP_DEPENDENCY' || code === 'WINDOW_MISMATCH') throw error;
    throw new Fault('ASSERTION_CAPTURE_FAILED', error instanceof Error ? error.message : 'The window screenshot failed');
  }
  let actualImage;
  try {
    const size = decodePng(actualBytes, framePixelLimit);
    actualImage = size;
  } catch (error) {
    throw new Fault('ASSERTION_CAPTURE_FAILED', error instanceof PngError ? error.message : 'The screenshot is not a usable PNG');
  }
  const actual: ScreenshotActual = { frameWidth: actualImage.width, frameHeight: actualImage.height };
  if (actualImage.width !== baseline.frameWidth || actualImage.height !== baseline.frameHeight) {
    return {
      passed: false, code: 'ASSERTION_SCREENSHOT_SIZE', actual,
      message: `截图尺寸 ${actualImage.width}×${actualImage.height} 与基线 ${baseline.frameWidth}×${baseline.frameHeight} 不一致`,
    };
  }
  const cropped = crop(actualImage, region.x, region.y, region.width, region.height);
  let differentPixels = 0;
  for (let index = 0; index < cropped.data.length; index += 4) {
    if (cropped.data[index] !== baselineImage.data[index] ||
        cropped.data[index + 1] !== baselineImage.data[index + 1] ||
        cropped.data[index + 2] !== baselineImage.data[index + 2] ||
        cropped.data[index + 3] !== baselineImage.data[index + 3]) {
      differentPixels++;
    }
  }
  const diffRatio = differentPixels / (region.width * region.height);
  const observed: ScreenshotActual = { ...actual, differentPixels, diffRatio };
  const passed = diffRatio <= expect.maxDiffRatio;
  return {
    passed,
    actual: observed,
    ...(passed ? {} : {
      code: 'ASSERTION_SCREENSHOT_DIFF',
      message: `区域差异 ${differentPixels} 像素（${(diffRatio * 100).toFixed(2)}%），上限 ${(expect.maxDiffRatio * 100).toFixed(2)}%`,
      evidence: { baseline: baselineBytes, actual: encodePng(cropped) },
    }),
  };
}

async function evaluateWindow(
  check: WindowAssertCheck, context: AssertionContext, budget: RegexBudget,
): Promise<AssertionObservation> {
  const expect = check.expect;
  const matched = matchingWindows(check, await windowInventory(check, context), budget);
  if (expect.property === 'exists') {
    if (matched.length > 1) throw new Fault('AMBIGUOUS_TARGET', 'More than one window matches the window assertion');
    const actual = matched.length === 1;
    return { passed: actual === (expect as { equals: boolean }).equals, actual };
  }
  if (!matched.length) throw new Fault('WINDOW_NOT_FOUND', 'No window matches the window assertion');
  if (matched.length > 1) throw new Fault('AMBIGUOUS_TARGET', 'More than one window matches the window assertion');
  const [window] = matched;
  if (expect.property === 'title') {
    return {
      passed: compare(window.title, expect as StringExpectation, budget),
      ...observedString(window.title, context.secretTexts),
    };
  }
  return evaluateScreenshot(check, window, expect as ScreenshotExpectation, context);
}

function isWindowCheck(check: AssertCheck): boolean {
  return check.target.kind === 'window';
}

/**
 * Observes one assertion. Comparison failures return `passed: false` so the
 * caller can record the expected value next to the observed one; driver faults
 * without an observation are rethrown.
 */
export async function evaluateAssertion(
  check: AssertCheck, context: AssertionContext,
): Promise<AssertionObservation> {
  const budget = new RegexBudget();
  if (isWindowCheck(check)) return evaluateWindow(check as WindowAssertCheck, context, budget);
  return evaluateElement(check as ElementAssertCheck, context, budget);
}

/** Dry-run: configuration and scope only; no pixels are captured or compared. */
export async function resolveAssertion(check: AssertCheck, context: AssertionContext) {
  if (!isWindowCheck(check)) {
    try {
      resolve(await context.snapshot(), check.target as ElementAssertCheck['target']);
    } catch (error) {
      if (!(error instanceof Fault && error.code === 'NOT_FOUND' && check.expect.property === 'exists')) throw error;
    }
    return;
  }
  const windowCheck = check as WindowAssertCheck;
  const expect = windowCheck.expect;
  const matched = matchingWindows(windowCheck, await windowInventory(windowCheck, context), new RegexBudget());
  if (expect.property === 'exists') {
    if (matched.length > 1) throw new Fault('AMBIGUOUS_TARGET', 'More than one window matches the window assertion');
    return;
  }
  if (!matched.length) throw new Fault('WINDOW_NOT_FOUND', 'No window matches the window assertion');
  if (matched.length > 1) throw new Fault('AMBIGUOUS_TARGET', 'More than one window matches the window assertion');
  if (expect.property !== 'screenshot') return;
  await loadBaseline(context.baselineDir, expect as ScreenshotExpectation);
}
