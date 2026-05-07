/**
 * @fileoverview contigs.bin reader.
 *
 * Layout (mirrors qtmap-index writer in src/cli/index_build.c):
 *
 *   header     : u32 contig_count, u32 reserved
 *   per-contig : u32 name_offset, u16 name_len, u16 reserved, u64 length
 *   names blob : utf-8, no separators; per-contig name_offset+name_len
 */

const HEADER_SIZE = 8;
const RECORD_SIZE = 16;

/**
 * @param {ArrayBuffer | Uint8Array | Buffer} buffer
 * @returns {Array<{name: string, length: number}>}
 */
export function parseContigs(buffer) {
  const view = bufferDataView(buffer);
  const count = view.getUint32(0, true);
  const records = [];
  let nameOffset = 0;
  for (let i = 0; i < count; ++i) {
    const off = HEADER_SIZE + i * RECORD_SIZE;
    const recordOffset = view.getUint32(off + 0, true);
    const nameLen = view.getUint16(off + 4, true);
    const length = Number(view.getBigUint64(off + 8, true));
    records.push({
      name: '',          // filled in below from the names blob
      length,
      _nameOffset: recordOffset,
      _nameLen: nameLen,
    });
    nameOffset = recordOffset + nameLen;
  }
  const namesBlobStart = HEADER_SIZE + count * RECORD_SIZE;
  const namesBytes = new Uint8Array(view.buffer, view.byteOffset + namesBlobStart, nameOffset);
  const decoder = new TextDecoder();
  for (const r of records) {
    r.name = decoder.decode(namesBytes.subarray(r._nameOffset, r._nameOffset + r._nameLen));
    delete r._nameOffset;
    delete r._nameLen;
  }
  return records;
}

function bufferDataView(buffer) {
  if (buffer instanceof DataView) return buffer;
  if (buffer instanceof Uint8Array) {
    return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  return new DataView(buffer);
}
