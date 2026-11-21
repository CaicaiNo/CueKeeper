import { readFile, writeFile } from 'node:fs/promises';
import { schemas } from '../dist/contracts.js';

for (const [name, schema] of Object.entries(schemas)) {
  const path = new URL(`../schemas/${name}.schema.json`, import.meta.url);
  const content = JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: `Cuekeeper ${name} v1`,
    ...schema,
  }, null, 2) + '\n';
  if (process.argv[2] === '--write') {
    await writeFile(path, content);
  } else if (await readFile(path, 'utf8') !== content) {
    throw new Error(`Schema drift: ${name}.schema.json`);
  }
}
