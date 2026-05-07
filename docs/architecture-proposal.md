# Architecture Proposal

## Summary

`qtmap` should be a browser-native QC mapper. It should use an
offline-built minimizer index stored as explicit binary shards, then map reads in
workers using typed arrays and bounded memory.

The first implementation should prioritize stability and observability over
full alignment fidelity.

## Packages

Proposed repo layout:

```text
packages/
  index-builder/        # Node/Rust CLI that builds browser reference packages
  mapper-core/          # TypeScript core data structures and scoring
  mapper-worker/        # Web Worker runtime
  qtqc-adapter/         # Thin integration layer for QTQC
  benchmark-runner/     # Browser and native comparison harness
docs/
  research-notes.md
  design-considerations.md
  architecture-proposal.md
  validation-plan.md
  open-questions.md
```

No code exists yet. This is a target shape.

## Reference Build Pipeline

Inputs:

- reference FASTA
- assembly metadata
- species metadata
- seed parameters
- repetitive k-mer thresholds

Build stages:

1. Normalize contig names and metadata.
2. Compute canonical k-mers/minimizers.
3. Count seed frequencies.
4. Apply frequency caps or weights.
5. Emit seed hit records.
6. Partition records into shards by seed hash prefix.
7. Sort within shard by seed hash and position.
8. Build compact per-shard seed directory.
9. Write binary shards.
10. Compute SHA-256 checksums.
11. Write `reference.json` and `build-report.json`.

The builder can be native Node/Rust because reference packages are produced by
QTQC maintainers, not by the browser.

## Browser Install Pipeline

Inputs:

- hosted `reference.json`
- shard URLs
- expected sizes and checksums

Install stages:

1. Fetch manifest.
2. Check compatibility with mapper version.
3. Download files to temporary OPFS names.
4. Verify size as each file completes.
5. Verify SHA-256 for each file.
6. Atomically rename or mark final files.
7. Write install marker containing manifest hash.
8. Expose installed reference in QTQC UI.

Partial downloads must stay invisible to analysis.

## Runtime Pipeline

```text
QTQC reads
  -> trim/demux assignments
  -> mapper input batches
  -> query seed extraction
  -> shard request planner
  -> worker shard loading
  -> anchor generation
  -> chaining
  -> top-chain selection
  -> optional refinement
  -> MappingRecord[]
  -> QTQC Dip-C pair/contact builder
```

## Worker Model

MVP:

- one controller worker
- N shard workers, where N defaults to `min(4, hardwareConcurrency - 1)`
- no SharedArrayBuffer requirement
- transfer `ArrayBuffer`s where practical

Possible later mode:

- SharedArrayBuffer-backed work queues
- WebAssembly threads
- requires cross-origin isolation

## Shard Request Planner

The planner should avoid loading the whole index.

For a read batch:

1. Extract all query seed hashes.
2. Compute shard IDs from hash prefix.
3. Count demand per shard.
4. Load high-demand shards first.
5. Optionally skip shards with too little evidence.
6. Evict least recently used shards when cache exceeds memory budget.

The planner should record:

- query seed count
- distinct shard count
- shard bytes loaded
- shard cache hit rate
- time spent reading shards
- time spent generating anchors

These diagnostics are essential because QTQC's current minimap2 problem was only
understandable after adding detailed timing logs.

## Binary Format Sketch

All integers little-endian.

`reference.json`:

```json
{
  "format": "qtmap-reference",
  "formatVersion": 1,
  "referenceId": "mm39",
  "taxid": 10090,
  "seedScheme": "canonical-minimizer",
  "k": 15,
  "w": 10,
  "shardBits": 12,
  "files": []
}
```

`seed-shard-N.bin`:

```text
magic: 8 bytes
format_version: u32
shard_id: u32
seed_count: u32
hit_count: u64
directory_offset: u64
hit_table_offset: u64
directory records...
hit records...
```

Directory record:

```text
seed_hash_suffix: u64
hit_offset: u64
hit_count: u32
flags: u32
```

Hit record:

```text
contig_id: u32
position: u32
flags: u32
```

This is intentionally simple. Compression can come later.

## Anchor Chaining

MVP chain scoring can be simpler than minimap2:

- group anchors by contig and strand
- sort by reference position and query position
- use diagonal consistency windows
- score by anchor count, span, and order
- penalize excessive gaps and diagonal jumps
- keep top K chains per segment

This should be good enough to place read segments for QC. If it is not, add a
more minimap2-like dynamic-programming chaining kernel.

## Optional Refinement

Refinement should be bounded and optional:

- only for top chains
- only around small windows near candidate placement
- no full-reference sequence loading
- use banded edit distance or seed-consistency checks

For contact QC, a confident approximate segment location is more important than
a perfect CIGAR.

## QTQC Integration

QTQC should call the engine behind a feature flag:

```ts
const result = await mapper.mapReads({
  reads,
  assignments,
  referenceId: 'mm39',
  mode: 'map-ont-qc',
  maxMemoryMb: 1536,
});
```

Return:

```ts
{
  mappings: MappingRecord[],
  summary: MappingSummary,
  timings: TimingBreakdown,
  reference: ReferenceRuntimeInfo,
  warnings: MapperWarning[]
}
```

QTQC should keep the current minimap2 path during development, then compare both
paths in the same benchmark harness.

## Observability Requirements

Every run should log:

- browser and origin
- reference manifest hash
- installed file checksums or verification IDs
- read count and base count
- seed extraction timing
- shard planning timing
- OPFS read timing
- shard bytes loaded
- anchor count
- chain count
- mapping count
- contact count
- memory estimates
- warnings and degraded modes

This must be present from the first prototype.
