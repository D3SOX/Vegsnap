# Refreshing screenshots

The capture suite renders the real Android app and packaged browser extension with fixed example data from `fixtures.json`. It captures manual entry, history, a result and an uncertain result in light and dark mode, then creates the store graphics and README previews. It never checks live products or calls AI.

## GitHub Actions

Run **Refresh screenshots** from the Actions tab and select the branch, tag or commit to capture. Download the **veguide-screenshots** artifact and review `contact-sheet.png` and the full-size images.

From a checkout of that same commit:

```sh
bun run screenshots:apply --run RUN_ID --commit
```

This downloads the bundle, verifies its source commit, source fingerprint, file list and checksums, updates only screenshot/marketing assets, and creates a GPG-signed commit. It never pushes. Without `--commit`, it only updates the files. Existing staged changes or edits to the asset files are rejected, so unrelated work cannot enter the commit. Normal website deployment runs after you push the asset commit.

No signing key is stored in GitHub Actions. The workflow only uploads review artifacts.

## Local captures

Install the project dependencies, Playwright's Chromium, and the Python rendering dependencies in a virtual environment:

```sh
bun install --frozen-lockfile
bun x playwright install chromium
python3 -m venv .venv-screenshots
.venv-screenshots/bin/pip install -r scripts/screenshots/requirements.txt
```

Use Java 21, an Android SDK that can build the app, and a running API 35 `google_apis` x86_64 emulator. The screenshot APK uses `app.veguide.screenshots`, so the regular app and its data are untouched. The runner acquires the Android lab lock and restores display, theme, clock, timezone and animation settings when finished.

```sh
.venv-screenshots/bin/python scripts/screenshots.py capture --serial emulator-5556
```

For another emulator, pass both `--serial emulator-PORT` and `--avd NAME`. Start it using your normal Android lab workflow; this script never starts, stops or wipes an emulator. Set `ANDROID_HOME` and `JAVA_HOME` as needed.

The result is in the ignored `artifacts/screenshots/` directory. Review it, then apply it:

```sh
bun run screenshots:apply --bundle artifacts/screenshots --commit
```

Capture only one platform with `--platform android` or `--platform extension`, then run `.venv-screenshots/bin/python scripts/screenshots.py render` after both are present. `--output PATH` selects another bundle directory. Rendering rejects missing captures or captures made from different source revisions. The existing `scripts/render-marketing.py` also supports `--output-root PATH`.

## Reproducibility

Fixtures use fixed IDs and dates. Captures fix English locale, UTC timezone, font scale, viewport/density, system clock, Android color seed and light/dark appearance. They wait for the UI and fonts rather than typing through an Android keyboard or using arbitrary sleep delays.

Playwright and Python rendering versions are pinned, and Actions uses Ubuntu 24.04 and API 35. Android SDK/system-image revisions and host fonts can still change pixels; compare reruns in the same environment rather than treating local and hosted captures as byte-identical. A layout change should change the images. Update the fixtures or semantic capture locators when the intended screens change.

Local bundles record whether the checkout had uncommitted changes. They can capture unreleased UI without presenting it as a published app release. The default workflow is manual; it does not add an emulator job to every ordinary PR check.
