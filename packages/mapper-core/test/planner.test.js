import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shardIdForHash,
  planShardBuckets,
  assignShardsToWorkers,
} from '../src/planner.js';

test('shardIdForHash uses LOW bits, not high', () => {
  // mm_hash64_v1 masks to 2k bits. For k=15 that's 30 bits, so high bits
  // are zero. A naive `>> 60` partition would put everything in shard 0.
  // Verify low-bits gives uniform distribution.
  const shardBits = 4;
  const counts = new Array(16).fill(0);
  for (let i = 0; i < 16000; ++i) {
    // simulate a 30-bit-masked hash
    const h = BigInt(Math.floor(Math.random() * (1 << 30)));
    counts[shardIdForHash(h, shardBits)]++;
  }
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  // Loose uniformity check: every shard should be at least 50% of mean.
  const mean = 16000 / 16;
  assert.ok(min > mean * 0.5, `shard distribution too skewed: min=${min}`);
  assert.ok(max < mean * 1.5, `shard distribution too skewed: max=${max}`);
});

test('planShardBuckets groups queries by shard', () => {
  const shardBits = 3;  // 8 shards
  const queries = [
    { readIdx: 0, qPos: 0,  qStrand: 0, hash: 0x10n }, // shard 0
    { readIdx: 0, qPos: 5,  qStrand: 0, hash: 0x11n }, // shard 1
    { readIdx: 1, qPos: 0,  qStrand: 0, hash: 0x21n }, // shard 1
    { readIdx: 2, qPos: 0,  qStrand: 1, hash: 0x37n }, // shard 7
  ];
  const buckets = planShardBuckets(queries, shardBits);
  assert.equal(buckets.size, 3);
  assert.equal(buckets.get(0).length, 1);
  assert.equal(buckets.get(1).length, 2);
  assert.equal(buckets.get(7).length, 1);
});

test('assignShardsToWorkers uses contiguous ranges', () => {
  const ids = [0, 1, 2, 3, 4, 5, 6, 7];
  const assignment = assignShardsToWorkers(ids, 4);
  // 8 shards, 4 workers, perWorker=2 → workers 0,0,1,1,2,2,3,3
  assert.deepEqual(assignment, [0, 0, 1, 1, 2, 2, 3, 3]);
});

test('shardIdForHash bounds check', () => {
  assert.throws(() => shardIdForHash(0n, 0));
  assert.throws(() => shardIdForHash(0n, 31));
});
