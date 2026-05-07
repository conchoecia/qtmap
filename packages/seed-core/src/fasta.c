#include "qtqc/fasta.h"

#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * Streaming FASTA reader. Reads one contig at a time; uppercases bases and
 * strips whitespace into a growable buffer; calls the user callback once
 * per contig with `seq_len` set to the post-strip length.
 *
 * No support for multi-fasta gzip; callers must gunzip first. Indices are
 * not built — we walk the file linearly.
 */

typedef struct {
    char  *buf;
    size_t cap;
    size_t len;
} growbuf;

static int gb_reserve(growbuf *g, size_t need) {
    if (g->cap >= need) return 0;
    size_t cap = g->cap ? g->cap : 4096;
    while (cap < need) cap *= 2;
    char *p = (char *)realloc(g->buf, cap);
    if (!p) return -1;
    g->buf = p;
    g->cap = cap;
    return 0;
}

static int gb_append(growbuf *g, char c) {
    if (gb_reserve(g, g->len + 1) < 0) return -1;
    g->buf[g->len++] = c;
    return 0;
}

int qtqc_fasta_iter(FILE *fp, qtqc_fasta_contig_cb cb, void *user) {
    growbuf seq = {0};
    growbuf name = {0};
    uint32_t contig_id = 0;
    int rc = 0;
    int in_header = 0;
    int have_contig = 0;

    int c;
    while ((c = fgetc(fp)) != EOF) {
        if (c == '>') {
            /* Flush previous contig if any. */
            if (have_contig) {
                if (gb_append(&seq, '\0') < 0) { rc = -1; goto out; }
                if (gb_append(&name, '\0') < 0) { rc = -1; goto out; }
                int cb_rc = cb(user, contig_id, name.buf, seq.buf, seq.len - 1);
                if (cb_rc != 0) { rc = cb_rc; goto out; }
                ++contig_id;
            }
            seq.len = 0;
            name.len = 0;
            in_header = 1;
            have_contig = 1;
            continue;
        }
        if (in_header) {
            if (c == '\n' || c == '\r') {
                in_header = 0;
            } else if (name.len == 0 && (c == ' ' || c == '\t')) {
                /* skip leading whitespace in name */
            } else if (c == ' ' || c == '\t') {
                /* truncate name at first whitespace */
                in_header = 0;
                /* drain rest of header line */
                while ((c = fgetc(fp)) != EOF && c != '\n') { /* noop */ }
            } else {
                if (gb_append(&name, (char)c) < 0) { rc = -1; goto out; }
            }
            continue;
        }
        if (isspace((unsigned char)c)) continue;
        if (gb_append(&seq, (char)toupper(c)) < 0) { rc = -1; goto out; }
    }

    if (have_contig) {
        if (gb_append(&seq, '\0') < 0) { rc = -1; goto out; }
        if (gb_append(&name, '\0') < 0) { rc = -1; goto out; }
        int cb_rc = cb(user, contig_id, name.buf, seq.buf, seq.len - 1);
        if (cb_rc != 0) rc = cb_rc;
    }

out:
    free(seq.buf);
    free(name.buf);
    return rc;
}
