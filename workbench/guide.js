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
    why: 'CueKeeper 的桌面录制组件；系统权限实际授予这个文件。',
    status: '未就绪',
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
        '在系统设置里勾选下面的录制器；完成后点“重新检查环境”。'),
      recorderRow());
    start.disabled = true;
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

  function copyPath(path) {
    if (!path) return;
    try {
      void navigator.clipboard?.writeText(path);
    } catch {
      // Some embedded pages disable the clipboard; the code element remains
      // selectable by hand.
    }
  }

  function recorderRow() {
    const path = health?.recorderPath;
    if (!path) return undefined;
    return el('div', { className: 'guide-recorder' },
      el('span', { className: 'guide-recorder-label' }, '授权对象'),
      el('code', { title: path }, path),
      button('复制', () => copyPath(path), {
        style: 'small', icon: 'copy', iconOnly: true, title: '复制路径',
      }),
      button('显示', () => void revealRecorder(), {
        style: 'small', icon: 'folder', iconOnly: true, title: '在 Finder 中显示录制器',
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
        recheck, start,
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
