/**
 * @fileoverview Shard worker entry point.
 *
 * Receives query batches from the controller and returns anchor records
 * (one per matched seed hit). One shard worker owns a partition of shard
 * files, identified by a list of shardIds at init time.
 *
 * Message protocol (mirrors qtqc-minimap2-wasm/src/worker.js shape so the
 * future qtqc-adapter can drop into either):
 *
 *   in : { id, command: 'init', payload: { referenceId, shardIds } }
 *   out: { id, type: 'ready' }
 *
 *   in : { id, command: 'lookup', payload: { batches: [{ shardId, queries }] } }
 *   out: { id, type: 'anchors', anchors: ArrayBuffer, anchorCount }
 *
 *   in : { id, command: 'shutdown' }
 *   out: { id, type: 'goodbye' }
 *
 * `queries` is a transferable Uint8Array shaped as a packed array of
 * (readIdx u32, qPos u32, qStrand u8, hash u64) records — see
 * encodeQueryBatch / decodeAnchorBatch below.
 */

import { ShardHandleCache, readSliceAsync } from './opfs-loader.js';
import {
  HEADER_SIZE,
  DIR_ENTRY_SIZE,
  HIT_RECORD_SIZE,
  parseShardHeader,
  decodeHit,
  findDirEntry,
} from '@qtmap/mapper-core/shard-codec';

/* --- Wire formats ----------------------------------------------------- */

/**
 * Each query record is 24 bytes:
 *   readIdx  u32  ( 0)
 *   qPos     u32  ( 4)
 *   qStrand  u32  ( 8) (0 or 1; padded to align hash)
 *   hash     u64  (16)
 */
export const QUERY_RECORD_SIZE = 24;

/**
 * Each anchor record emitted back is 24 bytes:
 *   readIdx   u32  ( 0)
 *   qPos      u32  ( 4)
 *   contigId  u32  ( 8)
 *   refPos    u32  (12)
 *   strand    u32  (16) — joint strand: qStrand XOR refStrand
 *   flags     u32  (20)
 */
export const ANCHOR_RECORD_SIZE = 24;

/* --- Worker state ----------------------------------------------------- */

/** @type {ShardHandleCache | null} */
let cache = null;
let useSyncHandles = true;
let referenceId = null;
/** @type {Map<number, { directory: ArrayBuffer, seedCount: number, hitTableOffset: number }>} */
const shardDirCache = new Map();

/* --- Helpers ---------------------------------------------------------- */

async function ensureShardLoaded(shardId, refDir) {
  if (shardDirCache.has(shardId)) return shardDirCache.get(shardId);

  // Read the 64-byte header to learn the directory layout.
  const headerBuf = useSyncHandles
    ? await cache.readSlice(shardId, 0, HEADER_SIZE)
    : await readSliceAsync(refDir, shardId, 0, HEADER_SIZE);
  const header = parseShardHeader(headerBuf, 0);

  // Then load the entire directory (~3% of file). Cached for the run.
  const dirBytes = header.seedCount * DIR_ENTRY_SIZE;
  const dirBuf = dirBytes === 0
    ? new ArrayBuffer(0)
    : (useSyncHandles
      ? await cache.readSlice(shardId, Number(header.directoryOffset), dirBytes)
      : await readSliceAsync(refDir, shardId, Number(header.directoryOffset), dirBytes));

  const entry = {
    directory: dirBuf,
    seedCount: header.seedCount,
    hitTableOffset: Number(header.hitTableOffset),
  };
  shardDirCache.set(shardId, entry);
  return entry;
}

/**
 * Process one (shardId, queries) batch. Issues a binary search per query
 * then a contiguous read for the matched hit slice.
 */
async function lookupBatch(shardId, queries, refDir, anchorOut) {
  const meta = await ensureShardLoaded(shardId, refDir);
  if (meta.seedCount === 0) return 0;

  let written = 0;

  for (const q of queries) {
    const e = findDirEntry(meta.directory, meta.seedCount, q.hash);
    if (!e || e.hitCount === 0) continue;

    const hitBytes = e.hitCount * HIT_RECORD_SIZE;
    const hitOffset = meta.hitTableOffset + e.hitOffset * HIT_RECORD_SIZE;
    const hitBuf = useSyncHandles
      ? await cache.readSlice(shardId, hitOffset, hitBytes)
      : await readSliceAsync(refDir, shardId, hitOffset, hitBytes);

    for (let i = 0; i < e.hitCount; ++i) {
      const hit = decodeHit(hitBuf, i * HIT_RECORD_SIZE);
      const aOff = (anchorOut.length + written) * ANCHOR_RECORD_SIZE;
      // Grow on demand
      if (aOff + ANCHOR_RECORD_SIZE > anchorOut.byteLength) {
        const grown = new Uint8Array(Math.max(aOff * 2, ANCHOR_RECORD_SIZE * 1024));
        grown.set(anchorOut.bytes);
        anchorOut.bytes = grown;
        anchorOut.byteLength = grown.byteLength;
      }
      const view = new DataView(anchorOut.bytes.buffer, anchorOut.bytes.byteOffset + aOff, ANCHOR_RECORD_SIZE);
      view.setUint32(0, q.readIdx, true);
      view.setUint32(4, q.qPos, true);
      view.setUint32(8, hit.contigId, true);
      view.setUint32(12, hit.pos, true);
      view.setUint32(16, q.qStrand ^ hit.strand, true);
      view.setUint32(20, e.flags, true);
      ++written;
    }
  }
  anchorOut.length += written;
  return written;
}

/* --- Message handler -------------------------------------------------- */

self.onmessage = async (ev) => {
  const { id, command, payload } = ev.data || {};
  try {
    switch (command) {
    case 'init': {
      referenceId = payload.referenceId;
      const refDir = await openReferenceDirInWorker(referenceId);
      // Decide sync vs async based on availability.
      useSyncHandles = await detectSyncHandleSupport(refDir, payload.shardIds);
      cache = useSyncHandles ? new ShardHandleCache(refDir) : null;
      self.postMessage({ id, type: 'ready', useSyncHandles });
      break;
    }
    case 'lookup': {
      const refDir = await openReferenceDirInWorker(referenceId);
      const out = { bytes: new Uint8Array(ANCHOR_RECORD_SIZE * 1024), byteLength: ANCHOR_RECORD_SIZE * 1024, length: 0 };
      let total = 0;
      for (const b of payload.batches) {
        total += await lookupBatch(b.shardId, b.queries, refDir, out);
      }
      // Slice to actual content length and transfer.
      const finalBytes = out.bytes.slice(0, total * ANCHOR_RECORD_SIZE);
      self.postMessage({
        id,
        type: 'anchors',
        anchors: finalBytes.buffer,
        anchorCount: total,
      }, [finalBytes.buffer]);
      break;
    }
    case 'shutdown': {
      cache?.closeAll();
      shardDirCache.clear();
      self.postMessage({ id, type: 'goodbye' });
      self.close();
      break;
    }
    default:
      self.postMessage({ id, type: 'error', error: `unknown command ${command}` });
    }
  } catch (e) {
    self.postMessage({ id, type: 'error', error: String(e?.message ?? e) });
  }
};

async function openReferenceDirInWorker(refId) {
  // Re-resolve from the OPFS root each time so handles stay fresh.
  const { openReferenceDir } = await import('./opfs-loader.js');
  return openReferenceDir(refId);
}

/**
 * Try one sync handle to decide whether the worker can use the fast path.
 * Falls back to async on any failure (browser disabled, locked file, etc).
 */
async function detectSyncHandleSupport(refDir, shardIds) {
  if (!shardIds || shardIds.length === 0) return false;
  try {
    const { openShardSyncHandle } = await import('./opfs-loader.js');
    const probe = await openShardSyncHandle(refDir, shardIds[0]);
    probe.close();
    return true;
  } catch (_e) {
    return false;
  }
}
