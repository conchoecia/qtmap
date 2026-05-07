/**
 * @fileoverview Shard request planner.
 *
 * The browser controller worker collects query minimizers across a batch of
 * reads, then asks the planner to bucket them by shard ID. Each bucket is
 * dispatched to a shard worker that owns the corresponding seed-shard-NNNN
 * file.
 *
 * Sharding rule (must match the C builder in src/cli/index_build.c): the
 * shard ID is the LOW `shardBits` of the 64-bit minimizer hash. We use low
 * bits because mm_hash64_v1 is masked to 2k bits, leaving the high bits
 * zero for k<32 — only the low bits give a uniform distribution.
 */

/**
 * Compute the shard ID for a hash, given `shardBits` from `reference.json`.
 *
 * @param {bigint} hash
 * @param {number} shardBits
 * @returns {number}
 */
export function shardIdForHash(hash, shardBits) {
  if (shardBits < 1 || shardBits > 30) {
    throw new RangeError(`shardBits out of range: ${shardBits}`);
  }
  const mask = (1n << BigInt(shardBits)) - 1n;
  return Number(hash & mask);
}

/**
 * Group an iterable of (readIdx, qPos, strand, hash) records into buckets,
 * one per shard ID.
 *
 * Output bucket structure is intentionally array-of-typed-array friendly so
 * we can transfer them to shard workers without expensive serialization
 * later. For now we return plain arrays; promote to typed arrays once we
 * benchmark the postMessage cost.
 *
 * @param {Iterable<{readIdx: number, qPos: number, qStrand: number, hash: bigint}>} queries
 * @param {number} shardBits
 * @returns {Map<number, Array<{readIdx: number, qPos: number, qStrand: number, hash: bigint}>>}
 */
export function planShardBuckets(queries, shardBits) {
  const buckets = new Map();
  for (const q of queries) {
    const sid = shardIdForHash(q.hash, shardBits);
    let bucket = buckets.get(sid);
    if (!bucket) {
      bucket = [];
      buckets.set(sid, bucket);
    }
    bucket.push(q);
  }
  return buckets;
}

/**
 * Distribute shard buckets across `workerCount` workers. Round-robin by
 * shard ID, biased so each worker tends to own a contiguous range (better
 * for OPFS sync handle caching).
 *
 * @param {Iterable<number>} shardIds
 * @param {number} workerCount  must be >= 1
 * @returns {number[]}  index `i` is the worker that owns shard `i`
 */
export function assignShardsToWorkers(shardIds, workerCount) {
  if (workerCount < 1) throw new RangeError('workerCount must be >= 1');
  const ids = [...shardIds].sort((a, b) => a - b);
  const out = new Array(ids.length === 0 ? 0 : ids[ids.length - 1] + 1).fill(-1);
  // Contiguous range partition rather than round-robin.
  const perWorker = Math.ceil(ids.length / workerCount);
  for (let i = 0; i < ids.length; ++i) {
    const worker = Math.min(workerCount - 1, Math.floor(i / perWorker));
    out[ids[i]] = worker;
  }
  return out;
}
