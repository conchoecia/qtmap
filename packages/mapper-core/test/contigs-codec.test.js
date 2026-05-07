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
  assert.equal(contigs.length, 2);
  assert.equal(contigs[0].name, 'contig1');
  assert.equal(contigs[1].name, 'contig2');
  assert.equal(contigs[0].length, 10000);
  assert.equal(contigs[1].length, 10000);
});
