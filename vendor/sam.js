export function stripSamHeaders(samText) {
  return String(samText || '')
    .split(/\r?\n/)
    .filter(line => line && !line.startsWith('@'))
    .join('\n');
}

export function mergeSamChunkText(existingText, chunkText, options = {}) {
  const includeHeaders = options.includeHeaders ?? !existingText;
  const text = String(chunkText || '');
  const filtered = includeHeaders
    ? text.trimEnd()
    : stripSamHeaders(text).trimEnd();
  if (!filtered) return existingText || '';
  if (!existingText) return `${filtered}\n`;
  return `${existingText.replace(/\n?$/, '\n')}${filtered}\n`;
}

export function mergeSamChunkTextPreservingHeaders(existingText, chunkText) {
  const existing = String(existingText || '');
  const headerLines = [];
  const headerSet = new Set();
  const records = [];

  for (const line of existing.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('@')) {
      if (!headerSet.has(line)) {
        headerSet.add(line);
        headerLines.push(line);
      }
    } else {
      records.push(line);
    }
  }

  for (const line of String(chunkText || '').split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('@')) {
      if (!headerSet.has(line)) {
        headerSet.add(line);
        headerLines.push(line);
      }
    } else {
      records.push(line);
    }
  }

  if (!headerLines.length && !records.length) return existing;
  return [...headerLines, ...records].join('\n') + '\n';
}
