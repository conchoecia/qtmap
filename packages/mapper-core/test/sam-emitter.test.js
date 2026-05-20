import test from 'node:test';
import assert from 'node:assert/strict';

import {
  approximateMapq,
  buildCigar,
  buildSamHeader,
  emitReadSamLines,
} from '../src/sam-emitter.js';

test('approximateMapq returns 0 when f1 is non-positive', () => {
  assert.equal(approximateMapq({ f1: 0, f2: 0, m: 10 }), 0);
  assert.equal(approximateMapq({ f1: -5, f2: 0, m: 10 }), 0);
});

test('approximateMapq grows with score and unique anchors, caps at 60', () => {
  // Pick small enough inputs that the cap doesn't dominate.
  const low  = approximateMapq({ f1: 5,  f2: 0, m: 2 });
  const mid  = approximateMapq({ f1: 30, f2: 0, m: 5 });
  const high = approximateMapq({ f1: 200, f2: 0, m: 50 });
  assert.ok(low < mid, `low=${low} mid=${mid}`);
  assert.ok(mid <= high, `mid=${mid} high=${high}`);
  assert.ok(high <= 60);
});

test('approximateMapq drops sharply when second-best is close', () => {
  const lonely  = approximateMapq({ f1: 100, f2: 0,  m: 20 });
  const tied    = approximateMapq({ f1: 100, f2: 95, m: 20 });
  assert.ok(tied < lonely / 4, `tied (${tied}) should be <<< lonely (${lonely})`);
});

test('buildCigar produces S<n>M<m>S<n> for primary; H clips for secondary', () => {
  const rec = { qStart: 30, qEnd: 980, refStart: 100, refEnd: 1050 };
  assert.equal(buildCigar(rec, 1000, false), '30S950M20S');
  assert.equal(buildCigar(rec, 1000, true),  '30H950M20H');
});

test('buildCigar omits zero-length leading or trailing clip', () => {
  assert.equal(buildCigar({ qStart: 0, qEnd: 1000, refStart: 0, refEnd: 1000 }, 1000, false), '1000M');
  assert.equal(buildCigar({ qStart: 50, qEnd: 1000, refStart: 0, refEnd: 950 }, 1000, false), '50S950M');
  assert.equal(buildCigar({ qStart: 0, qEnd: 800, refStart: 100, refEnd: 900 }, 1000, false), '800M200S');
});

test('buildSamHeader emits @HD + @SQ + @PG', () => {
  const hdr = buildSamHeader([
    { name: 'chr1', length: 1000 },
    { name: 'chr2', length: 2000 },
  ]);
  const lines = hdr.split('\n').filter(Boolean);
  assert.equal(lines[0], '@HD\tVN:1.6\tSO:unsorted');
  assert.equal(lines[1], '@SQ\tSN:chr1\tLN:1000');
  assert.equal(lines[2], '@SQ\tSN:chr2\tLN:2000');
  assert.ok(lines[3].startsWith('@PG\t'));
});

test('emitReadSamLines outputs one line per record with correct flags', () => {
  const read = {
    name: 'r1',
    seq: 'ACGT'.repeat(500),                    // 2000 bp
    qual: 'I'.repeat(2000),
  };
  const contigs = [{ name: 'chr1' }, { name: 'chr2' }];
  const records = [
    { contigId: 0, refStart: 100, refEnd: 900,  jointStrand: 0, qStart: 0,    qEnd: 800,
      score: 100, anchorCount: 30, uniqueAnchors: 28,
      isPrimary: true, isSupplementary: false, isSecondary: false, fragmentIndex: 0,
      mapqInputs: { f1: 100, f2: 0, m: 28 } },
    { contigId: 1, refStart: 5000, refEnd: 5800, jointStrand: 1, qStart: 900, qEnd: 1700,
      score: 80, anchorCount: 25, uniqueAnchors: 24,
      isPrimary: false, isSupplementary: true, isSecondary: false, fragmentIndex: 1,
      mapqInputs: { f1: 80, f2: 0, m: 24 } },
  ];
  const sam = emitReadSamLines(read, records, contigs);
  const lines = sam.trim().split('\n');
  assert.equal(lines.length, 2);

  const a = lines[0].split('\t');
  const b = lines[1].split('\t');
  assert.equal(a[0], 'r1');
  assert.equal(a[1], '0');           // primary, forward
  assert.equal(a[2], 'chr1');
  assert.equal(a[3], '101');         // 1-based
  assert.equal(a[5], '800M1200S');   // qStart=0, refSpan=800, trail=1200
  assert.equal(a[9], read.seq);      // primary carries full seq
  assert.equal(a[10], read.qual);

  assert.equal(b[1], String(0x10 | 0x800)); // reverse + supplementary
  assert.equal(b[2], 'chr2');
  assert.equal(b[3], '5001');
  assert.equal(b[5], '900S800M300S');
  assert.equal(b[9], '*');           // supplementary carries no seq

  // Both lines should carry the SA:Z tag listing the OTHER fragment.
  assert.ok(a.some(f => f.startsWith('SA:Z:')));
  assert.ok(b.some(f => f.startsWith('SA:Z:')));
});

test('emitReadSamLines emits one unmapped record when no fragments selected', () => {
  const read = { name: 'r1', seq: 'ACGT', qual: 'IIII' };
  const sam = emitReadSamLines(read, [], [{ name: 'chr1' }]);
  const fields = sam.trim().split('\t');
  assert.equal(fields[1], '4');
  assert.equal(fields[2], '*');
  assert.equal(fields[5], '*');
  assert.equal(fields[9], 'ACGT');
});

/* Regression guard for a silent-data-loss bug seen in the qtqc browser
 * pipeline: caller passed reads with `read_id` instead of `name`, so
 * every emitted SAM record had an empty QNAME. Downstream consumers
 * parsed by QNAME, all 4900 mapped records collapsed to ~3 unique
 * reads in the report, and mapping looked broken even though
 * mapReads itself had mapped 98%. Fail loud now so the bug is
 * caught immediately at first SAM emission. */
test('emitReadSamLines throws when read.name is missing', () => {
  const readNoName = { read_id: 'r1', seq: 'ACGT', qual: 'IIII' };
  assert.throws(
    () => emitReadSamLines(readNoName, [], [{ name: 'chr1' }]),
    /read\.name \(SAM QNAME\) is required/
  );
});

test('emitReadSamLines throws when read.name is empty string', () => {
  const readEmpty = { name: '', seq: 'ACGT', qual: 'IIII' };
  assert.throws(
    () => emitReadSamLines(readEmpty, [], [{ name: 'chr1' }]),
    /read\.name \(SAM QNAME\) is required/
  );
});

test('emitReadSamLines throws when read.name is non-string', () => {
  assert.throws(
    () => emitReadSamLines({ name: 42, seq: 'ACGT' }, [], [{ name: 'chr1' }]),
    /read\.name \(SAM QNAME\) is required/
  );
});
