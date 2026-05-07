/**
 * @fileoverview SAM → Hi-C contact diff against the QTQC dipc pipeline.
 *
 * Pipes both our SAM and the golden minimap2 SAM through QTQC's
 * `samToHickitSegText` + `hickitPairsFromFragments` to materialize the
 * actual contact pairs each mapper would produce, then reports the
 * per-pipeline counts plus a side-by-side diff at the contact level.
 *
 * Run:
 *   node packages/benchmark-runner/src/contacts-diff.js OURS.sam GOLD.sam
 */

import { readFileSync } from 'node:fs';

import {
  samToHickitSegText,
  parseSamForHickit,
} from '../../../../qtqc/src/qc/dipc-sam.js';
import {
  parseHickitSegText,
  hickitPairsFromFragments,
} from '../../../../qtqc/src/qc/dipc-pairs.js';

function pipeline(samPath, label, options = {}) {
  const sam = readFileSync(samPath, 'utf8');
  const parsed = parseSamForHickit(sam);
  const segOut = samToHickitSegText(sam, options);
  // `segOut.fragments` is already the structured fragment list; pass it
  // directly. (The earlier `parseHickitSegText(segOut.text)` re-parse call
  // was both unnecessary and wrong — segOut.segText is the field name.)
  const pairsOut = hickitPairsFromFragments(segOut.fragments);

  // Determine cis vs trans from segment chrom fields. dipc-pairs stores
  // segments with `chrom1`/`chrom2` derived via the chromOrder map, but
  // for raw counting we look at chr equivalence on the underlying segments.
  let cis = 0, trans = 0;
  for (const p of pairsOut.pairs) {
    if (p.chrom1 === p.chrom2) cis++;
    else trans++;
  }

  return {
    label,
    samBytes: sam.length,
    samRecords: parsed.totalSamRecords,
    samMapped: parsed.mappedSamRecords,
    fragmentsTotal: parsed.readOrder.length,
    fragmentsAfterFilter: segOut.stats.fragmentsWithSegments,
    fragmentsRejected: segOut.stats.fragmentsSkippedTooFewSegments + segOut.stats.fragmentsSkippedTooFewAlignments,
    alignmentsLowMapq: segOut.stats.alignmentsSkippedLowMapq,
    alignmentsBadCigar: segOut.stats.alignmentsSkippedInvalidCigar,
    emittedSegments: segOut.stats.emittedSegments,
    rawPairCount: pairsOut.rawPairCount,
    duplicateCount: pairsOut.duplicateCount,
    ignoredFragmentCount: pairsOut.ignoredFragmentCount,
    contactsTotal: pairsOut.pairs.length,
    contactsCis: cis,
    contactsTrans: trans,
  };
}

const [oursPath, goldPath] = process.argv.slice(2);
if (!oursPath || !goldPath) {
  console.error('usage: node contacts-diff.js OURS.sam GOLD.sam');
  process.exit(2);
}

const ours = pipeline(oursPath, 'OURS');
const gold = pipeline(goldPath, 'GOLD');

console.log('                              OURS         GOLD       diff      ratio');
console.log('  ─────────────────────────  ────────    ────────    ──────    ──────');
function row(label, getter) {
  const a = getter(ours), b = getter(gold);
  const diff = a - b;
  const ratio = b > 0 ? (a / b * 100).toFixed(1) + '%' : 'n/a';
  console.log(`  ${label.padEnd(25)}  ${String(a).padStart(8)}    ${String(b).padStart(8)}    ${(diff >= 0 ? '+' + diff : String(diff)).padStart(6)}    ${ratio.padStart(6)}`);
}
row('SAM records',         o => o.samRecords);
row('  mapped records',    o => o.samMapped);
row('Read fragments seen', o => o.fragmentsTotal);
row('  passed filter',     o => o.fragmentsAfterFilter);
row('  dropped',           o => o.fragmentsRejected);
row('  low MAPQ',          o => o.alignmentsLowMapq);
row('Emitted segments',    o => o.emittedSegments);
row('Raw pair count',      o => o.rawPairCount);
row('  duplicate-removed', o => o.duplicateCount);
row('  ignored fragments', o => o.ignoredFragmentCount);
row('Hi-C contact pairs',  o => o.contactsTotal);
row('  cis',               o => o.contactsCis);
row('  trans',             o => o.contactsTrans);
const cisFracO = ours.contactsTotal > 0 ? (ours.contactsCis / ours.contactsTotal * 100).toFixed(2) : '—';
const cisFracG = gold.contactsTotal > 0 ? (gold.contactsCis / gold.contactsTotal * 100).toFixed(2) : '—';
console.log(`  cis fraction:                 ${cisFracO}%       ${cisFracG}%`);
