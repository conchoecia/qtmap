# vendor/

Code copied verbatim from sister repos. Do not edit in place; if you need
changes, fork into `packages/mapper-core/src/` and update the import path.

| File | Source | Why |
|---|---|---|
| `fastq-chunker.js` | `qtqc-minimap2-wasm/src/fastq-chunker.js` | Pure-JS streaming FASTQ chunker (4-line records, no deps). Reused unchanged. |
| `sam.js` | `qtqc-minimap2-wasm/src/sam.js` | SAM @SQ/@PG header dedup across chunks. Reused unchanged. |

If you bump the upstream commit hash that these files were taken from, note
it here.
