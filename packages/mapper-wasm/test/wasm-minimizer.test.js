import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSeedCore } from '../src/bindings.js';
import {
  parseShard,
  decodeHit,
  HIT_RECORD_SIZE,
} from '../../mapper-core/src/shard-codec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const WASM_BIN = readFileSync(join(__dirname, '..', 'dist', 'seed_core.wasm'));

// In Node we have to pass the wasm bytes directly because the Emscripten
// module is built with -sENVIRONMENT=web,worker (no node fetch path).
async function load() {
  return loadSeedCore({ wasmBinary: WASM_BIN });
}

test('WASM hash function id matches C native', async () => {
  const core = await load();
  assert.equal(core.hashFunctionId(), 1);
});

test('WASM extractMinimizers produces deterministic output', async () => {
  const core = await load();
  const seq =
    'ACGTAGCATGCATGCATGCATGCATGCATGCAGCTAGCATCGTAGCTAGCATCGATCG' +
    'ACGCAGCTAGCATCGAGCAGCAGCAGGTACTAGCATCGATGCATGCATCGATGCATGC';
  const a = core.extractMinimizers(seq, 15, 10);
  const b = core.extractMinimizers(seq, 15, 10);
  assert.equal(a.length, b.length);
  assert.ok(a.length > 0, 'should produce minimizers');
  for (let i = 0; i < a.length; ++i) {
    assert.equal(a[i].hash, b[i].hash);
    assert.equal(a[i].pos, b[i].pos);
    assert.equal(a[i].strand, b[i].strand);
  }
});

test('WASM minimizer set matches C native CLI on synthetic FASTA', async () => {
  // Strategy: build a tiny FASTA, run qtmap-index against it (small
  // shard-bits so the binary fits one shard), then read back the shard's
  // hit table and compare every (contig, pos, strand) tuple to what the
  // WASM extractor produces directly on the same sequence.
  //
  // mm_hash64_v1 plus identical k/w means the two paths must produce
  // bit-identical seed sets; the only difference is where they end up
  // (shard hits vs plain array).
  const seq = 'A'.repeat(50) +
    'ACGTAGCATGCATGCATGCATGCATGCATGCAGCTAGCATCGTAGCTAGCATCGATCG' +
    'ACGCAGCTAGCATCGAGCAGCAGCAGGTACTAGCATCGATGCATGCATCGATGCATGC' +
    'TGAGCATGCAGCTAGCAGCAGCATGCAGCATGCATGCATGCATCGATCGTAGCATCGA';
  const tmp = mkdtempSync(join(tmpdir(), 'qtqc_wasm_'));
  try {
    const fastaPath = join(tmp, 'tiny.fa');
    const outDir = join(tmp, 'idx');
    writeFileSync(fastaPath, `>tiny\n${seq}\n`);
    mkdirSync(outDir);

    const cli = join(REPO_ROOT, 'build', 'packages', 'seed-core', 'qtmap-index');
    execFileSync(cli, [
      '--in', fastaPath,
      '--out', outDir,
      '--shard-bits', '4',
      '--reference-id', 'tiny',
      '--k', '15',
      '--w', '10',
    ], { stdio: 'pipe' });

    // Aggregate (pos, strand) tuples from every shard's hits.
    const cliHits = [];
    for (let s = 0; s < 16; ++s) {
      const path = join(outDir, `seed-shard-${String(s).padStart(4, '0')}.bin`);
      const buf = readFileSync(path);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const { header, hitsByteOffset } = parseShard(ab);
      for (let i = 0; i < Number(header.hitCount); ++i) {
        const off = hitsByteOffset + i * HIT_RECORD_SIZE;
        cliHits.push(decodeHit(ab, off));
      }
    }

    // WASM-side extraction.
    const core = await load();
    const wasmMinimizers = core.extractMinimizers(seq, 15, 10);

    // Compare by (pos, strand) as a multiset: each WASM minimizer must show
    // up as a hit in some shard. Hashes flow into shard IDs, so we don't
    // need to recompute shard IDs here; just check coverage.
    const wasmKey = wasmMinimizers
      .map(m => `${m.pos}|${m.strand}`)
      .sort();
    const cliKey = cliHits
      .map(h => `${h.pos}|${h.strand}`)
      .sort();
    assert.deepEqual(wasmKey, cliKey,
      `WASM and CLI minimizer sets disagree (wasm=${wasmKey.length}, cli=${cliKey.length})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
