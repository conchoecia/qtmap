# Synthetic tier-1 QC fixture

Small, fully synthetic genome + read set used as qtmap's primary CI
regression target. Committed to the repo so every test run hits the
same bytes without depending on external downloads or private data.

## Contents

- `synth.fa` — 4 random contigs `chr1..chr4`, 250 kb each (1 Mb total).
  Generated from `random.seed(42)`; reproducible byte-for-byte.
- `synth.fastq` — 5,000 simulated long reads. Lengths drawn from a
  lognormal centered at 700 bp (~250–1800 bp range), random contig and
  strand, 2 % per-base substitution error, constant Phred 40 quality.
  Read seed `4242`. Each header carries ground-truth coordinates
  (`truth_contig`, `truth_start`, `truth_len`, `truth_strand`) so the
  reads can be scored without the golden SAM.
- `synth.map-ont.native.sam` — `minimap2 -ax map-ont synth.fa synth.fastq`.
  Acts as the "ground truth that minimap2 sees" baseline. All 5,000 reads
  map; no supplementary, no secondary.
- `synth.expected.json` — summary metrics + seeds, so any drift in the
  generator or in minimap2 is immediately visible as a JSON diff.
- `index-out-1/` — `qtmap-index` output for `synth.fa` at `--k 15 --w 10
  --shard-bits 4`. 4 MB across 16 shards. Used by `mapper-core` and
  `mapper-worker` unit tests.

## Regeneration

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j
bash fixtures/synthetic/gen-synthetic.sh
```

Requires `python3`, `minimap2`, and a built `qtmap-index` binary at
`build/packages/seed-core/qtmap-index`. Every output file must be
byte-identical to what is committed — CI can `git diff` after regen to
prove the fixture is reproducible.

## Tier context

Tier 1 (this fixture) is the in-repo, every-PR smoke target. It runs
synthetic-only and trades realism for determinism and zero external
dependencies. Higher tiers exist for organism-level realism:

- **Tier 2** — yeast Hi-C (downloaded at CI time, see
  `scripts/cross-organism-test.sh` for the sacCer3 ONT analogue;
  Hi-C variant is forthcoming).
- **Tier 3** — 5 k subsampled Pore-C reads against mouse mm39 and
  human hg38 (private; hosted separately, not in repo).
- **Tier 4** — full-library benchmarks on the calibration fixtures
  (5KSR46 mm39, QDYBSX hg38); local-only, not in CI.
