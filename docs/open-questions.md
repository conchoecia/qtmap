# Open Questions

## Product Questions

1. What exact QTQC outputs must match native minimap2?
2. How much deviation in contact count is acceptable for QC?
3. Should QTQC label this as "QC mapping" in the UI?
4. Should Chrome users see this engine automatically, or opt in?
5. Should Firefox keep using minimap2-WASM if it remains faster and accurate?

## Algorithm Questions

1. Are minimizers sufficient for Dip-C read segments, or do we need strobemers or
   syncmers?
2. What k/window values preserve enough split-read/contact signal?
3. Should highly repetitive seeds be dropped, down-weighted, or retained with a
   hard cap?
4. How many top chains per segment are needed to classify ambiguous mappings?
5. Is optional refinement needed for contact QC, or is chaining enough?

## Reference Package Questions

1. What shard size gives the best Chrome behavior?
2. Should shards be hash-prefix based or contig/block based?
3. Can we make one package work for both Chrome and Firefox?
4. Should `map-ont` and `map-pb` use separate browser reference packages?
5. Can we support low-memory and high-sensitivity variants without confusing the
   UI?

## Browser Runtime Questions

1. Are OPFS sync access handles faster than async `File` reads for this access
   pattern in Chrome?
2. Is the main Chrome pathology triggered by repeated small reads, seeking, or
   native minimap2 parsing behavior?
3. Can explicit shard prefetching eliminate the Chrome slowdown?
4. Is SharedArrayBuffer worth the COOP/COEP deployment complexity?
5. How much memory can we safely allocate without causing post-run renderer
   crashes?

## Validation Questions

1. Which native minimap2 outputs should be the gold standard?
2. Do we validate on read placement, contact pairs, or final QC plots?
3. What datasets can be committed publicly?
4. How do we test multi-mapping and repetitive regions without overbuilding the
   first prototype?
5. What benchmark should block QTQC integration?

## Repo And Naming Questions

Possible names:

- `qtqc-mm2browser`
- `qtqc-browser-mapper`
- `qtqc-qcmapper`
- `qtqc-minimizer-qc`

Recommended name for now: `qtqc-mm2browser`, because it clearly connects to the
problem we are solving while leaving room to diverge from minimap2 internals.
