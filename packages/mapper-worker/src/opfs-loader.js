/**
 * @fileoverview OPFS shard loader.
 *
 * Wraps the OPFS / FileSystemSyncAccessHandle API for reading shard files
 * by explicit byte offset. Sync access handles are dedicated-worker-only
 * and ~3-4x faster than the async API for the small-read patterns we use.
 *
 * Layout under OPFS root:
 *   /qtmap/references/<refId>/reference.json
 *   /qtmap/references/<refId>/contigs.bin
 *   /qtmap/references/<refId>/seed-shard-NNNN.bin
 *   /qtmap/references/<refId>/.install-marker.json
 *
 * The loader caches sync handles per shard file because opening one is
 * expensive (a few ms) and we expect to read every shard many times during
 * a mapping run.
 */

const ROOT_DIR = 'qtmap';
const REFERENCES_DIR = 'references';

/**
 * Open the OPFS root for the application namespace. Creates the
 * `/qtmap/references` tree on first run.
 *
 * @returns {Promise<FileSystemDirectoryHandle>} the references/ dir handle
 */
export async function openReferencesDir() {
  const root = await navigator.storage.getDirectory();
  const app = await root.getDirectoryHandle(ROOT_DIR, { create: true });
  return app.getDirectoryHandle(REFERENCES_DIR, { create: true });
}

/**
 * Open the directory containing a specific reference's shards.
 *
 * @param {string} referenceId  e.g. "mm39"
 * @param {{ create?: boolean }} [opts]
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function openReferenceDir(referenceId, opts = {}) {
  const refs = await openReferencesDir();
  return refs.getDirectoryHandle(referenceId, { create: !!opts.create });
}

/**
 * Open a sync access handle for a single shard file. Sync access handles
 * are only available inside dedicated workers; throws elsewhere.
 *
 * @param {FileSystemDirectoryHandle} refDir  result of openReferenceDir
 * @param {number} shardId
 * @returns {Promise<FileSystemSyncAccessHandle>}
 */
export async function openShardSyncHandle(refDir, shardId) {
  const name = shardFileName(shardId);
  const fh = await refDir.getFileHandle(name);
  // createSyncAccessHandle is dedicated-worker only.
  return fh.createSyncAccessHandle({ mode: 'read-only' });
}

/**
 * @param {number} shardId
 * @returns {string} canonical file name (zero-padded to 4 digits)
 */
export function shardFileName(shardId) {
  return `seed-shard-${String(shardId).padStart(4, '0')}.bin`;
}

/**
 * Lazy per-shard handle cache. Workers should keep one ShardHandleCache
 * for the duration of a mapping batch.
 */
export class ShardHandleCache {
  /**
   * @param {FileSystemDirectoryHandle} refDir
   * @param {object} [opts]
   * @param {number} [opts.maxOpen=512]  evict-oldest threshold
   */
  constructor(refDir, { maxOpen = 512 } = {}) {
    /** @type {FileSystemDirectoryHandle} */
    this._refDir = refDir;
    /** @type {Map<number, FileSystemSyncAccessHandle>} */
    this._handles = new Map();
    this._maxOpen = maxOpen;
  }

  /**
   * Get (or open) the sync handle for a shard file. Re-orders the LRU.
   *
   * @param {number} shardId
   * @returns {Promise<FileSystemSyncAccessHandle>}
   */
  async getHandle(shardId) {
    let h = this._handles.get(shardId);
    if (h) {
      // Bump LRU position.
      this._handles.delete(shardId);
      this._handles.set(shardId, h);
      return h;
    }
    h = await openShardSyncHandle(this._refDir, shardId);
    this._handles.set(shardId, h);
    if (this._handles.size > this._maxOpen) {
      // Evict oldest.
      const oldest = this._handles.keys().next().value;
      const victim = this._handles.get(oldest);
      this._handles.delete(oldest);
      try { victim.close(); } catch (_) { /* swallow */ }
    }
    return h;
  }

  /**
   * Read `len` bytes at `offset` from the given shard file. Returns a
   * fresh ArrayBuffer (a copy of the underlying read).
   *
   * @param {number} shardId
   * @param {number} offset
   * @param {number} len
   * @returns {Promise<ArrayBuffer>}
   */
  async readSlice(shardId, offset, len) {
    const h = await this.getHandle(shardId);
    const buf = new ArrayBuffer(len);
    const view = new Uint8Array(buf);
    const got = h.read(view, { at: offset });
    if (got !== len) {
      throw new Error(
        `OPFS short read on shard ${shardId} @${offset}: got ${got}/${len}`,
      );
    }
    return buf;
  }

  /** Close every cached handle. Call on worker termination. */
  closeAll() {
    for (const h of this._handles.values()) {
      try { h.close(); } catch (_) { /* swallow */ }
    }
    this._handles.clear();
  }
}

/**
 * Async fallback that goes through `FileSystemFileHandle.getFile()` and
 * `Blob.slice().arrayBuffer()`. Slower than sync access handles but works
 * in any context (main thread, shared workers, browsers that disable sync
 * handles).
 *
 * @param {FileSystemDirectoryHandle} refDir
 * @param {number} shardId
 * @param {number} offset
 * @param {number} len
 * @returns {Promise<ArrayBuffer>}
 */
export async function readSliceAsync(refDir, shardId, offset, len) {
  const fh = await refDir.getFileHandle(shardFileName(shardId));
  const file = await fh.getFile();
  return file.slice(offset, offset + len).arrayBuffer();
}
