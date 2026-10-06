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
  const host = document.createElement('div'); document.body.append(host);
  try {
    const result = {...analyzeText({text:'vitamin D',name:'Example oat drink',brand:'Example Maker'}),photos:['private-photo']};
    for (const outcome of ['vegan','not_vegan','uncertain','conflicting'] as const) {
      await act(() => render(<CommunityRepliesSection result={{...result,outcome}} locale="en" baseUrl="https://community.example"/>,host));
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
    await act(() => render(<CommunityRepliesSection result={result} locale="de" baseUrl="https://community.example"/>,host));
    expect(host.textContent).toContain('Antwort teilen'); expect(host.querySelector('a')?.href).toContain('lang=de');
    await act(() => render(<CommunityRepliesSection result={result} locale="en" baseUrl=""/>,host));
    expect(host.textContent).toBe('');
  } finally {
    await act(() => render(null,host)); Object.assign(globalThis,{window:previous.window,document:previous.document});
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:previous.navigator}); window.close();
  }
});
