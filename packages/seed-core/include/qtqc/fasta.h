#ifndef QTQC_FASTA_H
#define QTQC_FASTA_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

/*
 * Tiny streaming FASTA reader. Reads one contig at a time from a plain text
 * FASTA stream (no .fai index, no gzip — gunzip first). Returns each contig
 * via callback so callers can stream into the minimizer extractor without
 * holding the whole reference in memory.
 *
 * The callback's `seq` buffer is owned by the reader and only valid for the
 * duration of the call. It is uppercased and stripped of whitespace.
 */

typedef int (*qtqc_fasta_contig_cb)(
    void *user,
    uint32_t contig_id,
    const char *name,
    const char *seq, size_t seq_len);

/*
 * Iterate every contig in the FASTA stream `fp`, invoking `cb(user, ...)`
 * once per contig. Returns 0 on success, -1 on I/O or memory error, or the
 * first non-zero callback return code (callbacks may abort iteration).
 *
 * Contig IDs are assigned in stream order starting from 0.
 */
int qtqc_fasta_iter(FILE *fp, qtqc_fasta_contig_cb cb, void *user);

#endif
