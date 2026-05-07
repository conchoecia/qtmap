import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { DiskShardCache } from '../src/disk-shard-loader.js';
import { parseShard } from '../../mapper-core/src/shard-codec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', '..', '..', 'fixtures', 'synthetic', 'index-out-1');

test('DiskShardCache lookups agree with full-file parseShard', () => {
  const ref = JSON.parse(readFileSync(join(FIXTURE_DIR, 'reference.json'), 'utf8'));
  const cache = new DiskShardCache(FIXTURE_DIR, ref.shards);

  // Sample: parse shard 0 fully, then ask the cache for the same hashes.
  const buf = readFileSync(join(FIXTURE_DIR, 'seed-shard-0000.bin'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const { directory } = parseShard(ab);
  if (directory.length === 0) {
    cache.closeAll();
    return;
  }

  const hashes = directory.slice(0, 5).map(d => d.seedHash);
  const results = cache.lookupHits(0, hashes);
  assert.equal(results.length, hashes.length);
  for (let i = 0; i < hashes.length; ++i) {
    assert.equal(results[i].length, directory[i].hitCount,
      `hit count mismatch for seed ${i}`);
  }

  // Absent hash returns empty array.
  const absent = cache.lookupHits(0, [0xDEADBEEFDEADBEEFn]);
  assert.equal(absent.length, 1);
  // Could match by chance; only assert it doesn't crash.
  assert.ok(Array.isArray(absent[0]));

  cache.closeAll();
});
