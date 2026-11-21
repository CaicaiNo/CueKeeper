const ICONS = {
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
  play: '<path d="m6 3 14 9-14 9V3z"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="m2 2 20 20"/><path d="M6.71 6.71A10.9 10.9 0 0 0 2 12a10.9 10.9 0 0 0 10 6 10.9 10.9 0 0 0 5.29-1.29"/><path d="M10.73 5.08A10.9 10.9 0 0 1 12 5c4.48 0 8.27 2.94 10 7a11.8 11.8 0 0 1-1.67 2.68"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>',
  crosshair: '<circle cx="12" cy="12" r="10"/><path d="M22 12h-4"/><path d="M6 12H2"/><path d="M12 6V2"/><path d="M12 22v-4"/>',
  listPlus: '<path d="M11 12H3"/><path d="M16 6H3"/><path d="M16 18H3"/><path d="M18 9v6"/><path d="M21 12h-6"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  sliders: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 12.18-9.17 4.16a2 2 0 0 1-1.66 0L2 12.18"/><path d="m22 17.18-9.17 4.16a2 2 0 0 1-1.66 0L2 17.18"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  appWindow: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  pointer: '<path d="M4 4l7.07 17 2.51-7.39L21 11.07z"/>',
  pointerDouble: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  pointerRight: '<rect x="7" y="2" width="10" height="20" rx="5"/><path d="M12 2v6"/><path d="M12 8h5"/>',
  wheel: '<rect x="7" y="2" width="10" height="20" rx="5"/><path d="M12 7v4"/>',
  text: '<path d="M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1"/><path d="M7 2h1a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H7"/>',
  keyboard: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M6 12h.01"/><path d="M10 12h.01"/><path d="M14 12h.01"/><path d="M18 12h.01"/><path d="M7 16h10"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
};

export function createDom(document) {
  const el = (tag, attributes = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined || value === false) continue;
      if (key in node && !key.startsWith('aria')) node[key] = value;
      else node.setAttribute(key, value);
    }
    node.append(...children.filter(child => child !== undefined && child !== null));
    return node;
  };

  const icon = (name, size = 16) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({
      viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    })) svg.setAttribute(key, value);
    svg.innerHTML = ICONS[name] ?? '';
    return svg;
  };

  const button = (label, onclick, { style = '', disabled = false, key, title, icon: iconName, iconOnly = false } = {}) => {
    const children = [];
    if (iconName) children.push(icon(iconName));
    if (!iconOnly && label) children.push(el('span', {}, label));
    return el('button', {
      type: 'button', className: `button ${style}${iconOnly ? ' icon' : ''}`, onclick, disabled, id: key,
      title: title ?? (iconOnly ? label : undefined),
      'aria-label': iconOnly ? (title ?? label) : undefined,
    }, ...children);
  };

  const empty = text => el('p', { className: 'empty' }, text);
  const muted = text => el('p', { className: 'muted' }, text);
  const input = (options = {}) => el('input', { type: 'text', ...options });
  const field = (label, control) => el('label', { className: 'field' }, label, control);
  const select = (items, onchange) => el('select', { onchange },
    ...items.map(([value, label]) => el('option', { value }, label)));

  return { el, icon, button, empty, muted, input, field, select };
}
