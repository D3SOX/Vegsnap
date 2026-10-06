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
  const label = download?.querySelector('.download-match');
  if (label) label.hidden = false;
}
