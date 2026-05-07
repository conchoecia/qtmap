import test from 'node:test';
import assert from 'node:assert/strict';

import { selectFragments } from '../src/fragment-select.js';

function fakeChain({ readIdx = 0, contigId, jointStrand = 0, qStart, qEnd,
                   refStart, refEnd, score, anchorCount = 5, uniqueAnchors }) {
  return {
    readIdx, contigId, jointStrand,
    qStart, qEnd,
    refStart, refEnd,
    score,
    anchorCount,
    uniqueAnchors: uniqueAnchors ?? anchorCount,
    anchors: [],
  };
}

test('single chain becomes a single primary record', () => {
  const chains = [fakeChain({ contigId: 0, qStart: 0, qEnd: 1000, refStart: 0, refEnd: 1000, score: 50 })];
  const recs = selectFragments(chains);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].isPrimary, true);
  assert.equal(recs[0].isSupplementary, false);
  assert.equal(recs[0].isSecondary, false);
  assert.equal(recs[0].fragmentIndex, 0);
});

test('three non-overlapping fragments → 1 primary + 2 supplementary, sorted by qStart', () => {
  const chains = [
    fakeChain({ contigId: 0, qStart: 0,    qEnd: 800,  refStart: 100,   refEnd: 900,   score: 70 }),
    fakeChain({ contigId: 5, qStart: 900,  qEnd: 1700, refStart: 50000, refEnd: 50800, score: 50 }),
    fakeChain({ contigId: 9, qStart: 1800, qEnd: 2600, refStart: 90000, refEnd: 90800, score: 40 }),
  ];
  const recs = selectFragments(chains);
  assert.equal(recs.length, 3);
  // qStart order: 0, 900, 1800.
  assert.equal(recs[0].qStart, 0);
  assert.equal(recs[1].qStart, 900);
  assert.equal(recs[2].qStart, 1800);
  // Primary is the highest-score fragment overall (contigId 0, score 70).
  assert.equal(recs[0].isPrimary, true);
  assert.equal(recs[1].isPrimary, false);
  assert.equal(recs[1].isSupplementary, true);
  assert.equal(recs[2].isSupplementary, true);
});

test('overlapping high-score chain on same qSpan becomes secondary alternate when --secondary 1', () => {
  // Two near-tied placements of the same query region (repeat).
  const chains = [
    fakeChain({ contigId: 0, qStart: 0, qEnd: 800, refStart: 0,    refEnd: 800, score: 70 }),
    fakeChain({ contigId: 0, qStart: 5, qEnd: 805, refStart: 9000, refEnd: 9800, score: 65 }),
  ];
  const noSec = selectFragments(chains, { secondary: 0 });
  assert.equal(noSec.length, 1, '--secondary 0 emits only primary');

  const oneSec = selectFragments(chains, { secondary: 1 });
  assert.equal(oneSec.length, 2);
  assert.equal(oneSec[0].isPrimary, true);
  assert.equal(oneSec[1].isSecondary, true);
  assert.equal(oneSec[1].refStart, 9000);
});

test('primary picks highest-score fragment regardless of qStart order', () => {
  // Lower-scoring fragment is earlier in the read. Disable the score-ratio
  // floor for this test; the production default would treat a fragment at
  // 30/90 = 0.33 of best as noise.
  const chains = [
    fakeChain({ contigId: 1, qStart: 1000, qEnd: 1800, refStart: 5000, refEnd: 5800, score: 90 }),
    fakeChain({ contigId: 2, qStart: 0,    qEnd: 800,  refStart: 1000, refEnd: 1800, score: 30 }),
  ];
  const recs = selectFragments(chains, { minScoreRatio: 0 });
  assert.equal(recs.length, 2);
  // qStart-sorted: contigId 2 first, contigId 1 second.
  assert.equal(recs[0].contigId, 2);
  assert.equal(recs[0].isPrimary, false);
  assert.equal(recs[1].contigId, 1);
  assert.equal(recs[1].isPrimary, true);
});

test('mapqInputs reflects best vs second-best per fragment', () => {
  const chains = [
    fakeChain({ contigId: 0, qStart: 0,  qEnd: 800,  refStart: 0,    refEnd: 800,  score: 100, uniqueAnchors: 30 }),
    fakeChain({ contigId: 0, qStart: 10, qEnd: 805,  refStart: 5000, refEnd: 5800, score: 80,  uniqueAnchors: 25 }),
  ];
  const recs = selectFragments(chains, { secondary: 0 });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].mapqInputs.f1, 100);
  assert.equal(recs[0].mapqInputs.f2, 80, 'f2 should be the alternate even when not emitted');
  assert.equal(recs[0].mapqInputs.m, 30);
});
