import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR, generateFiles, readDataset, validateDataset } from '@planner/data';

for (const [path, content] of generateFiles()) {
  const target = join(DATA_DIR, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  console.log(`generate: wrote data/${path}`);
}

const problems = validateDataset(readDataset());
if (problems.length > 0) {
  console.error(`generate: dataset is invalid:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('generate: dataset valid');
