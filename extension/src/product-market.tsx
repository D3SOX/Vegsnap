import { useEffect, useState } from 'preact/hooks';
import { countryCode, type MarketSource, type Locale } from '@vegsnap/core';
import { marketMessages } from './i18n';

export function ProductMarket({market,locale,disabled,source,fallback,onSave}: {market:string; locale:Locale; disabled?:boolean; source?:MarketSource; fallback?:boolean; onSave:(market:string)=>Promise<void>}) {
  const [value,setValue] = useState(market);
  const t = marketMessages[locale];
  useEffect(()=>setValue(market),[market]);
  return <div class="product-country">
    <label>{fallback ? t.fallback : t.productCountry}<input value={value} maxLength={2} pattern="[A-Z]{2}" required disabled={disabled}
      onInput={event=>setValue(event.currentTarget.value.toUpperCase().replace(/[^A-Z]/g,'').slice(0,2))}/></label>
    {source && <p class="hint">{t[source]}</p>}
    {!fallback && <p class="hint">{t.correctionHint}</p>}
    <button type="button" onClick={()=>void onSave(value)} disabled={disabled || !/^[A-Z]{2}$/.test(value) || !countryCode(value)}>{t.saveCountry}</button>
  </div>;
}
