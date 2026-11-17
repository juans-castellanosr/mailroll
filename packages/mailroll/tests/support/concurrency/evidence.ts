import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function recordEvidence(name: string, observed: unknown): void {
  const dir = process.env['REPRO_EVIDENCE_DIR'];

  if (dir === undefined || dir === '') {
    return;
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(observed, null, 2)}\n`);
}
