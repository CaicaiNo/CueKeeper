import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FlowV2, StepV2 } from './contracts-v2.js';
import { parseFlowV2 } from './flow-v2.js';
import { Fault, object } from './locator.js';

// A template is a saved flow whose selected string fields were replaced with
// `{{name}}` placeholders. Applying a template substitutes real values back and
// returns a normal v2 flow; nothing else about the flow changes. Templates are
// plain JSON: there is no expression language and no code to run.

export interface TemplateParameter {
  /** Placeholder name, written `{{name}}` in the flow. */
  name: string;
  label: string;
  defaultValue?: string;
}

export interface Template {
  version: 1;
  id: string;
  name: string;
  description?: string;
  /** When the template was saved, as a wall clock. Older files may omit it. */
  createdAt?: string;
  parameters: TemplateParameter[];
  flow: FlowV2;
}

/**
 * One string a user can turn into a variable. Each field names exactly one
 * string inside a step, so a click's target name and its window title are
 * separate choices instead of one ambiguous "step value".
 */
export const templateFields = [
  'target.name', 'from.name', 'to.name', 'check.target.name',
  'scope.windowTitle', 'scope.fileName', 'text', 'expect',
] as const;
export type TemplateField = typeof templateFields[number];

export interface TemplateSelection {
  stepId: string;
  field: TemplateField;
  parameter: string;
  label?: string;
}

export interface TemplateValuePreview {
  stepId: string;
  field: TemplateField;
  value: string;
  label: string;
  suggested: string;
}

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const parameterPattern = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const placeholderPattern = /\{\{([a-zA-Z][a-zA-Z0-9_]{0,63})\}\}/g;
const maxValueLength = 4000;

export function templateDirectory() {
  return join(homedir(), '.cuekeeper', 'templates');
}

const fieldLabels: Record<TemplateField, string> = {
  'target.name': '点击目标',
  'from.name': '拖拽起点',
  'to.name': '拖拽终点',
  'check.target.name': '检查目标',
  'scope.windowTitle': '窗口标题',
  'scope.fileName': '文件名',
  text: '输入文本',
  expect: '期望值',
};

function elementName(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as { kind?: unknown; name?: unknown };
  return record.kind === 'element' && typeof record.name === 'string' ? record.name : undefined;
}

function setElementName(value: unknown, name: string): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as { kind?: unknown; name?: unknown };
  if (record.kind !== 'element') return false;
  record.name = name;
  return true;
}

function expectationKey(step: StepV2): 'equals' | 'contains' | 'matches' | undefined {
  const expect = (step as { check?: { expect?: unknown } }).check?.expect;
  if (expect === null || typeof expect !== 'object') return undefined;
  for (const key of ['equals', 'contains', 'matches'] as const) {
    if (typeof (expect as Record<string, unknown>)[key] === 'string') return key;
  }
  return undefined;
}

/** The one string a selection points at, or undefined when the step has none. */
export function stepFieldValue(step: StepV2, field: TemplateField): string | undefined {
  switch (field) {
    case 'target.name':
      return elementName((step as { target?: unknown }).target);
    case 'from.name':
      return elementName((step as { from?: unknown }).from);
    case 'to.name':
      return elementName((step as { to?: unknown }).to);
    case 'check.target.name':
      return elementName((step as { check?: { target?: unknown } }).check?.target);
    case 'scope.windowTitle': {
      const scope = (step as { scope?: { kind?: string; windowTitle?: string } }).scope;
      return scope?.kind === 'window' ? scope.windowTitle : undefined;
    }
    case 'scope.fileName': {
      const scope = (step as { scope?: { kind?: string; name?: string; suffix?: string } }).scope;
      if (scope?.kind !== 'file') return undefined;
      return typeof scope.name === 'string' ? scope.name
        : typeof scope.suffix === 'string' ? scope.suffix : undefined;
    }
    case 'text': {
      const text = (step as { text?: unknown }).text;
      return typeof text === 'string' ? text : undefined;
    }
    case 'expect': {
      const key = expectationKey(step);
      if (!key) return undefined;
      return (step as unknown as { check: { expect: Record<string, string> } }).check.expect[key];
    }
    default:
      return undefined;
  }
}

function setStepFieldValue(step: StepV2, field: TemplateField, value: string): boolean {
  switch (field) {
    case 'target.name':
      return setElementName((step as { target?: unknown }).target, value);
    case 'from.name':
      return setElementName((step as { from?: unknown }).from, value);
    case 'to.name':
      return setElementName((step as { to?: unknown }).to, value);
    case 'check.target.name':
      return setElementName((step as { check?: { target?: unknown } }).check?.target, value);
    case 'scope.windowTitle': {
      const scope = (step as { scope?: { kind?: string; windowTitle?: string } }).scope;
      if (scope?.kind !== 'window') return false;
      scope.windowTitle = value;
      return true;
    }
    case 'scope.fileName': {
      const scope = (step as { scope?: { kind?: string; name?: string; suffix?: string } }).scope;
      if (scope?.kind !== 'file') return false;
      if (typeof scope.name === 'string') scope.name = value;
      else if (typeof scope.suffix === 'string') scope.suffix = value;
      else return false;
      return true;
    }
    case 'text': {
      const record = step as { text?: unknown };
      if (typeof record.text !== 'string') return false;
      record.text = value;
      return true;
    }
    case 'expect': {
      const key = expectationKey(step);
      if (!key) return false;
      (step as unknown as { check: { expect: Record<string, string> } }).check.expect[key] = value;
      return true;
    }
    default:
      return false;
  }
}

/** A parameter name derived from a value, for the marking dialog's default. */
export function suggestParameter(field: TemplateField, value: string): string {
  const slug = value
    .normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, 48);
  const base = slug && /^[a-zA-Z]/.test(slug) ? slug : `${field.replace(/[^\w]+/g, '_')}_${slug || 'value'}`;
  return /^[a-zA-Z]/.test(base) ? base.slice(0, 64) : `value_${base.slice(0, 58)}`;
}

/**
 * Every string a template can parameterize, in step order. The page renders
 * this beside a step so the operator picks a real value instead of guessing.
 */
export function templateCandidates(flow: FlowV2): TemplateValuePreview[] {
  const previews: TemplateValuePreview[] = [];
  for (const step of flow.steps) {
    const role = (step as { target?: { role?: unknown } }).target?.role;
    const secureText = typeof role === 'string' && /secure/i.test(role);
    for (const field of templateFields) {
      if (field === 'text' && secureText) continue;
      const value = stepFieldValue(step, field);
      if (!value) continue;
      previews.push({
        stepId: step.id, field, value,
        label: fieldLabels[field],
        suggested: suggestParameter(field, value),
      });
    }
  }
  return previews;
}

/** Replace `{{name}}` in every string field a template can parameterize. */
export function substituteTemplate(
  flow: FlowV2,
  values: Readonly<Record<string, string>>,
): FlowV2 {
  const draft = structuredClone(flow) as FlowV2;
  for (const step of draft.steps) {
    for (const field of templateFields) {
      const current = stepFieldValue(step, field);
      if (current === undefined) continue;
      const next = current.replace(placeholderPattern, (match, name: string) => {
        const value = values[name];
        return value === undefined ? match : value;
      });
      if (next !== current) setStepFieldValue(step, field, next);
    }
  }
  return draft;
}

/** Placeholder names still present in a parameterized flow. */
export function templatePlaceholders(flow: FlowV2): Set<string> {
  const names = new Set<string>();
  for (const step of flow.steps) {
    for (const field of templateFields) {
      const value = stepFieldValue(step, field);
      if (value === undefined) continue;
      for (const match of value.matchAll(placeholderPattern)) names.add(match[1]);
    }
  }
  return names;
}

function checkParameters(parameters: readonly TemplateParameter[]) {
  const seen = new Set<string>();
  for (const parameter of parameters) {
    if (!parameterPattern.test(parameter.name)) {
      throw new Fault('TEMPLATE_PARAMETER_INVALID', `Invalid parameter name: ${parameter.name}`);
    }
    if (seen.has(parameter.name)) {
      throw new Fault('TEMPLATE_PARAMETER_DUPLICATE', `Duplicate parameter: ${parameter.name}`);
    }
    if (typeof parameter.label !== 'string' || !parameter.label.trim() || parameter.label.length > 256) {
      throw new Fault('TEMPLATE_LABEL_INVALID', `Parameter ${parameter.name} needs a label`);
    }
    if (parameter.defaultValue !== undefined &&
        (typeof parameter.defaultValue !== 'string' || parameter.defaultValue.length > maxValueLength)) {
      throw new Fault('TEMPLATE_DEFAULT_INVALID', `Parameter ${parameter.name} has an invalid default`);
    }
    seen.add(parameter.name);
  }
  return seen;
}

function checkDeclaredPlaceholders(flow: FlowV2, declared: ReadonlySet<string>) {
  for (const name of templatePlaceholders(flow)) {
    if (!declared.has(name)) {
      throw new Fault('TEMPLATE_PLACEHOLDER_UNKNOWN', `The flow uses {{${name}}} but no parameter declares it`);
    }
  }
}

/** Build a template from a flow plus the fields the user marked as variables. */
export function createTemplate(input: {
  id: string;
  name: string;
  description?: string;
  flow: FlowV2;
  selections: readonly TemplateSelection[];
  createdAt?: string;
}): Template {
  if (!idPattern.test(input.id)) throw new Fault('TEMPLATE_ID_INVALID', 'Invalid template id');
  if (!input.name.trim() || input.name.length > 256) {
    throw new Fault('TEMPLATE_NAME_REQUIRED', 'A template needs a name');
  }
  const flow = structuredClone(input.flow) as FlowV2;
  const parameters = new Map<string, TemplateParameter>();
  const parameterValues = new Map<string, string>();
  const touched = new Set<string>();
  for (const selection of input.selections) {
    if (!parameterPattern.test(selection.parameter)) {
      throw new Fault('TEMPLATE_PARAMETER_INVALID', `Invalid parameter name: ${selection.parameter}`);
    }
    if (!templateFields.includes(selection.field)) {
      throw new Fault('TEMPLATE_FIELD_UNSUPPORTED', `Unknown template field: ${selection.field}`);
    }
    const marker = `${selection.stepId}:${selection.field}`;
    if (touched.has(marker)) {
      throw new Fault('TEMPLATE_FIELD_DUPLICATE', `${selection.stepId} already marks ${selection.field}`);
    }
    touched.add(marker);
    const step = flow.steps.find(candidate => candidate.id === selection.stepId);
    if (!step) throw new Fault('TEMPLATE_STEP_MISSING', `No step ${selection.stepId}`);
    // A secure field's content is never kept as a template default; passwords
    // belong in a manual checkpoint, not in a reusable file.
    const role = (step as { target?: { role?: unknown } }).target?.role;
    if (selection.field === 'text' && typeof role === 'string' && /secure/i.test(role)) {
      throw new Fault('TEMPLATE_SECRET_VALUE', 'A secure text field cannot become a template default');
    }
    const current = stepFieldValue(step, selection.field);
    if (current === undefined) {
      throw new Fault('TEMPLATE_FIELD_EMPTY', `Step ${selection.stepId} has no value at ${selection.field}`);
    }
    if (!current.trim()) {
      throw new Fault('TEMPLATE_FIELD_EMPTY', `Step ${selection.stepId} has an empty value at ${selection.field}`);
    }
    if (current.length > maxValueLength) {
      throw new Fault('TEMPLATE_FIELD_TOO_LONG', `Step ${selection.stepId} value is too long to be a variable`);
    }
    // One parameter may fill several fields, but only with one value. Two
    // different values under one name would silently overwrite each other when
    // the template is applied, so refuse the ambiguity now.
    const known = parameterValues.get(selection.parameter);
    if (known !== undefined && known !== current) {
      throw new Fault('TEMPLATE_PARAMETER_CONFLICT',
        `Parameter ${selection.parameter} is marked on two different values; give them separate names`);
    }
    parameterValues.set(selection.parameter, current);
    if (!setStepFieldValue(step, selection.field, `{{${selection.parameter}}}`)) {
      throw new Fault('TEMPLATE_FIELD_UNSUPPORTED',
        `Step ${selection.stepId} cannot parameterize ${selection.field}`);
    }
    if (!parameters.has(selection.parameter)) {
      parameters.set(selection.parameter, {
        name: selection.parameter,
        label: selection.label?.trim() || fieldLabels[selection.field],
        defaultValue: current,
      });
    }
  }
  if (!parameters.size) {
    throw new Fault('TEMPLATE_NO_PARAMETERS', 'Mark at least one step value as a variable');
  }
  const declared = new Set(parameters.keys());
  checkDeclaredPlaceholders(flow, declared);
  parseFlowV2(flow);
  return {
    version: 1,
    id: input.id,
    name: input.name.trim(),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
    parameters: [...parameters.values()],
    flow,
  };
}

/** Parse and validate a template document read from disk or imported by hand. */
export function parseTemplate(input: unknown): Template {
  const record = object(input);
  if (record.version !== 1) throw new Fault('TEMPLATE_INVALID', 'Expected a version 1 template');
  if (typeof record.id !== 'string' || !idPattern.test(record.id)) {
    throw new Fault('TEMPLATE_ID_INVALID', 'Invalid template id');
  }
  if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 256) {
    throw new Fault('TEMPLATE_NAME_REQUIRED', 'A template needs a name');
  }
  if (record.description !== undefined &&
      (typeof record.description !== 'string' || record.description.length > 2000)) {
    throw new Fault('TEMPLATE_DESCRIPTION_INVALID', 'Invalid template description');
  }
  if (!Array.isArray(record.parameters) || record.parameters.length > 64) {
    throw new Fault('TEMPLATE_PARAMETERS_INVALID', 'A template needs a parameters array');
  }
  const parameters: TemplateParameter[] = record.parameters.map(item => {
    const parameter = object(item);
    if (typeof parameter.name !== 'string' || typeof parameter.label !== 'string' ||
        (parameter.defaultValue !== undefined && typeof parameter.defaultValue !== 'string')) {
      throw new Fault('TEMPLATE_PARAMETERS_INVALID', 'Each parameter needs a name, a label and an optional default');
    }
    return {
      name: parameter.name,
      label: parameter.label,
      ...(parameter.defaultValue === undefined ? {} : { defaultValue: parameter.defaultValue }),
    };
  });
  const declared = checkParameters(parameters);
  const flow = parseFlowV2(record.flow);
  checkDeclaredPlaceholders(flow, declared);
  return {
    version: 1,
    id: record.id,
    name: record.name.trim(),
    ...(typeof record.description === 'string' && record.description.trim()
      ? { description: record.description.trim() } : {}),
    ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
    parameters,
    flow,
  };
}

/**
 * Apply a template, substituting values and validating the result. A new flow
 * id and name keep two applications from looking like the same workflow.
 */
export function applyTemplate(
  template: Template,
  values: Readonly<Record<string, string>>,
  meta: { id: string; name?: string } = { id: template.id },
): FlowV2 {
  const parsed = parseTemplate(template);
  const merged: Record<string, string> = {};
  for (const parameter of parsed.parameters) {
    const value = values[parameter.name] ?? parameter.defaultValue ?? '';
    if (!value.trim()) {
      throw new Fault('TEMPLATE_VALUE_REQUIRED', `Parameter ${parameter.name} needs a value`);
    }
    if (value.length > maxValueLength) {
      throw new Fault('TEMPLATE_VALUE_TOO_LONG', `Parameter ${parameter.name} is too long`);
    }
    merged[parameter.name] = value;
  }
  const flow = substituteTemplate(parsed.flow, merged);
  // A placeholder with no parameter would survive substitution and reach the
  // desktop as literal braces, so refuse it here instead of at replay time.
  const left = templatePlaceholders(flow);
  if (left.size) {
    throw new Fault('TEMPLATE_VALUE_REQUIRED', `Missing values for ${[...left].join(', ')}`);
  }
  if (!idPattern.test(meta.id)) throw new Fault('TEMPLATE_ID_INVALID', 'Invalid flow id');
  flow.id = meta.id;
  flow.name = (meta.name?.trim() || parsed.name).slice(0, 256);
  return parseFlowV2(flow);
}

export async function listTemplates(directory = templateDirectory()): Promise<Template[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const templates: Template[] = [];
  for (const name of names.filter(entry => entry.endsWith('.template.json')).sort()) {
    try {
      templates.push(parseTemplate(JSON.parse(await readFile(join(directory, name), 'utf8'))));
    } catch {
      // A malformed template is skipped rather than failing the whole list.
    }
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function saveTemplate(template: Template, directory = templateDirectory()) {
  const parsed = parseTemplate(template);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${parsed.id}.template.json`);
  // Templates may carry recorded window titles and file names. Keep them
  // readable only by the operator, like a recording.
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function deleteTemplate(id: string, directory = templateDirectory()) {
  if (!idPattern.test(id)) throw new Fault('TEMPLATE_ID_INVALID', 'Invalid template id');
  await rm(join(directory, `${id}.template.json`), { force: true });
}
