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

// All commands remain available when JavaScript is disabled.
const browserSelect = document.querySelector('[data-browser-select]');
if (browserSelect) {
  const commands = document.querySelectorAll('.browser-registration [data-browser]');
  function updateBrowserCommands() {
    for (const command of commands) {
      command.hidden = command.dataset.browser !== browserSelect.value;
    }
  }
  browserSelect.closest('.browser-choice').hidden = false;
  browserSelect.addEventListener('change', updateBrowserCommands);
  updateBrowserCommands();
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
