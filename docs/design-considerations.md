# Design Considerations

## Product Boundary

QTQC needs fast, local, browser-side QC. It does not need to replace native
minimap2 for publication-grade alignments.

The mapper should answer:

- Did reads map to the expected species/reference?
- What fraction mapped?
- Are there enough long-range contacts?
- What is the approximate cis/trans contact distribution?
- Are per-library contact counts plausible?
- Are there obvious mapping/reference/sample failures?

The mapper does not initially need:

- exact CIGAR strings
- polished MAPQ values compatible with minimap2
- variant-calling quality alignments
- full SAM/BAM parity
- all minimap2 presets

## Primary User Value

Users should be able to run QTQC on a laptop browser and get a stable answer in
minutes, not tens of minutes or an eventual Chrome renderer crash.

Browser support priority:

1. Firefox: keep current viability.
2. Chrome: make mammal Dip-C mapping practical or explicitly route around it.
3. Safari: best effort after the core engine is independent of minimap2 `.mmi`.

## Core Technical Bet

The current Chrome slowdown is caused by the native minimap2 `.mmi` loading path
through Emscripten/WORKERFS/OPFS, not by raw OPFS throughput. Therefore a
browser-native index format should avoid the bad access pattern.

The new engine should:

- use fixed-layout binary shards
- read shards by explicit offsets
- avoid native `.mmi` entirely
- keep large data outside one WASM linear heap
- use typed arrays and workers as the main runtime model
- use WASM only for carefully bounded hot loops

## Reference Package Design

Each reference should be built offline into a versioned browser package:

```text
reference.json
contigs.bin
seed-directory.bin
seed-shard-0000.bin
seed-shard-0001.bin
...
frequency-mask.bin
build-report.json
```

`reference.json` should include:

- reference ID, for example `mm39`
- scientific name and taxid
- source FASTA and assembly accession
- mapper index version
- seed scheme and parameters
- shard count
- file sizes
- SHA-256 checksums
- build date
- compatibility version

The browser install process should verify every shard. A reference should only
be marked installed after all files pass size and checksum checks.

## Index Data Model

MVP index entries can be:

```text
seed_hash: uint64 or split uint32 pair
contig_id: uint32
position: uint32
strand: 1 bit packed into flags
frequency_class: small int or separate table
```

But the on-disk shard should avoid repeating `seed_hash` for every hit. A more
compact layout:

```text
shard header
seed directory: seed_hash_delta, offset, count
hit table: packed contig/position/strand records
```

Shard partitioning options:

- by high bits of seed hash
- by minimizer prefix
- by contig block

Hash-prefix sharding is likely best because query reads can determine exactly
which shards they need.

## Seed Scheme

Baseline:

- minimizers
- ONT-oriented k and window parameters
- canonical k-mers
- frequency caps or weights

Possible next steps:

- weighted minimizers inspired by Winnowmap
- syncmers/strobemers if minimizers are too repetitive
- separate low-memory and high-sensitivity reference packages

Important constraint: QTQC contact QC depends on read segments. Overly sparse
seeding may map whole reads but miss useful split-read/contact structure.

## Mapping Pipeline

Suggested MVP pipeline:

1. Parse reads and adapter-trimmed segments from QTQC.
2. Extract query minimizers per segment.
3. Group query seeds by reference shard.
4. Load only required shards from OPFS into workers.
5. Find seed hits and emit anchors.
6. Chain anchors per read segment.
7. Pick top chains with simple confidence scoring.
8. Optionally run bounded refinement around candidate chains.
9. Return approximate mapping records to QTQC.
10. Convert mapping records into Dip-C pair/contact summaries.

## Memory Strategy

Hard rules:

- Never require the full mammal index in memory.
- Never copy a multi-GB reference or index into one ArrayBuffer.
- Avoid retaining all read-level anchors for the full run.
- Process reads in batches.
- Transfer buffers to workers instead of cloning.
- Keep per-shard caches bounded with LRU eviction.

Target memory profile:

- index directory: tens of MB or less
- active shard set: configurable, ideally under 512 MB
- active read batch: small, for example 1k to 10k reads
- outputs: aggregate metrics plus optional compact mapping records

## Browser Storage Strategy

Use OPFS for installed reference packages. Avoid Cache Storage for multi-GB
reference assets because cache semantics and quota behavior are opaque for this
use case.

Use an install state machine:

```text
missing -> downloading -> downloaded -> verifying -> installed
```

Never treat presence of a file as proof of install. Installed status requires:

- manifest version matches
- all required files exist
- file sizes match
- checksums match
- install completion marker exists after verification

## Accuracy Strategy

The engine should report that it is QC-grade. Confidence should be calibrated
against native minimap2 outputs, but not represented as minimap2 MAPQ.

Useful confidence components:

- number of unique anchors
- chain score
- chain span on query and reference
- margin between best and second-best chain
- repetitive seed burden
- fraction of segment covered by anchors

For contact QC, the main validation metrics are:

- mapped read count
- contact count
- cis/trans fraction
- distance decay shape
- per-library contact counts
- agreement with native minimap2 on benchmark FASTQs

## API Contract With QTQC

QTQC should see a simple mapper interface:

```ts
type MappingRecord = {
  readId: string;
  segmentId: number;
  contig: string;
  pos0: number;
  pos1?: number;
  strand: '+' | '-';
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low' | 'multi';
  seedCount: number;
  chainScore: number;
  repetitive: boolean;
};
```

The engine should also report:

- reference package ID
- index version
- browser feature flags
- timing breakdown
- shard cache stats
- memory samples
- warnings

## Compatibility With Native Minimap2

This project should support comparison to minimap2, not pretend to be minimap2.

Recommended user-facing wording:

> QTQC browser mapping is optimized for local QC and approximate contact
> summaries. Use native minimap2/Dip-C pipelines for final alignments.

## Development Constraints

The first prototype should be debuggable:

- TypeScript for orchestration and binary parsing
- simple binary format with a clear spec
- small test references first
- deterministic output
- golden fixtures against native minimap2
- no cross-origin isolation requirement in MVP

Rust/WASM can be added later for hot loops after the data model is proven.
