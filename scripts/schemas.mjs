import { readFile, writeFile } from 'node:fs/promises';
import { schemas } from '../dist/contracts.js';
import { schemasV2 } from '../dist/contracts-v2.js';
import { schemasWorkbench } from '../dist/contracts-workbench.js';

// Both contract generations are published. Version 1 keeps its existing paths
// and byte-identical files; version 2 adds versioned `-v2` filenames so an old
// reader never has to guess which contract a path carries.
const published = [
  ...Object.entries(schemas).map(([name, schema]) => [`${name}.schema.json`, `Cuekeeper ${name} v1`, schema]),
  ...Object.entries(schemasV2).map(([name, schema]) => [`${name}.schema.json`, `Cuekeeper ${name} v2`, schema]),
  ...Object.entries(schemasWorkbench).map(([name, schema]) => [`${name}.schema.json`, `Cuekeeper ${name} v2`, schema]),
];

for (const [file, title, schema] of published) {
  const path = new URL(`../schemas/${file}`, import.meta.url);
  const content = JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    title,
    ...schema,
  }, null, 2) + '\n';
  if (process.argv[2] === '--write') {
    await writeFile(path, content);
  } else if (await readFile(path, 'utf8') !== content) {
    throw new Error(`Schema drift: ${file}`);
  }
}
