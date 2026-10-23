import { useEffect, useMemo, useState } from 'preact/hooks';
import { countryCode, countryOptions, type MarketSource, type Locale } from '@vegsnap/core';
import { marketMessages } from './i18n';

export function CountrySelect({value,locale,disabled,onChange}: {value:string; locale:Locale; disabled?:boolean; onChange:(market:string)=>void}) {
  const options = useMemo(()=>countryOptions(locale),[locale]);
  return <select class="country-select" value={value} required disabled={disabled} onChange={event=>onChange(event.currentTarget.value)}>
    {options.map(option=><option key={option.code} value={option.code}>{option.flag} {option.name}</option>)}
  </select>;
}

export function ProductMarket({market,locale,disabled,source,fallback,onSave}: {market:string; locale:Locale; disabled?:boolean; source?:MarketSource; fallback?:boolean; onSave:(market:string)=>Promise<void>}) {
  const [value,setValue] = useState(market);
  const t = marketMessages[locale];
  useEffect(()=>setValue(market),[market]);
  return <div class="product-country">
    <label>{fallback ? t.fallback : t.productCountry}<CountrySelect value={value} locale={locale} disabled={disabled}
      onChange={country=>{ setValue(country); if (fallback) void onSave(country); }}/></label>
    {source && <p class="hint">{t[source]}</p>}
    {!fallback && <p class="hint">{t.correctionHint}</p>}
    {!fallback && <button type="button" onClick={()=>void onSave(value)} disabled={disabled || value === market || !countryCode(value)}>{t.saveCountry}</button>}
  </div>;
}
