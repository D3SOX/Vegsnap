// Turn the stacked example results into tabs. Without JavaScript, all four stay visible.
const demo = document.querySelector('[data-demo]');
if (demo) {
  const tablist = demo.querySelector('[role="tablist"]');
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));

  function select(index, userAction) {
    tabs.forEach((tab, i) => {
      const selected = i === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[i].classList.toggle('is-active', selected);
      panels[i].classList.remove('is-entering');
    });
    if (userAction) {
      // Restart the short entrance so each switch shows what changed.
      void panels[index].offsetWidth;
      panels[index].classList.add('is-entering');
    }
  }

  panels.forEach((panel, i) => {
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tabs[i].id);
    panel.tabIndex = 0;
  });

  tablist.addEventListener('click', event => {
    const index = tabs.indexOf(event.target.closest('[role="tab"]'));
    if (index !== -1 && tabs[index].getAttribute('aria-selected') !== 'true') select(index, true);
  });

  tablist.addEventListener('keydown', event => {
    const current = tabs.indexOf(document.activeElement);
    if (current === -1) return;
    const keys = { ArrowLeft: current - 1, ArrowRight: current + 1, Home: 0, End: tabs.length - 1 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const index = (keys[event.key] + tabs.length) % tabs.length;
    tabs[index].focus();
    if (index !== current) select(index, true);
  });

  const initial = Math.max(0, tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true'));
  select(initial, false);
  tablist.hidden = false;
  demo.classList.add('is-tabbed');
}
