import test from 'node:test';
import assert from 'node:assert/strict';

import { chainAnchors } from '../src/chain.js';

/**
 * Build a synthetic anchor list for one read mapping forward to a contig.
 * Each anchor at (qPos = i*step, refPos = base + i*step). All same strand.
 */
function colinearAnchors({ count, step = 30, qBase = 0, refBase = 100,
                          contigId = 0, jointStrand = 0 }) {
  const anchors = [];
  for (let i = 0; i < count; ++i) {
    anchors.push({
      readIdx: 0,
      qPos: qBase + i * step,
      qStrand: 0,
      contigId,
      refPos: refBase + i * step,
      refStrand: jointStrand,
    });
  }
  return anchors;
}

test('single colinear chain is recovered', () => {
  const anchors = colinearAnchors({ count: 10 });
  const chains = chainAnchors(anchors);
  assert.equal(chains.length, 1);
  const c = chains[0];
  assert.equal(c.anchorCount, 10);
  assert.equal(c.contigId, 0);
  assert.equal(c.jointStrand, 0);
  assert.ok(c.score > 10, 'score should grow with anchor count');
});

test('two non-overlapping fragments produce two chains', () => {
  // Fragment A: query 0–300, ref chr0 100–400
  // Fragment B: query 1000–1300, ref chr1 500–800
  const a = colinearAnchors({ count: 11, qBase: 0, refBase: 100, contigId: 0 });
  const b = colinearAnchors({ count: 11, qBase: 1000, refBase: 500, contigId: 1 });
  const chains = chainAnchors([...a, ...b]);
  assert.ok(chains.length >= 2);

  // Map back by contigId
  const c0 = chains.find(c => c.contigId === 0);
  const c1 = chains.find(c => c.contigId === 1);
  assert.ok(c0 && c1);
  assert.ok(c0.anchorCount >= 10);
  assert.ok(c1.anchorCount >= 10);
});

test('reverse-strand fragment chains correctly', () => {
  // Anchors on a query that is reverse-complement of the reference: the
  // joint strand is 1. Without strand bookkeeping the diagonal would be
  // q+r = const, not r-q = const, and the chain would not form.
  const anchors = [];
  for (let i = 0; i < 8; ++i) {
    anchors.push({
      readIdx: 0,
      qPos: 200 - i * 25,    // decreasing as we walk reference forward
      qStrand: 0,
      contigId: 0,
      refPos: 1000 + i * 25,
      refStrand: 1,
    });
  }
  const chains = chainAnchors(anchors);
  const r = chains.find(c => c.jointStrand === 1);
  assert.ok(r, 'reverse-strand chain should exist');
  assert.ok(r.anchorCount >= 6);
});

test('large diagonal jumps break the chain', () => {
  // Two segments separated by a huge query insertion: ~10k bp of unmapped
  // sequence. With maxGap=5000 default they should not chain together.
  const partA = colinearAnchors({ count: 6, qBase: 0, refBase: 0 });
  const partB = colinearAnchors({ count: 6, qBase: 12000, refBase: 100, contigId: 0 });
  const chains = chainAnchors([...partA, ...partB]);
  // Should be two separate chains for contig 0 because the query gap is
  // huge between them.
  const onContig = chains.filter(c => c.contigId === 0);
  assert.ok(onContig.length >= 1, `expected ≥1 chain on contig 0, got ${onContig.length}`);
  // Best chain anchor count should not include both halves.
  for (const c of onContig) {
    assert.ok(c.anchorCount <= 7,
      `chain should not span the 12kb gap (anchorCount=${c.anchorCount})`);
  }
});

test('topK option caps chain count per bucket', () => {
  // 50 colinear anchors all in one bucket with no breakers; should still
  // produce only 1 dominant chain because greedy reconstruction marks them
  // all used.
  const anchors = colinearAnchors({ count: 50 });
  const chains = chainAnchors(anchors, { topK: 3 });
  assert.ok(chains.length <= 3);
  assert.ok(chains[0].anchorCount >= 30);
});
