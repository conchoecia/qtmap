#!/usr/bin/env bash
# Deterministic synthetic FASTA + FASTQ generator for tier-1 CI fixtures.
#
# Outputs (all committed to the repo as the tier-1 QC fixture):
#   synth.fa                — 4 × 250 kb random contigs (1 Mb total)
#   synth.fastq             — 5000 simulated ONT reads (lognormal length,
#                             2 % substitution error, mixed strand)
#   synth.map-ont.native.sam — minimap2 -ax map-ont golden alignment of
#                             synth.fastq against synth.fa
#   synth.expected.json     — summary metrics + the seeds used, so any
#                             downstream regression has a fixed target
#
# Seeds + Python's Mersenne Twister make every byte deterministic across
# machines and libc revisions. Re-running this script must produce
# bit-identical files; CI verifies that against the committed copies.
#
# Tools required: python3, minimap2 (>= 2.22).

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
FA="${DIR}/synth.fa"
FQ="${DIR}/synth.fastq"
SAM="${DIR}/synth.map-ont.native.sam"
META="${DIR}/synth.expected.json"

GENOME_SEED=42
READ_SEED=4242
N_CONTIGS=4
CONTIG_LEN=250000
N_READS=5000
READ_LEN_MEAN=700
READ_LEN_SIGMA=0.45
SUB_ERR=0.02

python3 - "$FA" "$FQ" "$GENOME_SEED" "$READ_SEED" \
        "$N_CONTIGS" "$CONTIG_LEN" "$N_READS" \
        "$READ_LEN_MEAN" "$READ_LEN_SIGMA" "$SUB_ERR" <<'PY'
import math
import random
import sys

(fa_path, fq_path,
 g_seed, r_seed,
 n_contigs, contig_len, n_reads,
 read_mean, read_sigma, sub_err) = sys.argv[1:]

g_seed = int(g_seed); r_seed = int(r_seed)
n_contigs = int(n_contigs); contig_len = int(contig_len); n_reads = int(n_reads)
read_mean = float(read_mean); read_sigma = float(read_sigma); sub_err = float(sub_err)

BASES = "ACGT"
COMP = str.maketrans("ACGTN", "TGCAN")

g_rng = random.Random(g_seed)
contigs = []
for c in range(1, n_contigs + 1):
    name = f"chr{c}"
    seq = "".join(g_rng.choice(BASES) for _ in range(contig_len))
    contigs.append((name, seq))

with open(fa_path, "w") as fa:
    for name, seq in contigs:
        fa.write(f">{name}\n")
        for i in range(0, len(seq), 60):
            fa.write(seq[i:i+60] + "\n")

mu = math.log(read_mean) - 0.5 * read_sigma * read_sigma

r_rng = random.Random(r_seed)
with open(fq_path, "w") as fq:
    for i in range(n_reads):
        cname, cseq = r_rng.choice(contigs)
        raw_len = int(round(r_rng.lognormvariate(mu, read_sigma)))
        L = max(100, min(raw_len, contig_len - 1))
        start = r_rng.randrange(0, contig_len - L + 1)
        sub = cseq[start:start + L]
        if r_rng.random() < 0.5:
            sub = sub.translate(COMP)[::-1]
            strand = "-"
        else:
            strand = "+"
        out = list(sub)
        for j in range(L):
            if r_rng.random() < sub_err:
                orig = out[j]
                choices = [b for b in BASES if b != orig]
                out[j] = r_rng.choice(choices)
        read = "".join(out)
        qual = "I" * L
        hdr = (f"@read{i:05d} truth_contig={cname} truth_start={start} "
               f"truth_len={L} truth_strand={strand}")
        fq.write(hdr + "\n" + read + "\n+\n" + qual + "\n")
PY

echo "[fixtures/synthetic] genome:"
wc -c "$FA"
echo "[fixtures/synthetic] fastq:"
wc -l "$FQ"

minimap2 --version >/dev/null 2>&1 || {
    echo "minimap2 not on PATH; install via brew install minimap2" >&2
    exit 1
}

minimap2 -t 1 -a -x map-ont "$FA" "$FQ" 2>/dev/null > "$SAM"

# qtmap-index shards. Rebuilt every time so the fixture is reproducible
# from the FASTA alone; CI verifies the committed index matches the
# regenerated one byte-for-byte.
IDX_DIR="${DIR}/index-out-1"
QTMAP_INDEX="${QTMAP_INDEX:-${DIR}/../../build/packages/seed-core/qtmap-index}"
if [ ! -x "$QTMAP_INDEX" ]; then
    echo "qtmap-index binary not at ${QTMAP_INDEX}; run cmake build first" >&2
    echo "  cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j" >&2
    exit 1
fi
rm -rf "$IDX_DIR"
mkdir -p "$IDX_DIR"
"$QTMAP_INDEX" --in "$FA" --out "$IDX_DIR" \
    --k 15 --w 10 --shard-bits 4 --reference-id synth 2>&1 | tail -5

python3 - "$SAM" "$META" "$N_READS" "$GENOME_SEED" "$READ_SEED" <<'PY'
import json
import sys
sam, meta, n_reads, g_seed, r_seed = sys.argv[1:]
n_reads = int(n_reads)

mapped = unmapped = supp = sec = 0
with open(sam) as fp:
    for line in fp:
        if line.startswith("@"): continue
        flag = int(line.split("\t", 2)[1])
        if flag & 0x4:
            unmapped += 1
        else:
            mapped += 1
        if flag & 0x800: supp += 1
        if flag & 0x100: sec += 1

with open(meta, "w") as fp:
    json.dump({
        "n_reads": n_reads,
        "genome_seed": int(g_seed),
        "read_seed": int(r_seed),
        "minimap2_alignment_records": mapped + unmapped,
        "minimap2_mapped": mapped,
        "minimap2_unmapped": unmapped,
        "minimap2_supplementary": supp,
        "minimap2_secondary": sec,
    }, fp, indent=2)
    fp.write("\n")

print(f"[fixtures/synthetic] golden: mapped={mapped} unmapped={unmapped} "
      f"supp={supp} sec={sec}")
PY

echo "[fixtures/synthetic] wrote ${FA}, ${FQ}, ${SAM}, ${META}"
