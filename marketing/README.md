# Marketing assets

These images show **Veguide 0.2.1** running on Android and in Chromium. The app screens are genuine captures; the device/browser frames and surrounding copy are added separately. The screenshots have no retouched UI, provider credentials, personal accounts or real purchase history. Product names are generic examples, not manufacturer endorsements.

PNG assets live in `website/images/` so the website and README use one copy. Editable sources and README badges live in `marketing/`.

## Exports

| Location | Size | Use |
| --- | --- | --- |
| `../website/images/screenshots/android-*.png` | 1080 × 2400 | Original Android captures |
| `../website/images/screenshots/extension-*.png` | 760 × 880 | Original extension captures |
| `../website/images/store/android/*-portrait.png` | 1080 × 1920 | Android listing screenshots with feature text above the phone |
| `../website/images/store/android/*-landscape.png` | 1920 × 1080 | Android promotional images with feature text beside the phone |
| `../website/images/store/extension/*.png` | 1280 × 800 | Extension listing screenshots with feature text beside the app |
| `../website/images/readme-preview.png` | 1400 × 760 | Compact README preview of both interfaces |
| `sources/*.svg` | Same as each export | Editable layouts with original screenshots embedded |
| `badges/{website,android,extension,obtainium}.svg` | 220 × 64 | Local README link badges |
| `badges/*-icon.svg` | 48 × 48 | Platform artwork visible in light and dark mode |

The three store panels cover **label entry**, **result explanations**, and **local history**. Original captures also include an uncertain result on each platform. All rendered PNGs use RGB with no transparency. Screens are scaled proportionally inside generic frames.

The extension exports use the screenshot dimensions documented by the [Chrome Web Store](https://developer.chrome.com/docs/webstore/images). The Android exports use portrait and landscape formats described in [Google Play's preview asset guidance](https://support.google.com/googleplay/android-developer/answer/9866151?hl=en). These are screenshot/promotion exports, not complete store submission kits: dedicated store icons, a Google Play feature graphic and Chrome promotional tiles are separate listing assets. The badges link to current downloads and installation instructions; they do not imply published store listings.

## Capture provenance

Captured on 6 October 2026 from the released `veguide.apk` and `veguide-chromium.crx` for version 0.2.1.

- **Android:** installed the APK on a fresh Pixel 7 emulator running Android 15 / API 35 at 1080 × 2400. Entered the examples through the app's manual check screen. Captured the display with `adb exec-out screencap -p`. The status bar uses Android's demo clock at 09:41. Android's dynamic Material colors are preserved.
- **Extension:** unpacked the released CRX and loaded it into an isolated Chromium session. Opened `chrome-extension://bljmddjdbglldnbdhdfdlbilieoheend/app.html` at 760 × 880 in light mode. The real background worker evaluated the examples and saved them to real local history. Captured the real extension page with `agent-browser`. No mock browser API, reconstructed interface or altered stylesheet is used in the final captures.
- **No cloud AI:** extension checks used the database connection; Android checks used local rules without a configured AI model. Uncertainty and certification caveats remain visible.

| Example | Input | Category | Expected result |
| --- | --- | --- | --- |
| Oat flakes (Android) | `Ingredients: oats` | Food | Composition appears vegan |
| Oat flakes (extension) | `Ingredients: oats, salt` | Food | Composition appears vegan |
| Honey granola | `Ingredients: oats, honey, almonds` | Food | Animal-derived content / not vegan |
| Fruit gummies (Android) | `Ingredients: sugar, natural flavouring` | Food | More information needed |
| Hand cream (extension) | `Ingredients: water, glycerin` | Cosmetics | More information needed |
| Cotton T-shirt (extension) | `Materials: cotton` | Clothing | More information needed |

All examples were submitted as complete lists. A composition result does not establish certification or undisclosed processing aids. Clothing may still require confirmation of coatings, glue and trims.

For new captures, use an isolated emulator/browser profile, keep the full screen dimensions above, and replace the appropriate original PNG. Avoid showing unrelated notifications or account information. The Android and extension `result` panels deliberately show different outcomes.

## Regenerate the graphics

The generator requires Python 3, CairoSVG, Pillow and the **DejaVu Sans / DejaVu Serif** fonts. It runs locally and requires no image-generation service or remote fonts. With those dependencies installed, run from the repository root:

```sh
python scripts/render-marketing.py
```

This regenerates the nine store images, their SVG sources, the README preview, the four badges and the platform icons from the original captures. Edit copy, colors and layout in `scripts/render-marketing.py`; direct edits to generated SVGs are overwritten on regeneration. The originals in `website/images/screenshots/` are never overwritten by this command.

The logo comes from `website/logo.svg`. New frame layouts, copy and badges follow the repository's AGPL-3.0-only license. The existing official Obtainium badge and platform icons keep their licenses in `website/icons/`.
