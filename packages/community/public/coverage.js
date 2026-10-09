import { copy, element } from './common.js';

const label = (tag,key,className) => { const node = element(tag,copy(key),className); node.dataset.copy = key; return node; };
const split = value => value.split(/[,\n]/).map(item => item.trim()).filter(Boolean);
/** One attachment and response, with editable coverage shared by submit and review forms. */
export function coverageEditor(form, initial, primary, moderator = false) {
  const section = element('fieldset'); section.append(label('legend','coverageTitle'));
  const prefix = `${primary.id ?? 'submission'}-coverage`;
  function field(name, label, value = '', multiline = false) {
    const input = element(multiline ? 'textarea' : 'input'); input.id = `${prefix}-${name}`; input.value = value; input.name = input.id;
    input.maxLength = multiline ? 3300 : 300;
    const title = element('label', copy(label)); title.dataset.copy = label; title.htmlFor = input.id; section.append(title, input); return input;
  }
  const title = label('label','coverageType'); const type = element('select'); type.name = 'coverage'; type.id = `${prefix}-type`; title.htmlFor = type.id;
  for (const [value, label] of [['products','coverageProducts'],['range','coverageRange']]) {
    const option = element('option', copy(label)); option.dataset.copy = label; option.value = value; type.append(option);
  }
  type.value = initial?.type ?? 'products'; section.append(title, type);
  const markets = field('markets','coverageMarkets', initial?.markets.join(', ') ?? primary.market);
  section.append(label('p','coverageMarketsHelp','hint'));
  const rangeSection = element('div'); section.append(rangeSection);
  const rangeName = field('range-name','rangeName', initial?.range?.name ?? '');
  const aliases = field('aliases','brandAliases', initial?.range?.brandAliases.join('\n') ?? '', true);
  const prefixes = field('prefixes','namePrefixes', initial?.range?.namePrefixes.join('\n') ?? '', true);
  const wholeBrand = element('input'); wholeBrand.type = 'checkbox'; wholeBrand.id = `${prefix}-whole-brand`; wholeBrand.checked = initial?.range?.wholeBrand ?? false;
  const brandLabel = element('label',null,'checkbox'); brandLabel.append(wholeBrand,label('span','wholeBrand'));
  rangeSection.append(rangeName.previousSibling, rangeName, aliases.previousSibling, aliases, prefixes.previousSibling, prefixes, brandLabel,
    label('p',moderator ? 'rangeReviewHelp' : 'rangeSubmitHelp','hint'));
  const products = element('div'); section.append(products);
  let sequence = 0, addButton;
  const primaryMatches = product => ['productName','brand','barcode','variant'].every(field => (product[field] ?? '') === (primary[field] ?? ''));
  const primaryIncluded = (initial?.products ?? []).some(primaryMatches);
  const limit = () => type.value === 'range' && !form.elements.namedItem('barcode').value.trim() && !primaryIncluded ? 25 : 24;
  function add(product = {}, existing = false) {
    if (!existing && products.children.length >= limit()) return;
    const row = element('fieldset',null,'reply-card'); row.append(label('legend','additionalProduct'));
    for (const [name,label,max] of [['productName','productName',300],['brand','brand',300],['barcode','barcode',40],['variant','variant',300]]) {
      const input = element('input'); input.dataset.productField = name; input.value = product[name] ?? ''; input.maxLength = max;
      input.required = name === 'productName' || name === 'brand'; input.id = `${prefix}-product-${sequence}-${name}`; input.name = input.id;
      const title = element('label',copy(label)); title.dataset.copy = label; title.htmlFor = input.id; row.append(title,input);
    }
    sequence++;
    const remove = label('button','removeProduct'); remove.type = 'button'; remove.addEventListener('click',()=>{row.remove(); addButton.disabled = false;}); row.append(remove); products.append(row);
    if (addButton) addButton.disabled = products.children.length >= limit();
  }
  for (const product of initial?.products ?? []) if (!primaryMatches(product)) add(product,true);
  const button = label('button','addProduct'); addButton = button; button.disabled = products.children.length >= limit(); button.type = 'button'; button.addEventListener('click',()=>add({brand:form.elements.namedItem('brand').value})); section.append(button);
  const update = () => { rangeSection.hidden = type.value !== 'range'; button.disabled = products.children.length >= limit(); };
  form.elements.namedItem('barcode').addEventListener('input',update);
  type.addEventListener('change',update); update();
  return { section, value() {
    const first = Object.fromEntries(['productName','brand','barcode','variant'].map(name => [name,form.elements.namedItem(name).value.trim()]));
    const additional = [...products.children].map(row => Object.fromEntries([...row.querySelectorAll('[data-product-field]')].map(input => [input.dataset.productField,input.value.trim()])));
    return { type:type.value, markets:[...new Set([form.elements.namedItem('market').value.trim().toUpperCase(),...split(markets.value).map(item=>item.toUpperCase())])],
      products:[...(type.value === 'products' || first.barcode || primaryIncluded ? [first] : []),...additional],
      ...(type.value === 'range' ? {range:{name:rangeName.value.trim(), wholeBrand:wholeBrand.checked, brandAliases:split(aliases.value), namePrefixes:split(prefixes.value)}} : {}) };
  }};
}
