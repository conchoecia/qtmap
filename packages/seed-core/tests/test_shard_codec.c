#include "qtqc/shard.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define EXPECT(expr) do { \
    if (!(expr)) { \
        fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #expr); \
        return 1; \
    } \
} while (0)

static int round_trip_small_shard(void) {
    /* Build a tiny shard, write it to a temp file, read it back, verify. */
    qtqc_shard_dir_entry_t dir[3];
    memset(dir, 0, sizeof(dir));
    dir[0].seed_hash = 0x1111111111111111ull; dir[0].count_and_flags = qtqc_pack_count_and_flags(2, 0);
    dir[1].seed_hash = 0x2222222222222222ull; dir[1].count_and_flags = qtqc_pack_count_and_flags(1, 0);
    dir[2].seed_hash = 0x3333333333333333ull; dir[2].count_and_flags = qtqc_pack_count_and_flags(3, 0x5);

    qtqc_shard_hit_t hits[6];
    memset(hits, 0, sizeof(hits));
    hits[0].contig_id = 1; hits[0].pos_strand_flags = qtqc_pack_pos_strand_flags(100, 0, 0);
    hits[1].contig_id = 1; hits[1].pos_strand_flags = qtqc_pack_pos_strand_flags(200, 1, 0);
    hits[2].contig_id = 2; hits[2].pos_strand_flags = qtqc_pack_pos_strand_flags(50,  0, 0);
    hits[3].contig_id = 0; hits[3].pos_strand_flags = qtqc_pack_pos_strand_flags(9,   0, 0);
    hits[4].contig_id = 0; hits[4].pos_strand_flags = qtqc_pack_pos_strand_flags(99,  1, 0);
    hits[5].contig_id = 0; hits[5].pos_strand_flags = qtqc_pack_pos_strand_flags(999, 0, 0x3);

    char tmpl[] = "/tmp/qtqc_shard_test_XXXXXX";
    int fd = mkstemp(tmpl);
    EXPECT(fd >= 0);
    FILE *fp = fdopen(fd, "wb");
    EXPECT(fp != NULL);
    EXPECT(qtqc_shard_write(fp, /* shard_id */ 0x42u, dir, 3, hits, 6) == 0);
    fclose(fp);

    /* Read back. */
    fp = fopen(tmpl, "rb");
    EXPECT(fp != NULL);

    qtqc_shard_header_t hdr;
    EXPECT(fread(&hdr, sizeof(hdr), 1, fp) == 1);
    EXPECT(memcmp(hdr.magic, QTQC_SHARD_MAGIC, QTQC_SHARD_MAGIC_LEN) == 0);
    EXPECT(hdr.format_version == QTQC_SHARD_FORMAT_VER);
    EXPECT(hdr.shard_id == 0x42u);
    EXPECT(hdr.seed_count == 3u);
    EXPECT(hdr.hit_count == 6u);
    EXPECT(hdr.directory_offset == sizeof(qtqc_shard_header_t));
    EXPECT(hdr.hit_table_offset ==
           sizeof(qtqc_shard_header_t) + 3u * sizeof(qtqc_shard_dir_entry_t));

    qtqc_shard_dir_entry_t rd_dir[3];
    EXPECT(fread(rd_dir, sizeof(rd_dir[0]), 3, fp) == 3);
    EXPECT(rd_dir[0].seed_hash == 0x1111111111111111ull);
    EXPECT(rd_dir[0].hit_offset == 0u);
    EXPECT(qtqc_dir_count(&rd_dir[0]) == 2u);
    EXPECT(qtqc_dir_flags(&rd_dir[0]) == 0u);
    EXPECT(rd_dir[1].seed_hash == 0x2222222222222222ull);
    EXPECT(rd_dir[1].hit_offset == 2u);
    EXPECT(qtqc_dir_count(&rd_dir[1]) == 1u);
    EXPECT(rd_dir[2].seed_hash == 0x3333333333333333ull);
    EXPECT(rd_dir[2].hit_offset == 3u);
    EXPECT(qtqc_dir_count(&rd_dir[2]) == 3u);
    EXPECT(qtqc_dir_flags(&rd_dir[2]) == 0x5u);

    qtqc_shard_hit_t rd_hits[6];
    EXPECT(fread(rd_hits, sizeof(rd_hits[0]), 6, fp) == 6);
    for (int i = 0; i < 6; ++i) {
        EXPECT(rd_hits[i].contig_id == hits[i].contig_id);
        EXPECT(qtqc_hit_pos(&rd_hits[i]) == qtqc_hit_pos(&hits[i]));
        EXPECT(qtqc_hit_strand(&rd_hits[i]) == qtqc_hit_strand(&hits[i]));
        EXPECT(qtqc_hit_flags(&rd_hits[i]) == qtqc_hit_flags(&hits[i]));
    }

    /* End of file. */
    int c = fgetc(fp);
    EXPECT(c == EOF);
    fclose(fp);
    remove(tmpl);
    return 0;
}

static int empty_shard_writes_header_only(void) {
    char tmpl[] = "/tmp/qtqc_shard_test_XXXXXX";
    int fd = mkstemp(tmpl);
    EXPECT(fd >= 0);
    FILE *fp = fdopen(fd, "wb");
    EXPECT(fp != NULL);
    EXPECT(qtqc_shard_write(fp, 0u, NULL, 0, NULL, 0) == 0);
    fclose(fp);

    fp = fopen(tmpl, "rb");
    EXPECT(fp != NULL);
    qtqc_shard_header_t hdr;
    EXPECT(fread(&hdr, sizeof(hdr), 1, fp) == 1);
    EXPECT(hdr.seed_count == 0u);
    EXPECT(hdr.hit_count == 0u);
    int c = fgetc(fp);
    EXPECT(c == EOF);
    fclose(fp);
    remove(tmpl);
    return 0;
}

static int directory_count_mismatch_returns_error(void) {
    qtqc_shard_dir_entry_t dir[1];
    memset(dir, 0, sizeof(dir));
    dir[0].seed_hash = 1;
    dir[0].count_and_flags = qtqc_pack_count_and_flags(5, 0);

    char tmpl[] = "/tmp/qtqc_shard_test_XXXXXX";
    int fd = mkstemp(tmpl);
    EXPECT(fd >= 0);
    FILE *fp = fdopen(fd, "wb");
    EXPECT(fp != NULL);
    /* dir says 5 hits but we pass hit_count=2 → mismatch -> -1 */
    EXPECT(qtqc_shard_write(fp, 0u, dir, 1, NULL, 2) == -1);
    fclose(fp);
    remove(tmpl);
    return 0;
}

int main(void) {
    int rc = 0;
    rc |= round_trip_small_shard();
    rc |= empty_shard_writes_header_only();
    rc |= directory_count_mismatch_returns_error();
    if (rc == 0) printf("test_shard_codec: ok\n");
    return rc;
}
