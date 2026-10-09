/** @jsxImportSource preact */
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { analyzeText } from '@vegsnap/core';
import { CommunityRepliesSection } from '../src/community-replies';

test('community actions cover all outcomes, share only identity, and disappear offline or when unconfigured',async () => {
  const window = new Window(); const document = window.document as unknown as Document;
  const previous = {window:globalThis.window,document:globalThis.document,navigator:globalThis.navigator};
  Object.assign(globalThis,{window,document}); Object.defineProperty(globalThis,'navigator',{configurable:true,value:window.navigator});
  const fetchReplies = Object.assign(async () => new Response(JSON.stringify({replies:[],more:false})),{preconnect:fetch.preconnect}) as typeof fetch;
  const host = document.createElement('div'); document.body.append(host);
  try {
    const result = {...analyzeText({text:'vitamin D',name:'Example oat drink',brand:'Example Maker'}),photos:['private-photo']};
    for (const outcome of ['vegan','not_vegan','uncertain','conflicting'] as const) {
      await act(() => render(<CommunityRepliesSection result={{...result,outcome}} locale="en" baseUrl="https://community.example" fetchReplies={fetchReplies}/>,host));
      expect(host.querySelectorAll('a')).toHaveLength(2);
      expect(host.querySelector('a')?.getAttribute('href')).toContain('/submit#name=Example+oat+drink');
      expect(host.innerHTML).not.toContain('private-photo');
      expect(host.innerHTML).not.toContain('vitamin');
    }
    Object.defineProperty(window.navigator,'onLine',{configurable:true,value:false});
    await act(() => { window.dispatchEvent(new window.Event('offline')); });
    expect(host.querySelector('a')).toBeNull(); expect(host.textContent).toContain('Go online');
    Object.defineProperty(window.navigator,'onLine',{configurable:true,value:true});
    await act(() => { window.dispatchEvent(new window.Event('online')); });
    expect(host.querySelectorAll('a')).toHaveLength(2);
    await act(() => render(<CommunityRepliesSection result={result} locale="de" baseUrl="https://community.example" fetchReplies={fetchReplies}/>,host));
    expect(host.textContent).toContain('Antwort teilen'); expect(host.querySelector('a')?.href).toContain('lang=de');
    await act(() => render(<CommunityRepliesSection result={result} locale="en" baseUrl="" fetchReplies={fetchReplies}/>,host));
    expect(host.textContent).toBe('');
  } finally {
    await act(() => render(null,host)); Object.assign(globalThis,{window:previous.window,document:previous.document});
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:previous.navigator}); window.close();
  }
});

test('opening a product fetches replies automatically, confirms range suggestions and clears withdrawn evidence on refresh', async () => {
  const window = new Window(); const document = window.document as unknown as Document;
  const previous = {window:globalThis.window,document:globalThis.document,navigator:globalThis.navigator};
  Object.assign(globalThis,{window,document}); Object.defineProperty(globalThis,'navigator',{configurable:true,value:window.navigator});
  const host = document.createElement('div'); document.body.append(host);
  const result = analyzeText({text:'vitamin D',name:'Fun Light Lemon',brand:'Orkla',barcode:'3017620422003',market:'SE'});
  const candidate = {productName:'Fun Light',brand:'Fun Light',barcode:'',market:'SE',variant:'',question:'Are all Fun Light drinks vegan?',reply:'All our Fun Light products are vegan.',
    repliedOn:'2026-01-10',claim:'vegan',scope:'whole_product',sourceUrl:'',id:'12345678-1234-4234-8234-123456789abc',reviewedAt:'2026-01-11T00:00:00Z',evidencePublic:false,match:'candidate'};
  let requests = 0; let received: unknown[] = []; let withdrawn = false;
  const fetchReplies = Object.assign(async (url: RequestInfo | URL, options?: RequestInit) => {
    requests++;
    const query = new URL(String(url)).searchParams;
    expect([...query.keys()]).toEqual(['market','barcode','name','brand']);
    expect(options?.credentials).toBe('omit'); expect(options?.referrerPolicy).toBe('no-referrer');
    expect(String(url)).not.toContain('vitamin');
    return new Response(JSON.stringify({replies:[],more:false,...(!withdrawn ? {candidates:[candidate]} : {})}));
  },{preconnect:fetch.preconnect}) as typeof fetch;
  const mount = async () => { await act(async () => { render(<CommunityRepliesSection result={result} locale="en" baseUrl="https://community.example" fetchReplies={fetchReplies} onReplies={replies=>{received=replies;}}/>,host); await new Promise(resolve=>setTimeout(resolve,0)); }); };
  try {
    await mount(); await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));}); expect(requests).toBe(1); expect(received).toHaveLength(0);
    expect(host.textContent).toContain('Possible product range');
    const confirm = [...host.querySelectorAll('button')].find(button=>button.textContent === 'This is my product range');
    expect(confirm).toBeDefined(); await act(()=>confirm!.click());
    expect(received).toHaveLength(1); expect(received[0]).toMatchObject({match:'name'});
    withdrawn = true;
    await act(async () => { [...host.querySelectorAll('button')].find(button=>button.textContent==='Refresh replies')!.click(); await new Promise(resolve=>setTimeout(resolve,0)); });
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
    expect(requests).toBe(2); expect(received).toHaveLength(0); expect(host.textContent).toContain('No reviewed replies found');
  } finally { await act(()=>render(null,host)); Object.assign(globalThis,{window:previous.window,document:previous.document}); Object.defineProperty(globalThis,'navigator',{configurable:true,value:previous.navigator}); }
});

test('automatic lookup respects permissions and offline mode, and rejects stale or incomplete evidence', async () => {
  const window = new Window(); const document = window.document as unknown as Document;
  const previous = {window:globalThis.window,document:globalThis.document,navigator:globalThis.navigator};
  Object.assign(globalThis,{window,document}); Object.defineProperty(globalThis,'navigator',{configurable:true,value:window.navigator});
  const host = document.createElement('div'); document.body.append(host);
  const original = analyzeText({name:'Drink',brand:'Maker',market:'SE'});
  let requests = 0, allowed = false, received: unknown[] = [], resolveRequest: ((response: Response)=>void) | undefined;
  const fetchReplies = Object.assign(async () => { requests++; return new Promise<Response>(resolve=>{resolveRequest=resolve;}); },{preconnect:fetch.preconnect}) as typeof fetch;
  const canLookup = async () => allowed;
  const mount = async (result=original,offline=false) => { await act(async () => { render(<CommunityRepliesSection key={result.id} result={result} locale="en" baseUrl="https://community.example" offline={offline} canLookup={canLookup} fetchReplies={fetchReplies} onReplies={replies=>{received=replies;}}/>,host); await new Promise(resolve=>setTimeout(resolve,0)); }); };
  try {
    await mount(); expect(requests).toBe(0); expect(host.textContent).toContain('Browser permission is needed');
    allowed = true; await mount(original,true); expect(requests).toBe(0);
    await mount(); expect(requests).toBe(1);
    const completeOldRequest = resolveRequest;
    await mount({...original,id:'another-product',identity:{...original.identity,name:'Another drink'}},true);
    await act(async()=>{completeOldRequest!(new Response(JSON.stringify({replies:[],more:false}))); await new Promise(resolve=>setTimeout(resolve,0));});
    expect(received).toHaveLength(0); expect(host.textContent).toContain('Go online');
    await mount({...original,id:'incomplete-evidence'},false);
    await act(async()=>{resolveRequest!(new Response(JSON.stringify({replies:[{
      productName:'Drink',brand:'Maker',barcode:'',market:'SE',variant:'',question:'Is it vegan?',reply:'Our drink is vegan.',
      repliedOn:'2026-01-10',claim:'vegan',scope:'whole_product',sourceUrl:'',id:'12345678-1234-4234-8234-123456789abc',
      reviewedAt:'2026-01-11T00:00:00Z',evidencePublic:false,match:'name',
    }],more:true}))); await new Promise(resolve=>setTimeout(resolve,10));});
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
    expect(received).toHaveLength(0); expect(host.textContent).toContain('More than 50 replies match');
  } finally { await act(()=>render(null,host)); Object.assign(globalThis,{window:previous.window,document:previous.document}); Object.defineProperty(globalThis,'navigator',{configurable:true,value:previous.navigator}); }
});
