import { describe, expect, test } from 'bun:test';
import fixtures from '../../../contracts/evidence-fixtures.json';
import { mergeResearch, researchAssessment, validateAIExtraction } from '../src/provider';
import type { Category } from '../src/types';

// The Android unit tests iterate the same contract, keeping both verdict ports aligned.
describe('shared evidence fixtures', () => {
  for (const item of fixtures.assessments) test(item.name, () => {
    const input = item.input as { photo: boolean; category?: Category };
    const result = researchAssessment(validateAIExtraction(item.extraction, { allowResearch: true }),
      { category: input.category, images: input.photo ? ['data:image/jpeg;base64,AA=='] : undefined });
    expect({ outcome: result.outcome as string, basis: result.basis as string }).toEqual(item.expected);
  });
  for (const item of fixtures.researchMerges) test(item.name, () => {
    const merged = mergeResearch(validateAIExtraction(item.original, { allowResearch: true }), validateAIExtraction(item.researched, { allowResearch: true }));
    expect((merged.webClaims ?? []).map(claim => claim.url)).toEqual(item.expected.webClaims);
    expect((merged.webCompositions ?? []).map(composition => composition.url)).toEqual(item.expected.webCompositions);
  });
});
