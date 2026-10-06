# Repository maintenance

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

## Screenshot refreshes

Use the **Refresh screenshots** GitHub Actions workflow or the local capture script to capture the real Android app and packaged extension with the checked-in fixtures. Preserve the light and dark variants and regenerate the store graphics and README previews together.

Follow [the capture instructions](scripts/screenshots/README.md) to review and apply a bundle. Apply from its source checkout with `bun run screenshots:apply --run RUN_ID --commit`; this creates a signed asset-only commit and does not push. Keep unrelated app changes out of screenshot commits.

## Companion development

`--output PATH` writes a manifest to the chosen path without registering it. For other architectures, build the companion with Rust and register the resulting executable:

```sh
cargo build --locked --release --manifest-path companion/Cargo.toml
python3 companion/install.py \
  --binary "$PWD/companion/target/release/veguide-companion" \
  --browser firefox --extension-id veguide@veguide.app
```

## Publishing releases

The [release workflow](.github/workflows/release.yml) runs on `v*` tags or a manual dispatch. Signing credentials are GitHub Actions secrets. Release APKs use a different certificate from local debug builds. Switching requires a reinstall, which can delete local history and settings.

Regional product packs are published in the continuously updated [`offline-data` release](https://github.com/D3SOX/veguide/releases/tag/offline-data); the app downloads them from its catalog.
