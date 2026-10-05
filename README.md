# Veguide

Veguide checks whether products appear vegan. Photograph a label on Android, or check selected text and product images in Chromium or Firefox.

It supports food, cosmetics, household products, clothing and shoes. It uses public product databases, local ingredient and material rules, and optional AI. Results show the evidence and explain which details are missing.

You do not need a Veguide account. History stays on your device. The app has no ads or telemetry.

This is an early release. Device, store and provider compatibility tests are ongoing.

[Website](https://veguide.app) · [Android releases](https://github.com/D3SOX/veguide/releases)

[![Get it on Obtainium](https://img.shields.io/badge/Get_it_on-Obtainium-526442?style=for-the-badge)](https://apps.obtainium.imranr.dev/redirect?r=obtainium%3A%2F%2Fapp%2F%257B%2522id%2522%253A%2522org.veguide.android%2522%252C%2522url%2522%253A%2522https%253A%252F%252Fgithub.com%252FD3SOX%252Fveguide%2522%252C%2522author%2522%253A%2522D3SOX%2522%252C%2522name%2522%253A%2522Veguide%2522%257D)

## What it does

- On Android, take or import photos, share a product, or enter text. The app has local history and offline text recognition with downloadable language models.
- In Chromium and Firefox, check selected text or right-click a product image. Enable store integrations if you want database checks while browsing. Background checks never use AI.
- Connect ChatGPT, an OpenAI-compatible API, or a compatible local model for AI checks. The extension needs the optional desktop companion for ChatGPT sign-in. API-key connections work without it.
- Look up barcodes in Open Food Facts, Open Beauty Facts and Open Products Facts. Regional packs provide a selection of these records offline.
- Review company concerns alongside the product result. A reviewed list records documented animal testing, opposition to animal-welfare protections and other animal exploitation. Each entry has a source, a review date and a status. Parent-company links need their own ownership source. Selling animal products alone does not qualify.

Company records never change the product's vegan result. The list is incomplete, so a missing record is not an ethical endorsement.

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

Build the optional desktop companion from the repository root:

```sh
cargo build --release --manifest-path companion/Cargo.toml
python3 companion/install.py --help
```

The installer registers the companion for a specific browser and extension ID. Supply the built binary path, browser and extension ID using the options shown by `--help`.

Automated tests use fixtures and mocked network responses. They do not establish live provider eligibility, store coverage or camera accuracy on real packaging.

## Releases

[GitHub Releases](https://github.com/D3SOX/veguide/releases) provides signed Android APKs and regional product packs. Obtainium can track these releases.

The release workflow runs on `v*` tags or a manual dispatch. Signing credentials are GitHub Actions secrets. Release APKs use a different certificate from local debug builds. Switching requires a reinstall, which can delete local history and settings.

## Data licenses

The application code uses AGPL-3.0-only. Open Food Facts, Open Beauty Facts and Open Products Facts databases use ODbL-1.0, with individual contents under DBCL-1.0. Regional packs retain source URLs and dates. These data licenses are separate from the application license.

Third-party dependencies, language models and certification marks retain their own licenses and terms.
