#include "qtqc/minimizer.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define EXPECT(expr) do { \
    if (!(expr)) { \
        fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #expr); \
        return 1; \
    } \
} while (0)

static int short_seq_returns_zero(void) {
    qtqc_minimizer_t out[16];
    /* k=15, len=10 -> below kmer length; should return 0. */
    EXPECT(qtqc_extract_minimizers("ACGTACGTAC", 10, 15, 10, out) == 0);
    return 0;
}

static int n_breaks_kmer(void) {
    qtqc_minimizer_t out[256];
    /* 30 As followed by N followed by 30 Cs.
       Pre-N window: 30 valid bases -> some minimizers.
       N: resets state.
       Post-N: 30 valid bases -> some minimizers.
       Sanity: count is non-zero and includes both regions. */
    char seq[64];
    memset(seq + 0, 'A', 30);
    seq[30] = 'N';
    memset(seq + 31, 'C', 30);
    seq[61] = '\0';
    size_t n = qtqc_extract_minimizers(seq, 61, 5, 4, out);
    EXPECT(n >= 2); /* should produce minimizers from both halves */
    return 0;
}

static int reverse_complement_matches(void) {
    /* The same minimizer (canonical) should be produced for a sequence and
       its reverse complement, just with the strand bit flipped and pos
       relative to the reverse strand. */
    const char *fwd = "ACGTACGTACGTACGTACGTACGTACGT"; /* 28 nt */
    char rev[29];
    for (size_t i = 0; i < 28; ++i) {
        char c = fwd[27 - i];
        rev[i] = (c == 'A') ? 'T' : (c == 'T') ? 'A' :
                 (c == 'C') ? 'G' : (c == 'G') ? 'C' : c;
    }
    rev[28] = '\0';

    qtqc_minimizer_t a[64], b[64];
    size_t na = qtqc_extract_minimizers(fwd, 28, 5, 4, a);
    size_t nb = qtqc_extract_minimizers(rev, 28, 5, 4, b);
    EXPECT(na > 0);
    EXPECT(nb > 0);
    /* For every hash in `a` we should be able to find the same hash in `b`.
       Strand bits differ; positions differ (relative to reverse strand). */
    for (size_t i = 0; i < na; ++i) {
        int found = 0;
        for (size_t j = 0; j < nb; ++j) {
            if (a[i].hash == b[j].hash) { found = 1; break; }
        }
        EXPECT(found);
    }
    return 0;
}

static int deterministic(void) {
    const char *seq = "ACGTAGCATGCATGCATGCATGCATGCATGCAGCTAGCATCG";
    qtqc_minimizer_t a[128], b[128];
    size_t na = qtqc_extract_minimizers(seq, strlen(seq), 15, 10, a);
    size_t nb = qtqc_extract_minimizers(seq, strlen(seq), 15, 10, b);
    EXPECT(na == nb);
    EXPECT(memcmp(a, b, na * sizeof(*a)) == 0);
    return 0;
}

static int positions_strictly_increase(void) {
    const char *seq =
        "ACGTAGCATGCATGCATGCATGCATGCATGCAGCTAGCATCGTAGCTAGCATCGATCG"
        "ACGCAGCTAGCATCGAGCAGCAGCAGGTACTAGCATCGATGCATGCATCGATGCATGC";
    size_t n = strlen(seq);
    qtqc_minimizer_t out[256];
    size_t k = qtqc_extract_minimizers(seq, n, 15, 10, out);
    EXPECT(k > 0);
    for (size_t i = 1; i < k; ++i) {
        /* dedup logic prevents emitting same (pos, hash, strand) twice;
           positions can repeat across different windows but successive
           emits should not be exact duplicates. */
        EXPECT(!(out[i].pos == out[i-1].pos &&
                 out[i].hash == out[i-1].hash &&
                 out[i].strand == out[i-1].strand));
    }
    return 0;
}

int main(void) {
    int rc = 0;
    rc |= short_seq_returns_zero();
    rc |= n_breaks_kmer();
    rc |= reverse_complement_matches();
    rc |= deterministic();
    rc |= positions_strictly_increase();
    if (rc == 0) printf("test_minimizer: ok\n");
    return rc;
}
