#include "qtqc/fasta.h"
#include "qtqc/hash.h"
#include "qtqc/minimizer.h"
#include "qtqc/sha256.h"
#include "qtqc/shard.h"

#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/*
 * qtqc-mm2-index — offline index builder for the browser mapper.
 *
 * Usage:
 *   qtqc-mm2-index --in REF.fa --out DIR [--k 15] [--w 10] [--shard-bits 12]
 *                  [--reference-id mm39] [--taxid 10090] [--freq-cap 1000]
 *
 * Outputs into DIR:
 *   reference.json         — manifest with per-file SHA-256
 *   contigs.bin            — packed contig table
 *   seed-shard-NNNN.bin    — one per (1 << shard_bits) shard
 *   build-report.json      — per-shard hit counts, distinct-seed histogram
 *
 * MVP single-threaded. mm39 walltime estimate: 5-15 min on a modern laptop.
 */

typedef struct {
    uint64_t hash;
    uint32_t contig_id;
    uint32_t pos;
    uint32_t flags; /* bit 0 = strand */
} record_t;

typedef struct {
    record_t *recs;
    size_t    n;
    size_t    cap;
} shard_buf_t;

typedef struct {
    char     *name;
    uint64_t  length;
} contig_t;

typedef struct {
    int   k;
    int   w;
    int   shard_bits;
    uint32_t freq_cap;

    contig_t *contigs;
    size_t    contig_n;
    size_t    contig_cap;

    shard_buf_t *shards;   /* (1 << shard_bits) buffers */
    size_t       shard_n;

    qtqc_minimizer_t *mz_buf;
    size_t            mz_cap;
} build_ctx_t;

static void die(const char *msg) {
    fprintf(stderr, "qtqc-mm2-index: %s\n", msg);
    exit(2);
}

static int reserve_records(shard_buf_t *s, size_t add) {
    if (s->n + add <= s->cap) return 0;
    size_t cap = s->cap ? s->cap : 1024;
    while (cap < s->n + add) cap *= 2;
    record_t *p = (record_t *)realloc(s->recs, cap * sizeof(*p));
    if (!p) return -1;
    s->recs = p;
    s->cap = cap;
    return 0;
}

static int reserve_mz(build_ctx_t *ctx, size_t need) {
    if (ctx->mz_cap >= need) return 0;
    size_t cap = ctx->mz_cap ? ctx->mz_cap : 1u << 20;
    while (cap < need) cap *= 2;
    qtqc_minimizer_t *p = (qtqc_minimizer_t *)realloc(ctx->mz_buf, cap * sizeof(*p));
    if (!p) return -1;
    ctx->mz_buf = p;
    ctx->mz_cap = cap;
    return 0;
}

static int reserve_contig(build_ctx_t *ctx) {
    if (ctx->contig_n + 1 <= ctx->contig_cap) return 0;
    size_t cap = ctx->contig_cap ? ctx->contig_cap * 2 : 64;
    contig_t *p = (contig_t *)realloc(ctx->contigs, cap * sizeof(*p));
    if (!p) return -1;
    ctx->contigs = p;
    ctx->contig_cap = cap;
    return 0;
}

/* Callback for each FASTA contig: extract minimizers and bucket them. */
static int on_contig(void *user, uint32_t contig_id,
                     const char *name, const char *seq, size_t seq_len) {
    build_ctx_t *ctx = (build_ctx_t *)user;

    if (reserve_contig(ctx) < 0) return -1;
    ctx->contigs[ctx->contig_n].name = strdup(name);
    if (!ctx->contigs[ctx->contig_n].name) return -1;
    ctx->contigs[ctx->contig_n].length = seq_len;
    ++ctx->contig_n;

    if (seq_len < (size_t)ctx->k) return 0;
    if (reserve_mz(ctx, seq_len) < 0) return -1;

    size_t mn = qtqc_extract_minimizers(seq, seq_len, ctx->k, ctx->w, ctx->mz_buf);

    /* Partition by the LOW shardBits of the hash. mm_hash64_v1 is masked to
       2*k bits, so high bits are zero for k<32; using low bits gives a
       uniform distribution regardless of k. The browser planner uses the
       same low-bits scheme. */
    const uint64_t shard_mask = (UINT64_C(1) << ctx->shard_bits) - 1u;
    for (size_t i = 0; i < mn; ++i) {
        uint64_t h = ctx->mz_buf[i].hash;
        size_t   sid = (size_t)(h & shard_mask);
        if (reserve_records(&ctx->shards[sid], 1) < 0) return -1;
        record_t *r = &ctx->shards[sid].recs[ctx->shards[sid].n++];
        r->hash = h;
        r->contig_id = contig_id;
        r->pos = ctx->mz_buf[i].pos;
        r->flags = ctx->mz_buf[i].strand & 1u;
    }
    return 0;
}

static int rec_cmp(const void *a, const void *b) {
    const record_t *ra = (const record_t *)a;
    const record_t *rb = (const record_t *)b;
    if (ra->hash < rb->hash) return -1;
    if (ra->hash > rb->hash) return 1;
    if (ra->contig_id < rb->contig_id) return -1;
    if (ra->contig_id > rb->contig_id) return 1;
    if (ra->pos < rb->pos) return -1;
    if (ra->pos > rb->pos) return 1;
    return 0;
}

/* Run SHA-256 over an entire file path. Returns 0 on success. */
static int file_sha256(const char *path, uint64_t *out_size, char hex[65]) {
    FILE *fp = fopen(path, "rb");
    if (!fp) return -1;
    qtqc_sha256_ctx ctx;
    qtqc_sha256_init(&ctx);
    uint8_t buf[1 << 16];
    uint64_t total = 0;
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), fp)) > 0) {
        qtqc_sha256_update(&ctx, buf, n);
        total += n;
    }
    fclose(fp);
    uint8_t digest[32];
    qtqc_sha256_final(&ctx, digest);
    qtqc_sha256_hex(digest, hex);
    *out_size = total;
    return 0;
}

typedef struct {
    char path[64];
    uint64_t size;
    char sha256[65];
} manifest_file_t;

static int write_contigs_bin(const char *path, const contig_t *contigs, size_t n) {
    FILE *fp = fopen(path, "wb");
    if (!fp) return -1;

    /* Header: u32 contig_count, u32 reserved, then per-contig records, then names blob. */
    uint32_t count = (uint32_t)n;
    uint32_t reserved = 0;
    if (fwrite(&count, 4, 1, fp) != 1) goto err;
    if (fwrite(&reserved, 4, 1, fp) != 1) goto err;

    /* Per-contig: u32 name_offset (in names blob), u16 name_len, u16 reserved, u64 length. */
    uint32_t name_offset = 0;
    for (size_t i = 0; i < n; ++i) {
        uint16_t nl = (uint16_t)strlen(contigs[i].name);
        uint16_t rs = 0;
        if (fwrite(&name_offset, 4, 1, fp) != 1) goto err;
        if (fwrite(&nl, 2, 1, fp) != 1) goto err;
        if (fwrite(&rs, 2, 1, fp) != 1) goto err;
        if (fwrite(&contigs[i].length, 8, 1, fp) != 1) goto err;
        name_offset += nl;
    }

    /* Names blob: concatenated, no separators. */
    for (size_t i = 0; i < n; ++i) {
        size_t nl = strlen(contigs[i].name);
        if (fwrite(contigs[i].name, 1, nl, fp) != nl) goto err;
    }
    fclose(fp);
    return 0;
err:
    fclose(fp);
    return -1;
}

static void usage(void) {
    fprintf(stderr,
        "usage: qtqc-mm2-index --in REF.fa --out DIR\n"
        "                      [--k 15] [--w 10] [--shard-bits 12]\n"
        "                      [--reference-id ID] [--taxid N] [--freq-cap 1000]\n");
    exit(2);
}

int main(int argc, char **argv) {
    const char *in_path = NULL;
    const char *out_dir = NULL;
    const char *reference_id = "unknown";
    int taxid = 0;
    build_ctx_t ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.k = 15;
    ctx.w = 10;
    ctx.shard_bits = 12;
    ctx.freq_cap = 1000;

    for (int i = 1; i < argc; ++i) {
        const char *a = argv[i];
        if      (!strcmp(a, "--in")            && i + 1 < argc) in_path = argv[++i];
        else if (!strcmp(a, "--out")           && i + 1 < argc) out_dir = argv[++i];
        else if (!strcmp(a, "--k")             && i + 1 < argc) ctx.k = atoi(argv[++i]);
        else if (!strcmp(a, "--w")             && i + 1 < argc) ctx.w = atoi(argv[++i]);
        else if (!strcmp(a, "--shard-bits")    && i + 1 < argc) ctx.shard_bits = atoi(argv[++i]);
        else if (!strcmp(a, "--reference-id")  && i + 1 < argc) reference_id = argv[++i];
        else if (!strcmp(a, "--taxid")         && i + 1 < argc) taxid = atoi(argv[++i]);
        else if (!strcmp(a, "--freq-cap")      && i + 1 < argc) ctx.freq_cap = (uint32_t)strtoul(argv[++i], NULL, 10);
        else { fprintf(stderr, "unknown arg: %s\n", a); usage(); }
    }
    if (!in_path || !out_dir) usage();
    if (ctx.k <= 0 || ctx.k > 28)        die("k must be in 1..28");
    if (ctx.w <= 0)                      die("w must be >= 1");
    if (ctx.shard_bits < 1 || ctx.shard_bits > 20)
                                          die("shard-bits must be in 1..20");

    ctx.shard_n = (size_t)1 << ctx.shard_bits;
    ctx.shards = (shard_buf_t *)calloc(ctx.shard_n, sizeof(*ctx.shards));
    if (!ctx.shards) die("alloc shards");

    fprintf(stderr, "[qtqc-mm2-index] reading %s ...\n", in_path);
    clock_t t0 = clock();

    FILE *fa = fopen(in_path, "rb");
    if (!fa) die("cannot open input FASTA");
    if (qtqc_fasta_iter(fa, on_contig, &ctx) < 0) die("FASTA iteration failed");
    fclose(fa);

    fprintf(stderr, "[qtqc-mm2-index] %zu contigs, building shards ...\n", ctx.contig_n);

    /* Sort + write each shard. */
    manifest_file_t *files = (manifest_file_t *)calloc(
        ctx.shard_n + 2, sizeof(*files));
    if (!files) die("alloc manifest");
    size_t file_n = 0;

    /* contigs.bin */
    char contigs_path[1024];
    snprintf(contigs_path, sizeof(contigs_path), "%s/contigs.bin", out_dir);
    if (write_contigs_bin(contigs_path, ctx.contigs, ctx.contig_n) < 0)
        die("write contigs.bin");
    snprintf(files[file_n].path, sizeof(files[file_n].path), "contigs.bin");
    if (file_sha256(contigs_path, &files[file_n].size, files[file_n].sha256) < 0)
        die("sha256 contigs.bin");
    ++file_n;

    /* per-shard files */
    uint64_t total_hits = 0;
    uint64_t total_distinct = 0;
    uint64_t capped_seeds = 0;
    for (size_t sid = 0; sid < ctx.shard_n; ++sid) {
        shard_buf_t *s = &ctx.shards[sid];
        char path[1024];
        snprintf(path, sizeof(path), "%s/seed-shard-%04zu.bin", out_dir, sid);
        FILE *fp = fopen(path, "wb");
        if (!fp) die("open shard file for write");

        if (s->n == 0) {
            /* still emit an empty shard so reference.json stays uniform */
            qtqc_shard_write(fp, (uint32_t)sid, NULL, 0, NULL, 0);
        } else {
            qsort(s->recs, s->n, sizeof(record_t), rec_cmp);

            /* Build directory + hits arrays. Apply freq cap by dropping
               oversize seeds entirely (skip them in directory + hits). */
            qtqc_shard_dir_entry_t *dir = (qtqc_shard_dir_entry_t *)
                calloc(s->n, sizeof(*dir));
            qtqc_shard_hit_t *hits = (qtqc_shard_hit_t *)
                calloc(s->n, sizeof(*hits));
            if (!dir || !hits) die("alloc shard write buffers");

            uint32_t dir_n = 0;
            uint64_t hit_n = 0;
            size_t i = 0;
            while (i < s->n) {
                size_t j = i + 1;
                while (j < s->n && s->recs[j].hash == s->recs[i].hash) ++j;
                uint32_t cnt = (uint32_t)(j - i);
                if (cnt > ctx.freq_cap) {
                    capped_seeds += cnt;
                } else {
                    dir[dir_n].seed_hash = s->recs[i].hash;
                    dir[dir_n].hit_offset = 0; /* recomputed in writer */
                    dir[dir_n].count_and_flags = qtqc_pack_count_and_flags(cnt, 0);
                    for (size_t r = i; r < j; ++r) {
                        if (s->recs[r].contig_id > 0xFFu) {
                            die("contig_id exceeds 8-bit cap (drop alts before build)");
                        }
                        hits[hit_n].contig_id = (uint16_t)s->recs[r].contig_id;
                        hits[hit_n].pos_strand_flags = qtqc_pack_pos_strand_flags(
                            s->recs[r].pos,
                            s->recs[r].flags & 1u,
                            (s->recs[r].flags >> 1) & QTQC_HIT_FLAGS_MASK);
                        ++hit_n;
                    }
                    ++dir_n;
                    ++total_distinct;
                }
                i = j;
            }
            total_hits += hit_n;

            if (qtqc_shard_write(fp, (uint32_t)sid, dir, dir_n, hits, hit_n) < 0)
                die("shard write failed");
            free(dir);
            free(hits);
        }
        fclose(fp);

        snprintf(files[file_n].path, sizeof(files[file_n].path),
                 "seed-shard-%04zu.bin", sid);
        if (file_sha256(path, &files[file_n].size, files[file_n].sha256) < 0)
            die("sha256 shard");
        ++file_n;

        /* free this shard's record buffer once it's on disk */
        free(s->recs);
        s->recs = NULL;
        s->n = 0;
        s->cap = 0;
    }

    /* reference.json */
    char manifest_path[1024];
    snprintf(manifest_path, sizeof(manifest_path), "%s/reference.json", out_dir);
    FILE *jf = fopen(manifest_path, "wb");
    if (!jf) die("open reference.json for write");

    fprintf(jf, "{\n");
    fprintf(jf, "  \"format\": \"qtqc-mm2browser-reference\",\n");
    fprintf(jf, "  \"formatVersion\": 1,\n");
    fprintf(jf, "  \"referenceId\": \"%s\",\n", reference_id);
    fprintf(jf, "  \"taxid\": %d,\n", taxid);
    fprintf(jf, "  \"seedScheme\": \"canonical-minimizer\",\n");
    fprintf(jf, "  \"k\": %d,\n", ctx.k);
    fprintf(jf, "  \"w\": %d,\n", ctx.w);
    fprintf(jf, "  \"shardBits\": %d,\n", ctx.shard_bits);
    fprintf(jf, "  \"hashFn\": \"mm_hash64_v1\",\n");
    fprintf(jf, "  \"hashFnId\": %u,\n", qtqc_hash_function_id());
    fprintf(jf, "  \"seedSchemeParams\": { \"freqCapPerHash\": %u },\n", ctx.freq_cap);
    fprintf(jf, "  \"contigs\": %zu,\n", ctx.contig_n);
    fprintf(jf, "  \"shards\": %zu,\n", ctx.shard_n);
    fprintf(jf, "  \"totalHits\": %" PRIu64 ",\n", total_hits);
    fprintf(jf, "  \"distinctSeeds\": %" PRIu64 ",\n", total_distinct);
    fprintf(jf, "  \"cappedSeedHits\": %" PRIu64 ",\n", capped_seeds);
    fprintf(jf, "  \"files\": [\n");
    for (size_t i = 0; i < file_n; ++i) {
        fprintf(jf, "    { \"path\": \"%s\", \"size\": %" PRIu64
                    ", \"sha256\": \"%s\" }%s\n",
                files[i].path, files[i].size, files[i].sha256,
                (i + 1 == file_n) ? "" : ",");
    }
    fprintf(jf, "  ]\n");
    fprintf(jf, "}\n");
    fclose(jf);

    double secs = (double)(clock() - t0) / (double)CLOCKS_PER_SEC;
    fprintf(stderr,
        "[qtqc-mm2-index] done. %zu contigs, %" PRIu64 " hits across %zu shards"
        " (%" PRIu64 " distinct seeds, %" PRIu64 " hits dropped by freq cap)"
        " in %.2fs\n",
        ctx.contig_n, total_hits, ctx.shard_n,
        total_distinct, capped_seeds, secs);

    /* cleanup */
    for (size_t i = 0; i < ctx.contig_n; ++i) free(ctx.contigs[i].name);
    free(ctx.contigs);
    free(ctx.shards);
    free(ctx.mz_buf);
    free(files);
    return 0;
}
