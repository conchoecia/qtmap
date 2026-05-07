const DEFAULT_READS_PER_CHUNK = 1000;

export async function* chunkFastqBlob(blob, options = {}) {
  const readsPerChunk = normalizeReadsPerChunk(options.readsPerChunk);
  const maxReads = Number.isFinite(options.maxReads) ? Math.max(0, Math.floor(options.maxReads)) : Infinity;
  const decoder = new TextDecoder();
  let carry = '';
  let recordLines = [];
  let chunkLines = [];
  let chunkReadCount = 0;
  let totalReadCount = 0;
  let chunkIndex = 0;
  let stopped = false;

  for await (const bytes of iterateBlobBytes(blob)) {
    carry += decoder.decode(bytes, { stream: true });
    const lines = carry.split(/\n/);
    carry = lines.pop() ?? '';

    for (const rawLine of lines) {
      ({ stopped, chunkIndex, chunkReadCount, totalReadCount, chunkLines, recordLines } = processFastqLine({
        rawLine,
        recordLines,
        chunkLines,
        chunkReadCount,
        chunkIndex,
        totalReadCount,
        maxReads,
        readsPerChunk,
      }));
      if (chunkLines.ready) {
        yield buildChunk(chunkLines.value, chunkReadCount, chunkIndex);
        chunkLines = [];
        chunkReadCount = 0;
        chunkIndex += 1;
      }
      if (stopped) break;
    }
    if (stopped) break;
  }

  if (!stopped) {
    const finalText = decoder.decode();
    const tail = `${carry}${finalText}`;
    if (tail.length > 0) {
      for (const rawLine of tail.split(/\n/)) {
        if (rawLine === '') continue;
        ({ stopped, chunkIndex, chunkReadCount, totalReadCount, chunkLines, recordLines } = processFastqLine({
          rawLine,
          recordLines,
          chunkLines,
          chunkReadCount,
          chunkIndex,
          totalReadCount,
          maxReads,
          readsPerChunk,
        }));
        if (chunkLines.ready) {
          yield buildChunk(chunkLines.value, chunkReadCount, chunkIndex);
          chunkLines = [];
          chunkReadCount = 0;
          chunkIndex += 1;
        }
        if (stopped) break;
      }
    }
  }

  if (recordLines.length !== 0) {
    throw new Error(`FASTQ ended with an incomplete ${recordLines.length}-line record.`);
  }
  if (!Array.isArray(chunkLines) && chunkLines.ready) {
    yield buildChunk(chunkLines.value, chunkReadCount, chunkIndex);
  } else if (Array.isArray(chunkLines) && chunkLines.length > 0) {
    yield buildChunk(chunkLines, chunkReadCount, chunkIndex);
  }
}

export async function collectFastqChunks(blob, options = {}) {
  const chunks = [];
  for await (const chunk of chunkFastqBlob(blob, options)) {
    chunks.push(chunk);
  }
  return chunks;
}

function processFastqLine({
  rawLine,
  recordLines,
  chunkLines,
  chunkReadCount,
  chunkIndex,
  totalReadCount,
  maxReads,
  readsPerChunk,
}) {
  if (totalReadCount >= maxReads) {
    return { stopped: true, chunkIndex, chunkReadCount, totalReadCount, chunkLines, recordLines };
  }

  const line = rawLine.replace(/\r$/, '');
  recordLines.push(line);
  if (recordLines.length < 4) {
    return { stopped: false, chunkIndex, chunkReadCount, totalReadCount, chunkLines, recordLines };
  }

  validateFastqRecord(recordLines, totalReadCount + 1);
  chunkLines.push(...recordLines);
  recordLines = [];
  chunkReadCount += 1;
  totalReadCount += 1;

  if (chunkReadCount >= readsPerChunk) {
    return {
      stopped: false,
      chunkIndex,
      chunkReadCount,
      totalReadCount,
      chunkLines: { ready: true, value: chunkLines },
      recordLines,
    };
  }

  return { stopped: false, chunkIndex, chunkReadCount, totalReadCount, chunkLines, recordLines };
}

function buildChunk(lines, readCount, index) {
  return {
    index,
    readCount,
    text: `${lines.join('\n')}\n`,
  };
}

function normalizeReadsPerChunk(value) {
  if (value === 0 || value === false || value === Infinity) return Number.MAX_SAFE_INTEGER;
  const parsed = Number.isFinite(value) ? Math.floor(value) : DEFAULT_READS_PER_CHUNK;
  return Math.max(1, parsed);
}

function validateFastqRecord(lines, readNumber) {
  if (!lines[0]?.startsWith('@')) {
    throw new Error(`FASTQ read ${readNumber} header does not start with @.`);
  }
  if (!lines[2]?.startsWith('+')) {
    throw new Error(`FASTQ read ${readNumber} separator does not start with +.`);
  }
}

async function* iterateBlobBytes(blob) {
  if (blob?.stream) {
    const reader = blob.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) yield value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  if (blob?.arrayBuffer) {
    yield new Uint8Array(await blob.arrayBuffer());
    return;
  }
  throw new Error('Expected a Blob/File-like FASTQ input.');
}
