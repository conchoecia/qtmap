#include "qtqc/hash.h"

/*
 * mm_hash64_v1 lives in the header as `static inline` so the compiler can
 * fold it into hot loops in minimizer.c. This TU exists to give CMake a
 * compilation unit and to expose a stable version tag.
 */

uint32_t qtqc_hash_function_id(void) {
    return 1u; /* mm_hash64_v1 */
}
