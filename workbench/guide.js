/**
 * The first-run guide. It explains the four steps that turn a recording into a
 * repeatable test, and shows the live recorder health so an operator who just
 * rebuilt the native helper knows why the record button is still off.
 *
 * The page owns no state beyond this dialog: opening it is safe at any time,
 * and every health probe is read-only.
 */

const healthHeader = 'x-cuekeeper-workbench';

export function createGuide({ dialog, dom, onStart }) {
  const { el, button, muted } = dom;
  let health;
  let checking = false;
  let built = false;

  const healthBox = el('div', { className: 'guide-health', 'aria-live': 'polite' });
  const recheck = button('重新检查环境', () => void check(), { style: 'small', icon: 'refresh' });
  const start = button('开始录制', () => {
    dialog.close();
    onStart?.();
  }, { style: 'small primary', icon: 'play', disabled: true });

  function renderHealth() {
    healthBox.replaceChildren();
    if (checking) {
      healthBox.append(muted('检查中…'));
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
        ...targetRows());
      start.disabled = false;
      return;
    }
    const checks = Array.isArray(health.blocking) ? health.blocking : [];
    healthBox.append(
      el('div', { className: 'guide-state error' }, '需要授权'),
      el('div', { className: 'guide-checks' },
        ...checks.map(check => el('div', {
          className: 'guide-check', title: `${check.label}：${check.detail}`,
        },
        el('span', {}, check.label),
        check.id === 'accessibility' || check.id === 'input-monitoring'
          ? button('设置', () => void openSettings(check.id), { style: 'small' })
          : undefined))),
      health.appPath ? muted('优先勾选 CueKeeper；若系统列出录制器，用下面一行添加。') : undefined,
      ...targetRows());
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
      // The blocking line already tells the operator where to go if the
      // shortcut cannot be opened.
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

  async function revealApp() {
    try {
      await fetch('/api/guide/reveal-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [healthHeader]: '1' },
        body: '{}',
      });
    } catch {
      // The path is printed next to the button; Finder is a convenience.
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

  function pathRow(label, path, reveal, revealTitle) {
    if (!path) return undefined;
    return el('div', { className: 'guide-recorder' },
      el('span', { className: 'guide-recorder-label' }, label),
      el('code', { title: path }, path),
      button('复制', () => copyPath(path), { style: 'small', icon: 'copy', iconOnly: true, title: '复制路径' }),
      button('显示', () => void reveal(), { style: 'small', icon: 'folder', iconOnly: true, title: revealTitle }));
  }

  function targetRows() {
    const rows = [];
    if (health?.appPath) {
      rows.push(pathRow('应用', health.appPath, revealApp, '在 Finder 中显示 CueKeeper'));
    }
    if (health?.recorderPath) {
      rows.push(pathRow('录制器', health.recorderPath, revealRecorder, '在 Finder 中显示录制器'));
    }
    return rows;
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
      el('div', { className: 'dialog-head' },
        el('h2', { id: 'guide-title' }, '4 步开始'),
        button('关闭', () => dialog.close(), { icon: 'x', iconOnly: true, title: '关闭' })),
      el('div', { className: 'guide stack-list' },
        healthBox,
        el('ol', { className: 'guide-steps' },
          step('1', '授权应用', '辅助功能 + 输入监控'),
          step('2', '录制操作', '倒计时 → 操作 → 停止'),
          step('3', '检查流程', 'dry-run 处理黄色步骤'),
          step('4', '回放报告', '实时回放，查看结果')),
        el('div', { className: 'actions guide-actions' },
          recheck, start,
          button('关闭', () => dialog.close(), { style: 'small' }))));
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
