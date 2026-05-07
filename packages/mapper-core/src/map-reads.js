/**
 * @fileoverview End-to-end mapping orchestrator.
 *
 * Wires the steps:
 *   1. extract minimizers per read (caller supplies extractor callback)
 *   2. bucket query minimizers by shard ID (planner)
 *   3. fetch hit slices per shard (caller supplies shardLookup callback)
 *   4. chain anchors per read
 *   5. select fragments (Hi-C concatamer aware)
 *   6. emit SAM body lines
 *
 * The shard transport is callback-driven so this module works in three
 * contexts:
 *   - Node tests with shards loaded into RAM (fixtures/synthetic)
 *   - Browser smoke page with shards fetched over HTTP and parsed in-page
 *   - Browser production with shards in OPFS, dispatched via Web Workers
 *
 * Caller supplies:
 *   - `extractMinimizers(seq) -> Array<{hash:bigint,pos:number,strand:0|1}>`
 *   - `lookupHits(shardId, hashes) -> Promise<Array<{hash:bigint,contigId:number,refPos:number,refStrand:number}[]>>`
 *     Returns one entry per input hash (parallel array). Empty array means no hits.
 *
 * Caller passes `referenceManifest` parsed from reference.json plus
 * `contigs` (parsed contigs.bin) so the SAM emitter has reference names
 * and lengths.
 */

import { shardIdForHash } from './planner.js';
import { chainAnchors } from './chain.js';
import { selectFragments } from './fragment-select.js';
import { buildSamHeader, emitReadSamLines } from './sam-emitter.js';

/**
 * Map a batch of reads end to end and produce a SAM body.
 *
 * @param {object} args
 * @param {Array<{name:string,seq:string,qual?:string}>} args.reads
 * @param {Array<{name:string,length:number}>} args.contigs
 * @param {object} args.referenceManifest  parsed reference.json
 * @param {(seq:string)=>Array<{hash:bigint,pos:number,strand:number}>} args.extractMinimizers
 * @param {(shardId:number, hashes:bigint[])=>Promise<Array<{contigId:number,refPos:number,refStrand:number}>[]>} args.lookupHits
 * @param {object} [args.options]
 * @param {number} [args.options.k=15]
 * @param {number} [args.options.w=10]
 * @param {number} [args.options.secondary=0]
 * @param {boolean} [args.options.emitHeader=true]
 * @returns {Promise<{sam:string, stats:object}>}
 */
export async function mapReads({
  reads,
  contigs,
  referenceManifest,
  extractMinimizers,
  lookupHits,
  options = {},
}) {
  const k = options.k ?? referenceManifest.k ?? 15;
  const w = options.w ?? referenceManifest.w ?? 10;
  const secondary = options.secondary ?? 0;
  const shardBits = referenceManifest.shardBits;

  /* Step 1 + 2: extract minimizers and bucket by shard ID. */
  const queryByShard = new Map();      // shardId -> [{readIdx, qPos, qStrand, hash}]
  const t0 = performance.now();
  for (let readIdx = 0; readIdx < reads.length; ++readIdx) {
    const r = reads[readIdx];
    const mz = extractMinimizers(r.seq);
    for (const m of mz) {
      const sid = shardIdForHash(m.hash, shardBits);
      let bucket = queryByShard.get(sid);
      if (!bucket) { bucket = []; queryByShard.set(sid, bucket); }
      bucket.push({
        readIdx,
        qPos: m.pos,
        qStrand: m.strand,
        hash: m.hash,
      });
    }
  }
  const tExtract = performance.now() - t0;

  /* Step 3: per-shard lookup. Aggregates anchors per read. */
  const anchorsByRead = Array.from({ length: reads.length }, () => []);
  const t1 = performance.now();
  let totalAnchors = 0;
  let shardsTouched = 0;
  for (const [shardId, queries] of queryByShard) {
    ++shardsTouched;
    const hashes = queries.map(q => q.hash);
    const hitArrays = await lookupHits(shardId, hashes);
    for (let i = 0; i < queries.length; ++i) {
      const q = queries[i];
      const hits = hitArrays[i];
      if (!hits || hits.length === 0) continue;
      for (const h of hits) {
        anchorsByRead[q.readIdx].push({
          readIdx: q.readIdx,
          qPos: q.qPos,
          qStrand: q.qStrand,
          contigId: h.contigId,
          refPos: h.refPos,
          refStrand: h.refStrand,
          hash: q.hash,
        });
        ++totalAnchors;
      }
    }
  }
  const tLookup = performance.now() - t1;

  /* Step 4 + 5: chain + select per read. */
  const t2 = performance.now();
  const fragmentSets = [];
  let mappedReads = 0;
  let unmappedReads = 0;
  let totalFragments = 0;
  for (let readIdx = 0; readIdx < reads.length; ++readIdx) {
    const anchors = anchorsByRead[readIdx];
    if (anchors.length === 0) { unmappedReads++; fragmentSets.push([]); continue; }
    const chains = chainAnchors(anchors, { k });
    const records = selectFragments(chains, { secondary });
    fragmentSets.push(records);
    if (records.length > 0) {
      mappedReads++;
      totalFragments += records.filter(r => !r.isSecondary).length;
    } else {
      unmappedReads++;
    }
  }
  const tChain = performance.now() - t2;

  /* Step 6: SAM emission. */
  const t3 = performance.now();
  let sam = '';
  if (options.emitHeader !== false) {
    sam += buildSamHeader(contigs);
  }
  for (let readIdx = 0; readIdx < reads.length; ++readIdx) {
    sam += emitReadSamLines(reads[readIdx], fragmentSets[readIdx], contigs);
  }
  const tEmit = performance.now() - t3;

  return {
    sam,
    stats: {
      readCount: reads.length,
      mappedReads,
      unmappedReads,
      totalFragments,
      totalAnchors,
      shardsTouched,
      timings: {
        extractMs: tExtract,
        lookupMs: tLookup,
        chainMs: tChain,
        emitMs: tEmit,
        totalMs: performance.now() - t0,
      },
    },
  };
}
