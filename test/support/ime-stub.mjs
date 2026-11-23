import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A recording now manages the input source, so a test that records must never
// reach the host's real TIS helper: it could switch the developer's own input
// method. Every recording fixture points CUEKEEPER_IME at this stub instead.

export const ABC_SOURCE = { id: 'com.apple.keylayout.ABC', name: 'ABC', ascii: true, selectable: true };
export const US_SOURCE = { id: 'com.apple.keylayout.US', name: 'U.S.', ascii: true, selectable: true };
export const SOGOU_SOURCE = {
  id: 'com.sogou.inputmethod.sogou.pinyin', name: '搜狗拼音', ascii: false, selectable: true,
};

/**
 * A stub TIS helper with its own state file. `select` changes the current
 * source, so a test can prove a recording switched and later restored it.
 * `calls` returns every command the CLI sent, in order.
 */
export function imeStub(dir, { current = ABC_SOURCE, sources = [ABC_SOURCE, US_SOURCE, SOGOU_SOURCE] } = {}) {
  const helper = join(dir, 'cuekeeper-ime');
  const log = join(dir, 'ime-calls.log');
  const state = join(dir, 'ime-state.json');
  writeFileSync(log, '');
  writeFileSync(state, JSON.stringify(current));
  writeFileSync(helper, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [command, ...args] = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify([command, ...args]) + '\\n');
const sources = ${JSON.stringify(sources)};
const reply = data => console.log(JSON.stringify({ ok: true, data }));
const current = () => JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8'));
if (command === 'version') reply({ helper: 'cuekeeper-ime', version: 1 });
else if (command === 'list') reply({ sources });
else if (command === 'current') reply({ source: current() });
else if (command === 'select') {
  const index = args.indexOf('--id');
  const source = sources.find(item => item.id === args[index + 1]);
  if (!source) {
    console.log(JSON.stringify({ ok: false, error: { code: 'INPUT_ERROR', message: 'missing input source' } }));
    process.exit(1);
  }
  writeFileSync(${JSON.stringify(state)}, JSON.stringify(source));
  reply({ source });
} else {
  console.log(JSON.stringify({ ok: false, error: { code: 'INPUT_ERROR', message: 'unknown command' } }));
  process.exit(1);
}
`, { mode: 0o700 });
  return {
    helper,
    log,
    /** Every helper call, as `[command, ...args]`. */
    calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    /** The source IDs the CLI selected, in order. */
    selects: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).filter(call => call[0] === 'select').map(call => call[2]),
    current: () => JSON.parse(readFileSync(state, 'utf8')),
  };
}
