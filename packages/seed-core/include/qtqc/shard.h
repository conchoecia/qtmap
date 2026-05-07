#ifndef QTQC_SHARD_H
#define QTQC_SHARD_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

/*
 * On-disk shard binary layout. All multi-byte integers are little-endian.
 *
 *   header      : qtqc_shard_header_t  (64 bytes; magic "MM2BSHRD")
 *   directory   : seed_count * qtqc_shard_dir_entry_t (16 B each)
 *   hits        : hit_count   * qtqc_shard_hit_t      (12 B each)
 *
 * Directory entries are sorted by seed_hash ascending. Hits for a given seed
 * are stored as a contiguous slice [hit_offset, hit_offset + hit_count).
 *
 * format_version: bumped any time the on-disk layout changes.
 */

#define QTQC_SHARD_MAGIC      "MM2BSHRD"
#define QTQC_SHARD_MAGIC_LEN  8
#define QTQC_SHARD_FORMAT_VER 2u

/*
 * Format v2 (current): packed records to fit a mammal-scale index in OPFS.
 *
 *   header   : 64 B (cache-line padded)
 *   directory: 16 B per distinct seed (was 24 B in v1)
 *   hits     : 6 B per hit             (was 12 B in v1)
 *
 * Hit record layout (6 bytes, little-endian):
 *   contig_id    : 16 bits (upper 8 reserved; only low 8 used in MVP)
 *   pos          : 28 bits  (encoded into pos_strand_flags low 28 bits)
 *   strand       : 1 bit   (bit 28 of pos_strand_flags)
 *   flags        : 3 bits   (bits 29-31 of pos_strand_flags; reserved)
 *
 * Directory entry layout (16 bytes, little-endian):
 *   seed_hash      : 64 bits
 *   hit_offset     : 32 bits  (record offset into hit table)
 *   count_and_flags: 32 bits  (low 24 = hit_count, high 8 = flags)
 *
 * Constraints implied by layout:
 *   contig_id ≤ 255       (drop alt scaffolds; mm39/hg38 main set fits)
 *   pos       ≤ 2^28 - 1   (≈ 268 Mbp; mm39 chr1 = 195 Mbp, fits)
 *   hit_count ≤ 2^24 - 1   (we already cap freq at 1000, no risk)
 */

#pragma pack(push, 1)

typedef struct {
    char     magic[QTQC_SHARD_MAGIC_LEN]; /* "MM2BSHRD"      8B */
    uint32_t format_version;              /*                 4B */
    uint32_t shard_id;                    /*                 4B */
    uint32_t seed_count;                  /*                 4B */
    uint32_t reserved0;                   /*                 4B */
    uint64_t hit_count;                   /*                 8B */
    uint64_t directory_offset;            /*                 8B */
    uint64_t hit_table_offset;            /*                 8B */
    uint64_t reserved1;                   /*                 8B */
    uint64_t reserved2;                   /* padding to 64B  8B */
} qtqc_shard_header_t;

typedef struct {
    uint64_t seed_hash;
    uint32_t hit_offset;        /* in records, into hit table */
    uint32_t count_and_flags;   /* low 24 bits: hit_count; high 8: flags */
} qtqc_shard_dir_entry_t;

typedef struct {
    uint16_t contig_id;         /* low 8 bits used; high 8 reserved */
    uint32_t pos_strand_flags;  /* pos:28, strand:1, flags:3 */
} qtqc_shard_hit_t;

#pragma pack(pop)

/* ------------------------------------------------------------------ */
/* Hit record bit-packing helpers. Inline so callers can use freely.  */

#define QTQC_HIT_POS_MASK    UINT32_C(0x0FFFFFFF)
#define QTQC_HIT_STRAND_BIT  UINT32_C(0x10000000)
#define QTQC_HIT_FLAGS_SHIFT 29
#define QTQC_HIT_FLAGS_MASK  UINT32_C(0x07)

static inline uint32_t qtqc_pack_pos_strand_flags(
    uint32_t pos, uint32_t strand, uint32_t flags)
{
    return (pos & QTQC_HIT_POS_MASK) |
           ((strand & 1u) << 28) |
           ((flags & QTQC_HIT_FLAGS_MASK) << QTQC_HIT_FLAGS_SHIFT);
}

static inline uint32_t qtqc_hit_pos(const qtqc_shard_hit_t *h) {
    return h->pos_strand_flags & QTQC_HIT_POS_MASK;
}

static inline uint32_t qtqc_hit_strand(const qtqc_shard_hit_t *h) {
    return (h->pos_strand_flags >> 28) & 1u;
}

static inline uint32_t qtqc_hit_flags(const qtqc_shard_hit_t *h) {
    return (h->pos_strand_flags >> QTQC_HIT_FLAGS_SHIFT) & QTQC_HIT_FLAGS_MASK;
}

/* Directory entry packing helpers. */

#define QTQC_DIR_COUNT_MASK   UINT32_C(0x00FFFFFF)
#define QTQC_DIR_FLAGS_SHIFT  24

static inline uint32_t qtqc_pack_count_and_flags(uint32_t count, uint32_t flags) {
    return (count & QTQC_DIR_COUNT_MASK) | ((flags & 0xFFu) << QTQC_DIR_FLAGS_SHIFT);
}

static inline uint32_t qtqc_dir_count(const qtqc_shard_dir_entry_t *d) {
    return d->count_and_flags & QTQC_DIR_COUNT_MASK;
}

static inline uint32_t qtqc_dir_flags(const qtqc_shard_dir_entry_t *d) {
    return (d->count_and_flags >> QTQC_DIR_FLAGS_SHIFT) & 0xFFu;
}

/* Helpers --------------------------------------------------------------- */

/*
 * Write a complete shard to `fp` from already-sorted directory + hit arrays.
 * Returns 0 on success, -1 on I/O error.
 *
 * `directory` must be sorted by seed_hash ascending.
 * `hit_offset` fields in `directory` are RECOMPUTED here based on per-entry
 * hit_count, so callers may leave them zero on input.
 */
int qtqc_shard_write(
    FILE *fp,
    uint32_t shard_id,
    qtqc_shard_dir_entry_t *directory, uint32_t seed_count,
    const qtqc_shard_hit_t *hits, uint64_t hit_count);

#endif
