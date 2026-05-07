#include "qtqc/minimizer.h"
#include "qtqc/hash.h"

#include <stdint.h>
#include <stddef.h>

/*
 * Canonical-minimizer extraction.
 *
 * For a sliding window of `w` consecutive k-mers, we emit the k-mer with the
 * smallest mm_hash64_v1(canonical_2bit_value, mask). Canonical = lex min of
 * forward and reverse-complement 2-bit representations.
 *
 * Strand bit:
 *   0 = forward kmer was (strictly) smaller, or tie.
 *   1 = reverse-complement kmer was strictly smaller.
 *
 * Algorithm: minimap2-style monotonic-deque sliding window. We do not import
 * minimap2 source; this is a clean re-implementation against the same hash
 * universe so seed-set debug diffs are clean.
 */

#define MAX_K 28u

/* 2-bit base encoding. Non-ACGT returns 4 (sentinel). */
static inline uint8_t base2bit(char c) {
    switch (c) {
    case 'A': case 'a': return 0;
    case 'C': case 'c': return 1;
    case 'G': case 'g': return 2;
    case 'T': case 't': return 3;
    default:            return 4;
    }
}

typedef struct {
    uint64_t hash;
    uint32_t pos;
    uint32_t strand;
} candidate_t;

size_t qtqc_extract_minimizers(
    const char *seq, size_t len,
    int k, int w,
    qtqc_minimizer_t *out)
{
    if (k <= 0 || (unsigned)k > MAX_K || w <= 0 || (size_t)k > len) {
        return 0;
    }

    const uint64_t mask = (k == 32) ? UINT64_C(0xFFFFFFFFFFFFFFFF)
                                    : ((UINT64_C(1) << (2 * (uint64_t)k)) - 1);
    const uint64_t shift_rev = 2u * ((uint64_t)k - 1u);

    uint64_t fwd = 0;
    uint64_t rev = 0;
    size_t   valid = 0;       /* consecutive valid bases so far */
    size_t   out_n = 0;
    uint32_t last_emit_pos = UINT32_MAX;
    uint32_t last_emit_strand = UINT32_MAX;
    uint64_t last_emit_hash = UINT64_MAX;

    /* Monotonic deque of candidates indexed by buffer offset. */
    candidate_t buf[256];
    int dq_head = 0;
    int dq_tail = 0;
    const int W = w; /* window size for deque */

    /* Helpers to push/pop from a circular ring of size 256. */
    #define DQ_EMPTY (dq_head == dq_tail)
    #define DQ_SIZE  ((dq_tail - dq_head + 256) & 255)
    #define DQ_FRONT (buf[dq_head & 255])
    #define DQ_BACK  (buf[(dq_tail - 1) & 255])

    for (size_t i = 0; i < len; ++i) {
        uint8_t b = base2bit(seq[i]);
        if (b >= 4) {
            valid = 0;
            fwd = 0;
            rev = 0;
            dq_head = dq_tail = 0;
            continue;
        }
        fwd = ((fwd << 2) | b) & mask;
        rev = (rev >> 2) | ((uint64_t)(3u - b) << shift_rev);
        ++valid;
        if (valid < (size_t)k) continue;

        uint64_t canon;
        uint32_t strand;
        if (fwd < rev)      { canon = fwd; strand = 0; }
        else if (rev < fwd) { canon = rev; strand = 1; }
        else                { canon = fwd; strand = 0; } /* palindrome: forward */

        candidate_t cur = {
            .hash   = qtqc_mm_hash64(canon, mask),
            .pos    = (uint32_t)i,
            .strand = strand
        };

        /* Drop deque-back entries whose hash >= cur.hash (monotonic). */
        while (!DQ_EMPTY && DQ_BACK.hash >= cur.hash) {
            dq_tail = (dq_tail - 1) & 255;
        }
        buf[dq_tail & 255] = cur;
        dq_tail = (dq_tail + 1) & 255;

        /* Drop deque-front entries that fall out of the window. The window
           covers k-mers ending at positions [i - W + 1 .. i]. */
        while (!DQ_EMPTY && DQ_FRONT.pos + (uint32_t)W <= cur.pos) {
            dq_head = (dq_head + 1) & 255;
        }

        /* Once we've seen at least one full window, the front of the deque
           is the minimizer of that window. Emit if it differs from the last
           emit we produced (de-duplicate consecutive identical hits). */
        if (valid >= (size_t)k + (size_t)W - 1u) {
            candidate_t mz = DQ_FRONT;
            if (mz.pos != last_emit_pos ||
                mz.hash != last_emit_hash ||
                mz.strand != last_emit_strand)
            {
                out[out_n].hash = mz.hash;
                out[out_n].pos = mz.pos;
                out[out_n].strand = mz.strand;
                ++out_n;
                last_emit_pos = mz.pos;
                last_emit_hash = mz.hash;
                last_emit_strand = mz.strand;
            }
        }
    }

    #undef DQ_EMPTY
    #undef DQ_SIZE
    #undef DQ_FRONT
    #undef DQ_BACK

    return out_n;
}
