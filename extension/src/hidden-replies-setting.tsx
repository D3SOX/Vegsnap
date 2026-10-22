/** @jsxImportSource preact */
import type { Locale } from '@vegsnap/core';
import { communityMessages, messages } from './i18n';

export function HiddenRepliesSetting({ count, locale, disabled, onRestore }: { count: number; locale: Locale; disabled: boolean; onRestore: () => void }) {
  return <section aria-labelledby="community-heading">
    <h2 id="community-heading">{communityMessages[locale].title}</h2>
    <p class="hint">{communityMessages[locale].hiddenNotice}</p>
    <button type="button" disabled={disabled || count === 0} onClick={onRestore}>{messages[locale].restoreHiddenReplies}{count > 0 ? ` (${count})` : ''}</button>
  </section>;
}
