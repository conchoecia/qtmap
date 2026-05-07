/*
 * Emscripten WASM entry point. Exports a small C ABI surface that the
 * TypeScript bindings call via ccall/cwrap.
 *
 * Built only when CMake is invoked under emcmake; the native CLI build
 * skips this file (see packages/seed-core/CMakeLists.txt).
 */

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

#include "qtqc/hash.h"
#include "qtqc/minimizer.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

/* Allow JS to allocate buffers in the WASM heap. */
EMSCRIPTEN_KEEPALIVE
void *qtqc_malloc(size_t n) { return malloc(n); }

EMSCRIPTEN_KEEPALIVE
void qtqc_free(void *p) { free(p); }

EMSCRIPTEN_KEEPALIVE
uint32_t qtqc_hash_id(void) { return qtqc_hash_function_id(); }

/*
 * Extract minimizers into a JS-supplied output buffer.
 *
 * `seq_ptr`     : char* into the WASM heap, length `seq_len`.
 * `out_ptr`     : qtqc_minimizer_t* into the WASM heap, capacity must be >= seq_len.
 * Returns the number of minimizers written.
 */
EMSCRIPTEN_KEEPALIVE
uint32_t qtqc_extract_minimizers_wasm(
    const char *seq_ptr, uint32_t seq_len,
    int k, int w,
    qtqc_minimizer_t *out_ptr)
{
    return (uint32_t)qtqc_extract_minimizers(seq_ptr, seq_len, k, w, out_ptr);
}
