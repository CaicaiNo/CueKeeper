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
      healthBox.append(muted('正在检查录制器、权限与 agent-desktop…'));
      start.disabled = true;
      return;
    }
    if (!health) {
      healthBox.append(el('div', { className: 'alert alert-soft alert-warning' },
        '暂时读不到录制环境。工作台仍可编辑已有流程；重新检查后再录制。'));
      start.disabled = true;
      return;
    }
    if (health.ok === true) {
      healthBox.append(el('div', { className: 'alert alert-soft alert-success' },
        '录制环境已就绪：录制器、辅助功能、输入监控与 agent-desktop 都通过。'));
      start.disabled = false;
      return;
    }
    const blocking = Array.isArray(health.blocking) ? health.blocking : [];
    const steps = Array.isArray(health.nextSteps) ? health.nextSteps : [];
    healthBox.append(
      el('div', { className: 'alert alert-soft alert-error' },
        el('strong', {}, '录制环境未就绪'),
        el('ul', { className: 'guide-checklist' },
          ...blocking.map(check => el('li', {},
            `${check.label}：${check.detail}`,
            check.id === 'accessibility' || check.id === 'input-monitoring'
              ? button('打开设置', () => void openSettings(check.id), { style: 'small' })
              : undefined)))),
      muted('如果刚重新编译过录制器，macOS 会把新二进制当成新程序：请在“系统设置 → 隐私与安全性”的辅助功能和输入监控里重新勾选 cuekeeper-capture。'),
      steps.length ? muted(steps[0]) : undefined);
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

  function step(number, title, body, hint) {
    return el('li', { className: 'guide-step' },
      el('span', { className: 'guide-num' }, number),
      el('div', {},
        el('strong', {}, title),
        el('p', {}, body),
        hint ? el('p', { className: 'muted' }, hint) : undefined));
  }

  function render() {
    if (built) return;
    built = true;
    const content = el('div', { className: 'modal-box guide-box' },
      el('div', { className: 'dialog-head' },
        el('h2', { id: 'guide-title' }, '4 步开始使用 CueKeeper'),
        button('关闭', () => dialog.close(), { icon: 'x', iconOnly: true, title: '关闭' })),
      el('div', { className: 'guide stack-list' },
        muted('录制一次真实操作，确认目标后就能重复回放和断言；不需要写代码。'),
        healthBox,
        el('ol', { className: 'guide-steps' },
          step('1', '先授权录制器',
            '第一次使用、或重新编译 recorder 后，在系统设置里授予录制器“辅助功能”和“输入监控”权限。',
            '需要授权的程序是 dist/cuekeeper-capture；授权后点“重新检查环境”。'),
          step('2', '录制真实操作',
            '选择倒计时后点“开始录制”，正常操作目标 App，完成后点“停止录制”。',
            '录制中可以按 Ctrl+Option+P 暂停，Ctrl+Option+X 停止。'),
          step('3', '检查并编辑流程',
            '在工作台时间线里核对应用/窗口、目标控件和步骤顺序。',
            '黄色“需确认”的坐标步骤先编辑成元素目标，再跑 dry-run。'),
          step('4', '回放并查看报告',
            'dry-run 通过后执行实时回放；报告里能看到每一步的状态、耗时和失败原因。',
            '重复执行、批量运行、模板和行为库都在下方面板里。')),
        el('div', { className: 'actions guide-actions' },
          recheck, start,
          button('稍后再说', () => dialog.close(), { style: 'small' }))));
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
