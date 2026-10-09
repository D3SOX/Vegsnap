// Keep CSS tooltips dismissible without moving keyboard focus.
for (const placeholder of document.querySelectorAll('.store-placeholder')) {
  placeholder.addEventListener('keydown', event => {
    if (event.key === 'Escape') placeholder.classList.add('tooltip-dismissed');
  });
  for (const event of ['pointerleave', 'focusout']) {
    placeholder.addEventListener(event, () => placeholder.classList.remove('tooltip-dismissed'));
  }
}

// Read the browser's basic OS hint locally. No account, storage, or network request.
const userAgent = navigator.userAgent;
const platform = navigator.userAgentData?.platform || navigator.platform || '';
const mobile = navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod|CrOS|Chrome OS|Windows Phone|\biOS\b/i.test(`${userAgent} ${platform}`)
  || /mac/i.test(platform) && navigator.maxTouchPoints > 1;

function desktopOs(hint) {
  if (/\bWindows\b|^Win/i.test(hint)) return 'windows';
  if (/\bMacintosh\b|\bMac OS X\b|^Mac/i.test(hint)) return 'macos';
  if (/\bLinux\b/i.test(hint)) return 'linux';
  return null;
}

// User-agent overrides may leave platform hints unchanged. Honor the advertised
// desktop OS first, then fall back to client hints and the legacy platform.
const os = mobile ? null : desktopOs(userAgent)
  || desktopOs(navigator.userAgentData?.platform || '') || desktopOs(navigator.platform || '');

if (os) {
  for (const section of document.querySelectorAll('.companion-setup details[data-os]')) {
    section.open = section.dataset.os === os;
  }
  const download = document.querySelector(`[data-download-os="${os}"]`);
  download?.classList.add('primary');
}

// Use advertised browser names only; generic Chromium hints identify many forks.
function desktopBrowser(hints) {
  const names = [
    ['brave', /^Brave$/i, /\bBrave\//i],
    ['helium', /^Helium$/i, /\bHelium\//i],
    ['vivaldi', /^Vivaldi$/i, /\bVivaldi\//i],
    ['edge', /^Microsoft Edge$/i, /\bEdg\//i],
    ['librewolf', /^LibreWolf$/i, /\bLibreWolf\//i],
    ['zen', /^Zen(?: Browser)?$/i, /\bZen\//i],
    ['firefox', /^Firefox$/i, /\bFirefox\//i],
    ['chrome', /^Google Chrome$/i, null],
    ['chromium', null, /\bChromium\//i],
  ];
  for (const [browser, brand, agent] of names) {
    if (brand && hints.userAgentData?.brands?.some(item => brand.test(item.brand))
      || agent?.test(hints.userAgent || '')) return browser;
  }
  return null;
}

async function detectDesktopBrowser(hints) {
  let browser = desktopBrowser(hints);
  try {
    if (await hints.brave?.isBrave?.()) browser = 'brave';
  } catch { /* Browser privacy settings may block the optional Brave API. */ }
  return browser;
}

// All commands remain available when JavaScript is disabled. Use the translated
// native options as the custom icon menu's source.
const browserSelect = document.querySelector('[data-browser-select]');
if (browserSelect) {
  const choice = browserSelect.closest('.browser-choice');
  const commands = document.querySelectorAll('.browser-registration [data-browser]');
  const prompts = document.querySelectorAll('.browser-prompt');
  const options = [...browserSelect.options];
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = browserSelect.id;
  browserSelect.id += '-native';
  trigger.className = 'browser-select-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-labelledby', 'companion-browser-label companion-browser-value');
  trigger.innerHTML = '<span class="platform-icon" aria-hidden="true"></span><span id="companion-browser-value"></span><span class="browser-select-arrow" aria-hidden="true"></span>';
  const selectedIcon = trigger.querySelector('.platform-icon');
  const selectedLabel = trigger.querySelector('#companion-browser-value');
  const menu = document.createElement('ul');
  menu.id = 'companion-browser-options';
  menu.className = 'browser-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-labelledby', 'companion-browser-label');
  menu.hidden = true;
  trigger.setAttribute('aria-controls', menu.id);
  const iconClasses = { firefox: 'firefox-browser', chromium: 'chrome', chrome: 'chrome' };
  const items = options.map((option, index) => {
    const item = document.createElement('li');
    item.id = `${menu.id}-${index}`;
    item.setAttribute('role', 'option');
    item.dataset.value = option.value;
    const icon = document.createElement('span');
    icon.className = `platform-icon icon-${iconClasses[option.value] || option.value}`;
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = option.textContent;
    item.append(icon, label);
    menu.append(item);
    return item;
  });
  choice.append(trigger, menu);
  browserSelect.hidden = true;
  choice.hidden = false;
  let activeIndex = 0;
  let changed = false;

  function updateBrowserCommands() {
    for (const command of commands) {
      command.hidden = command.dataset.browser !== browserSelect.value;
    }
    for (const prompt of prompts) prompt.hidden = Boolean(browserSelect.value);
    selectedLabel.textContent = options[browserSelect.selectedIndex].textContent;
    selectedIcon.className = `platform-icon icon-${iconClasses[browserSelect.value] || browserSelect.value}`;
    selectedIcon.hidden = !browserSelect.value;
    for (const item of items) {
      item.setAttribute('aria-selected', String(item.dataset.value === browserSelect.value));
    }
  }

  function highlight(index) {
    activeIndex = (index + items.length) % items.length;
    items.forEach((item, i) => item.classList.toggle('active', i === activeIndex));
    trigger.setAttribute('aria-activedescendant', items[activeIndex].id);
    const item = items[activeIndex];
    if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
    }
  }

  function closeMenu() {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
  }

  function openMenu() {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    highlight(browserSelect.selectedIndex);
  }

  function choose(index) {
    browserSelect.value = options[index].value;
    browserSelect.dispatchEvent(new Event('change', { bubbles: true }));
    closeMenu();
  }

  trigger.addEventListener('click', () => menu.hidden ? openMenu() : closeMenu());
  menu.addEventListener('click', event => {
    const index = items.indexOf(event.target.closest('[role="option"]'));
    if (index !== -1) {
      choose(index);
      trigger.focus({ preventScroll: true });
    }
  });
  document.addEventListener('pointerdown', event => {
    if (!choice.contains(event.target)) closeMenu();
  });
  choice.addEventListener('focusout', event => {
    if (!choice.contains(event.relatedTarget)) closeMenu();
  });
  let search = '';
  let lastKey = 0;
  trigger.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape' && !menu.hidden) event.preventDefault();
      closeMenu();
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      const wasClosed = menu.hidden;
      if (wasClosed) openMenu();
      if (event.key === 'Home') highlight(0);
      else if (event.key === 'End') highlight(items.length - 1);
      else if (event.key === 'ArrowDown') highlight(activeIndex + 1);
      else if (event.key === 'ArrowUp') highlight(activeIndex - 1);
      else if (!wasClosed) choose(activeIndex);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (menu.hidden) openMenu();
      search = Date.now() - lastKey > 700 ? event.key : search + event.key;
      lastKey = Date.now();
      const index = options.findIndex(option => option.textContent.toLowerCase().startsWith(search.toLowerCase()));
      if (index !== -1) highlight(index);
    }
  });
  browserSelect.addEventListener('change', () => {
    changed = true;
    updateBrowserCommands();
  });
  updateBrowserCommands();

  // A delayed detection result must never replace a user's choice, even a reset.
  async function detectBrowser() {
    if (mobile || browserSelect.value) return;
    const browser = await detectDesktopBrowser(navigator);
    if (browser && !changed && !browserSelect.value) {
      browserSelect.value = browser;
      updateBrowserCommands();
    }
  }
  detectBrowser();
}

// Match full-size screenshot links to the images selected by <picture>.
const screenshotTheme = matchMedia('(prefers-color-scheme: dark)');
const screenshotLinks = [...document.querySelectorAll('a[data-dark-href]')]
  .map(link => ({ link, lightHref: link.getAttribute('href') }));
function updateScreenshotLinks() {
  for (const { link, lightHref } of screenshotLinks) {
    link.href = screenshotTheme.matches ? link.dataset.darkHref : lightHref;
  }
  if (imageViewer.open) updateViewerImage();
}

// A native modal keeps keyboard focus inside the viewer and the page inert.
const imageViewer = document.querySelector('.image-viewer');
const viewerImage = imageViewer.querySelector('.image-viewer-image');
const viewerCaption = imageViewer.querySelector('#image-viewer-caption');
const viewerCount = imageViewer.querySelector('.image-viewer-count');
const viewerClose = imageViewer.querySelector('[data-viewer-close]');
let viewerIndex = 0;
let viewerTrigger;

function updateViewerImage() {
  const { link } = screenshotLinks[viewerIndex];
  const thumbnail = link.querySelector('img');
  viewerImage.src = link.href;
  viewerImage.alt = thumbnail.alt;
  viewerCaption.textContent = link.closest('figure').querySelector('figcaption')?.textContent || thumbnail.alt;
  viewerCount.textContent = `${viewerIndex + 1} / ${screenshotLinks.length}`;
}

function stepViewer(direction) {
  viewerIndex = (viewerIndex + direction + screenshotLinks.length) % screenshotLinks.length;
  updateViewerImage();
}

screenshotLinks.forEach(({ link }, index) => {
  link.setAttribute('role', 'button');
  link.setAttribute('aria-haspopup', 'dialog');
  link.setAttribute('aria-controls', imageViewer.id);
  link.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    viewerIndex = index;
    viewerTrigger = link;
    updateViewerImage();
    imageViewer.showModal();
    viewerClose.focus({ preventScroll: true });
  });
  link.addEventListener('keydown', event => {
    if (event.key === ' ') {
      event.preventDefault();
      link.click();
    }
  });
});

viewerClose.addEventListener('click', () => imageViewer.close());
imageViewer.querySelector('[data-viewer-previous]').addEventListener('click', () => stepViewer(-1));
imageViewer.querySelector('[data-viewer-next]').addEventListener('click', () => stepViewer(1));
imageViewer.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    stepViewer(event.key === 'ArrowLeft' ? -1 : 1);
  }
});
imageViewer.addEventListener('click', event => {
  if (event.target === imageViewer || event.target.classList.contains('image-viewer-stage')) imageViewer.close();
});
imageViewer.addEventListener('close', () => {
  viewerTrigger?.focus({ preventScroll: true });
});

updateScreenshotLinks();
screenshotTheme.addEventListener('change', updateScreenshotLinks);
