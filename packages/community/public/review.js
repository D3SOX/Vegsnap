import { api, clearErrors, element, fieldError, message } from './common.js';
const access = document.querySelector('#access'), queue = document.querySelector('#queue'), records = document.querySelector('#records');
let token = '', cursor = '', nextCursor = null, generation = 0;
const headers = () => ({Authorization:`Bearer ${token}`});
const fields = [
  ['productName','Product name',300],['brand','Brand / manufacturer',300],['barcode','Barcode (optional)',40],
  ['market','Country code',2],['variant','Variant / size (optional)',300],['question','Question asked',4000],
  ['reply','Manufacturer response',8000],['repliedOn','Response date',10],['sourceUrl','Manufacturer source (optional)',2000],
];
function reviewForm(record) {
  const form = element('form',null,'reply-card'); form.noValidate = true;
  form.append(element('h2',`${record.brand} · ${record.productName}`),element('p',`${record.status} · submitted ${record.createdAt.slice(0,10)} · ${record.id}`,'hint'));
  const original = element('details',null,'review-original'); original.append(element('summary','Original submitted text (private)'));
  original.append(element('pre',JSON.stringify(record.original,null,2),'quote')); form.append(original);
  const download = element('button','Download private evidence'); download.type = 'button'; download.disabled = !record.hasEvidence;
  download.addEventListener('click',async () => {
    download.disabled = true;
    try {
      const response = await fetch(`/api/review/${record.id}/evidence`,{headers:headers(),credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(20_000)});
      if (!response.ok) throw new Error((await response.json()).error);
      const blob = await response.blob(), url = URL.createObjectURL(blob), link = element('a');
      link.href = url; link.download = `reply-${record.id}.${blob.type === 'application/pdf' ? 'pdf' : 'png'}`; link.click();
      setTimeout(() => URL.revokeObjectURL(url),1000);
    } catch (error) { message(error.message,true); }
    finally { download.disabled = !record.hasEvidence; }
  }); form.append(download);
  for (const [name,label,max] of fields) {
    const input = element(name === 'question' || name === 'reply' ? 'textarea' : 'input');
    input.id = `${record.id}-${name}`; input.name = name; input.maxLength = max; input.value = record[name];
    if (name === 'question' || name === 'reply') input.rows = 4;
    else input.type = name === 'repliedOn' ? 'date' : name === 'sourceUrl' ? 'url' : 'text';
    input.required = ['productName','brand','market','question','reply','repliedOn'].includes(name);
    const title = element('label',label); title.htmlFor = input.id; form.append(title,input);
  }
  for (const [name,label,options] of [
    ['claim','Reported answer',[['inconclusive','Still inconclusive'],['vegan','Vegan'],['not_vegan','Not vegan']]],
    ['scope','Response covers',[['ingredients','Specific ingredients / materials'],['processing','Processing / production'],['whole_product','The whole product']]],
  ]) {
    const select = element('select'); select.name = name; select.id = `${record.id}-${name}`;
    for (const [value,label] of options) { const option = element('option',label); option.value = value; select.append(option); }
    select.value = record[name]; const title = element('label',label); title.htmlFor = select.id; form.append(title,select);
  }
  const publish = element('input'); publish.type = 'checkbox'; publish.name = 'evidencePublic'; publish.checked = record.evidencePublic;
  const consent = element('label',null,'checkbox'); consent.append(publish,element('span','Publish the attachment too: I checked that it contains no personal information, including PDF metadata.'));
  const note = element('textarea'); note.name = 'reviewNote'; note.id = `${record.id}-reviewNote`; note.maxLength = 2000; note.value = record.reviewNote;
  const noteLabel = element('label','Private review note'); noteLabel.htmlFor = note.id;
  form.append(consent,noteLabel,note);
  const actions = element('div',null,'actions'), approve = element('button','Approve reviewed text','primary'), reject = element('button','Reject / withdraw');
  approve.type = reject.type = 'submit'; approve.value = 'approved'; reject.value = 'rejected'; actions.append(approve,reject); form.append(actions);
  form.addEventListener('submit',async event => {
    event.preventDefault(); clearErrors(form);
    const decision = event.submitter?.value;
    if (!decision) return;
    const submission = Object.fromEntries(fields.map(([name]) => [name,form.elements.namedItem(name).value]));
    for (const name of ['claim','scope']) submission[name] = form.elements.namedItem(name).value;
    for (const button of form.querySelectorAll('button')) button.disabled = true;
    try {
      await api(`/api/review/${record.id}`,{method:'POST',headers:{...headers(),'Content-Type':'application/json'},
        body:JSON.stringify({revision:record.revision,decision,submission,evidencePublic:publish.checked,reviewNote:note.value})});
      await load(); message(decision === 'approved' ? 'Reviewed reply published.' : 'Reply rejected. Any published text and evidence have been withdrawn.');
    } catch (error) {
      if (error.field) fieldError(form,error.field,error.message); else message(error.message,true);
      for (const button of form.querySelectorAll('button')) button.disabled = false;
      download.disabled = !record.hasEvidence;
    }
  }); return form;
}
async function load() {
  const current = ++generation;
  if (document.querySelector('#queue-type').value === 'reports') {
    const value = await api('/api/review/reports', {headers:headers()});
    if (current !== generation || !token) return;
    records.replaceChildren(...value.reports.map(reportCard));
    if (!value.reports.length) records.append(element('p','No content reports.','notice'));
    nextCursor = null; document.querySelector('#next').hidden = true;
    document.querySelector('#status').disabled = true;
    return;
  }
  document.querySelector('#status').disabled = false;
  const value = await api(`/api/review?${new URLSearchParams({status:document.querySelector('#status').value,cursor})}`,{headers:headers()});
  if (current !== generation || !token) return;
  records.replaceChildren(...value.submissions.map(reviewForm));
  if (!value.submissions.length) records.append(element('p','No submissions in this queue.','notice'));
  nextCursor = value.nextCursor; document.querySelector('#next').hidden = !nextCursor;
}
function reportCard(report) {
  const card = element('article',null,'reply-card');
  card.append(element('h2',report.kind === 'ai' ? 'Reported AI output' : 'Reported community reply'),
    element('p',`${report.created_at} · ${report.id}`,'hint'),element('h3','Reason'),element('p',report.reason,'quote'),
    element('h3','Reported content'),element('p',report.kind === 'ai' ? report.text : report.reply ?? 'Reply already removed.','quote'));
  const actions = element('div',null,'actions');
  if (report.kind === 'community' && report.reply_status === 'approved') {
    card.append(element('p',`${report.brand} · ${report.product_name} · ${report.content_id}`,'hint'));
    const withdraw = element('button','Withdraw reported reply'); withdraw.type = 'button';
    withdraw.addEventListener('click',async () => {
      withdraw.disabled = true;
      try {
        await api(`/api/review/${report.content_id}`,{method:'POST',headers:{...headers(),'Content-Type':'application/json'},
          body:JSON.stringify({revision:report.revision,decision:'rejected',reviewNote:'Withdrawn after a content report.'})});
        await load(); message('Reported reply withdrawn. Review the report before clearing it.');
      } catch (error) { withdraw.disabled = false; message(error.message,true); }
    }); actions.append(withdraw);
  }
  const clear = element('button','Mark handled and delete report'); clear.type = 'button';
  clear.addEventListener('click',async () => {
    clear.disabled = true;
    try { await api(`/api/review/reports/${report.id}`,{method:'DELETE',headers:headers()}); await load(); message('Report deleted.'); }
    catch (error) { clear.disabled = false; message(error.message,true); }
  }); actions.append(clear); card.append(actions);
  return card;
}
access.addEventListener('submit',async event => {
  event.preventDefault(); token = document.querySelector('#code').value; cursor = '';
  try { await load(); document.querySelector('#code').value = ''; access.hidden = true; queue.hidden = false; document.querySelector('#message').hidden = true; }
  catch (error) { token = ''; records.replaceChildren(); message(error.message,true); }
});
const refresh = async () => { cursor = ''; try { await load(); } catch (error) { message(error.message,true); } };
document.querySelector('#status').addEventListener('change',refresh); document.querySelector('#refresh').addEventListener('click',refresh);
document.querySelector('#queue-type').addEventListener('change',refresh);
document.querySelector('#next').addEventListener('click',async () => { if (!nextCursor) return; cursor = nextCursor; try { await load(); } catch (error) { message(error.message,true); } });
document.querySelector('#logout').addEventListener('click',() => {
  token = ''; generation++; records.replaceChildren(); queue.hidden = true; access.hidden = false; document.querySelector('#message').hidden = true; document.querySelector('#code').focus();
});
