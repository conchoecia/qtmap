#!/usr/bin/env bash
# Cross-organism calibration check for qtqc-mm2-index + the mapper.
#
# Builds an index for S. cerevisiae sacCer3 (~12 Mbp, ~38 % GC),
# generates 200 noiseless cut-and-RC reads from the reference, runs
# them through the mapper, and reports placement match rate vs truth.
#
# A regression here means the calibration constants in fragment-select.js
# / chain.js have drifted. A normal run produces:
#     primary placements : 200 / 200
#     ±10 bp match       : ≥ 95 %
#     ±50 bp match       : ≥ 97 %
#
# Usage: bash scripts/cross-organism-test.sh

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR="${WORKDIR:-/tmp/qtqc_cross_organism}"
mkdir -p "$WORKDIR"

echo "[1/4] download sacCer3 if missing"
if [ ! -s "$WORKDIR/sacCer3.fa" ]; then
    /usr/bin/curl -s -L -o "$WORKDIR/sacCer3.fa.gz" \
        https://hgdownload.soe.ucsc.edu/goldenPath/sacCer3/bigZips/sacCer3.fa.gz
    gunzip -kf "$WORKDIR/sacCer3.fa.gz"
fi

echo "[2/4] build index (w=15)"
mkdir -p "$WORKDIR/index_w15"
"$ROOT/build/packages/seed-core/qtqc-mm2-index" \
    --in "$WORKDIR/sacCer3.fa" \
    --out "$WORKDIR/index_w15" \
    --shard-bits 12 \
    --reference-id sacCer3 \
    --taxid 559292 \
    --w 15 \
    --freq-cap 1000 2>&1 | tail -2

echo "[3/4] simulate 200 noiseless reads (100 fwd, 100 rev-comp) + truth"
python3 << 'PY'
import random, os
random.seed(7)
WORKDIR = os.environ.get('WORKDIR', '/tmp/qtqc_cross_organism')
contigs = {}
name = None; seq = []
with open(f'{WORKDIR}/sacCer3.fa') as f:
    for line in f:
        if line.startswith('>'):
            if name: contigs[name] = ''.join(seq)
            name = line[1:].split()[0]; seq = []
        else:
            seq.append(line.strip().upper())
    if name: contigs[name] = ''.join(seq)
def rc(s):
    comp = {'A':'T','T':'A','C':'G','G':'C','N':'N'}
    return ''.join(comp.get(c, 'N') for c in reversed(s))
ctg_names = [n for n in contigs if not n.startswith('chrM') and contigs[n] and len(contigs[n]) > 5000]
with open(f'{WORKDIR}/reads.fastq', 'w') as f:
    idx = 0
    while idx < 200:
        c = random.choice(ctg_names)
        seq_c = contigs[c]
        L = random.randint(200, 800)
        if L >= len(seq_c): continue
        start = random.randint(0, len(seq_c) - L)
        chunk = seq_c[start:start+L]
        if 'N' in chunk: continue
        rev = idx >= 100
        out_seq = rc(chunk) if rev else chunk
        f.write(f'@yeast_r{idx} truth={c}:{start}:{rev}\n{out_seq}\n+\n{"!"*L}\n')
        idx += 1
PY
export WORKDIR
echo "[4/4] run mapper + verify"
node "$ROOT/packages/benchmark-runner/src/run-mapper.js" \
    --reference "$WORKDIR/index_w15" \
    --reads     "$WORKDIR/reads.fastq" \
    --out       "$WORKDIR/ours.sam" \
    --batch     200 --secondary 0 2>&1 | tail -5

node --input-type=module -e "
import { readFileSync } from 'node:fs';
const sam = readFileSync('$WORKDIR/ours.sam', 'utf8');
const fq = readFileSync('$WORKDIR/reads.fastq', 'utf8');
const truth = new Map();
for (const block of fq.split('\n@')) {
    const lines = block.split('\n');
    if (!lines[0]) continue;
    const header = lines[0].startsWith('@') ? lines[0].slice(1) : lines[0];
    const m = /^(yeast_r\d+) truth=(.*?):(\d+):(True|False)$/.exec(header);
    if (m) truth.set(m[1], { ref: m[2], pos: parseInt(m[3], 10), reverse: m[4] === 'True' });
}
let placed = 0, w10 = 0, w50 = 0;
for (const line of sam.split('\n')) {
    if (!line || line.startsWith('@')) continue;
    const f = line.split('\t');
    const flag = parseInt(f[1], 10);
    if (flag & 0x4) continue;
    if (flag & 0x100) continue;
    if (flag & 0x800) continue;
    const t = truth.get(f[0]);
    if (!t) continue;
    placed++;
    if (f[2] !== t.ref) continue;
    if (((flag & 0x10) !== 0) !== t.reverse) continue;
    const dp = Math.abs(parseInt(f[3], 10) - 1 - t.pos);
    if (dp <= 10) w10++;
    if (dp <= 50) w50++;
}
console.log('  primary placements: ' + placed + ' / 200');
console.log('  +-10 bp match:      ' + w10 + ' / 200 (' + (w10/200*100).toFixed(1) + '%)');
console.log('  +-50 bp match:      ' + w50 + ' / 200 (' + (w50/200*100).toFixed(1) + '%)');
process.exitCode = (placed >= 200 && w10 >= 190) ? 0 : 1;
"
