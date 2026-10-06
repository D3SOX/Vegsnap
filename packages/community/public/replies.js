import { api, card, clearErrors, copy, element, fieldError, languageSetup, message, prefill } from './common.js';
const form = document.querySelector('#search'), results = document.querySelector('#replies');
let records, more = false, generation = 0;
const render = () => {
  if (!records) return;
  results.replaceChildren(...records.map(card));
  if (!records.length) results.append(element('p',copy('none'),'notice'));
  if (more) results.append(element('p',copy('more'),'hint'));
};
const fragment = languageSetup(render); prefill(fragment);
history.replaceState(null,'',location.pathname);
function updateShareLink() {
  const params = new URLSearchParams();
  for (const [key,input] of [['name','productName'],['brand','brand'],['barcode','barcode'],['market','market']]) {
    const value = document.getElementById(input).value.trim(); if (value) params.set(key,value);
  }
  params.set('lang',document.documentElement.lang);
  document.querySelector('#share').href = `/submit#${params}`;
}
form.addEventListener('input',updateShareLink); document.querySelector('#language').addEventListener('change',updateShareLink); updateShareLink();
async function search() {
  const current = ++generation; clearErrors(form); records = undefined; results.replaceChildren(element('p',copy('loading')));
  const invalid = [...form.elements].find(input => input.willValidate && !input.validity.valid);
  if (invalid) { results.replaceChildren(); fieldError(form,invalid.name,invalid.validationMessage); return; }
  try {
    const params = new URLSearchParams(new FormData(form));
    const value = await api(`/api/replies?${params}`);
    if (generation !== current) return;
    records = value.replies; more = value.more; render();
  } catch (error) {
    if (generation !== current) return;
    results.replaceChildren();
    if (error.field) fieldError(form,error.field,error.message); else message(error.message || copy('failed'),true);
  }
}
form.addEventListener('submit',event => { event.preventDefault(); search(); });
if (document.querySelector('#market').checkValidity() && (form.elements.namedItem('barcode').value || form.elements.namedItem('name').value && form.elements.namedItem('brand').value)) search();
document.querySelector('#download').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  try {
    const collected = new Map(); let cursor = '', generatedAt;
    for (let page = 0; page < 100; page++) {
      const value = await api(`/api/snapshot${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      generatedAt ??= value.generatedAt;
      for (const record of value.replies) collected.set(record.id,record);
      if (!value.nextCursor) { cursor = ''; break; }
      if (cursor === value.nextCursor) throw new Error(copy('failed'));
      cursor = value.nextCursor;
    }
    if (cursor) throw new Error('The dataset is too large to download here. Use the paginated snapshot API.');
    const blob = new Blob([JSON.stringify({schemaVersion:1,generatedAt,replies:[...collected.values()]},null,2)],{type:'application/json'});
    const url = URL.createObjectURL(blob), link = element('a');
    link.href = url; link.download = 'vegsnap-manufacturer-replies.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000); message(copy('downloadDone'));
  } catch (error) { message(error.message || copy('failed'),true); }
  finally { button.disabled = false; }
});
