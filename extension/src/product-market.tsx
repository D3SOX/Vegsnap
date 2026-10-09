import { useEffect, useState } from 'preact/hooks';
import { countryCode, type MarketSource, type Locale } from '@vegsnap/core';

export function ProductMarket({market,locale,disabled,source,fallback,onSave}: {market:string; locale:Locale; disabled?:boolean; source?:MarketSource; fallback?:boolean; onSave:(market:string)=>Promise<void>}) {
  const [value,setValue] = useState(market);
  useEffect(()=>setValue(market),[market]);
  return <div class="product-country">
    <label>{fallback ? locale === 'de' ? 'Land bei unklaren Angaben' : 'Fallback country' : locale === 'de' ? 'Produktland' : 'Product country'}<input value={value} maxLength={2} pattern="[A-Z]{2}" required disabled={disabled}
      onInput={event=>setValue(event.currentTarget.value.toUpperCase().replace(/[^A-Z]/g,'').slice(0,2))}/></label>
    {source && <p class="hint">{({en:{manual:'Selected manually',fallback:'Fallback country',database:'Detected from database',packaging:'Detected from packaging (AI — check the label)'},de:{manual:'Manuell ausgewählt',fallback:'Land bei unklaren Angaben',database:'Aus Datenbank erkannt',packaging:'Aus Verpackung erkannt (KI — Etikett prüfen)'}})[locale][source]}</p>}
    {!fallback && <p class="hint">{locale === 'de' ? 'Land, für das das Produkt verkauft wird, z. B. SE für Schweden. Speichern aktualisiert die Community-Antworten. Prüfe erneut, um die ursprüngliche Analyse zu aktualisieren.' : 'Country this product is sold for, e.g. SE for Sweden. Saving refreshes community replies. Check again to refresh the original analysis.'}</p>}
    <button type="button" onClick={()=>void onSave(value)} disabled={disabled || !/^[A-Z]{2}$/.test(value) || !countryCode(value)}>{locale === 'de' ? 'Land speichern' : 'Save country'}</button>
  </div>;
}
