/**
 * @fileoverview High-level bindings around the seed_core WASM module.
 *
 * Loads the Emscripten ES module produced by `scripts/build-wasm.sh`, then
 * exposes a thin TypeScript-friendly surface: `loadSeedCore()` returns an
 * instance with `extractMinimizers(seq, k, w)` plus low-level memory
 * helpers if you need them.
 *
 * The WASM module itself is single-threaded, no SAB, no COOP/COEP.
 */

import createModule from '../dist/seed_core.js';

/**
 * Each minimizer record from `extractMinimizers` is laid out in memory as
 *   uint64_t hash    (8 bytes)
 *   uint32_t pos     (4 bytes)
 *   uint32_t strand  (4 bytes)
 * for a total of 16 bytes per record.
 *
 * On the JS side we read them back as { hash: bigint, pos: number, strand: 0|1 }.
 */
const MINIMIZER_RECORD_SIZE = 16;

/**
 * Initialize the WASM module. Returns a SeedCore instance.
 *
 * @param {object} [opts]
 * @param {string} [opts.wasmBinary]  optional pre-fetched bytes
 * @returns {Promise<SeedCore>}
 */
export async function loadSeedCore(opts = {}) {
  const moduleArg = {};
  if (opts.wasmBinary) moduleArg.wasmBinary = opts.wasmBinary;
  const Module = await createModule(moduleArg);
  return new SeedCore(Module);
}

export class SeedCore {
  /** @param {*} Module Emscripten module instance */
  constructor(Module) {
    this._M = Module;
    this._malloc = Module._qtqc_malloc;
    this._free = Module._qtqc_free;
    this._extract = Module._qtqc_extract_minimizers_wasm;
    this._hashId = Module._qtqc_hash_id;
  }

  /** @returns {number} hash function ID baked into reference.json */
  hashFunctionId() {
    return this._hashId();
  }

  /**
   * Extract canonical minimizers (k, w) from `seq`. Strand 0 = forward,
   * 1 = reverse-complement.
   *
   * @param {string} seq    ASCII sequence (A/C/G/T/N case-insensitive)
   * @param {number} k      kmer size, 1..28
   * @param {number} w      window size, >= 1
   * @returns {Array<{ hash: bigint, pos: number, strand: 0 | 1 }>}
   */
  extractMinimizers(seq, k, w) {
    const M = this._M;
    const seqBytes = new TextEncoder().encode(seq);
    const seqLen = seqBytes.length;

    const seqPtr = this._malloc(seqLen);
    if (!seqPtr) throw new Error('qtqc_malloc failed for sequence');
    M.HEAPU8.set(seqBytes, seqPtr);

    // Worst case: one record per base.
    const outBytes = seqLen * MINIMIZER_RECORD_SIZE;
    const outPtr = this._malloc(outBytes);
    if (!outPtr) {
      this._free(seqPtr);
      throw new Error('qtqc_malloc failed for output');
    }

    const n = this._extract(seqPtr, seqLen, k, w, outPtr);

    // Read back records as (u64 hash, u32 pos, u32 strand).
    const out = new Array(n);
    const heap64 = M.HEAPU64 ?? new BigUint64Array(M.HEAPU8.buffer);
    const heap32 = M.HEAPU32;
    for (let i = 0; i < n; ++i) {
      const recPtr = outPtr + i * MINIMIZER_RECORD_SIZE;
      const hash = heap64[recPtr / 8];
      const pos = heap32[(recPtr + 8) / 4];
      const strand = heap32[(recPtr + 12) / 4];
      out[i] = { hash, pos, strand };
    }

    this._free(seqPtr);
    this._free(outPtr);
    return out;
  }
}
