/** @jsxImportSource preact */
import { parseResultCompanyAssessment, safeSourceUrl, type CompanyAssessment, type CompanyConcern, type Locale } from '@veguide/core';

const messages = {
  en: {
    title: 'Company concerns', ai: 'AI company assessment', notAssessed: 'Company not assessed by AI.', reviewedRecords: 'Reviewed records', assessed: 'Assessed',
    aiNotice: 'AI interpreted these sources; the assessment is not independently verified and does not change the product’s vegan result.',
    noClearance: 'No concerns found in these sources is not an ethical endorsement.', mismatch: 'The reviewed records below include current concerns that this AI assessment did not report. Check both sets of sources.',
    concerns_found: 'Concerns found', no_concerns_found: 'No concerns found in searched sources', inconclusive: 'Inconclusive', forBrand: 'Company assessed for',
    empty: 'No concern matched in our limited reviewed dataset. This is not an ethical endorsement.',
    separate: 'These company records do not change the product’s vegan result.',
    parent: 'Parent company of', direct: 'Matched company or brand', reviewed: 'Reviewed', sourceDate: 'Source date',
    source: 'Conduct source', ownership: 'Ownership source', ownershipReviewed: 'Ownership reviewed',
    animal_testing: 'Animal testing', animal_welfare_lobbying: 'Opposition to animal-welfare protections', animal_exploitation: 'Documented animal exploitation',
    current: 'Current', resolved: 'Resolved', disputed: 'Disputed',
  },
  de: {
    title: 'Unternehmenshinweise', ai: 'KI-Unternehmensbewertung', notAssessed: 'Unternehmen nicht von KI bewertet.', reviewedRecords: 'Geprüfte Einträge', assessed: 'Bewertet',
    aiNotice: 'KI hat diese Quellen interpretiert. Die Bewertung ist nicht unabhängig geprüft und ändert das vegane Produktergebnis nicht.',
    noClearance: 'Keine gefundenen Bedenken in diesen Quellen sind kein ethisches Gütesiegel.', mismatch: 'Die geprüften Einträge unten enthalten aktuelle Bedenken, die diese KI-Bewertung nicht nennt. Prüfe beide Quellengruppen.',
    concerns_found: 'Bedenken gefunden', no_concerns_found: 'Keine Bedenken in den durchsuchten Quellen gefunden', inconclusive: 'Unklar', forBrand: 'Bewertetes Unternehmen für',
    empty: 'Kein Treffer in unserem begrenzten, geprüften Datenbestand. Dies ist kein ethisches Gütesiegel.',
    separate: 'Diese Unternehmenshinweise ändern das vegane Produktergebnis nicht.',
    parent: 'Mutterunternehmen von', direct: 'Zugeordnetes Unternehmen oder Marke', reviewed: 'Geprüft', sourceDate: 'Quelldatum',
    source: 'Quelle zum Verhalten', ownership: 'Quelle zur Eigentümerschaft', ownershipReviewed: 'Eigentümerschaft geprüft',
    animal_testing: 'Tierversuche', animal_welfare_lobbying: 'Lobbyarbeit gegen Tierschutz', animal_exploitation: 'Dokumentierte Ausbeutung von Tieren',
    current: 'Aktuell', resolved: 'Beendet', disputed: 'Umstritten',
  },
};
function formatDate(value: string, locale: Locale): string {
  if (/^\d{4}-\d{2}$/.test(value)) return value; // Retain month-only source precision.
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(locale, { timeZone: 'UTC' }) : value;
}
export function CompanyConcerns({ concerns, assessment: rawAssessment, locale }: { concerns: CompanyConcern[]; assessment?: CompanyAssessment; locale: Locale }) {
  const t = messages[locale];
  const assessment = parseResultCompanyAssessment(rawAssessment);
  return <section class="company-concerns">
    <h2>{t.title}</h2>
    {assessment ? <article class="evidence ai-company-assessment">
      <h3>{t.ai}</h3>
      <strong>{t[assessment.verdict]}</strong>
      <p>{assessment.company} · {assessment.scope === 'parent' ? t.parent : t.forBrand}: {assessment.brand}</p>
      <p>{assessment.summary}</p>
      {assessment.categories.length > 0 && <p>{assessment.categories.map(category => t[category]).join(' · ')}</p>}
      <p class="muted">{t.aiNotice}</p>
      {assessment.verdict === 'no_concerns_found' && <>
        <p class="muted">{t.noClearance}</p>
        {concerns.some(concern => concern.status === 'current') && <p class="alert">{t.mismatch}</p>}
      </>}
      <p class="hint">{t.assessed}: <time dateTime={assessment.assessedAt}>{formatDate(assessment.assessedAt, locale)}</time></p>
      {assessment.sources.map((source, index) => <div key={`${source.url}:${index}`}>
        <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title} ↗</a>
        <blockquote>{source.quote}</blockquote>
      </div>)}
      {assessment.ownershipSourceUrl && <p><a href={assessment.ownershipSourceUrl} target="_blank" rel="noopener noreferrer">{t.ownership} ↗</a></p>}
    </article> : <p class="muted">{t.notAssessed}</p>}
    <h3>{t.reviewedRecords}</h3>
    {concerns.length === 0 ? <p class="muted">{t.empty}</p> : <>
      <p class="muted">{t.separate}</p>
      {concerns.map((concern, index) => <article class="evidence" key={`${concern.id ?? index}:${concern.matchedBrand ?? ''}`}>
        <strong>{concern.company}</strong>
        {concern.matchedBrand && <p class="hint">{concern.scope === 'parent' ? t.parent : t.direct}: {concern.matchedBrand}</p>}
        <p><strong>{t[concern.category]}</strong> · {t[concern.status]}</p>
        <p>{concern.description}</p>
        <p class="hint">{t.reviewed}: <time dateTime={concern.reviewedAt}>{formatDate(concern.reviewedAt, locale)}</time>
          {concern.sourceDate && <> · {t.sourceDate}: <time dateTime={concern.sourceDate}>{formatDate(concern.sourceDate, locale)}</time></>}</p>
        {safeSourceUrl(concern.sourceUrl) && <a href={safeSourceUrl(concern.sourceUrl)} target="_blank" rel="noopener noreferrer">{t.source} ↗</a>}
        {concern.scope === 'parent' && safeSourceUrl(concern.ownershipSourceUrl) && <p>
          <a href={safeSourceUrl(concern.ownershipSourceUrl)} target="_blank" rel="noopener noreferrer">{t.ownership} ↗</a>
          {concern.ownershipReviewedAt && <small class="hint"> · {t.ownershipReviewed}: <time dateTime={concern.ownershipReviewedAt}>{formatDate(concern.ownershipReviewedAt, locale)}</time></small>}
        </p>}
      </article>)}
    </>}
  </section>;
}
