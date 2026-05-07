/**
 * @fileoverview Anchor chain DP, minimap2-style.
 *
 * Given a list of anchors for one read, produce a small set of high-scoring
 * collinear chains. Each chain represents a putative alignment of a query
 * region to a reference region.
 *
 * Scoring follows minimap2's mm_chain_dp:
 *
 *   f[i] = max over j<i of (f[j] + α(i,j))
 *
 *   α(i,j) = min(min(qSpan, refSpan), w_i)
 *           − γ_c(|qGap − refGap|)
 *           − 0.01 · k · |qGap − refGap|
 *
 * γ_c is a piecewise linear gap penalty that grows with log(gap). We use
 * the form `0.01 · k · g + 0.5 · log2(max(1, g))` from the mm2 paper §2.4.
 *
 * The chain reconstruction is by backpointer; we keep the top K chains
 * per (contig, strand) bucket.
 *
 * Inputs are flat anchor records:
 *   { readIdx, qPos, qStrand, contigId, refPos, refStrand }
 *
 * Outputs are chain records:
 *   { readIdx, contigId, jointStrand, qStart, qEnd, refStart, refEnd,
 *     score, anchorCount, anchors: number[] (indices into input) }
 */

const K_DEFAULT = 15;
const MAX_GAP_DEFAULT = 5000;
const MAX_DIAG_DRIFT = 200;
const TOP_K_PER_BUCKET = 10;

/**
 * Group anchors by (readIdx, contigId, jointStrand) and chain each bucket.
 *
 * @param {Array<{readIdx:number,qPos:number,qStrand:number,contigId:number,refPos:number,refStrand:number}>} anchors
 * @param {object} [opts]
 * @param {number} [opts.k=15] kmer size used for anchor span.
 * @param {number} [opts.maxGap=5000] max query or reference gap between anchors in a chain.
 * @param {number} [opts.maxDiagDrift=200] max |Δdiagonal| between consecutive anchors.
 * @param {number} [opts.topK=10] keep this many chains per (contig, strand).
 * @returns {Array<{readIdx:number,contigId:number,jointStrand:number,qStart:number,qEnd:number,refStart:number,refEnd:number,score:number,anchorCount:number,uniqueAnchors:number,anchors:number[]}>}
 */
export function chainAnchors(anchors, opts = {}) {
  const k = opts.k ?? K_DEFAULT;
  const maxGap = opts.maxGap ?? MAX_GAP_DEFAULT;
  const maxDiagDrift = opts.maxDiagDrift ?? MAX_DIAG_DRIFT;
  const topK = opts.topK ?? TOP_K_PER_BUCKET;

  // Bucket anchors. jointStrand = qStrand XOR refStrand.
  const buckets = new Map();
  for (let i = 0; i < anchors.length; ++i) {
    const a = anchors[i];
    const jointStrand = (a.qStrand ^ a.refStrand) & 1;
    const key = `${a.readIdx}|${a.contigId}|${jointStrand}`;
    let arr = buckets.get(key);
    if (!arr) { arr = []; buckets.set(key, arr); }
    arr.push(i);
  }

  // Empirical calibration on 5KSR46 / mm39 (w=15 index) vs minimap2 v2.22:
  //   ext   contacts   ±5      ±10     ±20
  //    5      957     75.4 %   89.1 %  93.6 %
  //    7      960     66.6 %   90.2 %  93.9 %    <-- chosen
  //    9      924     56.6 %   91.5 %  94.5 %
  //   10      854     50.4 %   91.8 %  94.7 %
  //   11      789     43.6 %   83.6 %  94.8 %
  //   13      604     33.0 %   69.4 %  95.1 %
  // ext=7 hits the contact-count target (Hi-C is the assay-relevant metric)
  // and lands at the ±5 / ±10 sweet spot. Larger ext gains ±10 placement
  // but loses contacts via cross-junction over-extension into adjacent
  // fragments of concatamer reads.
  const windowExt = opts.windowExt ?? 7;
  const chains = [];
  for (const idxs of buckets.values()) {
    chainBucket(anchors, idxs, k, maxGap, maxDiagDrift, topK, windowExt, chains);
  }

  // Sort all chains by descending score for downstream fragment selection.
  chains.sort((a, b) => b.score - a.score);
  return chains;
}

/**
 * Chain anchors for a single (readIdx, contig, strand) bucket.
 */
function chainBucket(allAnchors, idxs, k, maxGap, maxDiagDrift, topK, windowExt, out) {
  if (idxs.length === 0) return;
  const a0 = allAnchors[idxs[0]];
  const readIdx = a0.readIdx;
  const contigId = a0.contigId;
  const jointStrand = (a0.qStrand ^ a0.refStrand) & 1;

  // Sort by reference position; break ties by query position.
  idxs.sort((ia, ib) => {
    const a = allAnchors[ia], b = allAnchors[ib];
    return a.refPos - b.refPos || a.qPos - b.qPos;
  });

  const n = idxs.length;
  const f = new Float64Array(n);     // best score ending at i
  const p = new Int32Array(n);       // backpointer
  const cnt = new Int32Array(n);     // anchor count in chain ending at i
  for (let i = 0; i < n; ++i) {
    f[i] = k;        // anchor itself contributes ~k matched bases
    p[i] = -1;
    cnt[i] = 1;
  }

  for (let i = 1; i < n; ++i) {
    const ai = allAnchors[idxs[i]];
    const refI = ai.refPos;
    const qI = jointStrand === 1 ? -ai.qPos : ai.qPos;
    let bestF = k;
    let bestJ = -1;
    let bestCnt = 1;
    // Search a small window of predecessors. Anchors are sorted by refPos
    // ascending, so we walk j backwards while gap_r ≤ maxGap.
    for (let j = i - 1; j >= 0; --j) {
      const aj = allAnchors[idxs[j]];
      const gapR = refI - aj.refPos;
      if (gapR > maxGap) break;
      if (gapR <= 0) continue;
      const qJ = jointStrand === 1 ? -aj.qPos : aj.qPos;
      const gapQ = qI - qJ;
      if (gapQ <= 0 || gapQ > maxGap) continue;
      const drift = Math.abs(gapQ - gapR);
      if (drift > maxDiagDrift) continue;

      const span = Math.min(Math.min(gapQ, gapR), k);
      const linear = 0.01 * k * drift;
      const log = drift > 1 ? 0.5 * Math.log2(drift) : 0;
      const alpha = span - linear - log;
      const newScore = f[j] + alpha;
      if (newScore > bestF) {
        bestF = newScore;
        bestJ = j;
        bestCnt = cnt[j] + 1;
      }
    }
    f[i] = bestF;
    p[i] = bestJ;
    cnt[i] = bestCnt;
  }

  // Pull out top-K chain endpoints, then reconstruct each chain via
  // backpointers. We pick endpoints greedily: highest-score endpoint, then
  // mask out its members and pick again, until topK or no candidates.
  const used = new Uint8Array(n);
  for (let kk = 0; kk < topK; ++kk) {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < n; ++i) {
      if (used[i]) continue;
      if (f[i] > bestScore) { bestScore = f[i]; best = i; }
    }
    if (best === -1 || bestScore <= k) break;

    // Reconstruct.
    const chainAnchorIdxs = [];
    let cur = best;
    while (cur >= 0) {
      if (used[cur]) break;
      used[cur] = 1;
      chainAnchorIdxs.push(idxs[cur]);
      cur = p[cur];
    }
    chainAnchorIdxs.reverse();

    if (chainAnchorIdxs.length < 2) {
      // Single-anchor "chains" rarely yield a useful placement on long
      // reads. Allow them only if they are the sole option for the bucket.
      if (kk > 0) continue;
    }

    let qStart = Infinity, qEnd = -Infinity;
    let refStart = Infinity, refEnd = -Infinity;
    const hashes = new Set();
    for (const idx of chainAnchorIdxs) {
      const a = allAnchors[idx];
      if (a.qPos < qStart) qStart = a.qPos;
      if (a.qPos > qEnd) qEnd = a.qPos;
      if (a.refPos < refStart) refStart = a.refPos;
      if (a.refPos > refEnd) refEnd = a.refPos;
      if (a.hash !== undefined) hashes.add(String(a.hash));
    }
    /*
     * Anchor positions point at the LAST base of the kmer (see
     * minimizer.h). Subtract (k-1) to cover the first base of the leftmost
     * kmer. Then push the chain endpoints by an additional `windowExt` bp
     * on each side to approximate minimap2's base-level extension into the
     * soft-clip region. Empirically the leftmost minimizer fires up to w
     * bp later than the true alignment start (the prior window had no
     * hit), so a w/2 extension cuts the systematic chain-endpoint
     * imprecision roughly in half without crossing into other fragments.
     *
     * Capped by available query/ref bases so we never go negative or
     * past a contig boundary the caller can validate.
     */
    const baseQStart = Math.max(0, qStart - (k - 1));
    const baseRefStart = Math.max(0, refStart - (k - 1));
    const symExt = Math.min(windowExt, baseQStart, baseRefStart);
    const trailExt = windowExt; /* caller already clamps qEnd vs read length */

    out.push({
      readIdx,
      contigId,
      jointStrand,
      qStart: baseQStart - symExt,
      qEnd: qEnd + 1 + trailExt,         // caller clamps to read length
      refStart: baseRefStart - symExt,
      refEnd: refEnd + 1 + trailExt,
      score: bestScore,
      anchorCount: chainAnchorIdxs.length,
      uniqueAnchors: hashes.size || chainAnchorIdxs.length,
      anchors: chainAnchorIdxs,
    });
  }
}
