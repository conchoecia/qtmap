/**
 * @fileoverview SAM emitter for mapping records.
 *
 * Output matches what QTQC's `dipc-sam.js` parses (parseSamForHickit +
 * parseCigarForHickit). Specifically:
 *
 *   - one SAM record per accepted fragment (primary + supplementary +
 *     optional per-fragment secondaries)
 *   - flag bits: 0x10 (reverse), 0x100 (secondary), 0x800 (supplementary),
 *                0x4 (unmapped, only for reads with no mapped fragment)
 *   - 1-based POS field (SAM convention)
 *   - CIGAR as <qStart>S<refSpan>M<L−qEnd>S
 *     omitting zero-length clips; secondary records use H instead of S
 *   - SEQ + QUAL passthrough on primary; "*" on supplementary and secondary
 *   - SA:Z tag on every record of a multi-fragment read, listing the
 *     OTHER fragments
 *   - MAPQ via minimap2-style formula:
 *       mq = 40 · (1 − f2/f1) · min(1, m/10) · log(f1)
 *     clamped to [0, 60]
 */

const SAM_FLAG_REVERSE = 0x10;
const SAM_FLAG_SECONDARY = 0x100;
const SAM_FLAG_SUPPLEMENTARY = 0x800;
const SAM_FLAG_UNMAPPED = 0x4;

const MAPQ_MAX = 60;

/**
 * Compute approximate MAPQ from chain scoring inputs.
 *
 *   mq = 40 · (1 − f2/f1) · min(1, m/10) · log(f1)
 *
 * @param {{f1:number,f2:number,m:number}} inputs
 * @returns {number} integer MAPQ in [0, 60]
 */
export function approximateMapq({ f1, f2, m }) {
  if (!isFinite(f1) || f1 <= 0) return 0;
  const ratio = Math.max(0, 1 - (f2 > 0 ? f2 / f1 : 0));
  const uniqueScale = Math.min(1, m / 10);
  const logScore = Math.log(f1);
  const raw = 40 * ratio * uniqueScale * logScore;
  if (!isFinite(raw) || raw < 0) return 0;
  return Math.min(MAPQ_MAX, Math.round(raw));
}

/**
 * Build the CIGAR string. M-only with leading/trailing clips. Secondary
 * alignments use hard-clip H per SAM spec; primary and supplementary use
 * soft-clip S (and the pinned 5KSR46 fixture uses S on supp because it
 * was produced by `minimap2 -ax map-ont` defaults).
 *
 * @param {object} rec
 * @param {number} qLen full read length
 * @param {boolean} secondary
 * @returns {string}
 */
export function buildCigar(rec, qLen, secondary) {
  const clipChar = secondary ? 'H' : 'S';
  const leadClip = rec.qStart;
  const trailClip = qLen - rec.qEnd;
  const refSpan = rec.refEnd - rec.refStart;
  if (refSpan <= 0) return '*';
  const parts = [];
  if (leadClip > 0) parts.push(`${leadClip}${clipChar}`);
  parts.push(`${refSpan}M`);
  if (trailClip > 0) parts.push(`${trailClip}${clipChar}`);
  return parts.join('');
}

/**
 * Emit SAM @SQ headers from a contigs.bin parse + manifest.
 *
 * @param {Array<{name:string,length:number}>} contigs
 * @returns {string} including trailing \n
 */
export function buildSamHeader(contigs, programLine = '@PG\tID:qtmap\tPN:qtmap\tVN:0.0.0') {
  const lines = ['@HD\tVN:1.6\tSO:unsorted'];
  for (const c of contigs) {
    lines.push(`@SQ\tSN:${c.name}\tLN:${c.length}`);
  }
  lines.push(programLine);
  return lines.join('\n') + '\n';
}

/**
 * Emit one SAM body chunk for a single read's selected fragments.
 *
 * @param {object} read
 *   { name, seq, qual? }  qual is the FASTQ quality string or undefined
 * @param {Array<{contigId:number,refStart:number,refEnd:number,jointStrand:number,qStart:number,qEnd:number,score:number,anchorCount:number,uniqueAnchors:number,isPrimary:boolean,isSupplementary:boolean,isSecondary:boolean,fragmentIndex:number,mapqInputs:{f1:number,f2:number,m:number}}>} records
 * @param {Array<{name:string}>} contigs index → name lookup
 * @returns {string} SAM lines (one per record), \n-terminated. Empty string
 *   if records is empty (the caller may decide to emit an unmapped record).
 */
export function emitReadSamLines(read, records, contigs) {
  if (!read || typeof read.name !== 'string' || read.name.length === 0) {
    throw new Error(
      `emitReadSamLines: read.name (SAM QNAME) is required as a non-empty string, got ${JSON.stringify({
        name: read?.name,
        keys: read ? Object.keys(read) : null,
      })}. Callers passing alternate fields (e.g. \`read_id\`) must normalize them to \`name\` before emitting SAM.`
    );
  }
  if (records.length === 0) return emitUnmappedRecord(read);

  // Build SA:Z tag once (shared by every fragment of the same read).
  const fragmentRecords = records.filter(r => !r.isSecondary);
  const saTag = fragmentRecords.length > 1
    ? buildSaTag(fragmentRecords, contigs, read.seq.length)
    : null;

  const lines = [];
  for (const r of records) {
    const flag =
      (r.jointStrand === 1 ? SAM_FLAG_REVERSE : 0)
      | (r.isSupplementary ? SAM_FLAG_SUPPLEMENTARY : 0)
      | (r.isSecondary ? SAM_FLAG_SECONDARY : 0);

    const refName = contigs[r.contigId]?.name ?? `*contig${r.contigId}`;
    const pos1 = r.refStart + 1;     // SAM is 1-based
    const mapq = approximateMapq(r.mapqInputs);
    const cigar = buildCigar(r, read.seq.length, r.isSecondary);

    let seq = '*';
    let qual = '*';
    if (r.isPrimary) {
      // Primary always carries full SEQ+QUAL on the forward strand;
      // SAM convention says SEQ should be reverse-complemented if 0x10
      // is set, but parsers like dipc-sam.js consume the field as-is and
      // recover the read sequence from the CIGAR clip lengths. Match
      // minimap2 default which DOES rc the sequence on reverse mappings.
      seq = r.jointStrand === 1 ? reverseComplement(read.seq) : read.seq;
      qual = read.qual
        ? (r.jointStrand === 1 ? read.qual.split('').reverse().join('') : read.qual)
        : '*';
    }

    const optional = [];
    if (saTag && !r.isSecondary) optional.push(saTag);
    optional.push(`AS:i:${Math.round(r.score)}`);
    optional.push(`nm:i:${r.uniqueAnchors}`);   // unique anchor count, lowercase to avoid clashing with NM

    lines.push([
      read.name,
      String(flag),
      refName,
      String(pos1),
      String(mapq),
      cigar,
      '*',                  // RNEXT
      '0',                  // PNEXT
      '0',                  // TLEN
      seq,
      qual,
      ...optional,
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

function emitUnmappedRecord(read) {
  if (!read || typeof read.name !== 'string' || read.name.length === 0) {
    throw new Error(
      `emitUnmappedRecord: read.name (SAM QNAME) is required as a non-empty string, got ${JSON.stringify({
        name: read?.name,
        keys: read ? Object.keys(read) : null,
      })}`
    );
  }
  return [
    read.name,
    String(SAM_FLAG_UNMAPPED),
    '*',
    '0',
    '0',
    '*',
    '*',
    '0',
    '0',
    read.seq,
    read.qual ?? '*',
  ].join('\t') + '\n';
}

/**
 * SA:Z tag listing every OTHER fragment for the same read. Format per
 * SAM spec §1.6:
 *   SA:Z:(rname,pos,strand,CIGAR,mapQ,NM;)+
 */
function buildSaTag(fragmentRecords, contigs, qLen) {
  const segments = fragmentRecords.map(r => {
    const refName = contigs[r.contigId]?.name ?? `*contig${r.contigId}`;
    const strand = r.jointStrand === 1 ? '-' : '+';
    const cigar = buildCigar(r, qLen, false);
    const mapq = approximateMapq(r.mapqInputs);
    const nm = 0;
    return `${refName},${r.refStart + 1},${strand},${cigar},${mapq},${nm};`;
  });
  return `SA:Z:${segments.join('')}`;
}

/**
 * Reverse-complement an ASCII DNA sequence. Used when emitting the SEQ
 * field of a primary record on a reverse-strand mapping.
 */
function reverseComplement(seq) {
  const out = new Array(seq.length);
  for (let i = 0; i < seq.length; ++i) {
    const c = seq.charCodeAt(seq.length - 1 - i);
    out[i] = String.fromCharCode(rcCode(c));
  }
  return out.join('');
}

function rcCode(c) {
  switch (c) {
  case 65: return 84;  // A -> T
  case 67: return 71;  // C -> G
  case 71: return 67;  // G -> C
  case 84: return 65;  // T -> A
  case 78: return 78;  // N -> N
  case 97: return 116; // a -> t
  case 99: return 103; // c -> g
  case 103: return 99; // g -> c
  case 116: return 97; // t -> a
  case 110: return 110;// n -> n
  default: return 78;  // unknown -> N
  }
}
