export type Category = 'food' | 'drink' | 'cosmetics' | 'household' | 'clothing' | 'shoes' | 'other';
export type Outcome = 'vegan' | 'not_vegan' | 'uncertain' | 'conflicting';
export type Basis = 'certified' | 'manufacturer' | 'research' | 'composition' | 'packaging' | 'insufficient';
export type Locale = 'en' | 'de';
export interface CheckInput {
  text?: string;
  barcode?: string;
  name?: string;
  brand?: string;
  category?: Category;
  /** Only true when the user/source explicitly supplies the whole composition list. */
  complete?: boolean;
  market?: string;
  locale?: Locale;
  sourceUrl?: string;
  /** Already resized and stripped of metadata by the client. Never a remote URL. */
  images?: string[];
}
export interface Evidence {
  id: string;
  kind: 'user_text' | 'database' | 'ai_extraction' | 'certification' | 'manufacturer' | 'ocr';
  title: string;
  excerpt: string;
  url?: string;
  retrievedAt: string;
  sourceDate?: string;
  license?: string;
  claim?: 'vegan' | 'not_vegan';
  verification?: 'registry' | 'packaging' | 'source' | 'unverified';
}
export interface Finding {
  term: string;
  /** Display-only translation; term remains the source identity used by evaluation. */
  displayTerm?: string;
  displayLocale?: Locale;
  status: 'animal' | 'plant' | 'ambiguous' | 'unknown';
  ruleId?: string;
  explanation: string;
  evidenceId: string;
}
export interface CompanyConcern {
  id?: string;
  company: string;
  category: 'animal_testing' | 'animal_welfare_lobbying' | 'animal_exploitation';
  description: string;
  sourceUrl: string;
  reviewedAt: string;
  status: 'current' | 'resolved' | 'disputed';
  scope?: 'direct' | 'parent';
  matchedBrand?: string;
  ownershipSourceUrl?: string;
  ownershipReviewedAt?: string;
  sourceDate?: string;
}
export type AIErrorCode = 'authentication' | 'access_denied' | 'quota' | 'rate_limit' | 'timeout' | 'network' | 'unsupported_model' | 'invalid_response' | 'incomplete_response' | 'request_rejected' | 'service' | 'unknown';
export interface CheckResult {
  schemaVersion: 1;
  id: string;
  outcome: Outcome;
  basis: Basis;
  title: string;
  summary: string;
  category: Category;
  identity: { name?: string; brand?: string; barcode?: string; market: string; match: 'exact_barcode' | 'unconfirmed' };
  findings: Finding[];
  evidence: Evidence[];
  questions: string[];
  warnings: string[];
  crossContact: string[];
  companyConcerns: CompanyConcern[];
  checkedAt: string;
  usedAI: boolean;
  aiStatus?: 'not_needed' | 'disabled' | 'offline' | 'unconfigured' | 'vision_disabled' | 'failed' | 'text' | 'images';
  /** Fixed localized copy derived from code; never a raw provider error. */
  aiError?: { code: AIErrorCode; message: string };
  webSearchStatus?: 'searched' | 'not_used' | 'unsupported';
}
export interface AIExtraction {
  text: string;
  complete: boolean;
  category: Category;
  name?: string;
  brand?: string;
  barcode?: string;
  ingredientAssessments?: { term: string; translatedTerm?: string; status: Finding['status']; explanation: string }[];
  labelObservations?: { kind: 'vegan_certification' | 'vegan_claim'; name: string; text: string }[];
  webClaims?: { url: string; quote: string; claim: 'vegan' | 'not_vegan'; sourceType: 'manufacturer' | 'certification'; productName: string; brand: string }[];
  webCompositions?: { url: string; text: string; complete: boolean; sourceType: 'manufacturer' | 'retailer'; productName: string; brand: string }[];
  /** Adapter-supplied tool metadata. This key is never accepted from model-authored JSON. */
  research?: { searched: boolean; sources: { url: string; title: string }[] };
}
export interface ProviderAdapter {
  supportsWebSearch?: boolean;
  extract(input: CheckInput, signal?: AbortSignal): Promise<AIExtraction>;
}
export interface ProviderConfig {
  baseUrl: string;
  token?: string;
  model: string;
  supportsVision?: boolean;
}
export type CheckStage = 'database' | 'ai' | 'evaluating';
export interface CheckOptions {
  /** Validated on-device product snapshots, checked before public network databases. */
  offlineProducts?: { lookup(barcode: string, input: Pick<CheckInput, 'category' | 'locale' | 'market'>): DatabaseProduct | null };
  /** Reports real work boundaries without estimating completion percentages. */
  onProgress?: (stage: CheckStage) => void;
  mode: 'explicit' | 'background';
  provider?: ProviderAdapter;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Disable all public-database network requests. */
  offline?: boolean;
  now?: () => Date;
}
export interface DatabaseProduct {
  warnings?: string[];
  input: CheckInput;
  evidence: Evidence;
  labels: string[];
}
