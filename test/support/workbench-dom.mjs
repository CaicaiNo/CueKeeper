// The workbench page is plain ES modules, so the real `app.js` can run against
// a small DOM stand-in: clicks go through the same handlers the browser uses,
// and the assertions read the same nodes the operator sees.

export class ClassList {
  constructor() { this.values = new Set(); }
  add(...names) { for (const name of names) if (name) this.values.add(name); }
  remove(...names) { for (const name of names) this.values.delete(name); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.values.has(name) : Boolean(force);
    if (on) this.values.add(name); else this.values.delete(name);
    return on;
  }
}

export class TextNode {
  constructor(text) { this.nodeType = 3; this.textContent = String(text); }
}

export class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this._text = '';
    this.classList = new ClassList();
    this._className = '';
    this._id = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    for (const handler of ['onclick', 'onchange', 'onsubmit', 'oninput', 'ontoggle',
      'ondragstart', 'ondragover', 'ondrop', 'oncancel', 'onerror']) this[handler] = null;
  }

  get className() { return this._className; }

  get id() { return this._id; }

  set id(value) {
    this._id = String(value ?? '');
    if (this._id) this.ownerDocument.byId.set(this._id, this);
  }

  set className(value) {
    this._className = String(value ?? '');
    this.classList = new ClassList();
    for (const name of this._className.split(/\s+/).filter(Boolean)) this.classList.add(name);
  }

  get textContent() {
    return this._text + this.children.map(child => child.textContent).join('');
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value ?? '');
  }

  get lastChild() { return this.children.at(-1); }

  append(...nodes) {
    for (const node of nodes) {
      if (node === undefined || node === null) continue;
      const child = typeof node === 'string' ? new TextNode(node) : node;
      child.parentNode = this;
      this.children.push(child);
    }
  }

  prepend(...nodes) {
    for (const node of nodes.reverse()) {
      if (node === undefined || node === null) continue;
      const child = typeof node === 'string' ? new TextNode(node) : node;
      child.parentNode = this;
      this.children.unshift(child);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }

  after(node) {
    const parent = this.parentNode;
    const index = parent.children.indexOf(this);
    parent.children.splice(index + 1, 0, node);
    node.parentNode = parent;
  }

  replaceWith(node) {
    const parent = this.parentNode;
    parent.children[parent.children.indexOf(this)] = node;
    node.parentNode = parent;
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}

  matches(selector) {
    return selector.split(',').some(part => {
      const rule = part.trim();
      const match = /^([a-z]*)(?:\.([\w-]+))?(?:\[([\w-]+)\])?$/.exec(rule);
      if (!match) return false;
      const [, tag, className, attribute] = match;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      if (className && !this.classList.contains(className)) return false;
      if (attribute && !this.attributes.has(attribute)) return false;
      return true;
    });
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  descendants() {
    return this.children.flatMap(child =>
      child instanceof TextNode ? [] : [child, ...child.descendants()]);
  }

  querySelector(selector) {
    if (selector.includes(':not(')) return null;
    return this.descendants().find(node => node.matches(selector)) ?? null;
  }

  querySelectorAll(selector) {
    return this.descendants().filter(node => node.matches(selector));
  }

  click() {
    const event = {
      target: this, preventDefault() {}, stopPropagation() {}, dataTransfer: { setData() {}, getData() {} },
    };
    if (this.onclick) this.onclick(event);
    for (const handler of this.listeners.get('click') ?? []) handler(event);
  }
}

export class Document {
  constructor() {
    this.byId = new Map();
    this.body = new Element('body', this);
    this.activeElement = null;
    this.main = new Element('main', this);
    this.main.className = 'workspace';
    this.body.append(this.main);
  }

  createElement(tag) { return new Element(tag, this); }
  createElementNS(_namespace, tag) { return new Element(tag, this); }
  createTextNode(text) { return new TextNode(text); }
  getElementById(id) { return this.byId.get(id) ?? null; }
  querySelector(selector) {
    if (selector === 'main.workspace') return this.main;
    return this.body.querySelector(selector);
  }
  querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
  addEventListener() {}
}

/** The element ids `workbench/index.html` provides to `app.js`. */
export const PAGE_IDS = [
  'dialog', 'v2-pick-dialog', 'status', 'session-name', 'session-kind', 'summary', 'setup', 'timeline',
  'timeline-count', 'ignored-control', 'selection', 'inspector', 'draft', 'draft-count',
  'test-name', 'save-button', 'run-button', 'shell-button', 'privilege-button', 'import-button',
  'app-picker', 'app-picker-icon', 'app-picker-label', 'mode-edit', 'mode-batch',
  'template-button', 'actions-tab', 'library-tab', 'show-ignored', 'batch-log',
  'batch-workspace', 'edit-workspace', 'draft-section',
];

/**
 * Build the page skeleton and expose it the way a browser does. The returned
 * document is the one every assertion should read.
 */
export function installWorkbenchPage() {
  const document = new Document();
  for (const id of PAGE_IDS) {
    const node = document.createElement('div');
    node.id = id;
    document.main.append(node);
  }
  const location = { hash: '' };
  globalThis.document = document;
  globalThis.window = { addEventListener() {}, location };
  globalThis.location = location;
  globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
  return document;
}
