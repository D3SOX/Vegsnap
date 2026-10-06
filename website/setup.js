// Read the browser's basic OS hint locally. No account, storage, or network request.
const userAgent = navigator.userAgent;
const platform = navigator.userAgentData?.platform || navigator.platform || userAgent;
const mobile = navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod|CrOS|Windows Phone/i.test(userAgent)
  || /mac/i.test(platform) && navigator.maxTouchPoints > 1;
const os = mobile ? null : /win/i.test(platform) ? 'windows'
  : /mac/i.test(platform) ? 'macos' : /linux/i.test(platform) ? 'linux' : null;

if (os) {
  for (const section of document.querySelectorAll('.companion-setup details[data-os]')) {
    section.open = section.dataset.os === os;
  }
  const download = document.querySelector(`[data-download-os="${os}"]`);
  download?.classList.add('primary');
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
