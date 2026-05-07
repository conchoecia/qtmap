/**
 * @fileoverview Node-side mapper driver.
 *
 * Streams a FASTQ through @qtqc/mapper-core's mapReads orchestrator,
 * backed by a disk-resident shard index produced by qtqc-mm2-index.
 * Writes SAM body to a file or stdout.
 *
 * Usage:
 *   node packages/benchmark-runner/src/run-mapper.js \
 *     --reference /path/to/index/  \
 *     --reads     /path/to/reads.fastq \
 *     --out       /path/to/out.sam \
 *     [--batch 1000] [--secondary 0]
 */

import {
  createReadStream,
  readFileSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { mapReads } from '../../mapper-core/src/map-reads.js';
import { parseContigs } from '../../mapper-core/src/contigs-codec.js';
import { buildSamHeader } from '../../mapper-core/src/sam-emitter.js';
import { loadSeedCore } from '../../mapper-wasm/src/bindings.js';
import { DiskShardCache } from './disk-shard-loader.js';

const DEFAULT_BATCH = 1000;

function parseArgs(argv) {
  const out = { batch: DEFAULT_BATCH, secondary: 0 };
  for (let i = 0; i < argv.length; ++i) {
    const a = argv[i];
    if (a === '--reference') out.reference = argv[++i];
    else if (a === '--reads') out.reads = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--batch') out.batch = parseInt(argv[++i], 10);
    else if (a === '--secondary') out.secondary = parseInt(argv[++i], 10);
    else if (a === '--max-reads') out.maxReads = parseInt(argv[++i], 10);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.reference || !out.reads || !out.out) {
    throw new Error('required: --reference DIR --reads FASTQ --out SAM');
  }
  return out;
}

/**
 * Stream a FASTQ file in 4-line records. Yields { name, seq, qual }.
 * Stops at maxReads if specified.
 */
async function* streamFastq(path, maxReads) {
  const stream = createReadStream(path, { encoding: 'utf8' });
  let buffer = '';
  let count = 0;
  let lineState = 0;
  let cur = { name: '', seq: '', qual: '' };

  for await (const chunk of stream) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);

      switch (lineState) {
        case 0:
          if (!line.startsWith('@')) {
            throw new Error(`bad FASTQ header at record ${count}: ${line.slice(0, 40)}`);
          }
          cur.name = line.slice(1).split(/\s+/)[0];
          break;
        case 1:
          cur.seq = line;
          break;
        case 2:
          // separator '+'
          break;
        case 3:
          cur.qual = line;
          yield { name: cur.name, seq: cur.seq, qual: cur.qual };
          ++count;
          if (maxReads && count >= maxReads) return;
          cur = { name: '', seq: '', qual: '' };
          break;
      }
      lineState = (lineState + 1) % 4;
    }
  }
  // Final partial record (no trailing newline).
  if (buffer.length > 0 && lineState === 3) {
    cur.qual = buffer;
    yield { name: cur.name, seq: cur.seq, qual: cur.qual };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.error(`[run-mapper] reference: ${args.reference}`);
  console.error(`[run-mapper] reads:     ${args.reads}`);
  console.error(`[run-mapper] out:       ${args.out}`);
  console.error(`[run-mapper] batch:     ${args.batch}`);
  console.error(`[run-mapper] secondary: ${args.secondary}`);

  const ref = JSON.parse(readFileSync(join(args.reference, 'reference.json'), 'utf8'));
  const contigsBuf = readFileSync(join(args.reference, 'contigs.bin'));
  const contigs = parseContigs(contigsBuf);
  console.error(`[run-mapper] contigs:   ${contigs.length}`);
  console.error(`[run-mapper] shards:    ${ref.shards}`);
  console.error(`[run-mapper] k=${ref.k} w=${ref.w} shardBits=${ref.shardBits}`);

  const wasmBin = readFileSync(
    new URL('../../mapper-wasm/dist/seed_core.wasm', import.meta.url),
  );
  const core = await loadSeedCore({ wasmBinary: wasmBin });

  const cache = new DiskShardCache(args.reference, ref.shards);

  const out = openSync(args.out, 'w');

  // Header
  writeSync(out, buildSamHeader(contigs));

  let totalReads = 0;
  let totalMapped = 0;
  let totalAnchors = 0;
  let totalFragments = 0;
  let totalUnmapped = 0;

  const tStart = performance.now();
  let batch = [];
  for await (const read of streamFastq(args.reads, args.maxReads)) {
    batch.push(read);
    if (batch.length >= args.batch) {
      const r = await runBatch(batch, cache, core, contigs, ref, args.secondary);
      writeSync(out, r.body);
      totalReads += r.stats.readCount;
      totalMapped += r.stats.mappedReads;
      totalUnmapped += r.stats.unmappedReads;
      totalAnchors += r.stats.totalAnchors;
      totalFragments += r.stats.totalFragments;
      console.error(
        `[run-mapper] batch n=${batch.length} mapped=${r.stats.mappedReads} ` +
        `unmapped=${r.stats.unmappedReads} anchors=${r.stats.totalAnchors} ` +
        `(extract=${r.stats.timings.extractMs.toFixed(1)} ` +
        `lookup=${r.stats.timings.lookupMs.toFixed(1)} ` +
        `chain=${r.stats.timings.chainMs.toFixed(1)} ` +
        `emit=${r.stats.timings.emitMs.toFixed(1)} ` +
        `total=${r.stats.timings.totalMs.toFixed(1)}ms)`,
      );
      batch = [];
    }
  }
  if (batch.length > 0) {
    const r = await runBatch(batch, cache, core, contigs, ref, args.secondary);
    writeSync(out, r.body);
    totalReads += r.stats.readCount;
    totalMapped += r.stats.mappedReads;
    totalUnmapped += r.stats.unmappedReads;
    totalAnchors += r.stats.totalAnchors;
    totalFragments += r.stats.totalFragments;
  }

  closeSync(out);
  cache.closeAll();

  const wallMs = performance.now() - tStart;
  console.error('[run-mapper] DONE');
  console.error(`  reads:     ${totalReads}`);
  console.error(`  mapped:    ${totalMapped}`);
  console.error(`  unmapped:  ${totalUnmapped}`);
  console.error(`  anchors:   ${totalAnchors}`);
  console.error(`  fragments: ${totalFragments}`);
  console.error(`  wall:      ${(wallMs / 1000).toFixed(2)}s`);
  console.error(`  rps:       ${(totalReads / (wallMs / 1000)).toFixed(0)} reads/sec`);

  // Emit a JSON summary alongside the SAM file.
  const summaryPath = args.out + '.summary.json';
  writeFileSync(summaryPath, JSON.stringify({
    reads: totalReads,
    mapped: totalMapped,
    unmapped: totalUnmapped,
    anchors: totalAnchors,
    fragments: totalFragments,
    wallMs,
    rps: totalReads / (wallMs / 1000),
    reference: args.reference,
    referenceManifest: ref,
  }, null, 2));
  console.error(`[run-mapper] summary: ${summaryPath}`);
}

async function runBatch(batch, cache, core, contigs, ref, secondary) {
  const { sam, stats } = await mapReads({
    reads: batch,
    contigs,
    referenceManifest: ref,
    extractMinimizers: (seq) => core.extractMinimizers(seq, ref.k, ref.w),
    lookupHits: (sid, hashes) => cache.lookupHits(sid, hashes),
    options: { secondary, emitHeader: false },
  });
  return { body: sam, stats };
}

main().catch(e => {
  console.error('[run-mapper] FATAL:', e?.stack ?? e);
  process.exit(1);
});
