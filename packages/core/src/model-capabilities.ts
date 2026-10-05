export type ImageSupport = 'supported' | 'unsupported' | 'unknown';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Catalog metadata takes precedence. Missing metadata must not silently disable photos. */
export function imageSupport(model: string, metadata?: unknown): ImageSupport {
  if (record(metadata)) {
    for (const field of ['supportsImages', 'supports_image_input', 'supports_vision']) {
      if (typeof metadata[field] === 'boolean') return metadata[field] ? 'supported' : 'unsupported';
    }
    const capabilities = record(metadata.capabilities) ? metadata.capabilities : undefined;
    if (typeof capabilities?.vision === 'boolean') return capabilities.vision ? 'supported' : 'unsupported';
    const architecture = record(metadata.architecture) ? metadata.architecture : undefined;
    const modalities = metadata.input_modalities ?? architecture?.input_modalities;
    if (Array.isArray(modalities) && modalities.length > 0 && modalities.every(item => typeof item === 'string')) {
      return modalities.some(item => item.toLowerCase() === 'image') ? 'supported' : 'unsupported';
    }
  }
  const id = model.toLowerCase().trim().replace(/^openai\//, '');
  if (/^(?:gpt-3\.5(?:-|$)|gpt-4(?:-(?:0314|0613|32k)(?:-|$)|$)|o1-(?:mini|preview)(?:-|$)|o3-mini(?:-|$))/.test(id)) return 'unsupported';
  if (/^(?:gpt-4o(?:-|$)|gpt-4\.(?:1|5)(?:-|$)|gpt-4-(?:turbo|vision)(?:-|$)|gpt-[56](?:[.-]|$)|o1(?:-|$)|o3(?:-|$)|o4-mini(?:-|$))/.test(id)) return 'supported';
  return 'unknown';
}

export function acceptsImages(model: string, metadata?: unknown): boolean {
  return imageSupport(model, metadata) !== 'unsupported';
}
