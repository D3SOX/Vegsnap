/** @jsxImportSource preact */
import { parseResultCompanyAssessment, safeSourceUrl, type CompanyAssessment, type CompanyConcern, type Locale } from '@vegsnap/core';
import { companyMessages as messages } from './i18n';

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
