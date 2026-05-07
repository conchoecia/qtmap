/**
 * @fileoverview Base-level chain-endpoint refinement.
 *
 * Without base-level alignment our chain endpoint is the leftmost /
 * rightmost minimizer's first / last base. minimap2 -a runs ksw-based
 * extension into the soft-clip region and reports endpoints a few bp
 * earlier / later than the seed positions, which is why our placement
 * match rate at ±10 bp caps around 90 % even with the static windowExt
 * push from chain.js.
 *
 * This module does cheap base-level extension. For each chain end it
 * walks one base at a time into the unaligned flank, compares the read
 * base to the reference base, and grows the chain as long as the
 * sliding-window match rate stays above a threshold. Strand is handled:
 *
 *   - jointStrand 0 (forward): read[qStart-1] should match ref[refStart-1].
 *     Extending the read LEFT corresponds to extending the reference LEFT.
 *
 *   - jointStrand 1 (reverse): read maps to RC(ref). Extending the read
 *     LEFT corresponds to extending the reference RIGHT (refEnd grows).
 *     The read base at qStart-1 must match the complement of ref[refEnd].
 *
 * Both ends of the chain are refined symmetrically.
 *
 * The caller supplies a `getRefBases(contigId, start, end) -> string`
 * function. In Node tests this reads sequence.bin into RAM and decodes
 * via sequence-codec.decodeBases. In the browser it goes through OPFS.
 */

const COMPLEMENT = { A: 'T', T: 'A', C: 'G', G: 'C', N: 'N' };

/**
 * Refine a chain's endpoints in-place using base-level comparison.
 *
 * @param {object} chain                       chain record from chainAnchors
 * @param {string} readSeq                     full read sequence (forward strand of FASTQ)
 * @param {(contigId:number, start:number, end:number) => string} getRefBases
 * @param {number} contigLength                length of the contig in bp
 * @param {object} [opts]
 * @param {number} [opts.maxExt=40]            max bp to extend per side
 * @param {number} [opts.windowSize=10]        sliding window over which to compute match rate
 * @param {number} [opts.minMatchRate=0.6]     stop extending when window match rate falls below this
 * @returns {void}                             chain.qStart/qEnd/refStart/refEnd are updated
 */
export function refineChainEndpoints(
  chain, readSeq, getRefBases, contigLength,
  opts = {},
) {
  const maxExt = opts.maxExt ?? 40;
  const windowSize = opts.windowSize ?? 10;
  const minMatchRate = opts.minMatchRate ?? 0.6;

  if (chain.jointStrand === 0) {
    refineForwardLeft(chain, readSeq, getRefBases, contigLength, maxExt, windowSize, minMatchRate);
    refineForwardRight(chain, readSeq, getRefBases, contigLength, maxExt, windowSize, minMatchRate);
  } else {
    refineReverseLeft(chain, readSeq, getRefBases, contigLength, maxExt, windowSize, minMatchRate);
    refineReverseRight(chain, readSeq, getRefBases, contigLength, maxExt, windowSize, minMatchRate);
  }
}

/* ------------------------------------------------------------------ */
/* Forward (jointStrand = 0): read[qStart-i-1] should match ref[refStart-i-1] */

function refineForwardLeft(c, readSeq, getRefBases, contigLength, maxExt, win, minRate) {
  const startQ = c.qStart;
  const startR = c.refStart;
  const cap = Math.min(maxExt, startQ, startR);
  if (cap <= 0) return;

  const refBlock = getRefBases(c.contigId, startR - cap, startR);
  if (!refBlock || refBlock.length !== cap) return;

  // Walk inward from the alignment edge: position 0 is the base just left
  // of (qStart-1, refStart-1); positions 1..cap-1 deeper into the soft clip.
  // Build a match array from outermost to innermost (oldest first).
  const matches = new Array(cap);
  for (let i = 0; i < cap; ++i) {
    // refBlock[cap-1-i] is the base at refStart-1-i
    const refBase = refBlock.charAt(cap - 1 - i).toUpperCase();
    const readBase = readSeq.charAt(startQ - 1 - i).toUpperCase();
    matches[i] = (readBase === refBase) ? 1 : 0;
  }

  // Find the deepest extension where the trailing window stays above minRate.
  let extLen = 0;
  let windowSum = 0;
  for (let i = 0; i < cap; ++i) {
    windowSum += matches[i];
    if (i >= win) windowSum -= matches[i - win];
    const denom = Math.min(i + 1, win);
    if (windowSum / denom < minRate) break;
    extLen = i + 1;
  }
  if (extLen > 0) {
    c.qStart = startQ - extLen;
    c.refStart = startR - extLen;
  }
}

function refineForwardRight(c, readSeq, getRefBases, contigLength, maxExt, win, minRate) {
  const cap = Math.min(maxExt, readSeq.length - c.qEnd, contigLength - c.refEnd);
  if (cap <= 0) return;

  const refBlock = getRefBases(c.contigId, c.refEnd, c.refEnd + cap);
  if (!refBlock || refBlock.length !== cap) return;

  const matches = new Array(cap);
  for (let i = 0; i < cap; ++i) {
    const refBase = refBlock.charAt(i).toUpperCase();
    const readBase = readSeq.charAt(c.qEnd + i).toUpperCase();
    matches[i] = (readBase === refBase) ? 1 : 0;
  }

  let extLen = 0;
  let windowSum = 0;
  for (let i = 0; i < cap; ++i) {
    windowSum += matches[i];
    if (i >= win) windowSum -= matches[i - win];
    const denom = Math.min(i + 1, win);
    if (windowSum / denom < minRate) break;
    extLen = i + 1;
  }
  if (extLen > 0) {
    c.qEnd += extLen;
    c.refEnd += extLen;
  }
}

/* ------------------------------------------------------------------ */
/* Reverse (jointStrand = 1):
 *   read[qStart-1] should match COMPLEMENT(ref[refEnd])
 *   read[qEnd]     should match COMPLEMENT(ref[refStart-1])
 *
 * Extending the read's LEFT softclip (qStart smaller) grows refEnd.
 * Extending the read's RIGHT softclip (qEnd larger) shrinks refStart.
 */

function refineReverseLeft(c, readSeq, getRefBases, contigLength, maxExt, win, minRate) {
  const cap = Math.min(maxExt, c.qStart, contigLength - c.refEnd);
  if (cap <= 0) return;

  const refBlock = getRefBases(c.contigId, c.refEnd, c.refEnd + cap);
  if (!refBlock || refBlock.length !== cap) return;

  const matches = new Array(cap);
  for (let i = 0; i < cap; ++i) {
    const refBase = refBlock.charAt(i).toUpperCase();
    const readBase = readSeq.charAt(c.qStart - 1 - i).toUpperCase();
    const compRef = COMPLEMENT[refBase] || 'N';
    matches[i] = (readBase === compRef) ? 1 : 0;
  }

  let extLen = 0;
  let windowSum = 0;
  for (let i = 0; i < cap; ++i) {
    windowSum += matches[i];
    if (i >= win) windowSum -= matches[i - win];
    const denom = Math.min(i + 1, win);
    if (windowSum / denom < minRate) break;
    extLen = i + 1;
  }
  if (extLen > 0) {
    c.qStart -= extLen;
    c.refEnd += extLen;
  }
}

function refineReverseRight(c, readSeq, getRefBases, contigLength, maxExt, win, minRate) {
  const cap = Math.min(maxExt, readSeq.length - c.qEnd, c.refStart);
  if (cap <= 0) return;

  const refBlock = getRefBases(c.contigId, c.refStart - cap, c.refStart);
  if (!refBlock || refBlock.length !== cap) return;

  const matches = new Array(cap);
  for (let i = 0; i < cap; ++i) {
    // refBlock[cap-1-i] is the base at refStart-1-i
    const refBase = refBlock.charAt(cap - 1 - i).toUpperCase();
    const readBase = readSeq.charAt(c.qEnd + i).toUpperCase();
    const compRef = COMPLEMENT[refBase] || 'N';
    matches[i] = (readBase === compRef) ? 1 : 0;
  }

  let extLen = 0;
  let windowSum = 0;
  for (let i = 0; i < cap; ++i) {
    windowSum += matches[i];
    if (i >= win) windowSum -= matches[i - win];
    const denom = Math.min(i + 1, win);
    if (windowSum / denom < minRate) break;
    extLen = i + 1;
  }
  if (extLen > 0) {
    c.qEnd += extLen;
    c.refStart -= extLen;
  }
}
