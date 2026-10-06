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
}
updateScreenshotLinks();
screenshotTheme.addEventListener('change', updateScreenshotLinks);
