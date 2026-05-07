# qtmap

Design notes for a browser-first long-read mapping engine for QTQC.

This is a planning repository, not an implementation. The working assumption is
that QTQC should not try to make native minimap2's `.mmi` loading pattern work
perfectly in every browser. Instead, this project explores a purpose-built
browser mapper that produces QC-grade genomic placements fast enough for
Dip-C/Hi-C contact summaries.

## Problem

The current QTQC Dip-C path uses a custom minimap2 WebAssembly build and a
browser-split `.mmi` reference. The Firefox runs are practical, but the same
`mm39.map-ont.I500M.mmi` workload is much slower in Chrome. The archived QTQC
logs show that raw OPFS/WORKERFS read probes are fast in Chrome, while minimap2
index-part loading remains the slow step.

The key observation is:

- read alignment chunks take seconds
- index loading takes minutes
- Chrome is much slower than Firefox for index loading
- mapping outputs are otherwise consistent across browsers

That points to a poor interaction between Chrome, the Emscripten file layer,
OPFS/WORKERFS, and minimap2's native `.mmi` parsing/access pattern.

Relevant QTQC evidence lives in:

- `../qtqc/docs/benchmarks/dipc-mm39-browser-index-sweep-2026-05-04.md`
- `../qtqc/docs/benchmarks/raw-run-logs/2026-05-07-5ksr46-browser-runs/`

## Project Goal

Build a QC-grade browser mapper for QTQC that:

- avoids loading native `.mmi` files in the browser
- uses a browser-native indexed reference format
- runs consistently in Chrome and Firefox
- produces enough mapping information for QTQC contact QC
- verifies cached reference shards by size and checksum
- keeps user reads local to the browser

## Non-Goals

This project should not initially try to:

- replace minimap2 for final scientific alignments
- emit fully validated production SAM/BAM for downstream variant calling
- exactly reproduce minimap2 MAPQ/CIGAR behavior
- support every minimap2 preset
- build whole mammal indexes in the browser

QTQC can continue to tell users that final analyses should use native mapping
pipelines. This project is about fast local QC.

## Proposed Approach

The likely direction is a browser-native seed/chaining mapper:

1. Build a compact reference package offline.
2. Store minimizer or weighted-minimizer shards in OPFS.
3. Load only the shards needed by the reads.
4. Generate anchors in Web Workers using typed arrays.
5. Chain anchors into approximate genomic placements.
6. Optionally do a small banded refinement around candidate chains.
7. Return QC mappings to QTQC as read ID, contig, position, strand, confidence,
   and segment boundaries.

The design should bias toward stable browser behavior over maximum alignment
fidelity.

## Repository Contents

- `docs/research-notes.md`: Similar tools, papers, and platform constraints.
- `docs/design-considerations.md`: Product and algorithm design constraints.
- `docs/architecture-proposal.md`: Initial technical architecture.
- `docs/validation-plan.md`: Benchmarking and correctness plan.
- `docs/open-questions.md`: Decisions that need experiments.

## Current Status

Planning only. No package, no implementation, no commit history is required yet.
This directory is intentionally usable as the start of a future GitHub repo.
