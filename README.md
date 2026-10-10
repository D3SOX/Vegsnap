<div align="center">
  <picture><img src="website/logo.png" alt="Vegsnap leaf icon" width="88" height="88"></picture>
  <h1>Vegsnap</h1>
  <p><strong>Check whether a product appears vegan.</strong></p>
  <p>Photograph a label on Android, or check ingredients and product images in Chromium or Firefox.</p>
  <p>
    <picture><img src="marketing/badges/android-icon.svg" alt="Android" width="40" height="40"></picture>
    &nbsp;&nbsp;
    <picture><img src="marketing/badges/chromium-icon.svg" alt="Chromium" width="40" height="40"></picture>
    &nbsp;&nbsp;
    <picture><img src="marketing/badges/firefox-icon.svg" alt="Firefox" width="40" height="40"></picture>
  </p>
  <p><picture><source media="(prefers-color-scheme: dark)" srcset="website/images/dark/readme-preview.png"><img src="website/images/readme-preview.png" alt="Real Vegsnap screens: ingredient results in the browser extension and Android app" width="560"></picture></p>
  <p>
    <a href="https://vegsnap.app"><img src="marketing/badges/website.svg" alt="Visit the Vegsnap website" width="200" height="58"></a>
    <a href="https://github.com/D3SOX/vegsnap/releases/latest"><img src="marketing/badges/android.svg" alt="Download Android APK releases" width="200" height="58"></a>
    <a href="https://vegsnap.app/#play-test"><img src="marketing/badges/play.svg" alt="Join the Google Play closed test" width="200" height="58"></a>
    <br>
    <a href="#install-the-browser-extension"><img src="marketing/badges/extension.svg" alt="Install the browser extension from releases" width="200" height="58"></a>
    <a href="https://apps.obtainium.imranr.dev/redirect?r=obtainium%3A%2F%2Fapp%2F%257B%2522id%2522%253A%2522app.vegsnap%2522%252C%2522url%2522%253A%2522https%253A%252F%252Fgithub.com%252FD3SOX%252Fvegsnap%2522%252C%2522author%2522%253A%2522D3SOX%2522%252C%2522name%2522%253A%2522Vegsnap%2522%257D"><img src="marketing/badges/obtainium.svg" alt="Add to Obtainium" width="200" height="58"></a>
  </p>
  <p><a href="https://chromewebstore.google.com/detail/vegsnap/pkkfmbgdbdoccbdngnbfpjjhpldmphej"><img src="marketing/badges/chrome-web-store.svg" alt="Install from the Chrome Web Store" width="200" height="58"></a></p>
</div>

Vegsnap supports food, cosmetics, household products, clothing and shoes. It uses public product databases, local ingredient and material rules, and optional AI. Results show the evidence and explain which details are missing.

You do not need a Vegsnap account. History stays on your device. The app has no ads or telemetry.

You can look up reviewed manufacturer replies in the Android app or open the community service from the extension. To contribute a reply, open the submission form and redact personal details before sending it. The [community service](packages/community/README.md) publishes approved contributions on Cloudflare. Opening a product automatically looks up reviewed replies using its barcode, name, brand and country. Matching whole-product confirmations can change the displayed verdict; ingredient-only replies cannot. Conflicting evidence is shown explicitly. Your saved scan, history and photos stay on your device. Replies can cover several products or a reviewed product range. Android offline mode disables lookup; Firefox requires its data-sharing permission.

This is an early release. Device, store and provider compatibility tests are ongoing.


## What it does

- On Android, take or import photos, share a product, or enter text. The app has local history and offline text recognition with downloadable language models.
- In Chrome, Chromium, Brave, Helium, Vivaldi, Microsoft Edge, Firefox, Zen and LibreWolf, check selected text or right-click a product image. Enable store integrations if you want database checks while browsing. Background checks never use AI.
- Use Vegsnap AI for limited free checks without a subscription or API key. You can also connect ChatGPT with a Plus or Pro plan, an OpenAI-compatible API, or a compatible local model. Only ChatGPT sign-in in the extension needs the desktop companion.
- Look up barcodes in Open Food Facts, Open Beauty Facts and Open Products Facts. Regional packs provide a selection of these records offline.
- When AI finds a manufacturer contact, draft a question in English, German or Swedish. Copy it or open an email draft to ask about missing product details.
- Review company concerns alongside the product result. A reviewed list records documented animal testing, opposition to animal-welfare protections and other animal exploitation. Each entry has a source, a review date and a status. Parent-company links need their own ownership source. Selling animal products alone does not qualify.

Connected AI can also assess a company using searched sources. Its assessment stays separate from reviewed records and can be inconclusive. Neither changes the product's vegan result. A missing record or no concerns found is not an ethical endorsement.

German and English are supported, with Germany and the EU as the first markets. A native SwiftUI app for iPhone and iPad is available in [ios/](ios/). Releases include `vegsnap-unsigned.ipa`. It must be signed before installation, including the embedded share extension and its App Group entitlement.

## Screenshots

### Android

<p align="center">
  <a href="website/images/screenshots/android-check.png"><picture><source media="(prefers-color-scheme: dark)" srcset="website/images/dark/store/android/check-portrait.png"><img src="website/images/store/android/check-portrait.png" alt="Android: enter a product label, import photos or check a barcode" width="230"></picture></a>
  <a href="website/images/screenshots/android-result.png"><picture><source media="(prefers-color-scheme: dark)" srcset="website/images/dark/store/android/result-portrait.png"><img src="website/images/store/android/result-portrait.png" alt="Android: a honey granola result explains that honey is produced by bees" width="230"></picture></a>
  <a href="website/images/screenshots/android-history.png"><picture><source media="(prefers-color-scheme: dark)" srcset="website/images/dark/store/android/history-portrait.png"><img src="website/images/store/android/history-portrait.png" alt="Android: local history shows vegan, non-vegan and uncertain checks" width="230"></picture></a>
</p>

### Browser extension

<p align="center">
  <a href="website/images/screenshots/extension-check.png"><picture><source media="(prefers-color-scheme: dark)" srcset="website/images/dark/store/extension/check.png"><img src="website/images/store/extension/check.png" alt="Browser extension: check an ingredients list or add a product photo" width="720"></picture></a>
</p>
<p align="center">
  <a href="website/images/screenshots/extension-result.png"><picture><source media="(prefers-color-scheme: dark)" srcset="website/images/dark/store/extension/result.png"><img src="website/images/store/extension/result.png" alt="Browser extension: ingredient findings explain the result and its limits" width="355"></picture></a>
  <a href="website/images/screenshots/extension-history.png"><picture><source media="(prefers-color-scheme: dark)" srcset="website/images/dark/store/extension/history.png"><img src="website/images/store/extension/history.png" alt="Browser extension: search and revisit checks saved on your device" width="355"></picture></a>
</p>

Open an image to see the original screenshot.

## AI and evidence

For free AI checks, choose **Vegsnap AI** in Settings, select **Connect to free AI** and complete verification in your browser. Return to Vegsnap to see your remaining allowance. This connection needs no ChatGPT subscription, personal API key or desktop companion. Access expires after 24 hours and allowances reset at midnight UTC. A shared service limit can make free checks unavailable, and a failed AI request can count as a check.

Product checks have a request limit per verified installation, so users sharing a mobile network or Wi-Fi connection have separate limits. A broader IP limit protects connection setup and other service requests. Temporary throttling asks you to wait a minute; exhausted daily allowances reset at midnight UTC. Up to three photos sent together count as one check.

Vegsnap AI sends selected product text, prepared photos and product details through a maintainer-operated Cloudflare service to OpenAI. It does not send your saved history or personal provider credentials. See the [privacy policy](https://vegsnap.app/privacy.html) for storage and retention details.

ChatGPT sign-in on Android and in the browser extension requires a [ChatGPT Plus or Pro plan](https://developers.openai.com/siwc/quickstart). Free ChatGPT accounts are not supported for this connection. Android connects directly; the extension needs the desktop companion. Both support saving, switching and removing ChatGPT accounts in Settings, and prefer `gpt-6-luna` when available unless you select another model. Update the desktop companion to use account management in the extension. Switching reconnects the selected account through browser sign-in; disconnecting keeps saved accounts for later. Public database checks and local rules work without any AI connection.

AI can identify a product, read its label and assess unfamiliar ingredients. Vegsnap AI, ChatGPT and the official OpenAI API can also search for manufacturer and certification sources. Other compatible endpoints currently do not support web search.

Vegsnap accepts a web claim only if its URL came from the search tool and its product and brand match the check. AI-read labels and claims remain marked unverified. Community database labels do not establish verified certification.

Incomplete composition, ambiguous ingredient origins or conflicting sources can produce an uncertain result. Automatic store database checks need an exact barcode from the listing. Use a right-click check when a listing does not supply one.

Connecting a cloud provider can send selected text and photos to that provider when you start a check. The provider's retention policy, usage limits and charges apply. Database checks and local rules need no AI account.

## Install the Android app

Download the signed APK using the Android badge above. You can also use the Obtainium badge to track updates.

To join the Google Play closed test, first [join the Vegsnap testers group](https://groups.google.com/g/vegsnap-testers), then [opt in on Google Play](https://play.google.com/apps/testing/app.vegsnap) with the same Google account. Please stay opted in for at least 14 days, try the app and send feedback via [GitHub Issues](https://github.com/D3SOX/vegsnap/issues) or using the [contact on the website](https://vegsnap.app/#play-test).

Google Play and GitHub APKs use different signing keys. To switch between them, export your history, uninstall the current app and install the other version. Import your history and reconnect your AI provider. History exports do not include photos or credentials.

## Install the browser extension

Install Vegsnap from the [Chrome Web Store](https://chromewebstore.google.com/detail/vegsnap/pkkfmbgdbdoccbdngnbfpjjhpldmphej) in Chrome, Chromium, Brave, Helium, Vivaldi or Microsoft Edge. Firefox store approval is still pending; Firefox, Zen and LibreWolf can use the temporary Firefox package below. It requires a browser based on Firefox 140 or later.

Download the browser packages from the [latest release](https://github.com/D3SOX/vegsnap/releases/latest).

- Chrome, Chromium, Brave, Helium, Vivaldi and Microsoft Edge: extract `vegsnap-chromium.zip`, open `chrome://extensions` (`brave://extensions` in Brave, `helium://extensions` in Helium, `vivaldi://extensions` in Vivaldi or `edge://extensions` in Edge), enable developer mode and choose **Load unpacked**. Select the extracted folder. The release also includes `vegsnap-chromium.crx`, but some browsers restrict direct CRX installation. The ZIP works for development installation.
- Firefox, Zen and LibreWolf: download `vegsnap-firefox.xpi`, open `about:debugging`, choose **This Firefox**, then **Load Temporary Add-on** and select the file. The XPI is currently unsigned, so normal Firefox cannot install it permanently. Temporary add-ons disappear when the browser closes. Permanent installation needs Mozilla signing.

## Install the ChatGPT companion

The desktop companion connects the browser extension to your ChatGPT Plus or Pro plan. Vegsnap AI, API-key connections and Android ChatGPT sign-in work without it. The companion saves credentials in your operating system's credential store.

The commands below use the Chrome Web Store extension ID. If you installed the Chromium ZIP or CRX manually, replace `pkkfmbgdbdoccbdngnbfpjjhpldmphej` with `bljmddjdbglldnbdhdfdlbilieoheend`.

Download the archive for your computer from the [latest release](https://github.com/D3SOX/vegsnap/releases/latest). Registration requires Python 3. Install the files in a permanent location before running `install.py`.

<details>
<summary>Linux x86_64</summary>

Download `vegsnap-companion-linux-x86_64.tar.gz`, then run:

```sh
mkdir -p ~/.local/lib/vegsnap
tar -xzf ~/Downloads/vegsnap-companion-linux-x86_64.tar.gz -C ~/.local/lib/vegsnap
chmod +x ~/.local/lib/vegsnap/vegsnap-companion
```

<details>
<summary>Firefox</summary>

```sh
python3 ~/.local/lib/vegsnap/install.py \
  --binary "$HOME/.local/lib/vegsnap/vegsnap-companion" \
  --browser firefox --extension-id vegsnap@vegsnap.app
```

</details>

<details>
<summary>Chromium</summary>

```sh
python3 "$HOME/.local/lib/vegsnap/install.py" \
  --binary "$HOME/.local/lib/vegsnap/vegsnap-companion" \
  --browser chromium --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Google Chrome</summary>

```sh
python3 "$HOME/.local/lib/vegsnap/install.py" \
  --binary "$HOME/.local/lib/vegsnap/vegsnap-companion" \
  --browser chrome --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Brave</summary>

```sh
python3 "$HOME/.local/lib/vegsnap/install.py" \
  --binary "$HOME/.local/lib/vegsnap/vegsnap-companion" \
  --browser brave --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Helium</summary>

```sh
python3 "$HOME/.local/lib/vegsnap/install.py" \
  --binary "$HOME/.local/lib/vegsnap/vegsnap-companion" \
  --browser helium --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Vivaldi</summary>

```sh
python3 "$HOME/.local/lib/vegsnap/install.py" \
  --binary "$HOME/.local/lib/vegsnap/vegsnap-companion" \
  --browser vivaldi --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Microsoft Edge</summary>

```sh
python3 "$HOME/.local/lib/vegsnap/install.py" \
  --binary "$HOME/.local/lib/vegsnap/vegsnap-companion" \
  --browser edge --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Zen</summary>

```sh
python3 "$HOME/.local/lib/vegsnap/install.py" \
  --binary "$HOME/.local/lib/vegsnap/vegsnap-companion" \
  --browser zen --extension-id vegsnap@vegsnap.app
```

</details>

<details>
<summary>LibreWolf</summary>

```sh
python3 "$HOME/.local/lib/vegsnap/install.py" \
  --binary "$HOME/.local/lib/vegsnap/vegsnap-companion" \
  --browser librewolf --extension-id vegsnap@vegsnap.app
```

</details>

Linux needs an unlocked Secret Service wallet, such as KDE Wallet with Secret Service enabled.

</details>

<details>
<summary>macOS, Apple silicon and Intel</summary>

Download `vegsnap-companion-macos-universal.tar.gz`, then run:

```sh
mkdir -p "$HOME/Library/Application Support/Vegsnap"
tar -xzf ~/Downloads/vegsnap-companion-macos-universal.tar.gz \
  -C "$HOME/Library/Application Support/Vegsnap"
chmod +x "$HOME/Library/Application Support/Vegsnap/vegsnap-companion"
```

<details>
<summary>Firefox</summary>

```sh
python3 "$HOME/Library/Application Support/Vegsnap/install.py" \
  --binary "$HOME/Library/Application Support/Vegsnap/vegsnap-companion" \
  --browser firefox --extension-id vegsnap@vegsnap.app
```

</details>

<details>
<summary>Chromium</summary>

```sh
python3 "$HOME/Library/Application Support/Vegsnap/install.py" \
  --binary "$HOME/Library/Application Support/Vegsnap/vegsnap-companion" \
  --browser chromium --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Google Chrome</summary>

```sh
python3 "$HOME/Library/Application Support/Vegsnap/install.py" \
  --binary "$HOME/Library/Application Support/Vegsnap/vegsnap-companion" \
  --browser chrome --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Brave</summary>

```sh
python3 "$HOME/Library/Application Support/Vegsnap/install.py" \
  --binary "$HOME/Library/Application Support/Vegsnap/vegsnap-companion" \
  --browser brave --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Helium</summary>

```sh
python3 "$HOME/Library/Application Support/Vegsnap/install.py" \
  --binary "$HOME/Library/Application Support/Vegsnap/vegsnap-companion" \
  --browser helium --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Vivaldi</summary>

```sh
python3 "$HOME/Library/Application Support/Vegsnap/install.py" \
  --binary "$HOME/Library/Application Support/Vegsnap/vegsnap-companion" \
  --browser vivaldi --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Microsoft Edge</summary>

```sh
python3 "$HOME/Library/Application Support/Vegsnap/install.py" \
  --binary "$HOME/Library/Application Support/Vegsnap/vegsnap-companion" \
  --browser edge --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Zen</summary>

```sh
python3 "$HOME/Library/Application Support/Vegsnap/install.py" \
  --binary "$HOME/Library/Application Support/Vegsnap/vegsnap-companion" \
  --browser zen --extension-id vegsnap@vegsnap.app
```

</details>

<details>
<summary>LibreWolf</summary>

```sh
python3 "$HOME/Library/Application Support/Vegsnap/install.py" \
  --binary "$HOME/Library/Application Support/Vegsnap/vegsnap-companion" \
  --browser librewolf --extension-id vegsnap@vegsnap.app
```

</details>

The companion uses macOS Keychain. The release is not notarized. If macOS blocks it, review the downloaded executable in System Settings under Privacy & Security.

</details>

<details>
<summary>Windows x86_64</summary>

Download `vegsnap-companion-windows-x86_64.zip`. Install Python 3 and the [Microsoft Visual C++ v14 Redistributable for x64](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist/), then run these commands in PowerShell:

```powershell
$vegsnapDirectory = Join-Path $env:LOCALAPPDATA "Vegsnap\Companion"
New-Item -ItemType Directory -Force -Path $vegsnapDirectory | Out-Null
Expand-Archive -Force -Path "$HOME\Downloads\vegsnap-companion-windows-x86_64.zip" -DestinationPath $vegsnapDirectory
```

<details>
<summary>Firefox</summary>

```powershell
py -3 "$vegsnapDirectory\install.py" `
  --binary "$vegsnapDirectory\vegsnap-companion.exe" `
  --browser firefox --extension-id vegsnap@vegsnap.app
```

</details>

<details>
<summary>Chromium</summary>

```powershell
py -3 "$vegsnapDirectory\install.py" `
  --binary "$vegsnapDirectory\vegsnap-companion.exe" `
  --browser chromium --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Google Chrome</summary>

```powershell
py -3 "$vegsnapDirectory\install.py" `
  --binary "$vegsnapDirectory\vegsnap-companion.exe" `
  --browser chrome --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Brave</summary>

```powershell
py -3 "$vegsnapDirectory\install.py" `
  --binary "$vegsnapDirectory\vegsnap-companion.exe" `
  --browser brave --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Helium</summary>

```powershell
py -3 "$vegsnapDirectory\install.py" `
  --binary "$vegsnapDirectory\vegsnap-companion.exe" `
  --browser helium --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Vivaldi</summary>

```powershell
py -3 "$vegsnapDirectory\install.py" `
  --binary "$vegsnapDirectory\vegsnap-companion.exe" `
  --browser vivaldi --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Microsoft Edge</summary>

```powershell
py -3 "$vegsnapDirectory\install.py" `
  --binary "$vegsnapDirectory\vegsnap-companion.exe" `
  --browser edge --extension-id pkkfmbgdbdoccbdngnbfpjjhpldmphej
```

</details>

<details>
<summary>Zen</summary>

```powershell
py -3 "$vegsnapDirectory\install.py" `
  --binary "$vegsnapDirectory\vegsnap-companion.exe" `
  --browser zen --extension-id vegsnap@vegsnap.app
```

</details>

<details>
<summary>LibreWolf</summary>

```powershell
py -3 "$vegsnapDirectory\install.py" `
  --binary "$vegsnapDirectory\vegsnap-companion.exe" `
  --browser librewolf --extension-id vegsnap@vegsnap.app
```

</details>

The installer writes a separate manifest for each browser under `%LOCALAPPDATA%\Vegsnap\NativeMessagingHosts` and registers it under `HKEY_CURRENT_USER`. It does not need administrator access. Credentials use Windows Credential Manager.

</details>

### Connect your browser

Run the registration command for each browser you use: Firefox, Zen, LibreWolf, Chromium, Google Chrome, Brave, Helium, Vivaldi or Microsoft Edge. Brave on macOS and Brave, Helium and Vivaldi on Windows share Chrome's native-host registration location. Zen shares Firefox's location, as does LibreWolf on Windows. The Chrome Web Store version uses `pkkfmbgdbdoccbdngnbfpjjhpldmphej`. Manually installed ZIP and CRX release packages use `bljmddjdbglldnbdhdfdlbilieoheend`. Both IDs stay the same across updates. Firefox, Zen and LibreWolf use `vegsnap@vegsnap.app`.

After registration, restart your browser, open the extension's settings, choose **Connect ChatGPT** and allow the native-messaging permission. Complete sign-in in the browser. Keep the companion in its registered location. If you move it, run the installer again with the new path.

## Data licenses

The application code uses AGPL-3.0-only. Open Food Facts, Open Beauty Facts and Open Products Facts databases use ODbL-1.0, with individual contents under DBCL-1.0. Regional packs retain source URLs and dates. These data licenses are separate from the application license.

Third-party dependencies, language models and certification marks retain their own licenses and terms.
