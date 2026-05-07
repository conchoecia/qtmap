#include "qtqc/sha256.h"

#include <stdio.h>
#include <string.h>

#define EXPECT(expr) do { \
    if (!(expr)) { \
        fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #expr); \
        return 1; \
    } \
} while (0)

/* RFC 6234 / FIPS 180-4 known-answer vectors. */

static int kat_empty(void) {
    qtqc_sha256_ctx ctx;
    qtqc_sha256_init(&ctx);
    uint8_t digest[32];
    qtqc_sha256_final(&ctx, digest);
    char hex[65];
    qtqc_sha256_hex(digest, hex);
    EXPECT(strcmp(hex,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") == 0);
    return 0;
}

static int kat_abc(void) {
    qtqc_sha256_ctx ctx;
    qtqc_sha256_init(&ctx);
    qtqc_sha256_update(&ctx, "abc", 3);
    uint8_t digest[32];
    qtqc_sha256_final(&ctx, digest);
    char hex[65];
    qtqc_sha256_hex(digest, hex);
    EXPECT(strcmp(hex,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") == 0);
    return 0;
}

static int kat_long(void) {
    /* "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq" */
    const char *msg =
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    qtqc_sha256_ctx ctx;
    qtqc_sha256_init(&ctx);
    qtqc_sha256_update(&ctx, msg, strlen(msg));
    uint8_t digest[32];
    qtqc_sha256_final(&ctx, digest);
    char hex[65];
    qtqc_sha256_hex(digest, hex);
    EXPECT(strcmp(hex,
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1") == 0);
    return 0;
}

static int streaming_matches_one_shot(void) {
    /* Update in many small chunks must equal one big update. */
    const char *msg =
        "the quick brown fox jumps over the lazy dog. "
        "the quick brown fox jumps over the lazy dog. "
        "the quick brown fox jumps over the lazy dog. "
        "the quick brown fox jumps over the lazy dog.";
    size_t n = strlen(msg);

    qtqc_sha256_ctx a;
    qtqc_sha256_init(&a);
    qtqc_sha256_update(&a, msg, n);
    uint8_t da[32];
    qtqc_sha256_final(&a, da);

    qtqc_sha256_ctx b;
    qtqc_sha256_init(&b);
    for (size_t i = 0; i < n; ++i) qtqc_sha256_update(&b, msg + i, 1);
    uint8_t db[32];
    qtqc_sha256_final(&b, db);

    EXPECT(memcmp(da, db, 32) == 0);
    return 0;
}

int main(void) {
    int rc = 0;
    rc |= kat_empty();
    rc |= kat_abc();
    rc |= kat_long();
    rc |= streaming_matches_one_shot();
    if (rc == 0) printf("test_sha256: ok\n");
    return rc;
}
