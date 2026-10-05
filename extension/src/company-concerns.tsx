/** @jsxImportSource preact */
import { safeSourceUrl, type CompanyConcern, type Locale } from '@veguide/core';

const messages = {
  en: {
    title: 'Company concerns', empty: 'No concern matched in our limited reviewed dataset. This is not an ethical endorsement.',
    separate: 'These company records do not change the product’s vegan result.',
    parent: 'Parent company of', direct: 'Matched company or brand', reviewed: 'Reviewed', sourceDate: 'Source date',
    source: 'Conduct source', ownership: 'Ownership source', ownershipReviewed: 'Ownership reviewed',
    animal_testing: 'Animal testing', animal_welfare_lobbying: 'Opposition to animal-welfare protections', animal_exploitation: 'Documented animal exploitation',
    current: 'Current', resolved: 'Resolved', disputed: 'Disputed',
  },
  de: {
    title: 'Unternehmenshinweise', empty: 'Kein Treffer in unserem begrenzten, geprüften Datenbestand. Dies ist kein ethisches Gütesiegel.',
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
export function CompanyConcerns({ concerns, locale }: { concerns: CompanyConcern[]; locale: Locale }) {
  const t = messages[locale];
  return <section class="company-concerns">
    <h2>{t.title}</h2>
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
