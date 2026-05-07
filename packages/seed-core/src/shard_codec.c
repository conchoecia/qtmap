#include "qtqc/shard.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

/*
 * Shard codec: writer for binary shard files.
 *
 * Endianness: every modern target we support is little-endian (x86_64,
 * arm64, wasm32). We write packed structs directly via fwrite. If we ever
 * port to a big-endian host, swap-on-write goes here.
 *
 * A static_assert guards struct sizes so accidental layout changes break
 * the build immediately.
 */

#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "Shard codec assumes little-endian host"
#endif

_Static_assert(sizeof(qtqc_shard_header_t)    == 64,
    "qtqc_shard_header_t must be 64 bytes on disk");
_Static_assert(sizeof(qtqc_shard_dir_entry_t) == 16,
    "qtqc_shard_dir_entry_t must be 16 bytes (v2 packed) on disk");
_Static_assert(sizeof(qtqc_shard_hit_t)       == 6,
    "qtqc_shard_hit_t must be 6 bytes (v2 packed) on disk");

int qtqc_shard_write(
    FILE *fp,
    uint32_t shard_id,
    qtqc_shard_dir_entry_t *directory, uint32_t seed_count,
    const qtqc_shard_hit_t *hits, uint64_t hit_count)
{
    /* Recompute hit_offset chain across the directory based on hit_count
       (which lives in the low 24 bits of count_and_flags). */
    uint32_t running = 0;
    for (uint32_t i = 0; i < seed_count; ++i) {
        directory[i].hit_offset = running;
        running += qtqc_dir_count(&directory[i]);
    }
    if ((uint64_t)running != hit_count) {
        return -1; /* directory's per-entry counts disagree with total */
    }

    /* Compute fixed offsets: directory immediately after header, hits after. */
    const uint64_t dir_off = sizeof(qtqc_shard_header_t);
    const uint64_t hit_off = dir_off + (uint64_t)seed_count
                                     * sizeof(qtqc_shard_dir_entry_t);

    qtqc_shard_header_t hdr;
    memset(&hdr, 0, sizeof(hdr));
    memcpy(hdr.magic, QTQC_SHARD_MAGIC, QTQC_SHARD_MAGIC_LEN);
    hdr.format_version   = QTQC_SHARD_FORMAT_VER;
    hdr.shard_id         = shard_id;
    hdr.seed_count       = seed_count;
    hdr.hit_count        = hit_count;
    hdr.directory_offset = dir_off;
    hdr.hit_table_offset = hit_off;

    if (fwrite(&hdr, sizeof(hdr), 1, fp) != 1) return -1;

    if (seed_count > 0) {
        if (fwrite(directory, sizeof(qtqc_shard_dir_entry_t),
                   seed_count, fp) != seed_count) {
            return -1;
        }
    }
    if (hit_count > 0) {
        if (fwrite(hits, sizeof(qtqc_shard_hit_t),
                   (size_t)hit_count, fp) != (size_t)hit_count) {
            return -1;
        }
    }
    return 0;
}
