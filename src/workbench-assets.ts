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
  { path: '/batch.js', file: 'batch.js', type: 'text/javascript' },
  { path: '/dom.js', file: 'dom.js', type: 'text/javascript' },
  { path: '/model.js', file: 'model.js', type: 'text/javascript' },
  { path: '/picker.js', file: 'picker.js', type: 'text/javascript' },
  { path: '/record.js', file: 'record.js', type: 'text/javascript' },
  { path: '/guide.js', file: 'guide.js', type: 'text/javascript' },
  { path: '/vendor/daisyui.css', file: 'vendor/daisyui.css', type: 'text/css' },
  { path: '/preview.html', file: 'preview.html', type: 'text/html' },
  { path: '/preview.css', file: 'preview.css', type: 'text/css' },
];
