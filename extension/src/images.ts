/** Bound downloaded bytes even when the remote server omits Content-Length. */
export async function readImageResponse(response: Response): Promise<Blob> {
  const maxBytes = 15 * 1024 * 1024;
  const type = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new Error('Choose a JPEG, PNG or WebP image.');
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Image is too large.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The image response was empty.');
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return new Blob(chunks, { type });
      size += chunk.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('Image is too large.'); }
      chunks.push(new Uint8Array(chunk.value));
    }
  } finally { reader.releaseLock(); }
}

export async function sanitizeImage(blob: Blob): Promise<string> {
  if (blob.size > 15 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) throw new Error('Choose a JPEG, PNG or WebP image up to 15 MB.');
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width * bitmap.height > 40_000_000) throw new Error('Image dimensions are too large.');
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image processing is unavailable.');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally { bitmap.close(); }
}
