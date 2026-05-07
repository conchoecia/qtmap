import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSeedCore } from '../../mapper-wasm/src/bindings.js';
import {
  parseShard,
  findDirEntry,
  decodeHit,
  HEADER_SIZE,
  DIR_ENTRY_SIZE,
  HIT_RECORD_SIZE,
} from '../src/shard-codec.js';
import { mapReads } from '../src/map-reads.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const FIXTURE_DIR = join(REPO_ROOT, 'fixtures', 'synthetic', 'index-out-1');
const WASM_BIN = readFileSync(join(REPO_ROOT, 'packages', 'mapper-wasm', 'dist', 'seed_core.wasm'));

/**
 * Load synth.fa into per-contig records and parse all 16 shards into RAM.
 * Returns the artefacts mapReads() needs plus a contigSeq lookup so the
 * test can simulate reads cut from known reference positions.
 */
function loadFixture() {
  const fa = readFileSync(join(REPO_ROOT, 'fixtures', 'synthetic', 'synth.fa'), 'utf8');
  const contigSeqs = [];
  const contigs = [];
  let cur = null;
  for (const line of fa.split('\n')) {
    if (line.startsWith('>')) {
      if (cur) {
        contigSeqs.push(cur.seq);
        contigs.push({ name: cur.name, length: cur.seq.length });
      }
      cur = { name: line.slice(1).split(/\s+/)[0], seq: '' };
    } else if (cur) {
      cur.seq += line.toUpperCase().replace(/\s+/g, '');
    }
  }
  if (cur) {
    contigSeqs.push(cur.seq);
    contigs.push({ name: cur.name, length: cur.seq.length });
  }

  const ref = JSON.parse(readFileSync(join(FIXTURE_DIR, 'reference.json'), 'utf8'));
  const shards = [];
  for (let s = 0; s < ref.shards; ++s) {
    const path = join(FIXTURE_DIR, `seed-shard-${String(s).padStart(4, '0')}.bin`);
    const buf = readFileSync(path);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    shards.push(parseShard(ab));
  }

  return { contigs, contigSeqs, manifest: ref, shards };
}

test('end-to-end: 100 reads cut from synth.fa map back within ±10 bp', async () => {
  const { contigs, contigSeqs, manifest, shards } = loadFixture();
  const core = await loadSeedCore({ wasmBinary: WASM_BIN });

  // Cut 50 reads from contig0 forward, 50 from contig1 reverse-complemented.
  // Each read is 200 bp long; positions are spaced 100 bp apart.
  const reads = [];
  const truth = [];   // { contigId, refStart, refEnd, jointStrand }
  const mkRead = (contigId, refStart, len, rc) => {
    const rawSlice = contigSeqs[contigId].slice(refStart, refStart + len);
    const seq = rc ? reverseComplement(rawSlice) : rawSlice;
    const idx = reads.length;
    reads.push({ name: `r${idx}`, seq, qual: '!'.repeat(seq.length) });
    truth.push({ contigId, refStart, refEnd: refStart + len, jointStrand: rc ? 1 : 0 });
  };
  for (let i = 0; i < 50; ++i) mkRead(0, 100 + i * 150, 300, false);
  for (let i = 0; i < 50; ++i) mkRead(1, 100 + i * 150, 300, true);

  const lookupHits = (shardId, hashes) => {
    const shard = shards[shardId];
    const dirBytes = new Uint8Array(
      shard.hitsBuffer,
      HEADER_SIZE,
      shard.directory.length * DIR_ENTRY_SIZE,
    );
    const out = [];
    for (const h of hashes) {
      const e = findDirEntry(dirBytes, shard.directory.length, h);
      if (!e) { out.push([]); continue; }
      const hits = [];
      for (let i = 0; i < e.hitCount; ++i) {
        const off = shard.hitsByteOffset + (e.hitOffset + i) * HIT_RECORD_SIZE;
        const hit = decodeHit(shard.hitsBuffer, off);
        hits.push({
          contigId: hit.contigId,
          refPos: hit.pos,
          refStrand: hit.strand,
        });
      }
      out.push(hits);
    }
    return out;
  };

  const { sam, stats } = await mapReads({
    reads,
    contigs,
    referenceManifest: manifest,
    extractMinimizers: (seq) => core.extractMinimizers(seq, manifest.k, manifest.w),
    lookupHits: async (sid, hashes) => lookupHits(sid, hashes),
  });

  // Parse SAM body to recover primary placements per read.
  const bodyLines = sam.split('\n').filter(l => l && !l.startsWith('@'));
  const placementsByRead = new Map();
  for (const line of bodyLines) {
    const f = line.split('\t');
    const name = f[0];
    const flag = parseInt(f[1], 10);
    if (flag & 0x4) continue;                       // unmapped
    if (flag & 0x100) continue;                     // secondary
    if (flag & 0x800 && placementsByRead.has(name)) continue; // already have primary
    const refName = f[2];
    const pos1 = parseInt(f[3], 10);
    const reverse = (flag & 0x10) !== 0;
    if (!placementsByRead.has(name)) {
      placementsByRead.set(name, { refName, pos0: pos1 - 1, reverse });
    }
  }

  let placed = 0;
  let withinTolerance = 0;
  for (let i = 0; i < reads.length; ++i) {
    const got = placementsByRead.get(`r${i}`);
    if (!got) continue;
    placed++;
    const expectedRef = contigs[truth[i].contigId].name;
    const expectedPos = truth[i].refStart;
    const expectedStrand = truth[i].jointStrand;
    if (got.refName !== expectedRef) continue;
    if (Math.abs(got.pos0 - expectedPos) > 10) continue;
    if ((got.reverse ? 1 : 0) !== expectedStrand) continue;
    withinTolerance++;
  }

  // We expect a high pass rate. Tolerance 10 bp; some random sequences may
  // produce ambiguous placements.
  assert.ok(placed >= 95, `expected ≥95 reads placed, got ${placed}`);
  assert.ok(withinTolerance >= 90,
    `expected ≥90 reads within ±10 bp, got ${withinTolerance}`);

  // Sanity on stats.
  assert.equal(stats.readCount, 100);
  assert.ok(stats.mappedReads >= 95);
  assert.ok(stats.totalAnchors > 0);
});

function reverseComplement(seq) {
  const map = { A: 'T', T: 'A', C: 'G', G: 'C', N: 'N' };
  let out = '';
  for (let i = seq.length - 1; i >= 0; --i) out += map[seq[i]] || 'N';
  return out;
}
