import { analyzeText, parseSourceIngredients } from './analyze';
import { lookupProduct, normalizeBarcode } from './database';
import { validateAIExtraction } from './provider';
import { applyAIEvidence } from './ai-evidence';
import { applyWebEvidence } from './web-evidence';
import { mergeResults, withoutCompositionFindings } from './merge-results';
import { attachCompanyConcerns } from './company-concerns';
import { applyManufacturerContact } from './manufacturer-contact';
import { applyCompanyAssessment } from './company-assessment';
import { databaseCountryWarning, selectProductCountry } from './market';
import type { CheckInput, CheckOptions, CheckResult, DatabaseProduct } from './types';

function databaseResult(product: DatabaseProduct, input: CheckInput, now?: () => Date): CheckResult {
  const result = analyzeText({ ...product.input, locale: input.locale, category: input.category && input.category !== 'other' ? input.category : product.input.category }, now);
  result.evidence = [product.evidence];
  result.findings = result.findings.map(finding => ({ ...finding, evidenceId: product.evidence.id }));
  result.identity.match = 'exact_barcode';
  result.warnings.push(input.locale === 'de' ? 'Gemeinschaftlich gepflegter Datensatz; Markt, Rezeptur und Aktualität prüfen.' : 'Community-maintained record; check market, recipe and freshness.');
  // Country warnings are evaluated after packaging and database clues are combined.
  result.warnings.push(...(product.warnings ?? []).filter(warning => !/^(This record lists other markets|Dieser Datensatz nennt andere Märkte|Different market:|Abweichender Markt:)/.test(warning)));
  // Database label tags are community assertions, not independently verified registry claims.
  if (product.labels.length) result.warnings.push(`Database labels (unverified): ${product.labels.join(', ')}`);
  return result;
}

/** One bounded AI workflow (with an optional identity-only research follow-up); no AI request can run in background or offline mode. */
export async function checkProduct(input: CheckInput, options: CheckOptions): Promise<CheckResult> {
  options.signal?.throwIfAborted();
  options.onProgress?.('evaluating');
  let result = analyzeText(input, options.now);
  const markets: string[] = [];
  const evidenceMarkets: string[][] = [];
  let packagingCountry: string | undefined;
  const finish = () => {
    result.identity = {...result.identity,...selectProductCountry(input,packagingCountry,markets)};
    for (const countries of evidenceMarkets) {
      const warning = databaseCountryWarning(result.identity.market, countries, input.locale);
      if (warning && !result.warnings.includes(warning)) result.warnings.push(warning);
    }
    return attachCompanyConcerns(result, input.locale, result.identity.brand ?? input.brand);
  };
  const checked = new Set<string>();
  async function lookup(code?: string) {
    if (!code) return;
    const lookupKey = normalizeBarcode(code)?.padStart(14, '0') ?? code;
    if (checked.has(lookupKey)) return;
    checked.add(lookupKey);
    if (options.offlineProducts || !options.offline) options.onProgress?.('database');
    try {
      const local = options.offlineProducts?.lookup(code, input);
      if (local) { markets.push(...local.markets ?? []); evidenceMarkets.push(local.evidenceMarkets ?? local.markets ?? []); result = mergeResults(result, databaseResult(local, input, options.now)); return; }
      if (options.offline) {
        result.warnings.push(input.locale === 'de' ? 'Kein passender Eintrag im teilweisen Offline-Datenbestand.' : 'No exact record in the partial offline database.');
        return;
      }
      const product = await lookupProduct(code, { fetch: options.fetch, signal: options.signal, now: options.now,
        category: input.category, market: input.market, locale: input.locale, autoMarket: input.autoMarket });
      if (product) { markets.push(...product.markets ?? []); evidenceMarkets.push(product.markets ?? []); result = mergeResults(result, databaseResult(product, input, options.now)); }
      else result.warnings.push(input.locale === 'de' ? 'Kein passender Datenbankeintrag gefunden.' : 'No exact product record was found.');
    } catch (error) {
      if (options.signal?.aborted) throw error;
      result.warnings.push(error instanceof Error ? error.message : 'Database lookup failed.');
    }
  }
  await lookup(input.barcode);
  result.aiStatus = 'not_needed';
  result.webSearchStatus = 'not_used';
  if (options.mode !== 'explicit' || result.outcome !== 'uncertain' || !(input.text?.trim() || input.images?.length || input.name?.trim())) return finish();
  if (options.offline || !options.provider) {
    result.aiStatus = options.offline ? 'offline' : 'unconfigured';
    if (input.images?.length) result.warnings.push(input.locale === 'de'
      ? options.offline ? 'Die KI hat dieses Foto nicht analysiert: Der Offline-Modus ist aktiv.' : 'Die KI hat dieses Foto nicht analysiert: Ein Modell in den Einstellungen auswählen.'
      : options.offline ? 'AI did not analyze this photo: offline mode is enabled.' : 'AI did not analyze this photo: choose a model in Settings.');
    return finish();
  }
  options.signal?.throwIfAborted();
  if (options.provider.supportsWebSearch === false) result.webSearchStatus = 'unsupported';
  try {
    options.onProgress?.('ai');
    const extracted = validateAIExtraction(await options.provider.extract(input, options.signal), { allowResearch: true });
    options.onProgress?.('evaluating');
    const suppliedCode = input.barcode && normalizeBarcode(input.barcode);
    const extractedCode = extracted.barcode && normalizeBarcode(extracted.barcode);
    if (suppliedCode && extractedCode && suppliedCode.padStart(14, '0') !== extractedCode.padStart(14, '0')) {
      throw new Error('AI identified a different product barcode; confirm the product before using its evidence.');
    }
    // With text-only input, preserve the entire supplied composition: a substring could omit an unknown ingredient.
    const canonical = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    const original = input.text ?? '';
    const composition = original.replace(/^[\s\S]*?(?:ingredients|ingredienser|zutaten|materials|material|zusammensetzung|composition)\s*:\s*/i, '');
    if (!input.images?.length && extracted.text && ![canonical(original), canonical(composition)].includes(canonical(extracted.text))) {
      throw new Error('AI extraction changed the supplied text; the original evidence was kept.');
    }
    packagingCountry = extracted.packaging?.country;
    // Leading whitespace must stay on its line so blank lines are not rescanned from every newline.
    const localComplete = input.complete ?? /(?:^|\n)[^\S\r\n]*(?:ingredients|ingredienser|zutaten|materials|material|zusammensetzung|composition)\s*:/i.test(original);
    const complete = input.complete === false ? false : input.images?.length ? extracted.complete : localComplete && extracted.complete;
    // A checked complete text list remains the composition authority even when a front photo is attached.
    // The photo can add label evidence, but must not silently replace or truncate supplied ingredients.
    const hasCompleteText = input.complete === true && Boolean(original.trim());
    const authoritativeText = hasCompleteText ? original : extracted.text;
    const completeForEvaluation = authoritativeText.length <= 20_000 && (hasCompleteText || complete);
    const aiInput = { ...input, ...extracted,
      text: authoritativeText,
      category: input.category && input.category !== 'other' ? input.category : extracted.category,
      barcode: suppliedCode || extractedCode || input.barcode,
      complete: completeForEvaluation };
    const parsed = parseSourceIngredients(authoritativeText, extracted.ingredients);
    const extractedResult = analyzeText(aiInput, options.now, extracted.ingredients);
    extractedResult.usedAI = true;
    extractedResult.evidence = extracted.text ? [{ id: 'ai-extraction', kind: 'ai_extraction', title: 'AI transcription — check against the original',
      excerpt: extracted.text, retrievedAt: result.checkedAt }] : [];
    extractedResult.findings = extractedResult.findings.map(finding => ({ ...finding, evidenceId: 'ai-extraction' }));
    if (extracted.text) extractedResult.warnings.push(input.locale === 'de' ? 'KI-Abschrift am Original prüfen; keine Zertifizierungsprüfung.' : 'Verify the AI transcription against the original; no certification was checked.');
    result = mergeResults(parsed ? withoutCompositionFindings(result, authoritativeText) : result, extractedResult);
    result.aiStatus = input.images?.length ? 'images' : 'text';
    result.webSearchStatus = extracted.research?.searched ? 'searched' : options.provider.supportsWebSearch === false ? 'unsupported' : 'not_used';
    result = applyAIEvidence(result, aiInput, extracted, completeForEvaluation);
    result = applyWebEvidence(result, input, extracted);
    if (result.outcome === 'uncertain' && options.provider.supportsWebSearch && extracted.name && extracted.brand && !extracted.complete && !extracted.research?.searched) {
      result.warnings.push(input.locale === 'de' ? 'Die Webrecherche wurde nicht abgeschlossen; die verfügbaren Foto- oder Textbelege wurden beibehalten.' : 'Web research did not complete; the available photo or text evidence was kept.');
    }
    if (extracted.barcode && normalizeBarcode(extracted.barcode)) await lookup(extracted.barcode);
    result = applyManufacturerContact(result, input, extracted);
    result = applyCompanyAssessment(result, input, extracted);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    result.warnings.push(error instanceof Error ? error.message : 'AI could not complete this check.');
    result.aiStatus = error instanceof Error && /vision-capable/.test(error.message) ? 'vision_disabled' : 'failed';
  }
  return finish();
}
