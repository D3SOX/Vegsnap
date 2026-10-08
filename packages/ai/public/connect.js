const parameters = new URLSearchParams(location.hash.slice(1));
const token = parameters.get('token') ?? '';
const android = parameters.get('client') === 'android';
history.replaceState(null, '', location.pathname);
const status = document.querySelector('#status');
async function connect() {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Open Vegsnap’s settings and choose Connect to free AI.');
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('Vegsnap AI is unavailable. Please try again later.');
  const config = await response.json();
  if (!config.enabled) throw new Error('Free AI checks are not available yet. You can still use Vegsnap’s database checks, ChatGPT connection, or your own API key.');
  status.textContent = `Verify to get up to ${config.sessionCheckLimit} free checks per UTC day. The allowance is shared across the service too.`;
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  let widget;
  script.onload = () => { widget = window.turnstile.render('#challenge', {
    sitekey: config.siteKey, action: 'connect-ai',
    callback: async challenge => {
      status.textContent = 'Connecting…';
      try {
        const verified = await fetch('/api/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ challenge }) });
        if (!verified.ok) {
          const problem = await verified.json();
          throw new Error(typeof problem?.error?.message === 'string' ? problem.error.message.slice(0, 300) : 'Verification failed or expired. Start again in Vegsnap.');
        }
        status.textContent = 'Connected. Your free AI access is ready. Return to Vegsnap to start checking products.';
        document.querySelector('#return').hidden = !android;
        window.turnstile.remove(widget);
      } catch (error) { status.textContent = error.message; }
    },
    'error-callback': () => { status.textContent = 'Verification could not load. Check your connection and start again in Vegsnap.'; },
    'expired-callback': () => { status.textContent = 'Verification expired. Please verify again.'; },
  }); };
  script.onerror = () => { status.textContent = 'Verification could not load. Check your connection and start again in Vegsnap.'; };
  document.head.append(script);
}
connect().catch(error => { status.textContent = error.message; });
