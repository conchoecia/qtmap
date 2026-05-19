import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseContigs } from '../src/contigs-codec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

test('parseContigs reads synth.fa contigs.bin', () => {
  const buf = readFileSync(
    join(REPO_ROOT, 'fixtures', 'synthetic', 'index-out-1', 'contigs.bin'),
  );
  const contigs = parseContigs(buf);
  assert.equal(contigs.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.equal(contigs[i].name, `chr${i + 1}`);
    assert.equal(contigs[i].length, 250000);
  }
});
