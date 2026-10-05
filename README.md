# Veguide

An account-free, privacy-respecting vegan product checker for Android, Chromium, and Firefox. Designed for all product categories, including food, cosmetics, clothing, and shoes, with Germany/EU coverage and German/English first.

Veguide identifies products from photos or selected website content, checks public product databases, and uses an optional connected AI provider when evidence is missing. Supported providers can inspect images and research product sources on the web. Results explain their evidence and keep company concerns separate from the product's vegan status.

**Status:** first development implementation. Android, Chromium/Firefox, and the optional ChatGPT companion are implemented with automated checks. Device and live-provider checks are recorded in the platform validation notes; broader compatibility and release acceptance remain outstanding. This is not a release-ready certification service.

[Website](https://veguide.app) · [Android releases](https://github.com/D3SOX/veguide/releases)

[![Get it on Obtainium](https://img.shields.io/badge/Get_it_on-Obtainium-526442?style=for-the-badge)](https://apps.obtainium.imranr.dev/redirect?r=obtainium%3A%2F%2Fapp%2F%257B%2522id%2522%253A%2522org.veguide.android%2522%252C%2522url%2522%253A%2522https%253A%252F%252Fgithub.com%252FD3SOX%252Fveguide%2522%252C%2522author%2522%253A%2522D3SOX%2522%252C%2522name%2522%253A%2522Veguide%2522%257D)

## Try the implementation

Requirements: Bun 1.4.2; JDK 21 and Android SDK 36 for Android; Rust for the optional companion. No Veguide account or server is needed. Model/provider credentials are optional and are never required by automated tests.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run test:package
```

The packaging test generates and checks `extension/.output/chrome-mv3` and `extension/.output/firefox-mv3`. Load the appropriate development package using your browser's extension tools. For Firefox use `about:debugging` → This Firefox → Load Temporary Add-on; for Chromium enable developer mode in the extensions page and load the unpacked folder.

```sh
cd android
./gradlew testDebugUnitTest lintDebug
```

Open `android/` in Android Studio to run it on a device. Build the optional desktop companion with `cargo build --release --manifest-path companion/Cargo.toml`.

## What works now

- Exact barcode lookup in the Open Facts database family, local German/English ingredient and material rules, evidence-linked explanations, and conservative unknown/conflict handling.
- Android camera capture/import, AI-first image analysis and fallback offline German/English OCR with downloadable languages, local history, automatically saved settings, ChatGPT sign-in, and optional compatible-API image/text analysis.
- Chromium/Firefox selected-text and image checks, local history, session-only API keys, ChatGPT companion connection, and opt-in structured-data store badges.
- Shared result contracts, rule data, evaluation fixtures, provider/permission tests, and CI configuration.

## Current boundaries

AI can identify products, transcribe composition, assess unfamiliar ingredient terms, and observe explicit vegan labels in supplied photos. ChatGPT and the official OpenAI API can use web search to find product-specific manufacturer or certification sources; other compatible endpoints currently do not support search. A web claim is usable only when its URL was returned by the actual search tool and its product/brand match the identified product. AI-read labels and sources remain marked unverified; they are not independent certification-registry verification. Community database label tags never become verified certification automatically. Company concerns use a small reviewed local dataset with source dates and separately sourced parent-company relationships. Initial coverage includes Nestlé, Hälsans Kök and Garden Gourmet; an absent entry is not ethical clearance.

The store integration currently requires an unambiguous GTIN in structured product data. Many marketplace listings do not provide one, so generic right-click checks remain the fallback. Local rules and optional AI assessments distinguish unfamiliar terms from known animal or ambiguous ingredients. Missing composition or unresolved evidence can still return uncertain. An unknown result means more evidence is needed.

Automated tests use fixtures and mocked network responses. They do not establish live provider eligibility, real-store coverage, or camera/OCR accuracy on packaging. Broader device/provider compatibility testing remains ongoing.

## Confirmed decisions

- No Veguide account, mandatory backend, advertising, or telemetry.
- All product categories are in scope for the first release.
- Native Android with Jetpack Compose; native iOS planned later.
- Chromium and Firefox extension with generic checks and selected store integrations.
- Database-first checks; automatic AI for explicitly initiated checks, database-only background checks.
- ChatGPT sign-in as the preferred optional AI connection, with an optional desktop companion.
- OpenAI-compatible API connections and local/self-hosted AI as alternatives.
- Local history and settings; Scan, Manual, History, and Settings tabs on Android, with photo previews and Auto category selection.
- Evidence-linked company concerns, including documented animal exploitation, independent of product status.
- AGPL-3.0 licensing. This draft uses the SPDX designation `AGPL-3.0-only`.

Third-party data, model weights, dependencies, and certification marks retain their respective licenses and terms. Connecting a cloud provider sends the selected content to that provider; the plan explains how this is disclosed and controlled.

## Releases

Signed development APKs and regional packs are published on [GitHub Releases](https://github.com/D3SOX/veguide/releases). Regional packs and their licenses are in [regional-packs](regional-packs/README.md).

Releases run from `v*` tags or a manual workflow dispatch. Signing credentials live in GitHub Actions secrets, never in the repository. Release APKs use a different certificate from local debug builds; switching requires a deliberate reinstall and can delete local data.
