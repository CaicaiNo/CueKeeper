/** Static workbench files served by the local server and checked by `doctor`. */
export interface WorkbenchAsset {
  /** Request path. */
  path: string;
  /** File name under `<install root>/workbench/`. */
  file: string;
  /** Response content type without the charset suffix. */
  type: string;
}

export const workbenchAssets: readonly WorkbenchAsset[] = [
  { path: '/', file: 'index.html', type: 'text/html' },
  { path: '/style.css', file: 'style.css', type: 'text/css' },
  { path: '/app.js', file: 'app.js', type: 'text/javascript' },
  { path: '/dom.js', file: 'dom.js', type: 'text/javascript' },
  { path: '/model.js', file: 'model.js', type: 'text/javascript' },
  { path: '/picker.js', file: 'picker.js', type: 'text/javascript' },
];
