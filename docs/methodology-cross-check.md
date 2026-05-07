# Methodology Cross-Check: scNanoHi-C / Pore-C

This note records what the established Nanopore-Hi-C pipelines do, so future
contributors do not re-litigate decisions about pre-segmentation, MAPQ
thresholds, or how to handle multi-fragment reads.

## Reference pipelines

- **scNanoHi-C** — Li et al. 2023, *Nature Methods*. Single-cell Hi-C with
  Nanopore long reads. Uses `bwa bwasw` for alignment.
- **Pore-C-Snakemake / `pore_c`** — Oxford Nanopore's reference pipeline.
  Same `bwa bwasw` alignment, same downstream fragment-assignment model.
- **`pore-c-py`** — newer Nanopore tooling that has migrated to
  `minimap2 -ax map-ont -Y` for the alignment stage.

## What they do

1. **Demultiplex + adapter trim + length filter.** Reads <500 bp are dropped.
   Reads >100 kb are dropped before mapping (bwa-sw stability).
2. **Map the whole concatamer** as a single read. No pre-segmentation at
   restriction-enzyme cut sites. Splitting is recovered post-hoc from
   chimeric/supplementary SAM records.
3. **Keep every primary AND supplementary alignment** as a separate monomer.
   Each alignment is renamed `<read_id>:<read_idx>:<align_idx>`. Secondary
   alignments are also kept.
4. **Virtual digest of the reference** (e.g. MboI = `^GATC`) produces a
   restriction-fragment table.
5. **Assign each alignment to a fragment** by maximum overlap. Contacts are
   defined at the fragment level, not the bp level.
6. **Filter at the contact level**, not at the alignment level: drop
   adjacent-fragment / <1 kb close / duplicate / promiscuous (>10
   interactions) / isolated (no contact within 1 Mb).
7. **MAPQ cutoff = 1** for the main contact pipeline (very liberal). The
   strict MAPQ > 30 cited in the paper applies only to the orthogonal MALBAC
   scWGS validation track.

## Why this matters for qtqc-mm2browser

We are emitting SAM that downstream tooling (QTQC's `dipc-sam.js`,
hickit, pairtools, pore_c) will consume. To stay compatible:

- **Do not pre-segment reads.** Map the whole concatamer, emit primary +
  supplementary records.
- **Do not filter on MAPQ.** Calibrate MAPQ values close to minimap2's
  formula; the downstream tool picks the threshold.
- **Soft-clip vs hard-clip on supplementary records:** the pinned 5KSR46
  fixture used the default `minimap2 -x map-ont`, which hard-clips
  supplementary alignments. Match the fixture by default. Expose a
  `--soft-clip-supp` flag for users who feed downstream tools that need full
  read sequence on every record.
- **Optional length pre-filter** at the FASTQ chunker: `--min-len 500`
  (drop tiny reads), `--max-len 100000` (parity with their cap). Default
  off; expose as flags. Big speed win on noisy Nanopore runs.
- **Restriction-fragment-aware contact calling is downstream's job**, not
  ours. Our mapper output should be the same SAM minimap2 produces; the
  downstream tool does virtual digest + fragment intersection.

## Sources

- Paper: Li et al. 2023, scNanoHi-C, Nature Methods.
- Repos:
  - https://github.com/LuJiansen/scNanoHi-C
  - https://github.com/nanoporetech/Pore-C-Snakemake
  - https://github.com/nanoporetech/pore-c
  - https://github.com/nanoporetech/pore-c-py (newer minimap2-based)
