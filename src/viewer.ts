import type {
  AssertCheck, AssertionResult, Check, Entry, Flow, Report, ScreenshotActual, ScreenshotExpectation,
  Setup, StringExpectation,
} from './contracts.js';
import type { PlannedStep } from './flow.js';
import type { PackAsset } from './assets.js';

type ExecutableAction = PlannedStep['action'];
type AnyExpectation = Check['expect'] | AssertCheck['expect'];

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => entities[character]);

const statusLabels: Record<string, string> = {
  passed: '通过', resolved: '已解析', failed: '失败', blocked: '阻塞', skipped: '跳过',
};

const identityModeLabels: Record<string, string> = {
  bundle_path: '按副本路径', legacy_bundle_id: '按应用标识',
};
const identityStatusLabels: Record<string, string> = {
  verified: '已核对运行实例', offline_unverified: '离线来源', blocked: '应用身份阻塞',
};
const identityReasonLabels: Record<string, string> = {
  invalid_bundle_path: '选中的应用路径已失效，请重新选择副本并保存。',
  bundle_id_mismatch: '应用路径的应用标识已变更，请重新选择副本并保存。',
  unsupported_path_platform: '该应用路径属于另一平台，本机只能离线验证。',
  path_mismatch: '无法唯一确认目标副本，请打开选中的副本后重新运行。',
  multiple_instances: '同一应用有多个运行实例，请关闭冲突实例后重新运行。',
  multiple_installed_copies: '本机有多份可启动的副本，请明确选择路径后保存。',
  identity_unproven: '无法证明操作仍指向选中的副本，本轮已停止。',
  instance_changed: '目标实例在运行中发生了变化，本轮已停止。',
  driver_target_unconfirmed: '驱动无法证明窗口归属，本轮已停止。',
  fixture_path_mismatch: '快照来自另一个应用路径，请重新采集快照。',
  untargeted_input: '该坐标操作无法绑定到选中的副本，请改用元素定位器。',
};

function identityMarkup(report: Report) {
  const identity = report.appIdentity;
  if (!identity) return '';
  return `<span class="tag identity status-${escapeHtml(identity.status)}">${escapeHtml(
    identityStatusLabels[identity.status] ?? identity.status)} · ${escapeHtml(identityModeLabels[identity.mode] ?? identity.mode)}</span>`;
}

function identityBanner(report: Report) {
  const identity = report.appIdentity;
  if (!identity || identity.status !== 'blocked') return '<div class="banner" id="identityBanner" hidden></div>';
  const reason = typeof identity.reason === 'string' ? identity.reason : '';
  const hint = identityReasonLabels[reason] ?? '应用身份无法确认，本轮已停止。';
  return `<div class="banner" id="identityBanner">
    <span class="ic" aria-hidden="true">${viewerIcon('alert')}</span>
    <span><b>${escapeHtml(identityStatusLabels.blocked)}</b> <span class="mono">${escapeHtml(identity.code ?? '')}</span>　${escapeHtml(hint)}</span>
    <span class="sp"></span>
    <span class="mono">${escapeHtml(reason)}${identity.entryId ? ` · ${escapeHtml(identity.entryId)}` : ''}</span>
  </div>`;
}

/** Report warnings are the same input-source facts CLI and --json show. */
function imeBanners(report: Report) {
  return (report.warnings ?? []).map(item => `<div class="banner ime-banner ime-${escapeHtml(item.level)}">
    <span class="ic" aria-hidden="true">${viewerIcon('alert')}</span>
    <span><b>${escapeHtml(item.title)}</b> <span class="mono">${escapeHtml(item.code)}</span>　${escapeHtml(item.message)}
      <span class="ime-action">下一步：${escapeHtml(item.action)}</span></span>
    <span class="sp"></span>
    <span class="mono">${escapeHtml(item.original?.name ?? '')} → ${escapeHtml(item.current?.name ?? '')}</span>
  </div>`).join('');
}
const kindLabels: Record<string, string> = {
  setup: '前置条件', click: '点击', type: '输入', key: '快捷键', wait: '等待', assert: '断言', scroll: '滚轮',
  drag: '拖拽', hover: '悬停', paste: '粘贴',
};
const deliveryLabels: Record<string, string> = {
  delivered_verified: '已送达并验证',
  delivered_unverified: '已送达，未验证',
  delivery_uncertain: '送达不确定',
  not_delivered: '未送达',
  unknown: '未知',
};
const roleLabels: Record<string, string> = {
  'screenshot-before': '操作前截图',
  'screenshot-after': '操作后截图',
  screenshot: '截图',
  'assertion-baseline': '断言基线',
  'assertion-actual': '断言实际',
  log: '日志',
  snapshot: 'AX 快照',
  file: '附件',
};

function formatDuration(ms: number) {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const total = Math.round(ms / 1_000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function short(value: string, limit = 72) {
  const single = value.replace(/\s+/g, ' ');
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

function assetHref(path: string) {
  return path.split('/').map((segment, index) => index === 0 ? `assets/${encodeURIComponent(segment)}` : encodeURIComponent(segment)).join('/');
}

function chip(status: string) {
  return `<span class="chip status-${escapeHtml(status)}">${escapeHtml(statusLabels[status] ?? status)}</span>`;
}

interface LocatorShape {
  kind: string;
  app?: string;
  window?: string;
  match?: string;
  role?: string;
  name?: string;
  path?: string[];
  index?: number;
  point?: [number, number];
}

function locatorText(value: LocatorShape): string {
  if (value.kind === 'window') {
    const parts = [`应用=${value.app ?? ''}`];
    if (value.window !== undefined) parts.push(`窗口="${value.window}"`);
    if (value.match) parts.push(`匹配=${value.match}`);
    return parts.join(' · ');
  }
  if (value.kind === 'point' && value.point) return `坐标点 (${value.point[0]}, ${value.point[1]})`;
  const parts = [`role=${value.role ?? ''}`];
  if (value.name !== undefined) parts.push(value.name === '' ? 'name=""' : `name="${value.name}"`);
  if (value.path?.length) parts.push(`path=${value.path.join(' > ')}`);
  if (value.index !== undefined) parts.push(`index=${value.index}`);
  return parts.join(' · ');
}

function locatorShort(target: { kind: string; app?: string; window?: string; role?: string; name?: string; point?: [number, number] }) {
  if (target.kind === 'window') {
    return target.window ? `窗口 “${short(target.window, 32)}” · ${target.app ?? ''}` : `应用窗口 · ${target.app ?? ''}`;
  }
  if (target.kind === 'point' && target.point) return `坐标 (${target.point[0]}, ${target.point[1]})`;
  if (target.name) return `${target.role ?? '元素'} “${short(target.name, 32)}”`;
  return target.role ?? '元素';
}

function normalizeText(normalize: { ignoreCase?: boolean; whitespace?: string } | undefined) {
  if (!normalize) return '';
  return [normalize.ignoreCase ? '忽略大小写' : undefined, normalize.whitespace === 'trim' ? '去首尾空白' :
    normalize.whitespace === 'collapse' ? '折叠空白' : undefined].filter(Boolean).join(' · ');
}

function comparatorText(expect: StringExpectation) {
  const suffix = normalizeText(expect.normalize);
  const tail = suffix ? `（${suffix}）` : '';
  if ('equals' in expect) return `等于 ${JSON.stringify(expect.equals)}${tail}`;
  if ('contains' in expect) return `包含 ${JSON.stringify(expect.contains)}${tail}`;
  return `匹配 /${expect.matches}/${expect.normalize?.ignoreCase ? 'i' : ''}${tail}`;
}

function ratioText(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function screenshotText(expect: ScreenshotExpectation) {
  const { region } = expect;
  return `区域截图 ${region.width}×${region.height} @ (${region.x}, ${region.y}) · 差异 ≤ ${ratioText(expect.maxDiffRatio)}`;
}

function expectationText(expect: AnyExpectation, target?: 'element' | 'window') {
  switch (expect.property) {
    case 'exists':
      return target === 'window'
        ? (expect.equals ? '窗口存在' : '窗口不存在')
        : (expect.equals ? '元素存在' : '元素不存在');
    case 'visible': return expect.equals ? '元素可见' : '元素不可见';
    case 'screenshot': return screenshotText(expect);
    case 'title': return `窗口标题${comparatorText(expect)}`;
    default: return `元素${expect.property === 'text' ? '文本' : '值'}${comparatorText(expect)}`;
  }
}

function actualText(actual: AssertionResult['actual'] | ScreenshotActual | undefined, recorded = true) {
  if (actual === undefined) return recorded ? '未取得观测值' : '报告未记录实际值';
  if (typeof actual === 'boolean') return String(actual);
  if (typeof actual === 'string') return JSON.stringify(actual);
  const frame = `帧 ${actual.frameWidth}×${actual.frameHeight}`;
  if (actual.differentPixels === undefined || actual.diffRatio === undefined) return frame;
  return `${frame} · 差异 ${actual.differentPixels} 像素（${ratioText(actual.diffRatio)}）`;
}

function planIndex(flow: Flow, steps: PlannedStep[]) {
  const actions = new Map<string, ExecutableAction>();
  const setups = new Map<string, Setup>();
  for (const setup of flow.setup ?? []) setups.set(`global/setup/${setup.id}`, setup);
  for (const { id, action } of steps) {
    actions.set(id, action);
    for (const setup of action.setup ?? []) setups.set(`${id}/setup/${setup.id}`, setup);
  }
  return { actions, setups };
}


const modifierOrder = ['ctrl', 'alt', 'shift', 'meta'];
const modifierLabels: Record<string, string> = { ctrl: 'Ctrl', alt: 'Opt', shift: 'Shift', meta: 'Cmd' };
const keyLabels: Record<string, string> = {
  space: 'Space', return: 'Return', tab: 'Tab', escape: 'Esc', delete: 'Delete',
  backspace: 'Backspace', forwarddelete: 'Forward Delete', up: '↑', down: '↓',
  left: '←', right: '→', home: 'Home', end: 'End', pageup: 'Page Up', pagedown: 'Page Down',
};
function shortcutLabel(action: { modifiers?: string[]; key: string }) {
  return [
    ...modifierOrder.filter(key => (action.modifiers ?? []).includes(key)).map(key => modifierLabels[key]),
    keyLabels[action.key] ?? action.key.toUpperCase(),
  ].join('+');
}

const scrollArrows: Record<string, string> = { up: '↑', down: '↓', left: '←', right: '→' };

function scrollLabel(action: Extract<ExecutableAction, { kind: 'scroll' }>) {
  let direction: string;
  let amount: number;
  if ('direction' in action) {
    direction = action.direction;
    amount = action.amount;
  } else {
    const vertical = Math.abs(action.deltaY) >= Math.abs(action.deltaX) && action.deltaY !== 0;
    direction = vertical ? (action.deltaY > 0 ? 'up' : 'down') : (action.deltaX > 0 ? 'right' : 'left');
    amount = Math.max(1, Math.round(Math.abs(vertical ? action.deltaY : action.deltaX)));
  }
  return `滚轮 ${scrollArrows[direction] ?? ''} ${amount} 行`;
}

function gestureLabel(action: ExecutableAction) {
  if (action.kind === 'click') {
    if (action.button === 'right') return '右键';
    if (action.count === 2) return '双击';
    if (action.count === 3) return '三击';
  }
  return kindLabels[action.kind] ?? action.kind;
}

function summaryFor(entry: Entry, action: ExecutableAction | undefined, setup: Setup | undefined) {
  if (entry.kind === 'setup') return `前置条件 · ${setup?.name ?? entry.id.split('/').pop() ?? entry.id}`;
  if (!action) return `${kindLabels[entry.kind] ?? entry.kind}`;
  switch (action.kind) {
    case 'click': return `${gestureLabel(action)} ${locatorShort(action.target)}`;
    case 'drag': return `拖拽 ${locatorShort(action.from)} → ${locatorShort(action.to)}`;
    case 'scroll': return `${scrollLabel(action)} ${locatorShort(action.target)}`;
    case 'hover': return `悬停 ${locatorShort(action.target)} · ${action.durationMs} ms`;
    // Clipboard content is deliberately not rendered; only its size is evidence.
    case 'paste': return `粘贴 ${action.text.length} 字 ${locatorShort(action.target)}`;
    case 'type': return `${action.ime ? 'IME 文本插入' : '输入'} ${short(JSON.stringify(action.text), 40)}`;
    case 'key': return `快捷键 ${shortcutLabel(action)}`;
    case 'wait': return `等待 ${expectationText(action.check.expect)}`;
    case 'assert': return `断言 ${expectationText(action.check.expect, action.check.target.kind)}`;
    case 'shell': return `Shell · ${'argv' in action ? action.argv[0] : action.command}`;
  }
}

function deliveryOf(entry: Entry) {
  return 'delivery' in entry ? entry.delivery : undefined;
}

function deliveryText(entry: Entry) {
  const delivery = deliveryOf(entry);
  return delivery ? deliveryLabels[delivery] ?? delivery : undefined;
}

function nodeIcon(status: string) {
  if (status === 'failed') {
    return '<svg width="8" height="8" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  }
  if (status === 'passed' || status === 'resolved') {
    return '<svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5 6.2 11.6 13 4.6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  return '';
}

interface StepView {
  entry: Entry;
  action?: ExecutableAction;
  setup?: Setup;
  check?: Check | AssertCheck;
  expectation: string;
  summary: string;
  index: number;
}

function buildViews(report: Report, flow: Flow, steps: PlannedStep[]): StepView[] {
  const { actions, setups } = planIndex(flow, steps);
  return report.entries.map(entry => {
    const action = entry.kind === 'setup' ? undefined : actions.get(entry.id);
    const setup = entry.kind === 'setup' ? setups.get(entry.id) : undefined;
    const check = action && (action.kind === 'wait' || action.kind === 'assert') ? action.check :
      setup ? setup.check : undefined;
    return {
      entry,
      ...(action ? { action } : {}),
      ...(setup ? { setup } : {}),
      ...(check ? { check } : {}),
      expectation: check ? expectationText(check.expect, check.target.kind) : '',
      summary: summaryFor(entry, action, setup),
      index: 0,
    };
  }).map((view, index) => ({ ...view, index }));
}

function errorSection(view: StepView) {
  const { entry } = view;
  if (entry.status !== 'failed' && entry.status !== 'blocked') return '';
  const expected = view.expectation ||
    (entry.kind === 'click' ? '元素可解析并完成点击' :
      entry.kind === 'scroll' ? '滚动目标可解析并完成滚动' :
        entry.kind === 'drag' ? '拖拽两端可解析并完成拖拽' :
          entry.kind === 'hover' ? '悬停目标可解析并完成移动' :
            entry.kind === 'paste' ? '粘贴目标可聚焦并完成粘贴' :
              entry.kind === 'type' ? '输入已送达并生效' :
                entry.kind === 'key' ? '快捷键已送达并生效' : '步骤完成');
  const actual = entry.kind === 'assert' && entry.assertion?.actual !== undefined
    ? actualText(entry.assertion.actual)
    : entry.message ||
      (entry.status === 'blocked' ? '前置条件未满足，步骤未执行' : '报告未记录实际值');
  const attempts = (entry as Entry & { attempts?: unknown }).attempts;
  const retry = Array.isArray(attempts) && attempts.length
    ? attempts.map((attempt, index) =>
      `<dd>第 ${index + 1} 次 · ${escapeHtml(short(
        typeof attempt === 'string' ? attempt : JSON.stringify(attempt), 120))}</dd>`).join('')
    : '<dd>报告未记录重试</dd>';
  return `<section class="sect">
  <div class="sect-head"><h3>失败信息</h3><span class="rule"></span></div>
  <div class="error">
    <div class="error-head">
      <span class="ic" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 2.6v6.8M8 12.5v.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.3"/></svg></span>
      <span class="code">${escapeHtml(entry.code ?? 'STEP_FAILED')}</span>
      <span class="t">${escapeHtml(short(actual, 120))}</span>
    </div>
    <div class="error-body">
      <p>${escapeHtml(actual)}</p>
      <dl class="diff">
        <dt>期望</dt><dd class="good">${escapeHtml(expected)}</dd>
        <dt>实际</dt><dd class="bad">${escapeHtml(actual)}</dd>
        ${view.check ? `<dt>定位器</dt><dd>${escapeHtml(locatorText(view.check.target))}</dd>` : ''}
        ${deliveryText(entry) ? `<dt>送达</dt><dd>${escapeHtml(deliveryText(entry)!)}</dd>` : ''}
        <dt>重试</dt>${retry}
      </dl>
    </div>
  </div>
</section>`;
}

function assertionSection(view: StepView) {
  if (!view.check) return '';
  const wait = view.action?.kind === 'wait' ? view.action.timeoutMs : undefined;
  const repair = view.entry.kind === 'setup' ? view.entry.repair : undefined;
  const record = view.entry.kind === 'assert' ? view.entry.assertion : undefined;
  const expect = (record?.expected ?? view.check.expect) as AnyExpectation;
  const screenshot = 'property' in expect && expect.property === 'screenshot';
  const repairLabel = repair && [
    repair.kind === 'app_running' ? '确保应用运行' : '打开或聚焦窗口',
    statusLabels[repair.result],
    repair.code,
  ].filter(Boolean).join(' · ');
  const rows = [
    `<div class="row"><span class="k">期望</span><code>${escapeHtml(expectationText(expect, view.check.target.kind))}</code></div>`,
    `<div class="row"><span class="k">实际</span><code>${escapeHtml(actualText(record?.actual, record !== undefined))}</code></div>`,
    `<div class="row"><span class="k">结果</span>${chip(view.entry.status)}</div>`,
    `<div class="row"><span class="k">定位器</span><code>${escapeHtml(locatorText(view.check.target))}</code></div>`,
    view.entry.code ? `<div class="row"><span class="k">错误码</span><code>${escapeHtml(view.entry.code)}</code></div>` : '',
    screenshot ? `<div class="row"><span class="k">阈值</span><code>差异 ≤ ${ratioText((expect as ScreenshotExpectation).maxDiffRatio)}</code></div>` : '',
    wait !== undefined ? `<div class="row"><span class="k">超时上限</span><code>${wait} ms</code></div>` : '',
    repairLabel ? `<div class="row"><span class="k">修复</span><code>${escapeHtml(repairLabel)}</code></div>` : '',
  ].join('');
  return `<section class="sect">
  <div class="sect-head"><h3>断言</h3><span class="rule"></span></div>
  <div class="assertbox">${rows}</div>
</section>`;
}

function screenshotSection(view: StepView, assets: PackAsset[]) {
  if (view.entry.kind === 'setup') return '';
  const shots = assets.filter(asset => asset.role.startsWith('screenshot') || asset.role.startsWith('assertion'));
  if (!shots.length) {
    return `<section class="sect">
  <div class="sect-head"><h3>截图</h3><span class="rule"></span></div>
  <p class="empty-note">报告未包含该步截图。打包时把图片放在 <code>assets/${escapeHtml(view.entry.id)}/before.png</code> 与 <code>after.png</code> 即可显示。</p>
</section>`;
  }
  const figures = shots.map(asset => {
    const image = /\.(png|jpe?g|gif|webp|svg)$/i.test(asset.path);
    const href = assetHref(asset.path);
    return `<figure class="shot">
  ${image ? `<a class="shot-frame" href="${href}" target="_blank" rel="noreferrer"><img src="${href}" alt="${escapeHtml(roleLabels[asset.role])}" loading="lazy"></a>` :
    `<div class="shot-frame missing"><a href="${href}" download>${escapeHtml(asset.path)}</a></div>`}
  <figcaption class="shot-cap"><span>${escapeHtml(roleLabels[asset.role])}</span><span class="t">${escapeHtml(asset.path)}</span><span>${formatBytes(asset.bytes.length)}</span></figcaption>
</figure>`;
  }).join('');
  return `<section class="sect">
  <div class="sect-head"><h3>截图</h3><span class="extra">${shots.length} 张</span><span class="rule"></span></div>
  <div class="shots">${figures}</div>
</section>`;
}

function targetSection(view: StepView, flow: Flow) {
  const { action, entry } = view;
  if (entry.kind === 'setup' && !view.setup) return '';
  const rows: string[] = [];
  if (entry.kind === 'setup' && view.setup) {
    rows.push(`<div class="target wide"><p class="k">检查</p><div class="v">${escapeHtml(locatorText(view.setup.check.target))}</div></div>`);
    rows.push(`<div class="target"><p class="k">前置条件</p><div class="v">${escapeHtml(view.setup.name)} · ${escapeHtml(view.setup.state)}</div></div>`);
  }
  if (action) {
    if (action.kind === 'click') {
      rows.push(`<div class="target wide"><p class="k">定位器</p><div class="v">${escapeHtml(locatorText(action.target))}</div></div>`);
    } else if (action.kind === 'scroll') {
      rows.push(`<div class="target wide"><p class="k">定位器</p><div class="v">${escapeHtml(locatorText(action.target))}</div></div>`);
      rows.push(`<div class="target"><p class="k">滚动</p><div class="v">${escapeHtml(scrollLabel(action))}</div></div>`);
    } else if (action.kind === 'drag') {
      rows.push(`<div class="target wide"><p class="k">起点</p><div class="v">${escapeHtml(locatorText(action.from))}</div></div>`);
      rows.push(`<div class="target wide"><p class="k">终点</p><div class="v">${escapeHtml(locatorText(action.to))}</div></div>`);
      rows.push(`<div class="target"><p class="k">拖拽时长</p><div class="v">${formatDuration(action.durationMs)}</div></div>`);
    } else if (action.kind === 'hover') {
      rows.push(`<div class="target wide"><p class="k">定位器</p><div class="v">${escapeHtml(locatorText(action.target))}</div></div>`);
      rows.push(`<div class="target"><p class="k">停留</p><div class="v">${formatDuration(action.durationMs)}</div></div>`);
    } else if (action.kind === 'paste') {
      rows.push(`<div class="target wide"><p class="k">定位器</p><div class="v">${escapeHtml(locatorText(action.target))}</div></div>`);
      rows.push(`<div class="target"><p class="k">文本</p><div class="v">${action.text.length} 字（内容不写入报告）</div></div>`);
    } else if (action.kind === 'type') {
      rows.push(`<div class="target wide"><p class="k">定位器</p><div class="v">${escapeHtml(locatorText(action.target))}</div></div>`);
      rows.push(`<div class="target wide"><p class="k">文本</p><div class="v">${escapeHtml(action.text)}</div></div>`);
    } else if (action.kind === 'key') {
      rows.push(`<div class="target wide"><p class="k">快捷键</p><div class="v">${escapeHtml(shortcutLabel(action))}</div></div>`);
    } else if (action.kind === 'wait' || action.kind === 'assert') {
      rows.push(`<div class="target wide"><p class="k">定位器</p><div class="v">${escapeHtml(locatorText(action.check.target))}</div></div>`);
    }
    rows.push(`<div class="target"><p class="k">动作</p><div class="v">${escapeHtml(gestureLabel(action))}</div></div>`);
  }
  rows.push(`<div class="target"><p class="k">应用</p><div class="v">${escapeHtml(flow.target.app)}</div></div>`);
  rows.push(`<div class="target wide"><p class="k">窗口</p><div class="v">${escapeHtml(flow.target.window)}</div></div>`);
  const delivery = deliveryOf(entry);
  if (delivery) {
    rows.push(`<div class="target"><p class="k">送达状态</p><div class="v">${escapeHtml(deliveryLabels[delivery] ?? delivery)}</div></div>`);
  }
  return `<section class="sect">
  <div class="sect-head"><h3>目标</h3><span class="rule"></span></div>
  <div class="targets">${rows.join('')}</div>
</section>`;
}

function logsSection(view: StepView, assets: PackAsset[]) {
  const texts = assets.filter(asset => asset.text !== undefined);
  if (!texts.length) {
    return `<section class="sect">
  <div class="sect-head"><h3>日志</h3><span class="rule"></span></div>
  <p class="empty-note">报告未包含该步日志${view.entry.message ? `。步骤消息：${escapeHtml(view.entry.message)}` : '。'}</p>
</section>`;
  }
  const open = view.entry.status === 'failed' || view.entry.status === 'blocked';
  const panels = texts.map((asset, index) => `<details class="panel" data-restore-key="log-${view.index}-${index}"${open ? ' open' : ''}>
  <summary><span class="chev">▸</span>${escapeHtml(asset.path)} <span class="hint">${escapeHtml(roleLabels[asset.role])} · ${formatBytes(asset.bytes.length)}</span></summary>
  <div class="body"><pre>${escapeHtml(asset.text ?? '')}</pre></div>
</details>`).join('');
  return `<section class="sect">
  <div class="sect-head"><h3>日志与快照</h3><span class="rule"></span></div>
  ${panels}
</section>`;
}

function artifactsSection(assets: PackAsset[]) {
  if (!assets.length) return '';
  const rows = assets.map(asset => `<div class="artifact">
  <span class="ic" aria-hidden="true">${asset.role.startsWith('screenshot') ? '▣' : '▤'}</span>
  <span>${escapeHtml(asset.path)}</span>
  <span class="sz">${escapeHtml(roleLabels[asset.role])} · ${formatBytes(asset.bytes.length)}</span>
  <a class="dl" href="${assetHref(asset.path)}" download>下载</a>
</div>`).join('');
  return `<section class="sect">
  <div class="sect-head"><h3>产物</h3><span class="extra">${assets.length} 个文件</span><span class="rule"></span></div>
  <div class="artifacts">${rows}</div>
</section>`;
}

function detailMarkup(view: StepView, flow: Flow, assets: PackAsset[], initial: boolean, last: boolean) {
  const { entry } = view;
  const status = entry.status;
  return `<article class="detail-step" data-detail="${escapeHtml(entry.id)}" data-index="${view.index}"${initial ? '' : ' hidden'}>
  <header class="detail-head">
    <div class="crumb"><span>执行时间线</span><span class="sep">/</span><span>第 ${String(view.index + 1).padStart(2, '0')} 步</span></div>
    <div class="step-head">
      <span class="no">${String(view.index + 1).padStart(2, '0')}</span>
      <h2>${escapeHtml(view.summary)}</h2>
      ${chip(status)}
      ${last ? '<span class="chip warn last-known">最后已知</span>' : ''}
      <span class="head-meta">${formatDuration(entry.durationMs)} · +${formatDuration(entry.atMs)}</span>
    </div>
    <p class="summary">${escapeHtml(entry.message ?? `${kindLabels[entry.kind] ?? entry.kind} · ${entry.id}`)}</p>
  </header>
  ${errorSection(view)}
  ${assertionSection(view)}
  ${screenshotSection(view, assets)}
  ${targetSection(view, flow)}
  ${logsSection(view, assets)}
  ${artifactsSection(assets)}
</article>`;
}

export interface ViewerBundle {
  html: string;
  css: string;
  js: string;
}

const viewerIcons = {
  fileDown: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/>',
  fileCode: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 13 2 2-2 2"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54Z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};
const viewerIcon = (name: keyof typeof viewerIcons) =>
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${viewerIcons[name]}</svg>`;

export function renderViewer(report: Report, flow: Flow, steps: PlannedStep[], assets: PackAsset[]): ViewerBundle {
  const views = buildViews(report, flow, steps);
  const perEntry = new Map<string, PackAsset[]>();
  const unassigned: PackAsset[] = [];
  for (const asset of assets) {
    if (!asset.entryId) { unassigned.push(asset); continue; }
    const list = perEntry.get(asset.entryId) ?? [];
    list.push(asset);
    perEntry.set(asset.entryId, list);
  }

  const failed = views.filter(view => view.entry.status === 'failed' || view.entry.status === 'blocked');
  const assertions = views.filter(view => view.entry.kind === 'assert');
  const assertionsPassed = assertions.filter(view => view.entry.status === 'passed').length;
  const assertionExtras = ([['blocked', '阻塞'], ['skipped', '跳过'], ['resolved', '已解析']] as const)
    .map(([status, label]) => [assertions.filter(view => view.entry.status === status).length, label] as const)
    .filter(([count]) => count > 0);
  const initial = failed[0] ?? views[0];
  const last = views[views.length - 1];
  const autoDisconnected = Boolean(last && (last.entry.code === 'INTERRUPTED' || last.entry.code === 'STREAM_DISCONNECTED'));
  const completed = views.filter(view => ['passed', 'resolved'].includes(view.entry.status)).length;
  const skipped = views.filter(view => view.entry.status === 'skipped').length;
  const blocked = views.filter(view => view.entry.status === 'blocked').length;
  const totalDuration = views.reduce((max, view) => Math.max(max, view.entry.atMs + view.entry.durationMs), 0);
  const progress = views.length ? Math.round(completed / views.length * 100) : 0;
  const reportStatus = report.status;
  const reportStatusLabel = reportStatus === 'passed' ? '通过' : reportStatus === 'failed' ? '失败' : '阻塞';

  const entries = views.map(view => {
    const { entry } = view;
    const failure = entry.status === 'failed' || entry.status === 'blocked';
    const failedAssertion = entry.kind === 'assert' && entry.status === 'failed';
    const selected = initial?.entry.id === entry.id;
    return `<li class="entry status-${escapeHtml(entry.status)}${failure ? ' is-failed' : ''}${failedAssertion ? ' is-failed-assert' : ''}${selected ? ' selected' : ''}" data-step="${escapeHtml(entry.id)}" data-status="${escapeHtml(entry.status)}" data-kind="${escapeHtml(entry.kind)}">
  <button class="entry-row" type="button" data-select="${escapeHtml(entry.id)}" aria-current="${selected ? 'true' : 'false'}">
    <span class="a-node" aria-hidden="true">${nodeIcon(entry.status)}</span>
    <span class="a-main">
      <span class="a-title"><span class="idx">${String(view.index + 1).padStart(2, '0')}</span>${escapeHtml(view.summary)}</span>
      <span class="a-sub">${escapeHtml(kindLabels[entry.kind] ?? entry.kind)} · ${formatDuration(entry.durationMs)} · +${formatDuration(entry.atMs)}</span>
    </span>
    <span class="a-meta"><span class="status-text">${escapeHtml(statusLabels[entry.status] ?? entry.status)}</span>${last?.entry.id === entry.id ? '<span class="tag last-known">最后已知</span>' : ''}</span>
  </button>
</li>`;
  }).join('');

  const details = views.map(view => detailMarkup(
    view, flow, perEntry.get(view.entry.id) ?? [], initial?.entry.id === view.entry.id,
    last?.entry.id === view.entry.id,
  )).join('');

  const unassignedList = unassigned.length ? `<details class="panel rail-assets">
  <summary><span class="chev">▸</span>运行产物 <span class="hint">${unassigned.length} 个文件</span></summary>
  <div class="body"><ul class="asset-list">${unassigned.map(asset =>
    `<li><a href="${assetHref(asset.path)}" download>${escapeHtml(asset.path)}</a><span>${escapeHtml(roleLabels[asset.role])} · ${formatBytes(asset.bytes.length)}</span></li>`).join('')}</ul></div>
</details>` : '';

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(flow.name)} · Cuekeeper</title>
<style>${stylesheet}</style>
</head>
<body class="${autoDisconnected ? 'disconnected' : ''}" data-report-key="${escapeHtml(`${flow.id}:${report.startedAt}`)}" data-stream="${autoDisconnected ? 'disconnected' : 'connected'}" data-last-step="${escapeHtml(last?.entry.id ?? '')}">
<div class="app">
  <header class="topbar">
    <div class="brand"><span class="mark" aria-hidden="true"></span>Cuekeeper</div>
    <span class="divider" aria-hidden="true"></span>
    <div class="run-name">${escapeHtml(flow.name)} <span class="run-id">#${escapeHtml(report.flowId)}</span></div>
    <div class="run-state state-${escapeHtml(reportStatus)}"><span class="dot" aria-hidden="true"></span>${reportStatusLabel}</div>
    <div class="assert-stats" id="assertStats">断言 ${assertions.length} 条，${assertionsPassed} 条通过${assertionExtras.map(([count, label]) =>
      `<span class="assert-extra">${label} ${count}</span>`).join('')}</div>
    <div class="progress" role="img" aria-label="完成 ${completed} / ${views.length} 步">
      <span class="track"><span class="fill" style="width:${progress}%"></span></span>
      <span class="count">${completed} / ${views.length}</span>
    </div>
    <div class="elapsed">${formatDuration(totalDuration)}</div>
    <div class="env">${escapeHtml(flow.target.app)} · ${escapeHtml(flow.target.window)}${identityMarkup(report)}</div>
    <div class="top-actions">
      <a class="btn" href="report.json" download>${viewerIcon('fileDown')}报告 JSON</a>
      <a class="btn" href="flow.json" download>${viewerIcon('fileCode')}流程 JSON</a>
      <button class="btn" id="failedOnly" type="button" aria-pressed="false">${viewerIcon('filter')}只看失败</button>
      <button class="btn" id="assertFailedOnly" type="button" aria-pressed="false">${viewerIcon('alert')}只看失败断言</button>
      <button class="btn" id="streamToggle" type="button" aria-pressed="${autoDisconnected ? 'true' : 'false'}">${viewerIcon(autoDisconnected ? 'x' : 'activity')}${autoDisconnected ? '退出断流预览' : '断流预览'}</button>
    </div>
  </header>

  <div class="banner" id="banner"${autoDisconnected ? '' : ' hidden'}>
    <span class="ic" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 2.5v7M8 12.4v.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.3"/></svg></span>
    <span><b>事件流已断开</b> <span class="mono">· 报告止于最后一次事件</span>　最后已知：第 ${last ? String(last.index + 1).padStart(2, '0') : '—'} 步 ${escapeHtml(last?.entry.id ?? '')}</span>
    <span class="sp"></span>
    <button class="btn" id="bannerExit" type="button">${viewerIcon('x')}退出断流预览</button>
  </div>

  ${identityBanner(report)}
  ${imeBanners(report)}

  <main class="layout">
    <section class="rail" aria-label="执行时间线">
      <div class="rail-head">
        <h1>执行时间线</h1>
        <span class="rail-count">${views.length} 步</span>
      </div>
      <div class="restore" id="restore" hidden>
        <span class="dot" aria-hidden="true"></span>
        <span>已恢复上次视图</span>
        <span class="mono" id="restoreAt"></span>
        <span class="sp"></span>
        <button class="ghost" id="clearRestore" type="button">清除</button>
      </div>
      <ol class="timeline" id="timeline">${entries}</ol>
      <p class="empty-note rail-empty" id="railEmpty" hidden>没有失败步骤。</p>
      ${unassignedList}
    </section>

    <section class="detail" id="detail" aria-label="步骤详情">${details}</section>
  </main>

  <footer class="statusbar">
    <span>完成 <span class="mono">${completed}</span></span>
    <span class="sep" aria-hidden="true"></span>
    <span${failed.length ? ' class="bad"' : ''}>失败 <span class="mono">${failed.length}</span></span>
    <span class="sep" aria-hidden="true"></span>
    <span>阻塞 <span class="mono">${blocked}</span></span>
    <span class="sep" aria-hidden="true"></span>
    <span>跳过 <span class="mono">${skipped}</span></span>
    <span class="sep" aria-hidden="true"></span>
    <span>总耗时 <span class="mono">${formatDuration(totalDuration)}</span></span>
    <span class="sep" aria-hidden="true"></span>
    <span>报告 <span class="mono">${escapeHtml(report.startedAt)}</span></span>
    <span class="right conn" id="connState"><span class="dot" aria-hidden="true"></span>${autoDisconnected ? `已断开 · 止于第 ${last ? String(last.index + 1).padStart(2, '0') : '—'} 步` : '离线查看 · 无网络请求'}</span>
  </footer>
</div>
<script>${script}</script>
</body>
</html>
`;

  return { html, css: stylesheet, js: script };
}

const stylesheet = `
:root{color-scheme:light;
  --bg:#F5F4EF;--surface:#FFFFFF;--surface-2:#FAFAF7;
  --ink:#111110;--ink-2:#3C3B38;--muted:#77746C;
  --line:#E2E0D8;--line-strong:#D6D3CA;
  --accent:#C8401C;--accent-soft:#F7E5DE;
  --failed:#B3261E;--failed-soft:#FBF2F0;--failed-line:#E8D2CC;
  --warn:#8A5A12;--warn-soft:#FBF6EA;--warn-line:#E8DCC3;
  --ok:#2E6B4C;--ok-soft:#EFF5F1;
  --radius-s:4px;--radius-m:6px;--radius-l:8px;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,"JetBrains Mono",monospace;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;height:100vh;overflow:hidden;background:var(--bg);color:var(--ink);
  font:400 13px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;
  -webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit}
a{color:var(--accent)}
[hidden]{display:none!important}
.app{display:flex;flex-direction:column;height:100vh;min-height:0}

.topbar{display:flex;align-items:center;gap:18px;min-height:56px;padding:8px 22px;background:var(--surface);
  border-bottom:1px solid var(--line);z-index:6;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:8px;font-weight:500;letter-spacing:-.01em;white-space:nowrap}
.brand .mark{width:18px;height:18px;border:1.5px solid var(--ink);border-radius:5px;position:relative}
.brand .mark::after{content:"";position:absolute;left:5px;top:5px;width:6px;height:6px;border-radius:2px;background:var(--accent)}
.divider{width:1px;height:20px;background:var(--line-strong);flex:none}
.run-name{display:flex;align-items:baseline;gap:8px;font-weight:500;min-width:0}
.run-name .run-id{color:var(--muted);font-family:var(--mono);font-size:12px}
.run-state{display:flex;align-items:center;gap:6px;color:var(--ink-2);white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;background:var(--muted);flex:none}
.state-passed .dot{background:var(--ok)}
.state-failed .dot{background:var(--failed)}
.state-blocked .dot{background:var(--warn)}
.progress{display:flex;align-items:center;gap:8px}
.progress .track{width:88px;height:3px;border-radius:2px;background:var(--line);overflow:hidden}
.progress .fill{display:block;height:100%;background:var(--ink)}
.progress .count,.elapsed{font-family:var(--mono);font-size:12px;color:var(--ink-2);white-space:nowrap}
.env{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:26ch}
.assert-stats{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-2);white-space:nowrap}
.assert-stats .assert-extra{font-family:var(--mono);font-size:11px;color:var(--muted)}
.top-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.btn{height:32px;padding:0 11px;border:1px solid var(--line-strong);border-radius:var(--radius-s);
  background:var(--surface);cursor:pointer;color:var(--ink-2);display:inline-flex;align-items:center;gap:6px;
  text-decoration:none;white-space:nowrap}
.btn:hover{background:var(--surface-2);color:var(--ink)}
.btn svg{flex:none;opacity:.85}
.btn{display:inline-flex;align-items:center;gap:6px}
.btn[aria-pressed="true"]{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
.btn:focus-visible,.entry-row:focus-visible,.ghost:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

.banner{display:flex;align-items:center;gap:10px;min-height:40px;padding:6px 22px;
  background:var(--warn-soft);border-bottom:1px solid var(--warn-line);color:#6E4A12;font-size:12px;flex-wrap:wrap}
.banner .ic{display:grid;place-items:center;color:var(--warn)}
.banner b{font-weight:500;color:#5A3C0E}
.banner .mono{font-family:var(--mono);font-size:11.5px;color:#7A5A25}
.banner .sp{flex:1}
.banner .btn{height:26px;padding:0 10px;background:transparent;border-color:var(--warn-line);color:#6E4A12}
.banner .btn:hover{background:#F7EEDC;color:#5A3C0E}
.ime-banner .ime-action{display:block;margin-top:2px;color:#7A5A25;font-size:11.5px}

.layout{display:grid;grid-template-columns:392px minmax(0,1fr);flex:1;min-height:0}
.rail{background:var(--surface-2);border-right:1px solid var(--line);overflow-y:auto;padding:16px 12px 28px 16px}
.rail-head{display:flex;align-items:center;justify-content:space-between;margin:0 0 10px 6px}
.rail-head h1{font-size:12px;font-weight:500;color:var(--muted);margin:0}
.rail-count{font-family:var(--mono);font-size:11px;color:var(--muted)}
.restore{display:flex;align-items:center;gap:6px;margin:0 0 10px 4px;padding:6px 8px;border:1px solid var(--line);
  border-radius:6px;background:var(--surface);font-size:11px;color:var(--ink-2)}
.restore .dot{background:var(--accent);width:5px;height:5px}
.restore .mono{font-family:var(--mono);font-size:10.5px;color:var(--muted)}
.restore .sp{flex:1}
.ghost{background:none;border:0;color:var(--muted);font-size:11px;cursor:pointer;padding:2px 4px;border-radius:4px}
.ghost:hover{color:var(--ink);background:#F1EEE8}

.timeline{list-style:none;margin:0;padding:0;position:relative}
.timeline::before{content:"";position:absolute;left:16px;top:12px;bottom:14px;width:1.5px;background:var(--line)}
.entry{position:relative}
.entry-row{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:9px;align-items:center;width:100%;
  background:none;border:0;padding:7px 6px 7px 6px;border-radius:7px;cursor:pointer;text-align:left;position:relative;z-index:1}
.entry-row:hover{background:#F1EEE8}
.entry.selected .entry-row{background:var(--surface);box-shadow:0 0 0 1px var(--line) inset}
.a-node{width:16px;height:16px;border-radius:50%;border:1.5px solid var(--line-strong);background:var(--surface-2);
  display:grid;place-items:center;justify-self:center;color:#fff;flex:none}
.entry.status-passed .a-node,.entry.status-resolved .a-node{background:var(--ink);border-color:var(--ink)}
.entry.status-failed .a-node{background:var(--failed);border-color:var(--failed)}
.entry.status-blocked .a-node{background:var(--warn);border-color:var(--warn)}
.entry.status-skipped .a-node{background:transparent;border-style:dashed}
.a-main{min-width:0;display:flex;flex-direction:column;gap:1px}
.a-title{font-size:12.5px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.entry.selected .a-title{color:var(--ink)}
.entry.status-failed .a-title{color:var(--failed);font-weight:500}
.idx{font-family:var(--mono);font-size:10.5px;color:var(--muted);margin-right:6px}
.a-sub{font-family:var(--mono);font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.a-meta{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--muted);white-space:nowrap}
.status-text{display:none}
.tag{display:inline-flex;align-items:center;height:17px;padding:0 5px;border-radius:4px;font-size:10px;
  border:1px solid var(--line-strong);color:var(--ink-2);background:var(--surface)}
.last-known{display:none;border-color:var(--warn-line);background:var(--warn-soft);color:var(--warn)}
body.disconnected .last-known{display:inline-flex}
body.only-failed .entry:not(.is-failed){display:none}
body.only-failed-assert .entry:not(.is-failed-assert){display:none}
.rail-empty{margin:10px 6px;color:var(--muted);font-size:12px}
.rail-assets{margin-top:14px;background:var(--surface)}

.detail{overflow-y:auto;padding:0 30px 44px;min-width:0;scroll-behavior:smooth}
.detail-step{max-width:860px;padding-bottom:8px}
.detail-head{position:sticky;top:0;z-index:4;background:var(--bg);padding:22px 0 12px;border-bottom:1px solid transparent}
.crumb{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);margin:0 0 6px}
.crumb .sep{color:var(--line-strong)}
.step-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.step-head .no{font-family:var(--mono);font-size:13px;color:var(--muted)}
.step-head h2{font-size:21px;line-height:1.3;font-weight:500;margin:0;letter-spacing:-.01em}
.chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:5px;font-size:11.5px;
  border:1px solid var(--line);color:var(--ink-2);background:var(--surface);white-space:nowrap}
.chip.status-failed{color:var(--failed);border-color:var(--failed-line);background:var(--failed-soft)}
.chip.status-blocked,.chip.warn{color:var(--warn);border-color:var(--warn-line);background:var(--warn-soft)}
.chip.status-passed,.chip.status-resolved{color:var(--ok);border-color:#D5E4DB;background:var(--ok-soft)}
.chip.status-skipped{color:var(--muted)}
.head-meta{color:var(--muted);font-size:12px;font-family:var(--mono);margin-left:auto}
.summary{margin:10px 0 0;color:var(--ink-2);font-size:12.5px;max-width:74ch;overflow-wrap:anywhere}

.sect{margin-top:22px}
.sect-head{display:flex;align-items:center;gap:8px;margin:0 0 8px}
.sect-head h3{font-size:11.5px;font-weight:500;color:var(--muted);margin:0}
.sect-head .rule{flex:1;height:1px;background:var(--line)}
.sect-head .extra{font-size:11px;color:var(--muted);font-family:var(--mono)}

.error{border:1px solid var(--failed-line);border-radius:var(--radius-m);background:var(--surface);overflow:hidden}
.error-head{display:flex;align-items:center;gap:10px;padding:11px 14px;background:var(--failed-soft);border-bottom:1px solid var(--failed-line)}
.error-head .ic{color:var(--failed);display:grid;place-items:center;flex:none}
.error-head .code{font-family:var(--mono);font-size:11px;color:var(--failed)}
.error-head .t{font-size:12.5px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.error-body{padding:12px 14px}
.error-body p{margin:0;color:var(--ink-2);font-size:12px;overflow-wrap:anywhere}
.diff{display:grid;grid-template-columns:64px 1fr;gap:6px 12px;margin:10px 0 0}
.diff dt{color:var(--muted);font-size:11.5px;margin:0}
.diff dd{margin:0;font-family:var(--mono);font-size:11.5px;color:var(--ink-2);overflow-wrap:anywhere}
.diff dd.bad{color:var(--failed)}.diff dd.good{color:var(--ok)}

.assertbox{border:1px solid var(--line);border-radius:var(--radius-m);background:var(--surface);overflow:hidden}
.assertbox .row{display:grid;grid-template-columns:88px 1fr;gap:10px;align-items:center;padding:9px 12px;border-top:1px solid var(--line);font-size:12px}
.assertbox .row:first-child{border-top:0}
.assertbox .k{color:var(--muted);font-size:11.5px}
.assertbox code{font-family:var(--mono);font-size:11.5px;color:var(--ink-2);overflow-wrap:anywhere}

.shots{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.shot{margin:0;border:1px solid var(--line);border-radius:var(--radius-m);background:var(--surface);overflow:hidden}
.shot-frame{display:block;position:relative;aspect-ratio:16/10;background:#EDEAE4;overflow:hidden}
.shot-frame img{width:100%;height:100%;object-fit:contain;display:block}
.shot-frame.missing{display:grid;place-items:center;padding:18px;aspect-ratio:16/10}
.shot-cap{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 11px;border-top:1px solid var(--line);font-size:11px;color:var(--muted)}
.shot-cap .t{font-family:var(--mono);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty-note{margin:0;padding:8px 0;color:var(--muted);font-size:11.5px;line-height:1.65}
.empty-note code{font-family:var(--mono);font-size:10.5px;color:var(--ink-2)}

.targets{display:grid;grid-template-columns:1fr 1fr;background:var(--surface);border:1px solid var(--line);
  border-radius:var(--radius-m);overflow:hidden}
.target{background:var(--surface);padding:10px 12px;min-width:0;border-bottom:1px solid var(--line)}
.target:last-child{border-bottom:0}
.target .k{font-size:11px;color:var(--muted);margin:0 0 2px}
.target .v{font-family:var(--mono);font-size:11.5px;color:var(--ink-2);overflow-wrap:anywhere}
.target.wide{grid-column:1 / -1}

.panel{margin-top:10px;border:1px solid var(--line);border-radius:var(--radius-m);background:var(--surface)}
.panel summary{cursor:pointer;list-style:none;padding:9px 12px;font-size:11.5px;color:var(--ink-2);display:flex;align-items:center;gap:8px}
.panel summary::-webkit-details-marker{display:none}
.panel summary .chev{color:var(--muted);display:inline-block;transition:transform .12s ease}
.panel[open] summary .chev{transform:rotate(90deg)}
.panel .hint{margin-left:auto;font-size:10.5px;color:var(--muted);font-family:var(--mono)}
.panel .body{border-top:1px solid var(--line);padding:10px 12px;font-family:var(--mono);font-size:11px;
  color:var(--ink-2);background:var(--surface-2);border-radius:0 0 var(--radius-m) var(--radius-m);overflow:auto}
.panel .body pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;font:inherit}

.artifacts{border:1px solid var(--line);border-radius:var(--radius-m);background:var(--surface);overflow:hidden}
.artifact{display:grid;grid-template-columns:18px minmax(0,1fr) auto auto;gap:10px;align-items:center;padding:8px 12px;
  border-top:1px solid var(--line);font-size:12px;color:var(--ink-2)}
.artifact:first-child{border-top:0}
.artifact .ic{color:var(--muted)}
.artifact .sz{font-family:var(--mono);font-size:10.5px;color:var(--muted);white-space:nowrap}
.artifact .dl{background:none;border:0;color:var(--accent);cursor:pointer;font-size:11px;text-decoration:none;padding:2px 4px;border-radius:4px}
.artifact .dl:hover{background:var(--accent-soft)}
.asset-list{list-style:none;margin:0;padding:0}
.asset-list li{display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-top:1px solid var(--line);font-size:11px}
.asset-list li:first-child{border-top:0}
.asset-list a{text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.asset-list span{color:var(--muted);font-family:var(--mono);font-size:10.5px;white-space:nowrap}

.statusbar{display:flex;align-items:center;gap:16px;min-height:44px;padding:6px 22px;border-top:1px solid var(--line);
  background:var(--surface);font-size:11px;color:var(--muted);flex-wrap:wrap}
.statusbar .mono{font-family:var(--mono);color:var(--ink-2)}
.statusbar .bad{color:var(--failed)}
.statusbar .bad .mono{color:var(--failed)}
.statusbar .sep{width:1px;height:14px;background:var(--line)}
.statusbar .right{margin-left:auto;display:flex;align-items:center;gap:6px}
.conn .dot{width:5px;height:5px;background:var(--ok)}
body.disconnected .conn .dot{background:var(--warn)}
body.disconnected .detail-step .head-meta{color:var(--warn)}

@media (max-width:1160px){.env{display:none}.layout{grid-template-columns:348px minmax(0,1fr)}}
@media (max-width:900px){
  body{overflow:auto}
  .app{height:auto;min-height:100vh}
  .layout{display:block}
  .rail{border-right:0;border-bottom:1px solid var(--line);max-height:44vh}
  .detail{overflow:visible;padding:0 16px 32px}
  .shots,.targets{grid-template-columns:1fr}
  .topbar{padding:10px 16px}
  .statusbar .right{margin-left:0}
}
`;

const script = `
(function () {
  var body = document.body;
  var entries = Array.prototype.slice.call(document.querySelectorAll('[data-step]'));
  var panels = Array.prototype.slice.call(document.querySelectorAll('[data-detail]'));
  var storageKey = 'cuekeeper.report.' + (body.getAttribute('data-report-key') || 'report');
  var saved = null;
  try { saved = JSON.parse(window.localStorage.getItem(storageKey) || 'null'); } catch (error) { saved = null; }

  var failureStatuses = ['failed', 'blocked'];
  var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  var firstFailed = entries.filter(function (entry) {
    return failureStatuses.indexOf(entry.getAttribute('data-status')) >= 0;
  })[0];
  var state = {
    selected: params.get('step') || (saved && saved.selected) || (firstFailed && firstFailed.getAttribute('data-step')) ||
      (entries[0] && entries[0].getAttribute('data-step')) || null,
    onlyFailed: Boolean(saved && saved.onlyFailed),
    onlyFailedAssert: Boolean(saved && saved.onlyFailedAssert),
    disconnected: params.has('disconnected') || Boolean(saved && saved.disconnected) ||
      body.getAttribute('data-stream') === 'disconnected',
    details: (saved && saved.details) || {},
    restored: Boolean(saved)
  };

  function save() {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({
        selected: state.selected,
        onlyFailed: state.onlyFailed,
        onlyFailedAssert: state.onlyFailedAssert,
        disconnected: state.disconnected,
        details: state.details,
        at: new Date().toISOString()
      }));
    } catch (error) { /* file: origins may refuse storage; the viewer still works */ }
  }

  function entryById(id) {
    for (var index = 0; index < entries.length; index += 1) {
      if (entries[index].getAttribute('data-step') === id) return entries[index];
    }
    return null;
  }

  function isFailedAssert(entry) {
    return entry.getAttribute('data-kind') === 'assert' && entry.getAttribute('data-status') === 'failed';
  }

  function visibleEntries() {
    return entries.filter(function (entry) {
      if (state.onlyFailedAssert) return isFailedAssert(entry);
      return !state.onlyFailed || failureStatuses.indexOf(entry.getAttribute('data-status')) >= 0;
    });
  }

  function writeHash() {
    try {
      var value = state.selected ? '#step=' + encodeURIComponent(state.selected) : '';
      if (state.disconnected) value += (value ? '&' : '#') + 'disconnected';
      window.history.replaceState(null, '', value || window.location.pathname);
    } catch (error) { /* replaceState can be refused for file: URLs */ }
  }

  function select(id, persist) {
    if (!id || !entryById(id)) return;
    state.selected = id;
    entries.forEach(function (entry) {
      var current = entry.getAttribute('data-step') === id;
      entry.classList.toggle('selected', current);
      var button = entry.querySelector('[data-select]');
      if (button) button.setAttribute('aria-current', current ? 'true' : 'false');
    });
    panels.forEach(function (panel) {
      panel.hidden = panel.getAttribute('data-detail') !== id;
    });
    var detail = document.getElementById('detail');
    if (detail) detail.scrollTop = 0;
    if (persist !== false) {
      writeHash();
      save();
    }
  }

  function applyFilter() {
    body.classList.toggle('only-failed', state.onlyFailed);
    body.classList.toggle('only-failed-assert', state.onlyFailedAssert);
    var button = document.getElementById('failedOnly');
    if (button) button.setAttribute('aria-pressed', state.onlyFailed ? 'true' : 'false');
    var assertionButton = document.getElementById('assertFailedOnly');
    if (assertionButton) assertionButton.setAttribute('aria-pressed', state.onlyFailedAssert ? 'true' : 'false');
    var visible = visibleEntries();
    var empty = document.getElementById('railEmpty');
    if (empty) {
      var filtering = state.onlyFailed || state.onlyFailedAssert;
      empty.hidden = !(filtering && visible.length === 0);
      empty.textContent = state.onlyFailedAssert ? '没有失败断言。' : '没有失败步骤。';
    }
    if ((state.onlyFailed || state.onlyFailedAssert) && visible.length && !visible.some(function (entry) {
      return entry.getAttribute('data-step') === state.selected;
    })) {
      select(visible[0].getAttribute('data-step'));
    }
  }

  function applyStream() {
    body.classList.toggle('disconnected', state.disconnected);
    var toggle = document.getElementById('streamToggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', state.disconnected ? 'true' : 'false');
      toggle.textContent = state.disconnected ? '退出断流预览' : '断流预览';
    }
    var banner = document.getElementById('banner');
    if (banner) banner.hidden = !state.disconnected;
    var connection = document.getElementById('connState');
    if (connection) {
      connection.lastChild.textContent = state.disconnected ? '已断开 · 数据止于最后已知' : '离线查看 · 无网络请求';
    }
  }

  document.querySelectorAll('[data-select]').forEach(function (button) {
    button.addEventListener('click', function () {
      select(button.getAttribute('data-select'));
    });
  });

  var failedOnly = document.getElementById('failedOnly');
  if (failedOnly) failedOnly.addEventListener('click', function () {
    state.onlyFailed = !state.onlyFailed;
    if (state.onlyFailed) state.onlyFailedAssert = false;
    applyFilter();
    save();
  });

  var assertFailedOnly = document.getElementById('assertFailedOnly');
  if (assertFailedOnly) assertFailedOnly.addEventListener('click', function () {
    state.onlyFailedAssert = !state.onlyFailedAssert;
    if (state.onlyFailedAssert) state.onlyFailed = false;
    applyFilter();
    save();
  });

  function toggleStream() {
    state.disconnected = !state.disconnected;
    applyStream();
    writeHash();
    save();
  }
  var streamToggle = document.getElementById('streamToggle');
  if (streamToggle) streamToggle.addEventListener('click', toggleStream);
  var bannerExit = document.getElementById('bannerExit');
  if (bannerExit) bannerExit.addEventListener('click', function () {
    if (state.disconnected) toggleStream();
  });

  document.querySelectorAll('details[data-restore-key]').forEach(function (panel) {
    var key = panel.getAttribute('data-restore-key');
    if (Object.prototype.hasOwnProperty.call(state.details, key)) panel.open = Boolean(state.details[key]);
    panel.addEventListener('toggle', function () {
      state.details[key] = panel.open;
      save();
    });
  });

  var restore = document.getElementById('restore');
  var restoreAt = document.getElementById('restoreAt');
  if (restore && state.restored) {
    restore.hidden = false;
    if (restoreAt) restoreAt.textContent = saved && typeof saved.at === 'string' ? saved.at.slice(11, 19) + ' UTC' : '';
  }
  var clearRestore = document.getElementById('clearRestore');
  if (clearRestore) clearRestore.addEventListener('click', function () {
    try { window.localStorage.removeItem(storageKey); } catch (error) { /* ignore */ }
    state.restored = false;
    restore.hidden = true;
    if (restoreAt) restoreAt.textContent = '';
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    var visible = visibleEntries();
    if (!visible.length) return;
    var current = -1;
    for (var index = 0; index < visible.length; index += 1) {
      if (visible[index].getAttribute('data-step') === state.selected) current = index;
    }
    var next = event.key === 'ArrowDown' ? Math.min(visible.length - 1, current + 1) : Math.max(0, current - 1);
    select(visible[next].getAttribute('data-step'));
    visible[next].querySelector('[data-select]').focus();
    event.preventDefault();
  });

  applyFilter();
  applyStream();
  select(state.selected, false);
  if (state.selected) {
    var selectedEntry = entryById(state.selected);
    if (selectedEntry) selectedEntry.scrollIntoView({ block: 'nearest' });
  }
  save();
})();
`;
