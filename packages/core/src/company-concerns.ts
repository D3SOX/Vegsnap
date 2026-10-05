import sourceData from '../../../data/company-concerns.json';
import type { CheckResult, CompanyConcern, Locale } from './types';

export interface CompanyEntity {
  id: string;
  name: string;
  kind: 'company' | 'brand';
  aliases: string[];
  parent?: { id: string; sourceUrl: string; reviewedAt: string };
}
export interface CompanyConcernRecord {
  id: string;
  companyId: string;
  category: CompanyConcern['category'];
  description: Record<Locale, string>;
  sourceUrl: string;
  sourceDate?: string;
  reviewedAt: string;
  status: CompanyConcern['status'];
  redistribution: string;
}
export interface CompanyConcernDataset {
  version: 1;
  license: string;
  policy: string;
  entities: CompanyEntity[];
  records: CompanyConcernRecord[];
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function safeSource(value: unknown): value is string {
  if (!text(value)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
function date(value: unknown): value is string { return text(value) && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value)); }
function sourceDate(value: unknown): value is string { return text(value) && (/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value) || date(value)); }
function normalized(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(); }

/** Reviewed local data only. No AI/company claims or network results are accepted by this resolver. */
export function createCompanyConcernResolver(value: unknown): (brand?: string, locale?: Locale) => CompanyConcern[] {
  if (!object(value) || value.version !== 1 || !text(value.license) || !text(value.policy) || !Array.isArray(value.entities) || !Array.isArray(value.records)) {
    throw new Error('Invalid reviewed company dataset.');
  }
  const entities = new Map<string, CompanyEntity>();
  for (const entry of value.entities) {
    if (!object(entry) || !text(entry.id) || !text(entry.name) || !['company', 'brand'].includes(String(entry.kind)) ||
      !Array.isArray(entry.aliases) || !entry.aliases.every(text) || entities.has(entry.id)) throw new Error('Invalid or duplicate company entity.');
    if (entry.parent !== undefined && (!object(entry.parent) || !text(entry.parent.id) || !safeSource(entry.parent.sourceUrl) || !date(entry.parent.reviewedAt))) {
      throw new Error('A company ownership link needs an entity, source, and review date.');
    }
    entities.set(entry.id, entry as unknown as CompanyEntity);
  }
  for (const entity of entities.values()) {
    const seen = new Set([entity.id]);
    let current = entity;
    while (current.parent) {
      const parent = entities.get(current.parent.id);
      if (!parent || parent.kind !== 'company' || seen.has(parent.id)) throw new Error('Invalid or circular company ownership.');
      seen.add(parent.id); current = parent;
    }
  }
  const records = new Map<string, CompanyConcernRecord[]>();
  const recordIds = new Set<string>();
  for (const entry of value.records) {
    if (!object(entry) || !text(entry.id) || recordIds.has(entry.id) || !text(entry.companyId) || !entities.has(entry.companyId) ||
      !['animal_testing', 'animal_welfare_lobbying', 'animal_exploitation'].includes(String(entry.category)) ||
      !object(entry.description) || !text(entry.description.en) || !text(entry.description.de) ||
      !safeSource(entry.sourceUrl) || !date(entry.reviewedAt) || entry.sourceDate !== undefined && !sourceDate(entry.sourceDate) ||
      !['current', 'resolved', 'disputed'].includes(String(entry.status)) || !text(entry.redistribution)) {
      throw new Error('A company concern needs reviewed, localized, sourced conduct.');
    }
    recordIds.add(entry.id);
    records.set(entry.companyId, [...records.get(entry.companyId) ?? [], entry as unknown as CompanyConcernRecord]);
  }
  // An alias shared by two entities cannot establish which company the user means.
  const aliases = new Map<string, CompanyEntity | null>();
  for (const entity of entities.values()) for (const alias of [entity.name, ...entity.aliases]) {
    const key = normalized(alias);
    const existing = aliases.get(key);
    aliases.set(key, existing === undefined || existing?.id === entity.id ? entity : null);
  }
  return (brand, locale = 'en') => {
    if (!brand || brand.length > 1000) return [];
    const whole = aliases.get(normalized(brand));
    // A full alias such as "Example, Inc." wins over comma-separated brand metadata.
    if (whole === null) return [];
    const segments = whole ? [brand] : brand.split(',');
    if (segments.length > 8) return [];
    const matched = new Map<string, CompanyEntity>();
    for (const segment of segments) { const entity = aliases.get(normalized(segment)); if (entity) matched.set(entity.id, entity); }
    const concerns: CompanyConcern[] = [];
    for (const entity of matched.values()) {
      const actors = [entity, ...(entity.parent ? [entities.get(entity.parent.id)!] : [])];
      for (const actor of actors) for (const record of records.get(actor.id) ?? []) {
        const parent = actor.id !== entity.id ? entity.parent : undefined;
        concerns.push({
          id: record.id, company: actor.name, category: record.category, description: record.description[locale],
          sourceUrl: record.sourceUrl, reviewedAt: new Date(record.reviewedAt).toISOString(), status: record.status,
          scope: parent ? 'parent' : 'direct', matchedBrand: entity.name,
          ...(record.sourceDate ? { sourceDate: record.sourceDate } : {}),
          ...(parent ? { ownershipSourceUrl: parent.sourceUrl, ownershipReviewedAt: new Date(parent.reviewedAt).toISOString() } : {}),
        });
      }
    }
    return concerns;
  };
}

let bundledResolver: ReturnType<typeof createCompanyConcernResolver> | undefined;
export function resolveCompanyConcerns(brand?: string, locale: Locale = 'en'): CompanyConcern[] {
  bundledResolver ??= createCompanyConcernResolver(sourceData);
  return bundledResolver(brand, locale);
}
export function attachCompanyConcerns(result: CheckResult, locale: Locale = 'en', brand = result.identity.brand): CheckResult {
  return { ...result, companyConcerns: resolveCompanyConcerns(brand, locale) };
}
