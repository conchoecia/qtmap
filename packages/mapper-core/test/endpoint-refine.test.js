import test from 'node:test';
import assert from 'node:assert/strict';

import { refineChainEndpoints } from '../src/endpoint-refine.js';

const REF =
  'AAACCCGGGTTTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTAC' +  //  0..62
  'AAACCCGGGTTTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTAC' +  // 62..124
  'AAACCCGGGTTTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTAC';   // 124..186

function refLookup(_contigId, start, end) {
  return REF.slice(start, end);
}

function rcStr(s) {
  const map = { A: 'T', T: 'A', C: 'G', G: 'C', N: 'N' };
  let out = '';
  for (let i = s.length - 1; i >= 0; --i) out += map[s[i].toUpperCase()] || 'N';
  return out;
}

test('forward chain extends LEFT into matching soft-clip', () => {
  // Read = REF[10..50] with 10 bp soft clip on each side that matches REF.
  // Pretend the seed-anchor chain only saw REF[20..40], so qStart=20-10=10,
  // refStart=20. Refinement should extend to qStart=0, refStart=10 (matches
  // entire forward window).
  const readSeq = REF.slice(0, 60);   // first 60 bp
  const chain = {
    contigId: 0, jointStrand: 0,
    qStart: 20, qEnd: 40,
    refStart: 20, refEnd: 40,
  };
  refineChainEndpoints(chain, readSeq, refLookup, REF.length);
  // LEFT extension: qStart should drop to ~0
  assert.ok(chain.qStart < 5, `qStart should extend left, got ${chain.qStart}`);
  assert.equal(chain.refStart - chain.qStart, 0,
    `forward chain preserves diagonal: refStart - qStart should stay 0`);
  // RIGHT extension: qEnd should grow to ~60
  assert.ok(chain.qEnd > 55, `qEnd should extend right, got ${chain.qEnd}`);
  assert.equal(chain.refEnd - chain.qEnd, 0,
    `forward chain preserves diagonal: refEnd - qEnd should stay 0`);
});

test('forward chain does not run past totally non-matching soft clip', () => {
  // Read has 20 bp of bases that systematically disagree with REF on the
  // left soft clip. With minMatchRate=0.6 and window 10 the extension
  // should not reach the disagreeing region.
  const left = 'GGGGCCCCAAAATTTTGGCC';   // all four bases, not REF[0..20]
  // Pick something that actually disagrees by complement against REF[0..20].
  // REF[0..20] = AAACCCGGGTTTACGTACGT, so picking the same length of
  // distinct bases works.
  const read = left + REF.slice(20, 50);
  const chain = {
    contigId: 0, jointStrand: 0,
    qStart: 25, qEnd: 50,
    refStart: 25, refEnd: 50,
  };
  refineChainEndpoints(chain, read, refLookup, REF.length);
  // We allow some extension into adjacent matching positions (REF[20..24]
  // is part of the chain). The key invariant: it must NOT extend through
  // the entire 20 bp non-matching prefix.
  assert.ok(chain.qStart > 5,
    `qStart should stop before the non-matching prefix; got ${chain.qStart}`);
});

test('reverse chain extends correctly (jointStrand=1)', () => {
  // The chain is on the reverse strand: read = RC(ref[10..50]).
  // qStart..qEnd in the read corresponds to positions [10..50] of ref but
  // reverse-complemented. We pretend we only seeded REF[20..40] so the chain
  // starts at qStart=10, qEnd=30 (read coords are flipped).
  const slice = REF.slice(0, 60);
  const readSeq = rcStr(slice);  // 60 bp, fully RC of REF[0..60]
  // jointStrand=1 chain spans:
  //   read [qStart..qEnd] = RC(ref[refStart..refEnd])
  // For seeds at REF[20..40]:
  //   read positions: 60 - 40 = 20  .. 60 - 20 = 40
  const chain = {
    contigId: 0, jointStrand: 1,
    qStart: 20, qEnd: 40,
    refStart: 20, refEnd: 40,
  };
  refineChainEndpoints(chain, readSeq, refLookup, REF.length);
  // LEFT extension on read = grows refEnd; RIGHT extension on read = shrinks refStart.
  assert.ok(chain.qStart < 5, `qStart should extend, got ${chain.qStart}`);
  assert.ok(chain.refEnd > 55, `refEnd should grow, got ${chain.refEnd}`);
  assert.ok(chain.qEnd > 55, `qEnd should extend, got ${chain.qEnd}`);
  assert.ok(chain.refStart < 5, `refStart should shrink, got ${chain.refStart}`);
  // Diagonal invariant for joint=1: qStart + refEnd = constant ≈ readLen.
  assert.equal(chain.qStart + chain.refEnd, 60,
    `joint=1 invariant: qStart+refEnd = readLen=60`);
});

test('refinement is bounded by maxExt option', () => {
  const readSeq = REF.slice(0, 80);
  const chain = {
    contigId: 0, jointStrand: 0,
    qStart: 40, qEnd: 60,
    refStart: 40, refEnd: 60,
  };
  refineChainEndpoints(chain, readSeq, refLookup, REF.length, { maxExt: 5 });
  // With maxExt=5, qStart can drop at most 5 bp.
  assert.equal(chain.qStart, 35);
  assert.equal(chain.qEnd, 65);
});
