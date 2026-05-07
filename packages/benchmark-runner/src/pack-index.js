/**
 * @fileoverview Pack an index directory into a single .qpack file.
 *
 * Streaming so we don't have to hold the full mm39 / hg38 index in
 * memory. Two passes: (1) walk every file to compute size + sha256 to
 * fill the file table; (2) write header + table + concatenated data.
 *
 * Usage:
 *   node packages/benchmark-runner/src/pack-index.js \
 *     --in /tmp/mm39_build_w15/index \
 *     --out /tmp/mm39_build_w15/mm39_w15.qpack
 */

import {
  createReadStream,
  createWriteStream,
  readdirSync,
  readFileSync,
  statSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  QPACK_MAGIC,
  QPACK_FORMAT_VERSION,
  QPACK_HEADER_SIZE,
} from '../../mapper-core/src/qpack-codec.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; ++i) {
    const a = argv[i];
    if (a === '--in') out.in = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.in || !out.out) throw new Error('required: --in DIR --out PACK');
  return out;
}

function listFilesSorted(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (!st.isFile()) continue;
    out.push({ name, path, size: st.size });
  }
  // Stable order: sorted by name.
  out.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return out;
}

async function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('error', reject);
    s.on('data', chunk => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.error(`[pack-index] in:  ${args.in}`);
  console.error(`[pack-index] out: ${args.out}`);

  const files = listFilesSorted(args.in);
  console.error(`[pack-index] files: ${files.length}`);

  // Pass 1: compute sha256 for each file. The file table records absolute
  // size + sha256 + offset within the data section.
  const meta = [];
  let dataLen = 0;
  let pathTableSize = 0;
  for (const f of files) {
    const sha = await sha256File(f.path);
    const pathBytes = Buffer.from(f.name, 'utf8');
    if (pathBytes.length > 0xFFFF) throw new Error(`path too long: ${f.name}`);
    meta.push({
      path: f.name,
      pathBytes,
      size: f.size,
      offset: dataLen,
      sha,
      sourcePath: f.path,
    });
    dataLen += f.size;
    pathTableSize += 2 + 2 + 8 + 8 + 32 + pathBytes.length;
  }
  const dataOffset = QPACK_HEADER_SIZE + pathTableSize;
  const totalSize = dataOffset + dataLen;
  console.error(`[pack-index] data section: ${(dataLen / (1024 ** 3)).toFixed(2)} GiB`);
  console.error(`[pack-index] header+table: ${pathTableSize + QPACK_HEADER_SIZE} bytes`);
  console.error(`[pack-index] total qpack:  ${(totalSize / (1024 ** 3)).toFixed(2)} GiB`);

  // Pass 2: write.
  const fd = openSync(args.out, 'w');

  // Header (32 bytes).
  const header = Buffer.alloc(QPACK_HEADER_SIZE);
  header.write(QPACK_MAGIC, 0, 8, 'ascii');
  header.writeUInt32LE(QPACK_FORMAT_VERSION, 8);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(meta.length, 16);
  header.writeUInt32LE(0, 20);
  header.writeBigUInt64LE(BigInt(dataOffset), 24);
  writeSync(fd, header);

  // File table.
  for (const m of meta) {
    const entry = Buffer.alloc(2 + 2 + 8 + 8 + 32 + m.pathBytes.length);
    let p = 0;
    entry.writeUInt16LE(m.pathBytes.length, p); p += 2;
    entry.writeUInt16LE(0, p);                  p += 2;
    entry.writeBigUInt64LE(BigInt(m.size), p);  p += 8;
    entry.writeBigUInt64LE(BigInt(m.offset), p); p += 8;
    Buffer.from(m.sha, 'hex').copy(entry, p);   p += 32;
    m.pathBytes.copy(entry, p);                 p += m.pathBytes.length;
    writeSync(fd, entry);
  }

  // Data section: stream each file in order.
  let written = 0;
  for (const m of meta) {
    await new Promise((resolve, reject) => {
      const r = createReadStream(m.sourcePath);
      r.on('error', reject);
      r.on('data', chunk => writeSync(fd, chunk));
      r.on('end', resolve);
    });
    written += m.size;
    if (meta.length <= 100 || written % (1024 ** 3) < 1024 ** 2) {
      // Print at most every GB
      console.error(`[pack-index] wrote ${written.toLocaleString()} / ${dataLen.toLocaleString()} bytes`);
    }
  }

  fsyncSync(fd);
  closeSync(fd);
  console.error(`[pack-index] DONE`);
}

main().catch(e => {
  console.error('[pack-index] FATAL:', e?.stack ?? e);
  process.exit(1);
});
