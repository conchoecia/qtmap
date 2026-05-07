/**
 * @fileoverview Multi-fragment selection for Hi-C / Dip-C concatamer reads.
 *
 * Input: chains for one read, sorted by descending score (output of
 * chainAnchors).
 *
 * A concatamer read is a chain of ligated DNA fragments from different
 * genomic loci. Each fragment is one chain; selection produces a set of
 * non-overlapping query-span chains that together cover the read.
 *
 * Output records (one per emitted SAM line later):
 *   {
 *     readIdx, contigId, jointStrand,
 *     qStart, qEnd, refStart, refEnd,
 *     score, anchorCount, uniqueAnchors,
 *     fragmentIndex,             // 0 = primary fragment, 1..N supplementary
 *     samFlagBits,               // 0x10 / 0x800 / 0x100 (set later by emitter)
 *     mapqInputs: { f1, f2, m, repetitiveFraction },
 *     isPrimary, isSupplementary, isSecondary,
 *   }
 */

const QUERY_OVERLAP_TOLERANCE = 20;
const SECONDARY_QSPAN_OVERLAP = 0.8;

/**
 * Select fragment placements for one read from a list of candidate chains.
 *
 * @param {ReturnType<typeof import('./chain.js').chainAnchors>} chains
 * @param {object} [opts]
 * @param {number} [opts.secondary=0] keep up to N alternates per fragment as
 *   secondary records. 0 = match minimap2 -x map-ont default.
 * @param {number} [opts.overlapTolerance=20] qSpan overlap allowed
 *   between distinct fragments before treating one as a duplicate.
 * @returns {Array<{
 *   readIdx:number, contigId:number, jointStrand:number,
 *   qStart:number, qEnd:number, refStart:number, refEnd:number,
 *   score:number, anchorCount:number, uniqueAnchors:number,
 *   fragmentIndex:number,
 *   isPrimary:boolean, isSupplementary:boolean, isSecondary:boolean,
 *   altRank:number,
 *   mapqInputs:{f1:number,f2:number,m:number}
 * }>}
 */
export function selectFragments(chains, opts = {}) {
  const secondary = opts.secondary ?? 0;
  const tol = opts.overlapTolerance ?? QUERY_OVERLAP_TOLERANCE;

  if (chains.length === 0) return [];

  // Sort by descending score (defensive — chainAnchors already does this).
  const sorted = [...chains].sort((a, b) => b.score - a.score);

  // Step 1: greedy non-overlapping fragment picks by qSpan.
  const fragments = [];           // accepted fragments in selection order
  const usedRanges = [];          // accepted [qStart, qEnd] intervals
  const altsByFragment = new Map(); // fragmentIndex -> alternate chains

  for (const c of sorted) {
    const ovIdx = findOverlap(c, usedRanges, tol);
    if (ovIdx === -1) {
      // Accept as a new fragment.
      fragments.push(c);
      usedRanges.push({ qStart: c.qStart, qEnd: c.qEnd });
      altsByFragment.set(fragments.length - 1, []);
    } else {
      // Overlaps an existing fragment: candidate secondary alternate.
      const fragment = fragments[ovIdx];
      const ovFrac = qSpanOverlapFraction(c, fragment);
      if (ovFrac >= SECONDARY_QSPAN_OVERLAP) {
        altsByFragment.get(ovIdx).push(c);
      }
    }
  }

  // Step 2: identify primary = highest-score fragment overall.
  let primaryIdx = 0;
  for (let i = 1; i < fragments.length; ++i) {
    if (fragments[i].score > fragments[primaryIdx].score) primaryIdx = i;
  }

  // Step 3: emit records. Order: fragments by qStart ascending. Within
  // each fragment, primary/supplementary first then up to `secondary`
  // alternates.
  const fragmentOrder = fragments
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.qStart - b.f.qStart);

  const out = [];
  for (let oi = 0; oi < fragmentOrder.length; ++oi) {
    const { f, i } = fragmentOrder[oi];
    const isPrimary = (i === primaryIdx);
    const alts = altsByFragment.get(i) || [];
    const f2 = alts.length > 0 ? alts[0].score : 0;
    const m = f.uniqueAnchors;

    out.push({
      ...f,
      fragmentIndex: oi,
      isPrimary,
      isSupplementary: !isPrimary,
      isSecondary: false,
      altRank: 0,
      mapqInputs: { f1: f.score, f2, m },
    });

    for (let ai = 0; ai < Math.min(secondary, alts.length); ++ai) {
      const alt = alts[ai];
      out.push({
        ...alt,
        fragmentIndex: oi,
        isPrimary: false,
        isSupplementary: false,
        isSecondary: true,
        altRank: ai + 1,
        mapqInputs: {
          f1: alt.score,
          f2: ai + 1 < alts.length ? alts[ai + 1].score : 0,
          m: alt.uniqueAnchors,
        },
      });
    }
  }

  return out;
}

/**
 * Return the index in `usedRanges` whose interval overlaps the candidate by
 * more than `tol` bp on the query, or -1 if no overlap.
 */
function findOverlap(c, usedRanges, tol) {
  for (let i = 0; i < usedRanges.length; ++i) {
    const r = usedRanges[i];
    const ovStart = Math.max(c.qStart, r.qStart);
    const ovEnd = Math.min(c.qEnd, r.qEnd);
    if (ovEnd - ovStart > tol) return i;
  }
  return -1;
}

/** Fraction of `c.qSpan` covered by `r.qSpan`. */
function qSpanOverlapFraction(c, r) {
  const ovStart = Math.max(c.qStart, r.qStart);
  const ovEnd = Math.min(c.qEnd, r.qEnd);
  const ov = Math.max(0, ovEnd - ovStart);
  const cspan = Math.max(1, c.qEnd - c.qStart);
  return ov / cspan;
}
