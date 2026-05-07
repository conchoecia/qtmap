#!/usr/bin/env bash
# Deterministic synthetic FASTA generator for Phase 0 tests.
# Two contigs, 10kb each, repeatable Mersenne-twister seed so the build is
# bit-identical across machines and language stdlibs.

set -euo pipefail

OUT="${1:-$(dirname "$0")/synth.fa}"

python3 - <<'PY' > "${OUT}"
import random
random.seed(42)
bases = "ACGT"
for c in range(1, 3):
    print(f">contig{c}")
    seq = "".join(random.choice(bases) for _ in range(10000))
    for i in range(0, len(seq), 60):
        print(seq[i:i+60])
PY

echo "wrote ${OUT}"
wc -l "${OUT}"
