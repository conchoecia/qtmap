#ifndef QTQC_SHA256_H
#define QTQC_SHA256_H

#include <stddef.h>
#include <stdint.h>

/*
 * Self-contained SHA-256 streaming hasher. No OpenSSL dependency so the same
 * code paths work in Emscripten/WASM and in the native CLI.
 */

typedef struct {
    uint32_t state[8];
    uint64_t bitlen;
    uint32_t datalen;
    uint8_t  data[64];
} qtqc_sha256_ctx;

void qtqc_sha256_init(qtqc_sha256_ctx *ctx);
void qtqc_sha256_update(qtqc_sha256_ctx *ctx, const void *data, size_t len);
void qtqc_sha256_final(qtqc_sha256_ctx *ctx, uint8_t out[32]);

/* Convenience: hex-encode a 32-byte digest into a 65-char buffer (incl. \0). */
void qtqc_sha256_hex(const uint8_t digest[32], char out[65]);

#endif
