import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  contigByteOffsets,
  decodeBases,
  decodeWindow,
} from '../src/sequence-codec.js';
import { parseContigs } from '../src/contigs-codec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

test('contigByteOffsets is the cumulative sum of ceil(length / 4)', () => {
  const offsets = contigByteOffsets([
    { length: 0 },     // 0 bytes
    { length: 1 },     // 1 byte
    { length: 4 },     // 1 byte
    { length: 5 },     // 2 bytes
    { length: 16 },    // 4 bytes
  ]);
  assert.deepEqual(offsets, [0, 0, 1, 2, 4]);
});

test('decodeBases round-trips through CLI --store-sequence', () => {
  // Build a tiny FASTA, run qtmap-index --store-sequence, decode bases,
  // verify they match the FASTA.
  const fasta = '>tiny\nAAGCCCAATAAACCACTCTGACTGGCCGAATAGGGATATAGGCAACGACATGTGCGGCGA\nACTGCAGCATCGATCGCTAGCATGCATGCATCGAATACGCATGCATCGATCGAATACGCG\n';
  const expected =
    'AAGCCCAATAAACCACTCTGACTGGCCGAATAGGGATATAGGCAACGACATGTGCGGCGA' +
    'ACTGCAGCATCGATCGCTAGCATGCATGCATCGAATACGCATGCATCGATCGAATACGCG';
  const tmp = mkdtempSync(join(tmpdir(), 'qtqc_seq_'));
  try {
    const fastaPath = join(tmp, 'tiny.fa');
    const outDir = join(tmp, 'idx');
    writeFileSync(fastaPath, fasta);
    mkdirSync(outDir);
    const cli = join(REPO_ROOT, 'build', 'packages', 'seed-core', 'qtmap-index');
    execFileSync(cli, [
      '--in', fastaPath, '--out', outDir,
      '--shard-bits', '4', '--reference-id', 'tiny',
      '--store-sequence',
    ], { stdio: 'pipe' });

    const contigsBuf = readFileSync(join(outDir, 'contigs.bin'));
    const contigs = parseContigs(contigsBuf);
    assert.equal(contigs.length, 1);
    assert.equal(contigs[0].length, expected.length);

    const seqBin = readFileSync(join(outDir, 'sequence.bin'));
    const offsets = contigByteOffsets(contigs);

    // Full read.
    const full = decodeBases(seqBin, offsets[0], contigs[0].length,
                             0, contigs[0].length);
    assert.equal(full, expected);

    // Windowed read at an offset that's not byte-aligned.
    const w = decodeWindow(seqBin, offsets[0], contigs[0].length, 17, 5);
    // center=17 halfWindow=5 -> [12, 22)
    assert.equal(w.start, 12);
    assert.equal(w.end, 22);
    assert.equal(w.seq, expected.slice(12, 22));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
