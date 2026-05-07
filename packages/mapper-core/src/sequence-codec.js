/**
 * @fileoverview 2-bit packed reference sequence reader for sequence.bin.
 *
 * Layout (mirrors qtmap-index --store-sequence):
 *
 *   No header. Contigs are concatenated in declaration order. Each contig
 *   occupies ceil(length / 4) bytes. The byte offset for contig i is
 *
 *       Σ (ceil(contigs[j].length / 4)  for j < i)
 *
 *   Packing: ACGT → 0,1,2,3. Non-ACGT bases are packed as A. Within a byte
 *   base 0 sits in bits [0..1], base 1 in [2..3], base 2 in [4..5], base 3
 *   in [6..7]. Trailing pad bits in the last byte of each contig are zero.
 */

const ENCODE = ['A', 'C', 'G', 'T'];

/**
 * Compute the byte offset of each contig in the packed sequence blob.
 *
 * @param {Array<{length: number}>} contigs
 * @returns {number[]} parallel array of byte offsets
 */
export function contigByteOffsets(contigs) {
  const offsets = new Array(contigs.length);
  let cur = 0;
  for (let i = 0; i < contigs.length; ++i) {
    offsets[i] = cur;
    cur += Math.ceil(contigs[i].length / 4);
  }
  return offsets;
}

/**
 * Decode the bases at [start, end) on the given contig. start/end are
 * 0-based; end is exclusive. Returns a string of length end-start.
 *
 * @param {ArrayBuffer | Uint8Array} sequenceBin   the entire sequence.bin
 * @param {number} contigByteOffset                offset for this contig
 * @param {number} contigLength                    bp length of this contig
 * @param {number} start                           0-based inclusive
 * @param {number} end                             0-based exclusive
 */
export function decodeBases(sequenceBin, contigByteOffset, contigLength, start, end) {
  if (start < 0) start = 0;
  if (end > contigLength) end = contigLength;
  if (start >= end) return '';
  const u8 = sequenceBin instanceof Uint8Array
    ? sequenceBin
    : new Uint8Array(sequenceBin);
  const out = new Array(end - start);
  for (let i = 0; i < end - start; ++i) {
    const pos = start + i;
    const byte = u8[contigByteOffset + (pos >>> 2)];
    const nibble = (byte >>> ((pos & 3) << 1)) & 3;
    out[i] = ENCODE[nibble];
  }
  return out.join('');
}

/**
 * Convenience wrapper: decode a window around a chain endpoint. Returns the
 * substring and the actual [start, end) used (clamped to contig bounds).
 *
 * @returns {{seq: string, start: number, end: number}}
 */
export function decodeWindow(sequenceBin, contigByteOffset, contigLength, center, halfWindow) {
  const start = Math.max(0, center - halfWindow);
  const end = Math.min(contigLength, center + halfWindow);
  return {
    seq: decodeBases(sequenceBin, contigByteOffset, contigLength, start, end),
    start,
    end,
  };
}
