# Validation Plan

## Goal

Prove whether a browser-native mapper can replace the current minimap2-WASM path
for QTQC mammal Dip-C QC.

Success means:

- Chrome runtime becomes practical.
- Firefox stays practical.
- Contact QC summaries agree with native minimap2 closely enough for QTQC.
- Browser memory stays bounded.
- Failed or partial reference installs are detectable.

## Baselines

Use these as comparison baselines:

1. Native minimap2 on the same FASTQ/reference.
2. Current QTQC minimap2-WASM path in Firefox.
3. Current QTQC minimap2-WASM path in Chrome.

Relevant current QTQC logs:

- `../../qtqc/docs/benchmarks/raw-run-logs/2026-05-07-5ksr46-browser-runs/`

## Test Datasets

### Tiny smoke references

Purpose: algorithm correctness and deterministic tests.

- synthetic contigs
- known read placements
- known split reads
- repeated k-mer cases
- reverse-strand cases

### Small real references

Purpose: browser workflow and install testing.

- bacterial genome
- yeast genome
- small bait/adapter reference

### QTQC benchmark FASTQ

Purpose: continuity with current evidence.

- `5KSR46_2_DX_PIT_11.fastq`, 5,000 reads
- mouse mm39
- compare with archived QTQC logs

### Larger stress cases

Purpose: practical limits.

- 50k reads
- 100k reads
- hg38
- mm39
- low-memory mode
- high-sensitivity mode

## Metrics

Runtime:

- total analysis time
- reference install verification time
- seed extraction time
- shard planning time
- shard read time
- anchor generation time
- chaining time
- optional refinement time

Memory:

- active shard bytes
- peak JS heap where available
- active ArrayBuffer bytes tracked by engine
- worker count
- OPFS storage usage

Mapping:

- mapped reads
- uniquely placed reads
- multi-mapped reads
- unmapped reads
- mapped segments per read
- best/second-best confidence margin

Contact QC:

- raw pair count
- deduplicated pair count
- cis/trans fraction
- distance decay curve
- per-library contacts
- agreement with native minimap2-based QTQC

Browser stability:

- successful report generation
- automatic log/report download
- crash/no-crash
- repeated run behavior
- background tab behavior

## Acceptance Thresholds For MVP

For the 5,000-read mm39 benchmark:

- Chrome total time target: under 6 minutes.
- Firefox total time target: under 5 minutes.
- Mapped reads: within 5% relative of native minimap2/QTQC baseline.
- Dip-C contacts after filtering: within 10% relative of baseline.
- Interchromosomal fraction: within 0.05 absolute of baseline.
- No browser crash after report rendering.
- Peak tracked active index memory under 1.5 GiB.

These are initial thresholds. They can be tightened after the first prototype.

## Phase 0: Index Prototype

Deliverables:

- index builder for tiny FASTA
- binary shard writer
- manifest with sizes and SHA-256
- parser tests

Pass criteria:

- deterministic output
- validates checksums
- can answer seed lookup queries

## Phase 1: Placement Prototype

Deliverables:

- query minimizer extraction
- shard loading from local files or OPFS
- anchor generation
- simple chaining
- approximate placements

Pass criteria:

- synthetic reads map to expected contigs and positions
- repeated seeds are handled without explosion
- reverse-strand reads work

## Phase 2: QTQC Benchmark Prototype

Deliverables:

- mm39 package for browser testing
- QTQC benchmark FASTQ mapping
- output converter to QTQC pair/contact summaries

Pass criteria:

- Firefox and Chrome both complete
- contact summary is plausibly close to current minimap2-WASM output
- detailed run log exists

## Phase 3: Browser Performance Tuning

Experiments:

- shard size sweep
- seed density sweep
- LRU cache size sweep
- worker count sweep
- OPFS async reads vs sync access handles
- TypeScript hot loops vs Rust/WASM kernels
- weighted minimizer vs frequency cap

Pass criteria:

- Chrome no longer has pathological index-load behavior
- performance differences between Chrome and Firefox are explainable

## Phase 4: Production Decision

Possible outcomes:

1. Adopt as QTQC default for browser QC mapping.
2. Offer as Chrome fallback and keep minimap2-WASM for Firefox.
3. Keep as research prototype if accuracy is inadequate.
4. Move to a native local helper if browser-only mapping remains too costly.

## Required Reports

Each benchmark run should produce:

- raw run log
- machine-readable summary TSV
- browser console log
- reference manifest hash
- versioned mapper build ID
- comparison against native minimap2

No sequence reads should be committed to the repo unless explicitly cleared.
