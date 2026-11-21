import { moveAppFocus, pickerRows, staleAppPath } from './model.js';

const CATALOG_TTL = 60_000;

export function createAppPicker({
  requestAnimationFrame, dialog, dom, state, api, openDialog, status, render, appGlyph, appTitle,
}) {
  const { el, icon, button, muted, input } = dom;

  async function open() {
    if (!state.session) return;

    const search = input({ placeholder: '搜索应用', 'aria-label': '搜索应用' });
    const list = el('div', { className: 'app-list', role: 'listbox', 'aria-label': '本机应用' });
    const refresh = button('刷新目录', () => refreshCatalog(), {
      style: 'small', icon: 'refresh', iconOnly: true, title: '刷新目录', key: 'refresh-apps',
    });
    const searchWrap = el('div', { className: 'app-search' }, icon('search', 14), search);
    const body = el('div', { className: 'stack' },
      el('div', { className: 'app-search-bar' }, searchWrap, refresh), list);
    let catalog = [];
    let activeIndex = -1;
    let refreshing = false;

    list.replaceChildren(muted('正在读取本机应用…'));
    openDialog('选择应用', [body], undefined);
    requestAnimationFrame(() => search.focus());

    const mergedCatalog = () => {
      const merged = [...(state.catalog ?? [])];
      for (const app of Object.values(state.session.apps ?? {})) {
        if (!merged.some(item => item.bundleId === app.bundleId)) merged.push({ ...app, paths: app.paths ?? [] });
      }
      return merged;
    };

    const choose = (bundleId, path, app) => {
      if (bundleId && app?.paths?.length > 1 && !path) {
        showPaths(app);
        return;
      }
      state.app = bundleId;
      if (bundleId && app) state.appNames[bundleId] = app.name;
      if (bundleId && path) state.appPaths[bundleId] = path;
      dialog.close();
      render();
      status(bundleId ? `已筛选「${app?.name ?? bundleId}」` : '已显示全部应用');
    };

    const showPaths = app => {
      const current = state.appPaths[app.bundleId];
      const options = app.paths.map((path, index) => el('label', { className: 'path-option' },
        el('input', { type: 'radio', name: 'app-path', value: path, checked: current ? current === path : index === 0 }),
        el('span', {}, path)));
      const back = button('返回', () => {
        body.replaceChildren(el('div', { className: 'app-search-bar' }, searchWrap, refresh), list);
        draw(search.value);
        search.focus();
      }, { style: 'small', icon: 'undo' });
      const apply = el('button', {
        type: 'button', className: 'button primary',
        onclick: () => {
          const checked = body.querySelector('input[name="app-path"]:checked');
          if (checked) choose(app.bundleId, checked.value, app);
        },
      }, icon('check'), el('span', {}, '使用此副本'));
      body.replaceChildren(
        el('div', { className: 'path-step-head' }, back, el('strong', {}, app.name)),
        muted(`「${app.name}」有 ${app.paths.length} 份副本。保存测试项时会写入这条路径；回放按路径锁定在下一步接入。`),
        staleAppPath(app, state.appPaths)
          ? el('p', { className: 'path-stale' }, `已选路径不在当前目录中：${current}`)
          : undefined,
        el('div', { className: 'path-list' }, ...options),
        el('div', { className: 'actions' }, apply));
    };

    const appEmpty = (title, detail, clearSearch = false) => el('div', { className: 'app-empty' },
      el('span', { className: 'app-empty-icon' }, icon(clearSearch ? 'search' : 'appWindow', 20)),
      el('strong', {}, title),
      muted(detail),
      clearSearch
        ? button('清除搜索', () => { search.value = ''; draw(''); search.focus(); }, { style: 'small', icon: 'x' })
        : button('重新读取', () => refreshCatalog(), { style: 'small', icon: 'refresh' }));

    const rowNodes = () => [...list.querySelectorAll('.app-row')];

    const focusAt = index => {
      const nodes = rowNodes();
      if (!nodes.length) {
        activeIndex = -1;
        search.focus();
        return;
      }
      activeIndex = Math.min(Math.max(index, 0), nodes.length - 1);
      nodes[activeIndex].focus({ preventScroll: true });
      nodes[activeIndex].scrollIntoView({ block: 'nearest' });
    };

    const rowKeydown = (index, item) => event => {
      const count = rowNodes().length;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusAt(moveAppFocus(index, 1, count));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusAt(moveAppFocus(index, -1, count));
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.target.click();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        dialog.close();
      } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        search.value += event.key;
        draw(search.value);
        search.focus();
      } else if (event.key === 'Tab') {
        activeIndex = -1;
      }
    };

    const appRow = (item, index) => {
      const { app } = item;
      const stale = item.stale;
      const name = item.kind === 'all' ? '全部应用' : app.name;
      const detail = item.kind === 'all' ? '不过滤应用' : app.bundleId;
      return el('div', {
        className: `app-row${stale ? ' stale' : ''}`, role: 'option', tabindex: '-1',
        'aria-selected': String(item.selected),
        title: item.kind === 'all' ? '不过滤应用' : appTitle(item.bundleId),
        onclick: () => choose(item.kind === 'all' ? '' : item.bundleId, undefined, app),
        onkeydown: rowKeydown(index, item),
      },
      item.kind === 'all'
        ? el('span', { className: 'app-glyph app-glyph-all' }, icon('appWindow', 14))
        : appGlyph(item.bundleId, () => showPaths(app), 24),
      el('span', {},
        el('span', { className: 'app-row-name' }, name),
        el('span', { className: 'app-row-id' }, detail),
        stale ? el('span', { className: 'app-row-stale', title: `已选路径：${state.appPaths[item.bundleId]}` }, '路径已失效') : undefined),
      item.selected ? el('span', { className: 'app-row-check' }, icon('check', 14)) : undefined);
    };

    const draw = query => {
      activeIndex = -1;
      if (!catalog.length) {
        list.replaceChildren(appEmpty(
          state.catalogError ? '应用目录读取失败' : '没有读取到本机应用',
          state.catalogError ?? '只读取 /Applications、/System/Applications 和 ~/Applications。',
        ));
        return;
      }
      const rows = pickerRows(catalog, query, { current: state.app, appPaths: state.appPaths });
      if (!rows.length) {
        list.replaceChildren(appEmpty('没有匹配的应用', `没有找到「${query.trim()}」，换个名称或 bundle id 试试。`, true));
        return;
      }
      list.replaceChildren(...rows.map(appRow));
    };

    async function refreshCatalog() {
      if (refreshing) return;
      refreshing = true;
      refresh.setAttribute('aria-busy', 'true');
      const term = search.value;
      const offset = list.scrollTop;
      status('正在刷新本机应用目录…');
      try {
        state.catalog = (await api('apps')).apps;
        state.catalogAt = Date.now();
        state.catalogError = null;
        for (const app of state.catalog) state.appNames[app.bundleId] = app.name;
        status(state.catalog.length ? '已刷新本机应用' : '没有读取到本机应用');
      } catch (error) {
        state.catalogError = error.message;
        if (!state.catalog) state.catalog = Object.values(state.session.apps ?? {});
        status(`应用目录刷新失败，只显示本次会话的应用：${error.message}`, 'error');
      } finally {
        refreshing = false;
        refresh.setAttribute('aria-busy', 'false');
      }
      if (!dialog.open) return;
      catalog = mergedCatalog();
      draw(term);
      list.scrollTop = offset;
      search.focus({ preventScroll: true });
    }

    if (!state.catalog || Date.now() - state.catalogAt > CATALOG_TTL) {
      status('正在读取本机应用…');
      try {
        state.catalog = (await api('apps')).apps;
        state.catalogAt = Date.now();
        state.catalogError = null;
        for (const app of state.catalog) state.appNames[app.bundleId] = app.name;
        status(state.catalog.length ? '已读取本机应用' : '没有读取到本机应用');
      } catch (error) {
        state.catalogError = error.message;
        if (!state.catalog) state.catalog = Object.values(state.session.apps ?? {});
        status(`应用目录读取失败，只显示本次会话的应用：${error.message}`, 'error');
      }
    }
    if (!dialog.open) return;
    catalog = mergedCatalog();

    search.addEventListener('input', () => draw(search.value));
    search.addEventListener('focus', () => { activeIndex = -1; });
    search.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusAt(activeIndex < 0 ? 0 : moveAppFocus(activeIndex, 1, rowNodes().length));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusAt(activeIndex < 0 ? rowNodes().length - 1 : moveAppFocus(activeIndex, -1, rowNodes().length));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const nodes = rowNodes();
        (activeIndex >= 0 ? nodes[activeIndex] : nodes[0])?.click();
      }
    });
    body.addEventListener('keydown', event => {
      if (event.key === 'Escape' && dialog.open) {
        event.preventDefault();
        dialog.close();
      }
    });
    draw('');
  }

  return { open };
}
