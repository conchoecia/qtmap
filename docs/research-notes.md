# Research Notes

This document summarizes the prior art and browser platform constraints that
matter for a QTQC-specific browser mapper.

## 1. QTQC Evidence To Explain

Local evidence from QTQC is in:

- `../../qtqc/docs/benchmarks/dipc-mm39-browser-index-sweep-2026-05-04.md`
- `../../qtqc/docs/benchmarks/dipc-mm39-browser-index-sweep-2026-05-04.tsv`
- `../../qtqc/docs/benchmarks/raw-run-logs/2026-05-07-5ksr46-browser-runs/`

The relevant benchmark pattern is:

- Firefox 150, `mm39.map-ont.I500M.mmi`, OPFS probe: total 3m 54s, index loading
  3m 44s, chunk mapping 8.3s, OPFS/WORKERFS read probe about 375 MiB/s.
- Chrome 147, same reference and reads, OPFS probe: total 27m 51s, index loading
  27m 33s, chunk mapping 9.5s, OPFS/WORKERFS read probe about 326 MiB/s.

Interpretation: Chrome can read sampled reference bytes quickly, but minimap2's
native split-index loading/parsing path is still slow. The bottleneck is not
read mapping and not a simple cache/download failure.

## 2. Direct WASM Ports Of Native Bioinformatics Tools

### BioWasm and Aioli

BioWasm packages existing command-line bioinformatics tools for browser use via
WebAssembly and lists minimap2 among supported packages. Aioli is the JavaScript
library layer for running those tools in browser workers.

Sources:

- BioWasm: https://biowasm.com/
- Aioli npm package: https://www.npmjs.com/package/%40biowasm/aioli

Implication for QTQC:

- Direct WASM ports are valuable for smaller tools and smaller references.
- They preserve native command semantics.
- They do not necessarily fix native tools whose file access and memory model
  are mismatched to browser storage.
- QTQC's Chrome result is exactly the case where a native port can be correct
  but operationally poor.

### ViralWasm

ViralWasm uses WebAssembly to run original command-line tools client-side for
viral genomics and reports a browser slowdown relative to native tools that is
still acceptable for viral-scale workloads.

Source:

- ViralWasm paper: https://academic.oup.com/bioinformatics/article/40/1/btae018/7515252

Implication for QTQC:

- Browser WASM is a proven privacy-preserving deployment model.
- Viral workloads are much smaller than mammal whole-genome minimap2 indexes.
- The strategy "run the native CLI in WASM" does not automatically scale to
  multi-GB mammal references.

### BioChef

BioChef is a client-side WebAssembly workflow builder for genomic data analysis.
Its benchmark framing is useful: browser execution preserves privacy and avoids
server-side queues, but overhead can be substantial depending on workload.

Source:

- BioChef paper: https://link.springer.com/article/10.1186/s12859-026-06431-1

Implication for QTQC:

- Browser-local analysis remains a valid product direction.
- Performance has to be designed around browser constraints, not assumed from
  native command-line behavior.

## 3. Minimap2 Itself

Minimap2 follows a seed-chain-align design. It indexes reference minimizers in
a hash table, uses query minimizers as seeds, chains colinear anchors, and can
perform base-level dynamic programming when requested.

Sources:

- Minimap2 paper: https://pmc.ncbi.nlm.nih.gov/articles/PMC6137996/
- Project availability from paper: https://github.com/lh3/minimap2

Implication for QTQC:

- The high-level algorithm is still the right conceptual baseline.
- QTQC probably does not need full base-level alignment for contact QC.
- The browser-specific issue is not the minimizer/chaining idea; it is native
  `.mmi` loading and memory behavior in a browser filesystem/WASM runtime.

## 4. Approximate And Sketch-Based Long-Read Mapping

### MashMap

MashMap uses minimizers and MinHash-style identity estimation for approximate
long-read mapping. It intentionally reports approximate mapping intervals rather
than full base-level alignments, and shows that long-read mapping can be made
much lighter when the output target is approximate placement.

Source:

- MashMap paper: https://journals.sagepub.com/doi/10.1089/cmb.2018.0036

Implication for QTQC:

- This is close to QTQC's product need: approximate placement can be enough for
  QC summaries.
- A browser mapper can trade CIGAR fidelity for speed, memory stability, and
  contact-level correctness.

### Winnowmap

Winnowmap modifies minimizer sampling with weights to improve long-read mapping
in repetitive regions. It shows that better seed selection can reduce memory and
runtime pressure while improving repeat behavior.

Sources:

- Winnowmap paper: https://pmc.ncbi.nlm.nih.gov/articles/PMC7355284/
- Winnowmap2 paper: https://www.nature.com/articles/s41592-022-01457-8

Implication for QTQC:

- A browser-native index should not blindly store every frequent minimizer.
- Frequency-aware or weighted minimizer sampling is likely useful.
- Repetitive regions matter for mouse/human, but QC does not require perfect
  repeat resolution everywhere.

### Strobealign, Syncmers, And Strobemers

Strobealign combines newer seed types to reduce repetitive seed behavior in fast
short-read alignment. The exact short-read aligner is not a direct solution for
ONT Dip-C reads, but the seeding ideas are relevant.

Source:

- Strobealign paper: https://genomebiology.biomedcentral.com/articles/10.1186/s13059-022-02831-7

Implication for QTQC:

- A browser mapper should consider alternative seed schemes after a minimizer
  baseline is working.
- The first implementation should stay simpler: minimizers or weighted
  minimizers, then benchmark alternatives.

## 5. Browser Storage And Memory Constraints

### OPFS and Sync Access Handles

The Origin Private File System is origin-scoped storage. Its synchronous access
handle API is only available in dedicated workers and is designed for faster
in-place file operations.

Sources:

- web.dev OPFS guide: https://web.dev/articles/origin-private-file-system
- MDN `FileSystemSyncAccessHandle`: https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle

Implication for QTQC:

- Reference shards should live in OPFS, not Cache Storage.
- Heavy reads should happen in workers.
- A custom index reader can use predictable offset reads rather than relying on
  Emscripten's POSIX-like filesystem layer.

### WebAssembly Memory

WebAssembly memory is exposed as an `ArrayBuffer` or `SharedArrayBuffer`. Current
QTQC minimap2 runs operate near browser/WASM memory ceilings for larger split
sizes, so the mapper design should avoid materializing whole references or whole
native indexes in one linear memory.

Source:

- MDN `WebAssembly.Memory`: https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory

Implication for QTQC:

- Keep large reference data outside one WASM linear heap.
- Prefer typed-array shards and streaming/chunked processing.
- Use WASM kernels selectively for hot loops, not as the owner of all data.

### SharedArrayBuffer And Threads

SharedArrayBuffer and WebAssembly threads require secure context and
cross-origin isolation via COOP/COEP headers.

Sources:

- MDN `SharedArrayBuffer`: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
- MDN `crossOriginIsolated`: https://developer.mozilla.org/docs/Web/API/Window/crossOriginIsolated

Implication for QTQC:

- Do not require cross-origin isolation for the MVP.
- Use independent workers and transferable `ArrayBuffer`s first.
- Add an optional threaded/SAB mode later if Netlify/R2 headers and third-party
  assets can be made compatible.

## 6. Main Research Conclusion

The strongest design path is a QTQC-specific browser mapper, not another direct
minimap2 port. The core ideas to borrow are minimizer indexing, frequency-aware
sampling, anchor chaining, and approximate mapping. The core ideas to avoid are
native `.mmi` parsing, POSIX-like virtual filesystem access for multi-GB index
loading, and requiring full SAM/CIGAR fidelity before QTQC can show QC results.
