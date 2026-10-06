# Veguide

Veguide checks whether products appear vegan. Photograph a label on Android, or check selected text and product images in Chromium or Firefox.

It supports food, cosmetics, household products, clothing and shoes. It uses public product databases, local ingredient and material rules, and optional AI. Results show the evidence and explain which details are missing.

You do not need a Veguide account. History stays on your device. The app has no ads or telemetry.

This is an early release. Device, store and provider compatibility tests are ongoing.

[Website](https://veguide.app) · [Android releases](https://github.com/D3SOX/veguide/releases)

[![Get it on Obtainium](https://img.shields.io/badge/Get_it_on-Obtainium-526442?style=for-the-badge)](https://apps.obtainium.imranr.dev/redirect?r=obtainium%3A%2F%2Fapp%2F%257B%2522id%2522%253A%2522app.veguide%2522%252C%2522url%2522%253A%2522https%253A%252F%252Fgithub.com%252FD3SOX%252Fveguide%2522%252C%2522author%2522%253A%2522D3SOX%2522%252C%2522name%2522%253A%2522Veguide%2522%257D)

## What it does

- On Android, take or import photos, share a product, or enter text. The app has local history and offline text recognition with downloadable language models.
- In Chromium and Firefox, check selected text or right-click a product image. Enable store integrations if you want database checks while browsing. Background checks never use AI.
- Connect ChatGPT, an OpenAI-compatible API, or a compatible local model for AI checks. The extension needs the optional desktop companion for ChatGPT sign-in. API-key connections work without it.
- Look up barcodes in Open Food Facts, Open Beauty Facts and Open Products Facts. Regional packs provide a selection of these records offline.
- Review company concerns alongside the product result. A reviewed list records documented animal testing, opposition to animal-welfare protections and other animal exploitation. Each entry has a source, a review date and a status. Parent-company links need their own ownership source. Selling animal products alone does not qualify.

Connected AI can also assess a company using searched sources. Its assessment stays separate from reviewed records and can be inconclusive. Neither changes the product's vegan result. A missing record or no concerns found is not an ethical endorsement.

German and English are supported, with Germany and the EU as the first markets. A native iOS app is planned.

## AI and evidence

AI can identify a product, read its label and assess unfamiliar ingredients. ChatGPT and the official OpenAI API can also search for manufacturer and certification sources. Other compatible endpoints currently do not support web search.

Veguide accepts a web claim only if its URL came from the search tool and its product and brand match the check. AI-read labels and claims remain marked unverified. Community database labels do not establish verified certification.

Incomplete composition, ambiguous ingredient origins or conflicting sources can produce an uncertain result. Store badges require an exact barcode in the page's structured product data. Use a right-click check when a listing does not supply one.

Connecting a cloud provider can send selected text and photos to that provider when you start a check. The provider's retention policy, usage limits and charges apply. Database checks and local rules need no AI account.

## Run from source

Use Bun 1.4.2 for the extension. Android needs JDK 21 and Android SDK 37. The optional companion needs Rust. Automated tests do not require provider credentials.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run test:package
```

The packaging test creates and checks `extension/.output/chrome-mv3` and `extension/.output/firefox-mv3`.

In Chromium, enable developer mode on the extensions page and load the unpacked folder. In Firefox, open `about:debugging`, select **This Firefox**, then **Load Temporary Add-on** and choose the Firefox package's manifest.

Open `android/` in Android Studio to run the app on a device. Run its checks with:

```sh
cd android
./gradlew testDebugUnitTest lintDebug
```

Automated tests use fixtures and mocked network responses. They do not establish live provider eligibility, store coverage or camera accuracy on real packaging.

## Install the browser extension

Download the browser packages from the [latest release](https://github.com/D3SOX/veguide/releases/latest).

- Chromium: extract `veguide-chromium.zip`, open `chrome://extensions`, enable developer mode and choose **Load unpacked**. Select the extracted folder. The release also includes `veguide-chromium.crx`, but some browsers restrict direct CRX installation. The ZIP works for development installation.
- Firefox: download `veguide-firefox.xpi`, open `about:debugging`, choose **This Firefox**, then **Load Temporary Add-on** and select the file. The XPI is currently unsigned, so normal Firefox cannot install it permanently. Temporary add-ons disappear when Firefox closes. Permanent installation needs Mozilla signing.

## Install the ChatGPT companion

The extension needs a desktop companion for ChatGPT sign-in. API-key connections do not need it. The companion saves credentials in your operating system's credential store.

Download the archive for your computer from the [latest release](https://github.com/D3SOX/veguide/releases/latest). Registration requires Python 3. Install the files in a permanent location before running `install.py`.

### Linux x86_64

Download `veguide-companion-linux-x86_64.tar.gz`, then run:

```sh
mkdir -p ~/.local/lib/veguide
tar -xzf ~/Downloads/veguide-companion-linux-x86_64.tar.gz -C ~/.local/lib/veguide
chmod +x ~/.local/lib/veguide/veguide-companion
python3 ~/.local/lib/veguide/install.py \
  --binary "$HOME/.local/lib/veguide/veguide-companion" \
  --browser firefox --extension-id veguide@veguide.app
```

Linux needs an unlocked Secret Service wallet, such as KDE Wallet with Secret Service enabled.

### macOS, Apple silicon and Intel

Download `veguide-companion-macos-universal.tar.gz`, then run:

```sh
mkdir -p "$HOME/Library/Application Support/Veguide"
tar -xzf ~/Downloads/veguide-companion-macos-universal.tar.gz \
  -C "$HOME/Library/Application Support/Veguide"
chmod +x "$HOME/Library/Application Support/Veguide/veguide-companion"
python3 "$HOME/Library/Application Support/Veguide/install.py" \
  --binary "$HOME/Library/Application Support/Veguide/veguide-companion" \
  --browser firefox --extension-id veguide@veguide.app
```

The companion uses macOS Keychain. The release is not notarized. If macOS blocks it, review the downloaded executable in System Settings under Privacy & Security.

### Windows x86_64

Download `veguide-companion-windows-x86_64.zip`. Install Python 3 and the [Microsoft Visual C++ v14 Redistributable for x64](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist/), then run these commands in PowerShell:

```powershell
$veguideDirectory = Join-Path $env:LOCALAPPDATA "Veguide\Companion"
New-Item -ItemType Directory -Force -Path $veguideDirectory | Out-Null
Expand-Archive -Force -Path "$HOME\Downloads\veguide-companion-windows-x86_64.zip" -DestinationPath $veguideDirectory
py -3 "$veguideDirectory\install.py" `
  --binary "$veguideDirectory\veguide-companion.exe" `
  --browser firefox --extension-id veguide@veguide.app
```

The installer writes a separate manifest for each browser under `%LOCALAPPDATA%\Veguide\NativeMessagingHosts` and registers it under `HKEY_CURRENT_USER`. It does not need administrator access. Credentials use Windows Credential Manager.

### Connect your browser

The commands above register Firefox. For Chromium, use `--browser chromium` and replace the extension ID with the value shown on `chrome://extensions`. Google Chrome uses `--browser chrome`. The release's `chromium-extension-id.txt` also contains the package's ID. Run registration once for each browser you use.

After registration, open the extension's settings, choose **Connect ChatGPT** and allow the native-messaging permission. Complete sign-in in the browser. Keep the companion in its registered location. If you move it, run the installer again with the new path.

`--output PATH` writes a manifest to the chosen path without registering it. For other architectures, build the companion with Rust and register the resulting executable:

```sh
cargo build --locked --release --manifest-path companion/Cargo.toml
python3 companion/install.py \
  --binary "$PWD/companion/target/release/veguide-companion" \
  --browser firefox --extension-id veguide@veguide.app
```

## Releases

[GitHub Releases](https://github.com/D3SOX/veguide/releases) provides signed Android APKs, browser packages and desktop companions. Obtainium can track app releases. [Regional product packs](https://github.com/D3SOX/veguide/releases/tag/offline-data) live in one continuously updated release; the app downloads them from its catalog.

The release workflow runs on `v*` tags or a manual dispatch. Signing credentials are GitHub Actions secrets. Release APKs use a different certificate from local debug builds. Switching requires a reinstall, which can delete local history and settings.

## Data licenses

The application code uses AGPL-3.0-only. Open Food Facts, Open Beauty Facts and Open Products Facts databases use ODbL-1.0, with individual contents under DBCL-1.0. Regional packs retain source URLs and dates. These data licenses are separate from the application license.

Third-party dependencies, language models and certification marks retain their own licenses and terms.
