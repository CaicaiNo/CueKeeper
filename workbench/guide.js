/**
 * The first-run guide. It shows the live recorder health, explains the two
 * macOS permissions in product language, and puts the settings action next to
 * each missing permission. The four-step tour is kept as a collapsible
 * appendix so the permission panel stays compact at small window sizes.
 */

const healthHeader = 'x-cuekeeper-workbench';

const permissionCopy = {
  accessibility: {
    name: '辅助功能',
    why: '读取应用窗口和控件，执行点击、输入和快捷键。',
    status: '未授权',
    pane: 'accessibility',
  },
  'input-monitoring': {
    name: '输入监控',
    why: '录制键盘和鼠标操作。',
    status: '未授权',
    pane: 'input-monitoring',
  },
  recorder: {
    name: '录制器',
    why: 'App 内置的录制器；macOS 把权限算在启动它的 CueKeeper 上。',
    status: '未授权',
  },
  'agent-desktop': {
    name: '桌面代理',
    why: '连接桌面应用，用于回放和窗口读取；需要 agent-desktop 1.3.1。',
    status: '未安装',
  },
};

export function createGuide({ dialog, dom, onStart }) {
  const { el, button } = dom;
  let health;
  let checking = false;
  let built = false;

  const healthBox = el('div', { className: 'guide-health', 'aria-live': 'polite' });
  const recheck = button('重新检查环境', () => void check(), { style: 'small', icon: 'refresh' });
  const request = button('请求权限', () => void requestPermissions(), {
    style: 'small primary', icon: 'lock',
  });
  const start = button('开始录制', () => {
    dialog.close();
    onStart?.();
  }, { style: 'small primary', icon: 'play', disabled: true });

  function copyFor(check) {
    return permissionCopy[check.id]
      ?? { name: '录制环境', why: '这一项需要处理。', status: '需要处理' };
  }

  function renderHealth() {
    healthBox.replaceChildren();
    request.hidden = health?.ok === true;
    if (checking) {
      healthBox.append(el('p', { className: 'muted' }, '检查中…'));
      start.disabled = true;
      return;
    }
    if (!health) {
      healthBox.append(el('div', { className: 'guide-state warning' }, '无法读取录制环境'));
      start.disabled = true;
      return;
    }
    if (health.ok === true) {
      healthBox.append(
        el('div', { className: 'guide-state ok' }, '环境就绪'),
        recorderRow());
      start.disabled = false;
      return;
    }

    const checks = Array.isArray(health.blocking) ? health.blocking : [];
    healthBox.append(
      el('div', { className: 'guide-state error' }, '需要授权'),
      el('div', { className: 'guide-permissions' },
        ...checks.map(check => {
          const copy = copyFor(check);
          return el('div', { className: 'guide-permission' },
            el('div', { className: 'guide-permission-main' },
              el('strong', {}, copy.name,
                el('span', { className: 'guide-permission-status' }, copy.status)),
              el('small', {}, copy.why)),
            copy.pane
              ? button('打开设置', () => void openSettings(copy.pane), {
                style: 'small', icon: 'sliders',
              })
              : undefined);
        })),
      el('p', { className: 'muted guide-hint' },
        '点“请求权限”弹出系统授权；输入监控通常还要手动添加。'),
      el('p', { className: 'muted guide-hint' },
        'macOS 把内置录制器的权限算在 CueKeeper 上：点“打开设置”会在 Finder 中选中 CueKeeper，把它拖进列表；或点 ＋ 后按 ⌘⇧G 粘贴复制的路径。'),
      recorderRow());
    start.disabled = true;
  }

  async function requestPermissions() {
    try {
      await fetch('/api/guide/request-recorder-permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [healthHeader]: '1' },
        body: '{}',
      });
    } catch {
      // The permission rows still open the settings panes if the prompt
      // cannot be started.
    }
  }

  async function openSettings(id) {
    try {
      await fetch('/api/guide/open-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [healthHeader]: '1' },
        body: JSON.stringify({ id }),
      });
    } catch {
      // The permission row already names the settings pane if the shortcut
      // cannot be opened.
    }
    // Input Monitoring does not add the app by itself. Show CueKeeper in Finder
    // so it can be dragged into the list, or picked with the + button.
    await revealRecorder();
  }

  async function revealRecorder() {
    try {
      await fetch('/api/guide/reveal-recorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [healthHeader]: '1' },
        body: '{}',
      });
    } catch {
      // The exact path is printed next to the button; Finder is a convenience.
    }
  }

  async function copyPath(path) {
    if (!path) return;
    try {
      // Copy through the workbench: pbcopy is the clipboard System Settings
      // pastes from, and it does not depend on WKWebView clipboard support.
      const response = await fetch('/api/guide/copy-recorder-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [healthHeader]: '1' },
        body: '{}',
      });
      if (response.ok) return;
    } catch {
      // Fall through to the page clipboard.
    }
    try {
      void navigator.clipboard?.writeText(path);
    } catch {
      // Some embedded pages disable the clipboard; the path remains selectable.
    }
  }

  function recorderRow() {
    const path = health?.appPath || health?.recorderPath;
    if (!path) return undefined;
    const name = path.split('/').filter(Boolean).at(-1) ?? path;
    return el('div', { className: 'guide-recorder' },
      el('span', { className: 'guide-recorder-label' }, '授权对象'),
      el('code', { title: path }, name),
      button('复制', () => void copyPath(path), {
        style: 'small', icon: 'copy', iconOnly: true, title: '复制完整路径',
      }),
      button('显示', () => void revealRecorder(), {
        style: 'small', icon: 'folder', iconOnly: true, title: '在 Finder 中显示 CueKeeper',
      }));
  }

  async function check() {
    if (checking) return;
    checking = true;
    renderHealth();
    try {
      const response = await fetch('/api/record/health', { headers: { [healthHeader]: '1' } });
      health = await response.json();
    } catch {
      health = undefined;
    } finally {
      checking = false;
      renderHealth();
    }
  }

  function step(number, title, hint) {
    return el('li', { className: 'guide-step' },
      el('span', { className: 'guide-num' }, number),
      el('div', {},
        el('strong', {}, title),
        el('small', { className: 'muted' }, hint)));
  }

  function render() {
    if (built) return;
    built = true;
    const content = el('div', { className: 'modal-box guide-box' },
      el('div', { className: 'dialog-head guide-head' },
        el('h2', { id: 'guide-title' }, '使用引导'),
        button('关闭', () => dialog.close(), { icon: 'x', iconOnly: true, title: '关闭' })),
      el('div', { className: 'guide-body' },
        healthBox,
        el('details', { className: 'guide-more' },
          el('summary', {}, '4 步使用流程'),
          el('ol', { className: 'guide-steps' },
            step('1', '授权录制器', '辅助功能 + 输入监控'),
            step('2', '录制操作', '倒计时 → 操作 → 停止'),
            step('3', '检查流程', 'dry-run 处理黄色步骤'),
            step('4', '回放报告', '实时回放，查看结果')))),
      el('div', { className: 'actions guide-actions' },
        recheck, request, start,
        button('关闭', () => dialog.close(), { style: 'small' })));
    dialog.replaceChildren(content);
  }

  dialog.addEventListener('close', () => {
    try {
      localStorage.setItem('cuekeeper.guide.v1', 'seen');
    } catch {
      // A private or embedded page may not expose localStorage; the guide is
      // still available from the header button.
    }
  });

  return {
    open() {
      render();
      if (!dialog.open) dialog.showModal();
      void check();
    },
  };
}
