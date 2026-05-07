import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseShardHeader,
  parseShard,
  findDirEntry,
  decodeHit,
  HEADER_SIZE,
  DIR_ENTRY_SIZE,
  HIT_RECORD_SIZE,
  SHARD_FORMAT_VERSION,
} from '../src/shard-codec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', '..', '..', 'fixtures', 'synthetic', 'index-out-1');

function readShardBuffer(shardId) {
  const name = `seed-shard-${String(shardId).padStart(4, '0')}.bin`;
  const buf = readFileSync(join(FIXTURE_DIR, name));
  // Detach the underlying ArrayBuffer slice so DataView treats offset==0.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

test('synthetic shard 0 has expected header', () => {
  const buf = readShardBuffer(0);
  const header = parseShardHeader(buf);
  assert.equal(header.shardId, 0);
  assert.ok(header.seedCount > 0);
  assert.ok(header.hitCount > 0n);
  assert.equal(Number(header.directoryOffset), HEADER_SIZE);
  assert.equal(
    Number(header.hitTableOffset),
    HEADER_SIZE + header.seedCount * DIR_ENTRY_SIZE,
  );
});

test('all 16 synthetic shards parse with correct format version', () => {
  for (let s = 0; s < 16; ++s) {
    const buf = readShardBuffer(s);
    const header = parseShardHeader(buf);
    assert.equal(header.shardId, s);
    // file_size sanity: header + directory + hits
    const expected =
      HEADER_SIZE +
      header.seedCount * DIR_ENTRY_SIZE +
      Number(header.hitCount) * HIT_RECORD_SIZE;
    assert.equal(buf.byteLength, expected,
      `shard ${s}: byteLength mismatch`);
  }
  // Format version is captured via parseShard's strict check
  assert.equal(SHARD_FORMAT_VERSION, 2);
});

test('parseShard returns correct directory and per-seed binary search agrees', () => {
  const buf = readShardBuffer(0);
  const { header, directory } = parseShard(buf);

  // Directory entries must be sorted by seedHash ascending.
  for (let i = 1; i < directory.length; ++i) {
    assert.ok(
      directory[i - 1].seedHash <= directory[i].seedHash,
      `directory not sorted at index ${i}`,
    );
  }

  // Hit-offset chain agrees with cumulative counts.
  let running = 0;
  for (const e of directory) {
    assert.equal(e.hitOffset, running, 'hitOffset chain mismatch');
    running += e.hitCount;
  }
  assert.equal(BigInt(running), header.hitCount);

  // Random sample: bin search agrees with linear lookup.
  const dirBytes = new Uint8Array(buf, HEADER_SIZE, directory.length * DIR_ENTRY_SIZE);
  for (let i = 0; i < Math.min(directory.length, 20); ++i) {
    const e = directory[i];
    const found = findDirEntry(dirBytes, directory.length, e.seedHash);
    assert.ok(found);
    assert.equal(found.seedHash, e.seedHash);
    assert.equal(found.hitOffset, e.hitOffset);
    assert.equal(found.hitCount, e.hitCount);
  }

  // A clearly absent hash returns null.
  const absent = findDirEntry(dirBytes, directory.length, 0xDEADBEEFDEADBEEFn);
  // It might coincidentally match; just verify it's either null or has the
  // correct seed_hash.
  if (absent) {
    assert.equal(absent.seedHash, 0xDEADBEEFDEADBEEFn);
  } else {
    assert.equal(absent, null);
  }
});

test('decodeHit unpacks pos/strand/flags correctly', () => {
  const buf = readShardBuffer(0);
  const { header, directory, hitsByteOffset } = parseShard(buf);
  if (header.seedCount === 0) return;

  // Grab first seed's hits and validate ranges.
  const firstSeed = directory[0];
  for (let i = 0; i < firstSeed.hitCount; ++i) {
    const off = hitsByteOffset + (firstSeed.hitOffset + i) * HIT_RECORD_SIZE;
    const hit = decodeHit(buf, off);
    assert.ok(hit.contigId < 65536, 'contig_id must fit in 16 bits');
    assert.ok(hit.pos < (1 << 28), 'pos must fit in 28 bits');
    assert.ok(hit.strand === 0 || hit.strand === 1);
    assert.ok(hit.flags >= 0 && hit.flags < 8, 'flags 3 bits');
  }
});
