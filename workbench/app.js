import {
  canUndo, changeTarget, compileDraft, confirmCondition, confirmedSetup, deleteCondition, id, makeBehavior,
  retargetCondition, sameTarget, setupDraft, undoCondition, visibleRows,
} from './model.js';

const $ = name => document.getElementById(name);
const dialog = $('dialog');
const state = {
  session: null, library: [], allowLive: false, app: '', selected: new Set(), ignored: new Set(),
  expanded: new Set(), showIgnored: false, focused: null, draft: [], tab: 'actions', saving: false, setup: null,
};

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (key in node && !key.startsWith('aria')) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter(child => child !== undefined && child !== null));
  return node;
}

function button(label, onclick, { style = '', disabled = false, key, title } = {}) {
  return el('button', { type: 'button', className: `button ${style}`, onclick, disabled, id: key, title }, label);
}

const empty = text => el('p', { className: 'empty' }, text);
const muted = text => el('p', { className: 'muted' }, text);
const duration = ms => ms === undefined ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
const timestamp = ms => ms === undefined ? '—' : `+${(ms / 1000).toFixed(2)} s`;
const actionTarget = action => action.target ?? action.check?.target;
const isCompatible = row => sameTarget(row, state.session.target);
const getRows = () => state.session?.timeline ?? [];
const selectedRows = () => visibleRows(getRows(), state.app, state.ignored, false).filter(row => state.selected.has(row.id));
const short = (text, length = 82) => text.length > length ? text.slice(0, length) + '…' : text;

function locatorLabel(target) {
  if (!target) return '目标窗口';
  if (target.kind === 'point') return `坐标 (${target.point.join(', ')})`;
  return [target.role, target.name, target.path?.join(' › '), target.index === undefined ? '' : `[${target.index}]`]
    .filter(Boolean).join(' · ');
}

function actionLabel(action) {
  const label = locatorLabel(actionTarget(action));
  switch (action.kind) {
    case 'click': return label;
    case 'type': return typeof action.text === 'string' ? `输入 “${short(action.text)}”` : `输入参数 ${action.text.param}`;
    case 'key': return [...(action.modifiers ?? []), action.key].join(' + ');
    case 'assert':
    case 'wait': return `${label} · ${action.check.expect.property} = ${short(String(action.check.expect.equals))}`;
    default: return action.kind;
  }
}

function infoList(entries, className) {
  return el('dl', { className }, ...entries.map(([label, value]) => {
    const pair = [el('dt', {}, label), el('dd', {}, String(value))];
    return className === 'stats' ? el('div', {}, ...pair) : pair;
  }).flat());
}

function status(message, type = '') {
  $('status').className = `status ${type}`;
  $('status').textContent = message;
}

async function api(route, data = {}) {
  const response = await fetch(`/api/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cuekeeper-workbench': '1' },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function setSession(session) {
  Object.assign(state, {
    session, app: '', focused: null, draft: [], tab: 'actions', showIgnored: false,
    selected: new Set(), ignored: new Set(), expanded: new Set(),
    setup: session ? setupDraft(session.setup ?? []) : null,
  });
  $('show-ignored').checked = false;
  $('test-name').value = session ? `${session.name.slice(0, 248)} 测试` : '';
  render();
}

function renderSummary() {
  const { session } = state;
  $('session-name').textContent = session?.name ?? '';
  if (!session) {
    $('summary').replaceChildren(muted('尚未导入运行目录'));
    $('apps').replaceChildren();
    return;
  }
  const apps = new Map();
  const windows = new Set();
  for (const row of session.timeline) {
    apps.set(row.app, (apps.get(row.app) ?? 0) + 1);
    windows.add(JSON.stringify([row.app, row.window]));
  }
  const timing = { capture: '录制时间', replay: '回放时间', 'dry-run': '离线验证时间' }[session.timingSource];
  $('summary').replaceChildren(
    muted(short(session.directory.split('/').at(-1), 48)),
    infoList([['时长', duration(session.durationMs)], ['动作', session.timeline.length],
      ['应用', apps.size], ['窗口', windows.size]], 'stats'),
    muted(timing ?? '原始录制缺少时间数据'),
    session.startedAt ? el('time', { className: 'muted', dateTime: session.startedAt },
      session.startedAt.slice(0, 19).replace('T', ' ') + ' UTC') : undefined,
  );
  $('apps').replaceChildren(...[['', session.timeline.length], ...apps].map(([app, count], index) => el('button', {
    type: 'button', className: 'app-filter', id: `app-${index}`, 'aria-pressed': String(state.app === app),
    onclick: () => {
      state.app = app;
      state.selected.clear();
      state.focused = null;
      render();
    },
  }, el('span', { className: 'app-name' }, app || '全部应用'), el('span', { className: 'time trailing' }, count))));
}

const setupStates = {
  inferred: '待确认', confirmed: '已确认', invalid: '已失效', deleted: '已删除',
};

function conditionDetail(condition) {
  const ensure = condition.ensure;
  if (ensure?.kind === 'window_ready') return `${ensure.app} · ${ensure.window}`;
  if (ensure?.kind === 'app_running') return ensure.app;
  return locatorLabel(condition.check.target);
}

function conditionDialog(condition) {
  const ensure = condition.ensure;
  const app = input({ required: true, maxLength: 256, value: ensure?.app ?? state.session.target.app });
  const title = input({
    required: true, maxLength: 256,
    value: ensure?.kind === 'window_ready' ? ensure.window : condition.check.target.name ?? state.session.target.window,
  });
  openDialog('更换前置条件', [
    field('应用标识', app), field('窗口标题', title),
    muted('更换后条件回到待确认状态；确认后才会保存进测试项并参与回放。'),
  ], '更换', () => {
    const next = retargetCondition(state.setup, condition.id, { app: app.value, window: title.value });
    render();
    status(`已更换「${next.name}」，待重新确认`, 'success');
  });
}

function renderSetup() {
  const { session, setup } = state;
  const panel = $('setup');
  if (!session || !setup) {
    panel.replaceChildren(muted('导入运行目录后显示推断的前置条件。'));
    return;
  }
  const conditions = setup.conditions;
  const confirmed = confirmedSetup(conditions).length;
  const summary = muted(conditions.length
    ? `${confirmed} / ${conditions.length} 个已确认条件会随测试项保存并参与回放`
    : '没有前置条件。');
  if (!conditions.length) {
    panel.replaceChildren(summary);
    return;
  }
  panel.replaceChildren(summary, ...conditions.map(condition => {
    const deleted = condition.state === 'deleted';
    return el('article', { className: `condition${deleted ? ' removed' : ''}`, id: `condition-${condition.id}` },
      el('div', { className: 'condition-head' },
        el('span', { className: `state-chip ${condition.state}` }, setupStates[condition.state] ?? condition.state),
        el('strong', {}, condition.name)),
      el('p', { className: 'muted' }, conditionDetail(condition)),
      el('div', { className: 'actions' },
        button('确认', () => {
          confirmCondition(setup, condition.id);
          render();
          status(`已确认「${condition.name}」，保存时一并写入`, 'success');
        }, { style: 'small', disabled: deleted || condition.state === 'confirmed' }),
        button('更换', () => conditionDialog(condition), { style: 'small', disabled: deleted }),
        button('删除', () => {
          deleteCondition(setup, condition.id);
          render();
          status(`已删除「${condition.name}」，可用撤销恢复`, 'success');
        }, { style: 'small danger', disabled: deleted }),
        button('撤销', () => {
          undoCondition(setup, condition.id);
          render();
          status('已撤销前置条件的上一次修改');
        }, { style: 'small', disabled: !canUndo(setup, condition.id) })));
  }));
}

function renderTimeline() {
  const rows = visibleRows(getRows(), state.app, state.ignored, state.showIgnored);
  const selected = selectedRows();
  $('ignored-control').hidden = !state.session;
  $('timeline-count').textContent = state.session ? `${rows.length} 个动作` : '';
  $('selection').replaceChildren(...(selected.length ? [
    el('div', { className: 'selection-bar' },
      el('span', {}, `已选 ${selected.length} 个动作`),
      el('span', { className: 'trailing' }),
      button('合并为行为', () => mergeDialog(selected), {
        style: 'small', disabled: selected.length < 2 || selected.some(row => !isCompatible(row)), key: 'merge-selected',
      }),
      button('清除', () => { state.selected.clear(); render(); }, { style: 'small' })),
  ] : []));
  if (!rows.length) {
    $('timeline').replaceChildren(empty(state.session ? '当前筛选下没有动作。' : '导入运行目录后查看录制动作。'));
    return;
  }
  $('timeline').replaceChildren(...rows.map(row => {
    const ignored = state.ignored.has(row.id);
    const selector = el('input', {
      id: `select-${row.id}`, type: 'checkbox', checked: state.selected.has(row.id), disabled: ignored,
      'aria-label': `选择 ${row.action.kind} ${row.id}`,
      onchange: event => {
        if (event.target.checked) state.selected.add(row.id);
        else state.selected.delete(row.id);
        render();
      },
    });
    const focus = el('button', {
      type: 'button', id: `inspect-${row.id}`, className: 'row-focus',
      'aria-pressed': String(state.focused === row.id),
      onclick: () => { state.focused = row.id; state.tab = 'actions'; render(); },
    },
    el('span', { className: 'time' }, timestamp(row.atMs)),
    el('span', { className: 'kind' }, row.action.kind),
    el('span', { className: 'row-description' }, el('strong', {}, actionLabel(row.action)),
      el('small', {}, `${row.app} · ${row.window}${ignored ? ' · 已忽略' : ''}`)),
    el('span', { className: 'time row-duration', title: '动作耗时' }, duration(row.durationMs)));
    const thumbnail = row.thumbnail && el('details', {
      className: 'thumbnail', open: state.expanded.has(row.id),
      ontoggle: event => {
        if (event.target.open) state.expanded.add(row.id);
        else state.expanded.delete(row.id);
      },
    }, el('summary', {}, '查看缩略图'), el('img', { src: row.thumbnail, alt: '动作截图', loading: 'lazy' }));
    return el('article', {
      className: `row${state.focused === row.id ? ' active' : ''}${ignored ? ' ignored' : ''}`,
    }, el('div', { className: 'row-line' }, selector, focus), thumbnail || undefined);
  }));
}

function addAction(action) {
  state.draft.push({ id: id('action'), action: structuredClone(action) });
  renderDraft();
  status(`已加入 ${action.kind}`, 'success');
}

function renderInspector() {
  for (const tab of ['actions', 'library']) $(`${tab}-tab`).setAttribute('aria-pressed', String(state.tab === tab));
  const panel = $('inspector');
  if (state.tab === 'library') {
    const items = [...state.library].sort((a, b) => a.behavior.name.localeCompare(b.behavior.name));
    panel.replaceChildren(items.length ? el('div', { className: 'stack' }, ...items.map(item => {
      const compatible = state.session && sameTarget(item.target, state.session.target);
      const { behavior, parameterTypes } = item;
      return el('article', { className: 'library-item stack' },
        el('h3', {}, behavior.name),
        muted(`${behavior.steps.length} 步 · ${item.target.app} · ${item.target.window}`),
        behavior.parameters.length ? muted(behavior.parameters.map(param => `${param} · ${parameterTypes[param]}`).join(' / ')) : undefined,
        el('div', { className: 'actions' },
          button('引用', () => behaviorDialog(item, false), { style: 'small', disabled: !compatible }),
          button('复制到草稿', () => behaviorDialog(item, true), { style: 'small', disabled: !compatible })),
        compatible || !state.session ? undefined : muted('此行为属于另一目标窗口。'));
    })) : empty('从时间线选中多个动作，合并到行为库。'));
    return;
  }
  const row = getRows().find(action => action.id === state.focused);
  if (!row) {
    panel.replaceChildren(empty('选择时间线中的动作查看定位器与整理操作。'));
    return;
  }
  const ignored = state.ignored.has(row.id);
  const editable = !ignored && isCompatible(row);
  panel.replaceChildren(el('div', { className: 'stack' },
    el('h3', {}, actionLabel(row.action)),
    infoList([['动作', row.action.kind], ['应用', row.app], ['窗口', row.window],
      ['定位器', locatorLabel(actionTarget(row.action))], ['时间', timestamp(row.atMs)], ['耗时', duration(row.durationMs)]], 'meta-grid'),
    isCompatible(row) ? undefined : muted('该动作属于另一窗口，只能在时间线复盘。'),
    el('div', { className: 'actions' },
      button('加入测试项', () => addAction(row.action), { disabled: !editable }),
      button('添加断言', () => assertionDialog(row), { disabled: !editable }),
      button('重新拾取', () => locatorDialog(row), { disabled: !editable || row.action.kind === 'key' }),
      button(ignored ? '恢复动作' : '忽略动作', () => {
        if (ignored) state.ignored.delete(row.id);
        else {
          state.ignored.add(row.id);
          state.selected.delete(row.id);
        }
        status(ignored ? '已恢复动作' : '已从时间线隐藏。可勾选「显示已忽略」查看。', 'success');
        render();
      }))));
}

function renderDraft() {
  const { draft, session, saving } = state;
  $('draft-count').textContent = `${draft.length} 项`;
  $('save-button').disabled = !draft.length || saving;
  $('run-button').disabled = !draft.length || saving;
  const items = draft.map((entry, index) => {
    const move = offset => {
      [draft[index], draft[index + offset]] = [draft[index + offset], draft[index]];
      renderDraft();
      $(`draft-${entry.id}-${offset}`)?.focus();
    };
    return el('li', { className: 'draft-item' },
      el('span', { className: 'kind' }, entry.item ? '行为' : entry.action.kind),
      el('strong', {}, entry.item?.behavior.name ?? actionLabel(entry.action)),
      el('div', { className: 'button-group trailing' },
        entry.item ? button('参数', () => behaviorDialog(entry.item, false, entry), { style: 'small' }) : undefined,
        button('上移', () => move(-1), { style: 'small', disabled: index === 0, key: `draft-${entry.id}--1` }),
        button('下移', () => move(1), { style: 'small', disabled: index === draft.length - 1, key: `draft-${entry.id}-1` }),
        button('删除', () => { draft.splice(index, 1); renderDraft(); status('已从草稿移除'); }, { style: 'small danger' })));
  });
  $('draft').replaceChildren(...(items.length ? items : [
    el('li', {}, empty(session ? '加入动作，或从行为库引用行为。' : '导入会话后开始编排测试项。')),
  ]));
}

function render() {
  const focus = document.activeElement?.id;
  renderSummary();
  renderSetup();
  renderTimeline();
  renderInspector();
  renderDraft();
  if (focus && !dialog.open) $(focus)?.focus({ preventScroll: true });
}

const field = (label, input) => el('label', { className: 'field' }, label, input);
const input = (options = {}) => el('input', { type: 'text', ...options });
const select = (items, onchange) => el('select', { onchange },
  ...items.map(([value, label]) => el('option', { value }, label)));

function openDialog(title, content, submitLabel, submit) {
  let busy = false;
  const error = el('p', { className: 'form-error', role: 'alert' });
  const dismiss = button('关闭', () => dialog.close());
  const confirm = submit && el('button', { className: 'button primary', type: 'submit' }, submitLabel);
  const form = el('form', {
    className: 'stack',
    onsubmit: async event => {
      event.preventDefault();
      if (!submit || busy) return;
      busy = true;
      confirm.disabled = true;
      dismiss.disabled = true;
      error.textContent = '';
      try {
        await submit();
        dialog.close();
      } catch (failure) {
        error.textContent = failure.message;
      } finally {
        busy = false;
        confirm.disabled = false;
        dismiss.disabled = false;
      }
    },
  },
  el('div', { className: 'dialog-head' }, el('h2', { id: 'dialog-title' }, title), dismiss),
  ...content, error, confirm ? el('div', { className: 'actions' }, confirm) : undefined);
  dialog.oncancel = event => { if (busy) event.preventDefault(); };
  dialog.replaceChildren(form);
  dialog.showModal();
}

function importDialog() {
  const directory = input({ required: true, placeholder: '/…/sandbox/运行目录' });
  openDialog('导入运行目录', [
    field('本地目录路径', directory),
    muted('读取 flow.json 或 recorded.flow.json。report.json、actions.json 与 snapshot.json 存在时一并导入。'),
    state.draft.length ? muted('成功导入后将切换会话。请先保存要保留的草稿。') : undefined,
  ], '导入', async () => {
    setSession(await api('import', { directory: directory.value.trim() }));
    status('已导入本地会话', 'success');
  });
}

function mergeDialog(rows) {
  const name = input({ required: true, maxLength: 256, placeholder: '例如 登录' });
  const typeRows = rows.filter(row => row.action.kind === 'type');
  const fields = typeRows.map((row, index) => ({
    row, param: input({ placeholder: index ? `text${index + 1}` : 'text', maxLength: 64 }),
    type: select([['string', 'string'], ['secret', 'secret']]),
  }));
  const add = el('input', { type: 'checkbox', checked: true });
  openDialog('合并为行为', [
    field('行为名称', name),
    muted(rows.map(row => row.action.kind).join(' → ')),
    fields.length ? el('div', { className: 'parameter-list stack' },
      el('h3', {}, '提取输入文本为参数'),
      muted('参数名留空时保留原文本。secret 使用环境变量名，草稿和行为库只保存变量名或参数名。'),
      ...fields.map(({ row, param, type }, index) => el('div', { className: 'parameter-row' },
        field(`参数名 · ${short(actionLabel(row.action), 32)}`, param), field(`类型 ${index + 1}`, type)))) : undefined,
    el('label', { className: 'checkbox' }, add, '同时加入测试项草稿'),
  ], '保存行为', async () => {
    if (!name.value.trim()) throw new Error('填写行为名称。');
    const bindings = new Map(fields.filter(({ param }) => param.value.trim()).map(({ row, param, type }) =>
      [row.id, { param: param.value.trim(), type: type.value }]));
    const { item, defaults } = makeBehavior(rows, name.value.trim(), bindings, state.session.target);
    const saved = await api('library', { session: state.session.id, item });
    state.library.push(saved);
    if (add.checked) state.draft.push({ id: id('call'), item: saved, args: defaults });
    state.selected.clear();
    state.tab = 'library';
    render();
    status(`已保存行为「${saved.behavior.name}」${add.checked ? '并加入草稿' : ''}`, 'success');
  });
}

function behaviorDialog(item, copy, entry) {
  const { behavior, parameterTypes } = item;
  const name = copy ? input({ required: true, maxLength: 256, value: `${behavior.name.slice(0, 250)} 副本` }) : undefined;
  const fields = behavior.parameters.map(param => {
    const secret = parameterTypes[param] === 'secret';
    return {
      param, secret, node: input({
        required: true, maxLength: secret ? 81 : 4000, spellcheck: false, autocomplete: 'off',
        value: entry?.args[param] ?? (secret ? `CUEKEEPER_SECRET_${param.toUpperCase()}` : ''),
      }),
    };
  });
  openDialog(entry ? '编辑行为参数' : copy ? '复制行为' : '引用行为', [
    name ? field('副本名称', name) : muted(`${behavior.name} · ${behavior.steps.length} 步`),
    ...fields.map(({ param, secret, node }) => field(secret ? `${param} · 环境变量名` : param, node)),
  ], entry ? '应用参数' : '加入草稿', () => {
    for (const { secret, node } of fields) {
      if (secret && !/^CUEKEEPER_SECRET_[A-Z0-9_]{1,64}$/.test(node.value)) {
        throw new Error('secret 必须填写以 CUEKEEPER_SECRET_ 开头的环境变量名。');
      }
    }
    const args = Object.fromEntries(fields.map(({ param, node }) => [param, node.value]));
    if (copy && !name.value.trim()) throw new Error('填写副本名称。');
    const definition = copy
      ? { ...structuredClone(item), behavior: { ...structuredClone(behavior), id: id('behavior'), name: name.value.trim() } }
      : item;
    if (entry) entry.args = args;
    else state.draft.push({ id: id('call'), item: definition, args });
    renderDraft();
    status(entry ? '已更新行为参数' : `已加入行为「${definition.behavior.name}」`, 'success');
  });
}

function frameLabel(candidate) {
  if (!candidate.bounds) return '快照未提供边界';
  const { x, y, width, height } = candidate.bounds;
  return `${x}, ${y} · ${width} × ${height}${candidate.point ? ` · 中心 ${candidate.point.join(', ')}` : ''}`;
}

function candidateLabel(candidate) {
  return `${candidate.interactive ? '可交互' : '容器'} · ${locatorLabel(candidate.locator)}`;
}

function locatorFields(original) {
  const initial = original?.kind === 'element' ? original : undefined;
  const role = input({ required: true, maxLength: 256, value: initial?.role ?? '' });
  const name = input({ maxLength: 256, value: initial?.name ?? '' });
  const exactName = el('input', { type: 'checkbox', checked: initial?.name !== undefined });
  const path = input({ value: initial?.path?.join(' / ') ?? '', placeholder: 'window / scrollarea / textfield' });
  const index = el('input', { type: 'number', min: '0', step: '1', value: initial?.index ?? '' });
  const candidates = state.session.candidates;
  const detail = el('p', { className: 'muted' });
  const picker = select([['', '手动填写'], ...candidates.map((candidate, i) => [String(i), candidateLabel(candidate)])],
    event => {
      if (!event.target.value) {
        detail.textContent = '';
        return;
      }
      const candidate = candidates[Number(event.target.value)];
      const target = candidate.locator;
      role.value = target.role;
      name.value = target.name ?? '';
      exactName.checked = target.name !== undefined;
      path.value = target.path?.join(' / ') ?? '';
      index.value = target.index ?? '';
      detail.textContent = `${candidate.ref} · ${frameLabel(candidate)}`;
    });
  return {
    controls: [
      candidates.length ? field('从快照拾取控件', picker) : muted('此目录没有可拾取的控件快照。可手动填写 AX 定位器。'),
      candidates.length ? detail : undefined,
      field('角色', role), field('名称', name), el('label', { className: 'checkbox' }, exactName, '匹配名称（可匹配空名称）'),
      field('角色路径，可选', path), field('匹配索引，从 0 开始，可选', index),
    ],
    value() {
      const roles = path.value.split('/').map(part => part.trim()).filter(Boolean);
      if (!role.value.trim() || roles.length > 51 || roles.some(part => part.length > 256) ||
          (index.value !== '' && !Number.isSafeInteger(Number(index.value)))) throw new Error('检查定位器角色、路径和索引。');
      return {
        kind: 'element', role: role.value.trim(),
        ...(exactName.checked ? { name: name.value } : {}),
        ...(roles.length ? { path: roles } : {}),
        ...(index.value === '' ? {} : { index: Number(index.value) }),
      };
    },
  };
}

function locatorDialog(row) {
  const picker = locatorFields(actionTarget(row.action));
  openDialog('重新拾取定位器', picker.controls, '替换定位器', () => {
    row.action = changeTarget(row.action, picker.value());
    render();
    status('已替换时间线动作的定位器。可重新加入草稿。', 'success');
  });
}

function assertionDialog(row) {
  const picker = locatorFields(actionTarget(row.action));
  const equals = input({ maxLength: 4000 });
  const toggle = select([['true', '成立'], ['false', '不成立']]);
  const textField = field('预期内容', equals);
  const boolField = field('预期结果', toggle);
  textField.hidden = true;
  const property = select([['exists', '存在'], ['visible', '可见'], ['text', '文本'], ['value', '值']], event => {
    textField.hidden = ['exists', 'visible'].includes(event.target.value);
    boolField.hidden = !textField.hidden;
  });
  openDialog('添加断言', [...picker.controls, field('属性', property), boolField, textField], '加入测试项', () => {
    addAction({
      id: id('assert'), kind: 'assert',
      check: { target: picker.value(), expect: {
        property: property.value, equals: textField.hidden ? toggle.value === 'true' : equals.value,
      } },
    });
  });
}

function currentTest() {
  const name = $('test-name').value.trim();
  if (!name) throw new Error('填写测试项名称。');
  const session = { ...state.session, setup: state.setup?.conditions ?? state.session.setup };
  return { session: state.session.id, test: compileDraft(session, name, state.draft) };
}

async function saveTest() {
  state.saving = true;
  renderDraft();
  try {
    const { output } = await api('save', currentTest());
    status(`已保存 · ${output}`, 'success');
  } catch (error) {
    status(error.message, 'error');
  } finally {
    state.saving = false;
    renderDraft();
  }
}

const resultStatus = { resolved: '已解析', passed: '通过', failed: '失败', blocked: '阻塞', skipped: '跳过' };

function runDialog() {
  const { session, allowLive } = state;
  if (!session.hasSnapshot && !allowLive) {
    openDialog('运行测试项', [
      muted('离线运行需要目录内的 snapshot.json。实时回放需要在启动工作台时显式启用 --allow-live-replay。'),
    ]);
    return;
  }
  const modes = [];
  if (session.hasSnapshot) modes.push(['offline', '离线解析定位器']);
  if (allowLive) modes.push(['live', '回放到当前目标窗口']);
  const confirmed = el('input', { type: 'checkbox' });
  const confirmation = el('label', { className: 'checkbox', hidden: session.hasSnapshot },
    confirmed, `我确认向 ${session.target.window} 执行动作`);
  const mode = select(modes, () => { confirmation.hidden = mode.value !== 'live'; });
  openDialog('运行测试项', [
    field('运行方式', mode), confirmation,
    muted('离线运行读取快照。实时回放向目标窗口写入并可能触发 macOS 权限提示。'),
    muted('前置条件修复可能启动应用或将窗口切到前台。含坐标点击的测试项需要保存后使用 CLI 的 --headed 参数。'),
  ], '开始运行', async () => {
    const selected = mode.value;
    if (selected === 'live' && !confirmed.checked) throw new Error('确认目标窗口后开始回放。');
    const report = await api('run', { ...currentTest(), mode: selected, confirm: confirmed.checked });
    status(`${selected === 'offline' ? '离线运行' : '实时回放'}${resultStatus[report.status]} · ${report.entries.length} 条结果`,
      report.status === 'passed' ? 'success' : 'error');
    setTimeout(() => openDialog('运行结果', [
      el('h3', {}, resultStatus[report.status]),
      el('ol', { className: 'stack' }, ...report.entries.map(entry => el('li', {},
        `${entry.kind} · ${resultStatus[entry.status]} · ${entry.durationMs} ms`,
        entry.message ? muted(entry.message) : undefined))),
    ]), 0);
  });
}

$('import-button').onclick = importDialog;
$('show-ignored').onchange = event => { state.showIgnored = event.target.checked; render(); };
$('save-button').onclick = saveTest;
$('run-button').onclick = runDialog;
for (const tab of ['actions', 'library']) $(`${tab}-tab`).onclick = () => { state.tab = tab; renderInspector(); };

try {
  const initial = await api('state');
  state.library = initial.library;
  state.allowLive = initial.allowLive;
  setSession(initial.session ?? null);
  status(initial.session ? '已导入本地会话' : '会话与测试项保存在本机');
} catch (error) {
  render();
  status(error.message, 'error');
}
