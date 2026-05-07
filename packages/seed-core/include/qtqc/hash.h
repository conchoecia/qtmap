#ifndef QTQC_HASH_H
#define QTQC_HASH_H

#include <stdint.h>

/*
 * mm_hash64_v1: invertible 64-bit multiply-XOR identical to minimap2's
 * mm_hash64. Same hash universe enables direct seed-set diffs against
 * minimap2 during debugging.
 *
 * Reference: minimap2 sketch.c, lh3/minimap2 (MIT).
 */
static inline uint64_t qtqc_mm_hash64(uint64_t key, uint64_t mask) {
    key = (~key + (key << 21)) & mask;
    key = key ^ (key >> 24);
    key = ((key + (key << 3)) + (key << 8)) & mask;
    key = key ^ (key >> 14);
    key = ((key + (key << 2)) + (key << 4)) & mask;
    key = key ^ (key >> 28);
    key = (key + (key << 31)) & mask;
    return key;
}

/* Returns the hash-function-version tag baked into reference.json. */
uint32_t qtqc_hash_function_id(void);

#endif
