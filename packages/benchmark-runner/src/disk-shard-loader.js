/**
 * @fileoverview Node-side shard loader.
 *
 * Caches shard headers + directories in RAM. Reads hit slices on demand
 * via fs.openSync + readSync. Designed for the benchmark harness; the
 * browser has its own OPFS-backed loader.
 */

import {
  openSync,
  closeSync,
  readSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  parseShardHeader,
  decodeHit,
  findDirEntry,
  HEADER_SIZE,
  DIR_ENTRY_SIZE,
  HIT_RECORD_SIZE,
} from '../../mapper-core/src/shard-codec.js';

/**
 * Lazy-loaded per-shard state. We keep the directory bytes in RAM (since
 * binary search hits the directory many times) and read hit slices via
 * pread. fd is opened on first access.
 */
export class DiskShardCache {
  /**
   * @param {string} indexDir   path to a directory containing seed-shard-*.bin
   * @param {number} shardCount total number of shards (from reference.json)
   */
  constructor(indexDir, shardCount) {
    this.indexDir = indexDir;
    this.shardCount = shardCount;
    this._fds = new Map();             // shardId -> fd
    this._headers = new Map();         // shardId -> { seedCount, hitTableOffset, hitCount }
    this._directories = new Map();     // shardId -> Uint8Array (directory bytes)
  }

  _ensureLoaded(shardId) {
    if (this._headers.has(shardId)) return;

    const path = join(this.indexDir, `seed-shard-${String(shardId).padStart(4, '0')}.bin`);
    const fd = openSync(path, 'r');
    this._fds.set(shardId, fd);

    const headerBuf = Buffer.alloc(HEADER_SIZE);
    readSync(fd, headerBuf, 0, HEADER_SIZE, 0);
    const header = parseShardHeader(headerBuf, 0);

    let dirBytes;
    if (header.seedCount > 0) {
      const dirSize = header.seedCount * DIR_ENTRY_SIZE;
      const dirBuf = Buffer.alloc(dirSize);
      readSync(fd, dirBuf, 0, dirSize, Number(header.directoryOffset));
      dirBytes = new Uint8Array(dirBuf.buffer, dirBuf.byteOffset, dirSize);
    } else {
      dirBytes = new Uint8Array(0);
    }
    this._directories.set(shardId, dirBytes);
    this._headers.set(shardId, {
      seedCount: header.seedCount,
      hitTableOffset: Number(header.hitTableOffset),
      hitCount: header.hitCount,
    });
  }

  /**
   * Look up a batch of hashes against one shard. Returns an array of
   * arrays, one per input hash; empty subarray if the hash is absent.
   *
   * @param {number} shardId
   * @param {bigint[]} hashes
   * @returns {Array<{contigId:number,refPos:number,refStrand:number}>[]}
   */
  lookupHits(shardId, hashes) {
    this._ensureLoaded(shardId);
    const meta = this._headers.get(shardId);
    if (meta.seedCount === 0) return hashes.map(() => []);

    const fd = this._fds.get(shardId);
    const dir = this._directories.get(shardId);

    const out = new Array(hashes.length);
    for (let i = 0; i < hashes.length; ++i) {
      const e = findDirEntry(dir, meta.seedCount, hashes[i]);
      if (!e || e.hitCount === 0) { out[i] = []; continue; }
      const sliceBytes = e.hitCount * HIT_RECORD_SIZE;
      const sliceOffset = meta.hitTableOffset + e.hitOffset * HIT_RECORD_SIZE;
      const buf = Buffer.alloc(sliceBytes);
      readSync(fd, buf, 0, sliceBytes, sliceOffset);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + sliceBytes);
      const arr = new Array(e.hitCount);
      for (let h = 0; h < e.hitCount; ++h) {
        const hit = decodeHit(ab, h * HIT_RECORD_SIZE);
        arr[h] = {
          contigId: hit.contigId,
          refPos: hit.pos,
          refStrand: hit.strand,
        };
      }
      out[i] = arr;
    }
    return out;
  }

  closeAll() {
    for (const fd of this._fds.values()) {
      try { closeSync(fd); } catch (_e) { /* swallow */ }
    }
    this._fds.clear();
    this._directories.clear();
    this._headers.clear();
  }
}
