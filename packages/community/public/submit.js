import { api, clearErrors, copy, fieldError, languageSetup, message, prefill } from './common.js';

import { coverageEditor } from './coverage.js';

const form = document.querySelector('#submission');
const send = document.querySelector('#send');
const fileInput = document.querySelector('#evidence');
const fragment = languageSetup();
prefill(fragment);
const primary = Object.fromEntries(['productName','brand','barcode','market','variant'].map(name=>[name,form.elements.namedItem(name).value]));
const coverage = coverageEditor(form,undefined,primary);
form.querySelector('fieldset').after(coverage.section);
// Remove product identity from the address bar after using it, without persisting it.
history.replaceState(null, '', location.pathname);
document.querySelector('#repliedOn').max = new Date().toISOString().slice(0,10);
let processed, previewUrl, widget, token = '', busy = false, fileGeneration = 0;
const ready = () => { send.disabled = busy || !processed || !token; };

fileInput.addEventListener('change', async () => {
  const generation = ++fileGeneration;
  processed = undefined; ready(); clearErrors(form);
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  document.querySelector('#preview').hidden = true;
  const file = fileInput.files[0];
  if (!file) return;
  try {
    let candidate;
    if (file.type === 'application/pdf' && file.size <= 2_000_000) candidate = file;
    else if (['image/jpeg','image/png'].includes(file.type) && file.size <= 10_000_000) {
      const image = await createImageBitmap(file);
      try {
        if (!image.width || !image.height || image.width * image.height > 40_000_000) throw new Error();
        const scale = Math.min(1,2400 / Math.max(image.width,image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1,Math.round(image.width * scale)); canvas.height = Math.max(1,Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error();
        context.drawImage(image,0,0,canvas.width,canvas.height);
        candidate = await new Promise(resolve => canvas.toBlob(resolve,'image/png'));
      } finally { image.close(); }
    }
    if (!candidate || candidate.size > 2_000_000) throw new Error();
    if (generation !== fileGeneration) return;
    processed = candidate;
    previewUrl = URL.createObjectURL(candidate);
    const image = document.querySelector('#image-preview'), pdf = document.querySelector('#pdf-preview');
    image.hidden = candidate.type !== 'image/png'; pdf.hidden = candidate.type !== 'application/pdf';
    if (!image.hidden) image.src = previewUrl; else image.removeAttribute('src');
    if (!pdf.hidden) pdf.href = previewUrl; else pdf.removeAttribute('href');
    document.querySelector('#preview').hidden = false; ready();
  } catch {
    if (generation === fileGeneration) fieldError(form,'evidence',copy('fileFailed'));
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  clearErrors(form);
  const invalid = [...form.elements].find(input => input.willValidate && !input.validity.valid);
  if (invalid) { fieldError(form,invalid.name,invalid.validationMessage); return; }
  if (!processed) { fieldError(form,'evidence',copy('fileFailed')); return; }
  if (!token) { message(copy('challengeFailed'),true); return; }
  busy = true; ready(); send.textContent = copy('sending');
  try {
    const body = new FormData(form);
    body.set('evidence',processed,processed.type === 'application/pdf' ? 'reply.pdf' : 'reply.png');
    body.set('cf-turnstile-response',token);
    body.set('coverage',JSON.stringify(coverage.value()));
    const result = await api('/api/submissions',{method:'POST',body});
    form.hidden = true;
    message(copy('success') + result.id);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    processed = undefined;
  } catch (error) {
    if (error.field) fieldError(form,error.field,error.message); else message(error.message || copy('failed'),true);
    token = ''; if (widget !== undefined) window.turnstile.reset(widget);
  } finally { busy = false; send.textContent = copy('send'); ready(); }
});

try {
  const config = await api('/api/config');
  if (!config.submissionsEnabled || !config.siteKey) {
    message(copy('unavailable')); for (const fieldset of form.querySelectorAll('fieldset')) fieldset.disabled = true;
  } else {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.addEventListener('load', () => {
      widget = window.turnstile.render('#challenge',{sitekey:config.siteKey,action:'submit-reply',
        callback: value => { token = value; ready(); },
        'expired-callback': () => { token = ''; ready(); },
        'error-callback': () => { token = ''; ready(); message(copy('challengeFailed'),true); },
      });
    });
    script.addEventListener('error', () => message(copy('challengeFailed'),true));
    document.head.append(script);
  }
} catch { message(copy('failed'),true); }
