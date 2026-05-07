#ifndef QTQC_MINIMIZER_H
#define QTQC_MINIMIZER_H

#include <stddef.h>
#include <stdint.h>

/*
 * Minimizer record produced by qtqc_extract_minimizers.
 *
 * Layout:
 *   hash   : 64-bit canonical-kmer hash (mm_hash64_v1).
 *   pos    : 0-based reference position of the *last* base of the kmer.
 *   strand : 0 = forward, 1 = reverse-complement minimizer originated from
 *            the reverse strand of the input sequence.
 */
typedef struct {
    uint64_t hash;
    uint32_t pos;
    uint32_t strand; /* 0 or 1 */
} qtqc_minimizer_t;

/*
 * Extract canonical minimizers (hash, pos, strand) from `seq` (length `len`)
 * using window `w` and kmer size `k` (k <= 28 enforced because we pack two
 * bits per base into a uint64).
 *
 * Output buffer `out` must hold at least `len` records (worst case). Returns
 * the number of records written.
 *
 * `seq` may contain ACGTacgt; non-ACGT bases break the running kmer.
 *
 * Hash is mm_hash64_v1 of the canonical kmer (lex min of forward/reverse
 * 2-bit-encoded values), folded into the lower 2*k bits.
 */
size_t qtqc_extract_minimizers(
    const char *seq, size_t len,
    int k, int w,
    qtqc_minimizer_t *out);

#endif
