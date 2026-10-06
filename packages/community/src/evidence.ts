import { SubmissionError } from '@vegsnap/core/community';

export const MAX_EVIDENCE_BYTES = 2_000_000;
const signature = [137, 80, 78, 71, 13, 10, 26, 10];
/** Keep only PNG image/color chunks, dropping metadata, custom chunks and extra frames. */
export function cleanEvidence(bytes: Uint8Array, type: string): { bytes: Uint8Array; type: string } {
  const fail = () => { throw new SubmissionError('evidence', 'Attach a valid PNG screenshot or PDF no larger than 2 MB.'); };
  if (!bytes.length || bytes.length > MAX_EVIDENCE_BYTES) return fail();
  if (type === 'application/pdf') {
    if (new TextDecoder().decode(bytes.slice(0, 8)).startsWith('%PDF-') && new TextDecoder().decode(bytes.slice(-1024)).includes('%%EOF')) return { bytes, type };
    return fail();
  }
  if (type !== 'image/png' || !signature.every((value, index) => bytes[index] === value)) return fail();
  const chunks = [bytes.slice(0, 8)]; const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, first = true, imageData = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + length + 12;
    if (end > bytes.length) return fail();
    const name = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8));
    if (first) {
      if (name !== 'IHDR' || length !== 13) return fail();
      const width = view.getUint32(offset + 8), height = view.getUint32(offset + 12);
      if (!width || !height || width > 5000 || height > 5000 || width * height > 12_000_000) return fail();
      first = false;
    } else if (name === 'IHDR') return fail();
    if (name === 'IDAT') imageData = true;
    if (['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB'].includes(name)) chunks.push(bytes.slice(offset, end));
    offset = end;
    if (name === 'IEND') {
      if (length !== 0 || !imageData) return fail();
      const cleaned = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let at = 0;
      for (const chunk of chunks) { cleaned.set(chunk, at); at += chunk.length; }
      return { bytes: cleaned, type };
    }
  }
  return fail();
}
