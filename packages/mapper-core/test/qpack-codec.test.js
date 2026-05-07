import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  QPACK_MAGIC,
  QPACK_FORMAT_VERSION,
  buildQpack,
  parseQpackHeader,
} from '../src/qpack-codec.js';

function fakeEntry(path, content) {
  const bytes = new TextEncoder().encode(content);
  const sha = createHash('sha256').update(bytes).digest('hex');
  return { path, bytes, sha256: sha };
}

test('round-trip a small qpack', () => {
  const a = fakeEntry('reference.json', '{"hello":"world"}');
  const b = fakeEntry('seed-shard-0000.bin', '\x00\x01\x02\x03\x04');
  const c = fakeEntry('contigs.bin', 'CONTIG-1');
  const pack = buildQpack([a, b, c]);

  const parsed = parseQpackHeader(pack);
  assert.equal(parsed.formatVersion, QPACK_FORMAT_VERSION);
  assert.equal(parsed.fileCount, 3);
  assert.equal(parsed.files.length, 3);

  const byName = new Map(parsed.files.map(f => [f.path, f]));
  assert.ok(byName.has('reference.json'));
  assert.ok(byName.has('seed-shard-0000.bin'));
  assert.ok(byName.has('contigs.bin'));

  // Verify offsets and sizes line up with the data section.
  const dataView = new Uint8Array(pack.buffer, pack.byteOffset + parsed.dataOffset);
  for (const e of [a, b, c]) {
    const meta = byName.get(e.path);
    assert.equal(meta.size, e.bytes.length);
    assert.equal(meta.sha256, e.sha256);
    const slice = dataView.subarray(meta.offset, meta.offset + meta.size);
    assert.deepEqual([...slice], [...e.bytes]);
  }
});

test('rejects bad magic', () => {
  const pack = buildQpack([fakeEntry('a', 'b')]);
  pack[0] = 'X'.charCodeAt(0);
  assert.throws(() => parseQpackHeader(pack), /bad qpack magic/);
});

test('rejects unsupported version', () => {
  const pack = buildQpack([fakeEntry('a', 'b')]);
  // Version is at byte 8; bump it past 1.
  new DataView(pack.buffer).setUint32(8, 999, true);
  assert.throws(() => parseQpackHeader(pack), /unsupported qpack version/);
});
