/**
 * @fileoverview TypeScript-friendly mirror of the C shard codec.
 *
 * Reads format-v2 binary shards produced by the qtqc-mm2-index CLI. Used
 * from both Node (for tests, golden compares) and the browser worker
 * (where ArrayBuffer is the input). All multi-byte integers are
 * little-endian; we use DataView with `littleEndian = true`.
 *
 * Layout (mirrors packages/seed-core/include/qtqc/shard.h):
 *
 *   header   : 64 B
 *     magic[8]            "MM2BSHRD"
 *     format_version u32  must be 2
 *     shard_id       u32
 *     seed_count     u32
 *     reserved0      u32
 *     hit_count      u64
 *     directory_off  u64
 *     hit_table_off  u64
 *     reserved1      u64
 *     reserved2      u64
 *
 *   directory: seed_count × 16 B
 *     seed_hash       u64
 *     hit_offset      u32  (record index into hit table)
 *     count_and_flags u32  (low 24 = count, high 8 = flags)
 *
 *   hits: hit_count × 6 B
 *     contig_id        u16  (low 8 used)
 *     pos_strand_flags u32  (pos:28, strand:1, flags:3)
 */

export const SHARD_MAGIC = 'MM2BSHRD';
export const SHARD_FORMAT_VERSION = 2;
export const HEADER_SIZE = 64;
export const DIR_ENTRY_SIZE = 16;
export const HIT_RECORD_SIZE = 6;

const HIT_POS_MASK = 0x0FFFFFFF;
const HIT_STRAND_BIT = 0x10000000;
const HIT_FLAGS_SHIFT = 29;
const HIT_FLAGS_MASK = 0x07;

const DIR_COUNT_MASK = 0x00FFFFFF;
const DIR_FLAGS_SHIFT = 24;

/**
 * Parse the 64-byte shard header from `buffer` at `offset`.
 *
 * @param {ArrayBuffer | Uint8Array} buffer
 * @param {number} [offset]
 * @returns {{
 *   shardId: number,
 *   seedCount: number,
 *   hitCount: bigint,
 *   directoryOffset: bigint,
 *   hitTableOffset: bigint,
 * }}
 */
export function parseShardHeader(buffer, offset = 0) {
  const view = bufferDataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(offset + 0),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
    view.getUint8(offset + 4),
    view.getUint8(offset + 5),
    view.getUint8(offset + 6),
    view.getUint8(offset + 7),
  );
  if (magic !== SHARD_MAGIC) {
    throw new Error(`bad shard magic: ${JSON.stringify(magic)}`);
  }
  const formatVersion = view.getUint32(offset + 8, true);
  if (formatVersion !== SHARD_FORMAT_VERSION) {
    throw new Error(
      `unsupported shard formatVersion ${formatVersion}; expected ${SHARD_FORMAT_VERSION}`,
    );
  }
  return {
    shardId: view.getUint32(offset + 12, true),
    seedCount: view.getUint32(offset + 16, true),
    hitCount: view.getBigUint64(offset + 24, true),
    directoryOffset: view.getBigUint64(offset + 32, true),
    hitTableOffset: view.getBigUint64(offset + 40, true),
  };
}

/**
 * Decode a single hit record at `offset` in `buffer`.
 *
 * @param {ArrayBuffer | Uint8Array} buffer
 * @param {number} offset
 * @returns {{ contigId: number, pos: number, strand: number, flags: number }}
 */
export function decodeHit(buffer, offset) {
  const view = bufferDataView(buffer);
  const contigId = view.getUint16(offset, true) & 0xFF;
  const psf = view.getUint32(offset + 2, true);
  return {
    contigId,
    pos: psf & HIT_POS_MASK,
    strand: (psf & HIT_STRAND_BIT) ? 1 : 0,
    flags: (psf >>> HIT_FLAGS_SHIFT) & HIT_FLAGS_MASK,
  };
}

/**
 * Decode a single directory entry at `offset` in `buffer`.
 *
 * @param {ArrayBuffer | Uint8Array} buffer
 * @param {number} offset
 * @returns {{ seedHash: bigint, hitOffset: number, hitCount: number, flags: number }}
 */
export function decodeDirEntry(buffer, offset) {
  const view = bufferDataView(buffer);
  const cf = view.getUint32(offset + 12, true);
  return {
    seedHash: view.getBigUint64(offset, true),
    hitOffset: view.getUint32(offset + 8, true),
    hitCount: cf & DIR_COUNT_MASK,
    flags: (cf >>> DIR_FLAGS_SHIFT) & 0xFF,
  };
}

/**
 * Binary-search the directory for `seedHash`. Returns the matching entry or
 * null. The caller must have already loaded the directory bytes (e.g. by
 * reading [directoryOffset, hitTableOffset) from OPFS).
 *
 * @param {ArrayBuffer | Uint8Array} dirBuffer  packed directory bytes only
 * @param {number} seedCount                    number of entries in dirBuffer
 * @param {bigint} seedHash
 * @returns {{ seedHash: bigint, hitOffset: number, hitCount: number, flags: number } | null}
 */
export function findDirEntry(dirBuffer, seedCount, seedHash) {
  const view = bufferDataView(dirBuffer);
  let lo = 0;
  let hi = seedCount;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const off = mid * DIR_ENTRY_SIZE;
    const midHash = view.getBigUint64(off, true);
    if (midHash < seedHash) {
      lo = mid + 1;
    } else if (midHash > seedHash) {
      hi = mid;
    } else {
      const cf = view.getUint32(off + 12, true);
      return {
        seedHash: midHash,
        hitOffset: view.getUint32(off + 8, true),
        hitCount: cf & DIR_COUNT_MASK,
        flags: (cf >>> DIR_FLAGS_SHIFT) & 0xFF,
      };
    }
  }
  return null;
}

/**
 * Convenience: parse the whole shard from a single buffer (e.g. fs.readFileSync).
 * Returns header + decoded directory entries + view onto the hit table bytes.
 *
 * @param {ArrayBuffer | Uint8Array} buffer
 * @returns {{
 *   header: ReturnType<typeof parseShardHeader>,
 *   directory: ReturnType<typeof decodeDirEntry>[],
 *   hitsView: DataView,
 *   hitsBuffer: ArrayBuffer,
 *   hitsByteOffset: number,
 * }}
 */
export function parseShard(buffer) {
  const header = parseShardHeader(buffer, 0);
  const directory = new Array(header.seedCount);
  const dirOff = Number(header.directoryOffset);
  for (let i = 0; i < header.seedCount; ++i) {
    directory[i] = decodeDirEntry(buffer, dirOff + i * DIR_ENTRY_SIZE);
  }
  const hitsByteOffset = Number(header.hitTableOffset);
  const view = bufferDataView(buffer);
  return {
    header,
    directory,
    hitsView: view,
    hitsBuffer: view.buffer,
    hitsByteOffset,
  };
}

function bufferDataView(buffer) {
  if (buffer instanceof DataView) return buffer;
  if (buffer instanceof Uint8Array) {
    return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  return new DataView(buffer);
}
