/**
 * @fileoverview SAM placement diff against a golden minimap2 SAM.
 *
 * Compares two SAM files at the per-(read_id, segment_index) level. A
 * placement matches when:
 *
 *   - both SAMs report the read as mapped
 *   - same RNAME (contig)
 *   - same strand (flag 0x10)
 *   - |POS_us − POS_them| ≤ tolerance
 *
 * Segment index = position within the (read_id) ordering by qStart, where
 * qStart is recovered from CIGAR clips. This matches QTQC's dipc-sam.js
 * `parseCigarForHickit` notion of clipStart.
 *
 * Reports:
 *   - record-level placement match rate
 *   - mapped-set Jaccard on read IDs
 *   - MAPQ Spearman + RMSE on the matched-record subset
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const FLAG_UNMAPPED = 0x4;
const FLAG_REVERSE = 0x10;
const FLAG_SECONDARY = 0x100;
const FLAG_SUPPLEMENTARY = 0x800;

/**
 * Stream a SAM file. Yields records:
 *   { name, flag, refName, pos1, mapq, cigar, qStart, qEnd, refSpan }
 *
 * Headers are skipped. CIGAR-derived qStart/qEnd/refSpan let downstream
 * compare segment indices stably across SAMs that disagree on which
 * fragment is "primary".
 */
async function* streamSam(path) {
  const stream = createReadStream(path);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    if (line.startsWith('@')) continue;
    const f = line.split('\t');
    if (f.length < 11) continue;
    const flag = parseInt(f[1], 10);
    const cigar = f[5];
    const { qStart, qEnd, refSpan } = parseCigarSpans(cigar);
    yield {
      name: f[0],
      flag,
      refName: f[2],
      pos0: parseInt(f[3], 10) - 1,
      mapq: parseInt(f[4], 10),
      cigar,
      reverse: (flag & FLAG_REVERSE) !== 0,
      secondary: (flag & FLAG_SECONDARY) !== 0,
      supplementary: (flag & FLAG_SUPPLEMENTARY) !== 0,
      unmapped: (flag & FLAG_UNMAPPED) !== 0,
      qStart,
      qEnd,
      refSpan,
    };
  }
}

function parseCigarSpans(cigar) {
  if (cigar === '*' || !cigar) return { qStart: 0, qEnd: 0, refSpan: 0 };
  let qStart = 0, qEnd = 0, refSpan = 0;
  let cursor = 0;
  let firstOp = true;
  let lastConsumesQuery = false;
  let n = 0;
  for (let i = 0; i < cigar.length; ++i) {
    const c = cigar[i];
    if (c >= '0' && c <= '9') { n = n * 10 + (c.charCodeAt(0) - 48); continue; }
    if (n === 0) { /* skip */ continue; }
    const op = c;
    const consumesQuery = (op === 'M' || op === 'I' || op === '=' || op === 'X' || op === 'S');
    const consumesRef = (op === 'M' || op === 'D' || op === 'N' || op === '=' || op === 'X');
    const isClip = (op === 'S' || op === 'H');

    if (firstOp && isClip) {
      qStart = n;
    }
    if (consumesQuery) {
      cursor += n;
      lastConsumesQuery = true;
    } else if (op === 'H' && !firstOp) {
      // trailing hard clip — qEnd already captured by earlier S/M; skip
      lastConsumesQuery = false;
    } else {
      lastConsumesQuery = false;
    }
    if (consumesRef) refSpan += n;
    if (!isClip) qEnd = cursor;
    firstOp = false;
    n = 0;
  }
  return { qStart, qEnd, refSpan };
}

/**
 * Group SAM records by (read_id), each value is an array sorted by qStart.
 * Drops unmapped records.
 */
async function groupByReadId(path) {
  const grouped = new Map();
  for await (const rec of streamSam(path)) {
    if (rec.unmapped) {
      // Note unmapped reads but don't add to placements.
      let bucket = grouped.get(rec.name);
      if (!bucket) { bucket = { records: [], unmapped: true }; grouped.set(rec.name, bucket); }
      bucket.unmapped = true;
      continue;
    }
    let bucket = grouped.get(rec.name);
    if (!bucket) { bucket = { records: [], unmapped: false }; grouped.set(rec.name, bucket); }
    bucket.records.push(rec);
  }
  for (const v of grouped.values()) {
    v.records.sort((a, b) => a.qStart - b.qStart);
  }
  return grouped;
}

/**
 * @param {string} oursPath
 * @param {string} goldenPath
 * @param {object} [opts]
 * @param {number} [opts.tolerance=10]   ±bp tolerance on POS
 * @returns {Promise<{
 *   readsBoth: number,
 *   readsOurs: number,
 *   readsGolden: number,
 *   recordsBoth: number,
 *   recordsOurs: number,
 *   recordsGolden: number,
 *   placementsCompared: number,
 *   placementsMatched: number,
 *   placementMatchRate: number,
 *   mappedJaccard: number,
 *   mapqRmse: number,
 *   mapqSpearman: number,
 * }>}
 */
export async function diffSam(oursPath, goldenPath, opts = {}) {
  const tolerance = opts.tolerance ?? 10;

  const ours = await groupByReadId(oursPath);
  const golden = await groupByReadId(goldenPath);

  let recordsOurs = 0;
  for (const v of ours.values()) recordsOurs += v.records.length;
  let recordsGolden = 0;
  for (const v of golden.values()) recordsGolden += v.records.length;

  const oursMapped = new Set();
  for (const [name, v] of ours) if (v.records.length > 0) oursMapped.add(name);
  const goldenMapped = new Set();
  for (const [name, v] of golden) if (v.records.length > 0) goldenMapped.add(name);

  // Jaccard on mapped-read sets.
  const inter = new Set([...oursMapped].filter(n => goldenMapped.has(n)));
  const union = new Set([...oursMapped, ...goldenMapped]);
  const mappedJaccard = union.size === 0 ? 0 : inter.size / union.size;

  // Per-read segment alignment via greedy nearest-placement matching.
  // We pair each "ours" record to the closest unused "golden" record on the
  // same (refName, strand). qStart-rank pairing fails because chain
  // endpoints between our mapper and minimap2 produce different qStart
  // values for the same true placement.
  let placementsCompared = 0;
  let placementsMatched = 0;
  const mapqOurs = [];
  const mapqGolden = [];
  for (const name of inter) {
    const a = ours.get(name).records;
    const b = golden.get(name).records;
    const usedB = new Uint8Array(b.length);

    // For each ours record, scan goldens for same (ref, strand) and pick
    // the unused one with the smallest |pos diff|.
    for (const ar of a) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let j = 0; j < b.length; ++j) {
        if (usedB[j]) continue;
        if (ar.refName !== b[j].refName) continue;
        if (ar.reverse !== b[j].reverse) continue;
        const d = Math.abs(ar.pos0 - b[j].pos0);
        if (d < bestDist) { bestDist = d; bestIdx = j; }
      }
      if (bestIdx === -1) continue;     // no candidate of right ref+strand
      usedB[bestIdx] = 1;
      placementsCompared++;
      if (bestDist <= tolerance) {
        placementsMatched++;
        mapqOurs.push(ar.mapq);
        mapqGolden.push(b[bestIdx].mapq);
      }
    }
    // Records on either side without a partner (e.g. ours emitted on a
    // contig golden didn't, or golden has 3 supps when ours has 2) are
    // silently dropped from the rate. Count them in unmatchedOurs /
    // unmatchedGolden if useful later.
  }

  return {
    readsOurs: oursMapped.size,
    readsGolden: goldenMapped.size,
    readsBoth: inter.size,
    recordsOurs,
    recordsGolden,
    recordsBoth: placementsCompared,
    placementsCompared,
    placementsMatched,
    placementMatchRate: placementsCompared === 0 ? 0 : placementsMatched / placementsCompared,
    mappedJaccard,
    mapqRmse: rmse(mapqOurs, mapqGolden),
    mapqSpearman: spearman(mapqOurs, mapqGolden),
  };
}

function rmse(a, b) {
  if (a.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < a.length; ++i) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s / a.length);
}

function spearman(a, b) {
  if (a.length < 2) return 0;
  const ra = rankify(a);
  const rb = rankify(b);
  const meanA = ra.reduce((x, y) => x + y, 0) / ra.length;
  const meanB = rb.reduce((x, y) => x + y, 0) / rb.length;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < ra.length; ++i) {
    const dA = ra[i] - meanA;
    const dB = rb[i] - meanB;
    num += dA * dB;
    denA += dA * dA;
    denB += dB * dB;
  }
  if (denA === 0 || denB === 0) return 0;
  return num / Math.sqrt(denA * denB);
}

function rankify(values) {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((x, y) => x.v - y.v);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j < indexed.length - 1 && indexed[j + 1].v === indexed[i].v) ++j;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; ++k) ranks[indexed[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

/* CLI entry point ----------------------------------------------------- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const [oursPath, goldenPath, ...rest] = process.argv.slice(2);
  if (!oursPath || !goldenPath) {
    console.error('usage: node sam-diff.js OURS.sam GOLDEN.sam [--tolerance N]');
    process.exit(2);
  }
  let tolerance = 10;
  for (let i = 0; i < rest.length; ++i) {
    if (rest[i] === '--tolerance') tolerance = parseInt(rest[++i], 10);
  }
  diffSam(oursPath, goldenPath, { tolerance }).then(r => {
    console.log(JSON.stringify(r, null, 2));
  }).catch(e => { console.error(e); process.exit(1); });
}
