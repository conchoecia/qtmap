/**
 * @fileoverview .qpack — single-file bundle of an index directory.
 *
 * Lets the user download one file (~3.5 GiB for mm39) instead of 4099
 * separate HTTP fetches. Install-time we parse the file table from the
 * header and write each entry as a separate file in OPFS, so the runtime
 * still has the per-shard sync-access-handle path that's fast in all
 * three browsers.
 *
 * Layout (all little-endian):
 *
 *   magic [8]            "QTQCPACK"
 *   format_version u32   1
 *   reserved      u32
 *   file_count    u32
 *   data_offset   u64    byte offset where file data starts; the file
 *                        table sits in [16 .. data_offset).
 *   reserved      u64
 *
 *   --- file table, file_count entries ---
 *   path_len   u16        UTF-8 byte length of the relative path
 *   reserved   u16
 *   size       u64        bytes of file data
 *   offset     u64        relative to data_offset; absolute = data_offset + offset
 *   sha256     [32]       sha256 of the file's bytes
 *   path       [path_len] UTF-8 path, no null terminator
 *
 *   --- file data section ---
 *   concatenated file bytes, no padding
 */

export const QPACK_MAGIC = 'QTQCPACK';
export const QPACK_FORMAT_VERSION = 1;
export const QPACK_HEADER_SIZE = 32;     // magic + version + reserved + count + data_offset + reserved2

/**
 * Parse the qpack header + file table from a buffer or first-N bytes.
 *
 * @param {ArrayBuffer | Uint8Array} buffer
 * @returns {{
 *   formatVersion: number,
 *   fileCount: number,
 *   dataOffset: number,
 *   files: Array<{ path: string, size: number, offset: number, sha256: string }>,
 * }}
 */
export function parseQpackHeader(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  // Magic check.
  let magic = '';
  for (let i = 0; i < 8; ++i) magic += String.fromCharCode(u8[i]);
  if (magic !== QPACK_MAGIC) {
    throw new Error(`bad qpack magic: ${JSON.stringify(magic)}`);
  }
  const formatVersion = view.getUint32(8, true);
  if (formatVersion !== QPACK_FORMAT_VERSION) {
    throw new Error(`unsupported qpack version ${formatVersion}; expected ${QPACK_FORMAT_VERSION}`);
  }
  const fileCount = view.getUint32(16, true);
  const dataOffset = Number(view.getBigUint64(24, true));

  // Walk file table starting after the fixed header.
  const files = [];
  let cursor = QPACK_HEADER_SIZE;
  const decoder = new TextDecoder();
  for (let i = 0; i < fileCount; ++i) {
    if (cursor + 4 + 8 + 8 + 32 > dataOffset) {
      throw new Error(`qpack file table runs past dataOffset at entry ${i}`);
    }
    const pathLen = view.getUint16(cursor, true);
    cursor += 2;
    const _reserved = view.getUint16(cursor, true);
    cursor += 2;
    const size = Number(view.getBigUint64(cursor, true));
    cursor += 8;
    const offset = Number(view.getBigUint64(cursor, true));
    cursor += 8;
    const sha = u8.subarray(cursor, cursor + 32);
    cursor += 32;
    if (cursor + pathLen > dataOffset) {
      throw new Error(`qpack path runs past dataOffset at entry ${i}`);
    }
    const path = decoder.decode(u8.subarray(cursor, cursor + pathLen));
    cursor += pathLen;

    files.push({
      path,
      size,
      offset,
      sha256: [...sha].map(b => b.toString(16).padStart(2, '0')).join(''),
    });
  }
  return { formatVersion, fileCount, dataOffset, files };
}

/**
 * Build a qpack from a list of `{ path, bytes, sha256 }` entries.
 *
 * Returns the complete qpack as a Uint8Array. Suitable for files up to
 * ~1 GiB; for bigger packs use the streaming Node-side packer in
 * packages/benchmark-runner/src/pack-index.js.
 *
 * @param {Array<{ path: string, bytes: Uint8Array, sha256: string }>} entries
 * @returns {Uint8Array}
 */
export function buildQpack(entries) {
  const encoder = new TextEncoder();
  // Encode paths once, accumulate file table size.
  const meta = entries.map(e => {
    const pathBytes = encoder.encode(e.path);
    if (pathBytes.length > 0xFFFF) {
      throw new Error(`path too long for u16 length: ${e.path}`);
    }
    return {
      pathBytes,
      size: e.bytes.length,
      sha256: e.sha256,
      bytes: e.bytes,
    };
  });
  let tableSize = 0;
  for (const m of meta) {
    tableSize += 2 + 2 + 8 + 8 + 32 + m.pathBytes.length;
  }
  const dataOffset = QPACK_HEADER_SIZE + tableSize;
  let totalSize = dataOffset;
  for (const m of meta) totalSize += m.size;

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  // Header.
  for (let i = 0; i < 8; ++i) out[i] = QPACK_MAGIC.charCodeAt(i);
  view.setUint32(8, QPACK_FORMAT_VERSION, true);
  view.setUint32(12, 0, true);                          // reserved
  view.setUint32(16, meta.length, true);                // file count
  view.setUint32(20, 0, true);                          // reserved
  view.setBigUint64(24, BigInt(dataOffset), true);      // data offset

  // File table.
  let cursor = QPACK_HEADER_SIZE;
  let runningOffset = 0;
  for (const m of meta) {
    view.setUint16(cursor, m.pathBytes.length, true); cursor += 2;
    view.setUint16(cursor, 0, true);                   cursor += 2;
    view.setBigUint64(cursor, BigInt(m.size), true);   cursor += 8;
    view.setBigUint64(cursor, BigInt(runningOffset), true); cursor += 8;
    // sha256 hex string -> 32 bytes
    if (m.sha256.length !== 64) throw new Error(`bad sha256 length: ${m.sha256}`);
    for (let j = 0; j < 32; ++j) {
      out[cursor + j] = parseInt(m.sha256.slice(j * 2, j * 2 + 2), 16);
    }
    cursor += 32;
    out.set(m.pathBytes, cursor);
    cursor += m.pathBytes.length;

    runningOffset += m.size;
  }

  // Data section.
  let dataCursor = dataOffset;
  for (const m of meta) {
    out.set(m.bytes, dataCursor);
    dataCursor += m.size;
  }

  return out;
}
