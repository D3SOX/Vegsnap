// Check the preferred language once per browser; keep manual language changes.
(() => {
  try {
    const key = 'veguide-language-checked';
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');

    const language = navigator.languages?.[0] || navigator.language || '';
    if (location.pathname === '/' && /^de(?:-|$)/i.test(language)) {
      location.replace('/de/' + location.search + location.hash);
    }
  } catch {
    // Leave the chosen page open when browser storage is unavailable.
  }
})();
