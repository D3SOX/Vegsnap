#!/usr/bin/env python3
"""Package existing WXT builds and the exact sources needed for store review."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def archive_tree(path, directory, overrides=None):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for source in sorted(directory.rglob('*')):
            if source.is_file():
                name = source.relative_to(directory).as_posix()
                archive.writestr(name, (overrides or {}).get(name, source.read_bytes()))
    with zipfile.ZipFile(path) as archive:
        if archive.testzip() is not None:
            raise ValueError(f'Invalid archive: {path}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/store-submission')
    parser.add_argument('--packages-only', action='store_true', help='Skip screenshots and promotional graphics (no image dependencies required)')
    args = parser.parse_args()
    chrome = ROOT / 'extension/.output/chrome-mv3'
    firefox = ROOT / 'extension/.output/firefox-mv3'
    chrome_manifest = json.loads((chrome / 'manifest.json').read_text())
    firefox_manifest = json.loads((firefox / 'manifest.json').read_text())
    version = chrome_manifest['version']
    if version != firefox_manifest['version']:
        raise ValueError('Browser builds must have the same version')
    # The Web Store assigns its own identity. Development keys are not accepted.
    chrome_manifest.pop('key', None)
    output = args.output.resolve() / f'v{version}'
    output.mkdir(parents=True, exist_ok=True)
    archive_tree(output / 'vegsnap-chrome-store.zip', chrome, {'manifest.json': (json.dumps(chrome_manifest, indent=2) + '\n').encode()})
    archive_tree(output / 'vegsnap-firefox.xpi', firefox)
    node_version = subprocess.check_output(['node', '--version'], text=True).strip()
    bun_version = subprocess.check_output(['bun', '--version'], text=True).strip()
    instructions = f'''Vegsnap {version} — Mozilla source review

The source archive contains the exact input files used for this submission.
Build environment: {platform.system()} {platform.machine()}; Node.js {node_version}; Bun {bun_version}.
WXT, Vite and other dependencies are pinned in bun.lock.
Tools are open source. Install Bun {bun_version} from https://bun.sh/docs/installation
(versioned releases: https://github.com/oven-sh/bun/releases/tag/bun-v{bun_version}).

From the extracted source root:
  bun install --frozen-lockfile
  bun run --cwd extension wxt build -b firefox

The generated files are in extension/.output/firefox-mv3.
Compare their bytes with the submitted XPI; ZIP metadata/order may differ.
Do not use build:firefox or scripts/offline-snapshot.ts for this comparison:
those commands refresh live product data. This archive includes the exact
bundled data/offline/bundle.json used in the submitted build. No Android SDK,
Java, Rust, companion installation, credentials or signing keys are needed.
The optional companion source is included for inspection but is not built
into the extension. No remote executable code is used.

Review notes and test steps: extension/store-listing.json.
The addons-linter innerHTML warning is in bundled Preact's renderer; application
components do not use dangerouslySetInnerHTML or insert product HTML.
'''
    paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT).decode().split('\0')
    included = [path for path in paths if path and (path.startswith(('extension/', 'packages/', 'data/', 'contracts/', 'scripts/', 'companion/')) or path in ('package.json', 'bun.lock', 'LICENSE', 'README.md', 'tsconfig.json'))]
    with zipfile.ZipFile(output / 'vegsnap-firefox-source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('AMO-README.txt', instructions)
        for path in sorted(set(included)):
            source = ROOT / path
            if source.is_file():
                archive.write(source, path)
    with zipfile.ZipFile(output / 'vegsnap-firefox-source.zip') as archive:
        if archive.testzip() is not None:
            raise ValueError('Invalid source archive')
    shutil.copyfile(ROOT / 'extension/store-listing.json', output / 'store-listing.json')
    upload_files = [output / name for name in ('vegsnap-chrome-store.zip', 'vegsnap-firefox.xpi', 'vegsnap-firefox-source.zip', 'store-listing.json')]
    if not args.packages_only:
        prepare_graphics(output)
        upload_files.extend(output / name for name in ('icon-128.png', 'chrome-small-promo.png'))
        upload_files.extend((output / 'screenshots').rglob('*.png'))
    metadata = {'version': version, 'chromium_store_id': json.loads((ROOT / 'extension/store-listing.json').read_text()).get('chromium_store_id'), 'firefox_id': firefox_manifest['browser_specific_settings']['gecko']['id'],
                'files': {path.relative_to(output).as_posix(): sha256(path.read_bytes()) for path in sorted(upload_files) if path.is_file()}}
    (output / 'submission.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(f'Prepared Vegsnap {version}: {output}')
    print(f'Chromium ID: {metadata["chromium_store_id"] or "assigned after store upload"}; Firefox ID: {metadata["firefox_id"]}')


def prepare_graphics(output):
    for variant in ('light', 'dark'):
        destination = output / 'screenshots' / variant
        if destination.exists():
            shutil.rmtree(destination)
        destination.mkdir(parents=True, exist_ok=True)
        source = ROOT / 'website/images' / ('dark/store/extension' if variant == 'dark' else 'store/extension')
        for path in sorted(source.glob('*.png')):
            shutil.copyfile(path, destination / path.name)
    shutil.copyfile(ROOT / 'extension/public/icons/128.png', output / 'icon-128.png')
    # Brand-only promotional art; screenshots are reused without modification.
    import cairosvg
    from PIL import Image
    logo = base64.b64encode((ROOT / 'website/logo.svg').read_bytes()).decode()
    promo = f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="440" height="280" viewBox="0 0 440 280"><rect width="440" height="280" fill="#183e2c"/><circle cx="405" cy="55" r="170" fill="#24543b"/><path d="M0 260 Q210 155 440 260" fill="none" stroke="#c8dfa9" opacity=".2" stroke-width="2"/><image xlink:href="data:image/svg+xml;base64,{logo}" x="169" y="40" width="102" height="102"/><text x="220" y="193" text-anchor="middle" fill="#f8f5e9" font-family="DejaVu Sans" font-size="39" font-weight="bold">Vegsnap</text><text x="220" y="227" text-anchor="middle" fill="#c8dfa9" font-family="DejaVu Sans" font-size="17">Check ingredients. See the evidence.</text></svg>'''
    (output / 'chrome-small-promo.svg').write_text(promo + '\n')
    cairosvg.svg2png(bytestring=promo.encode(), write_to=str(output / 'chrome-small-promo.png'))
    with Image.open(output / 'chrome-small-promo.png') as rendered:
        rendered.convert('RGB').save(output / 'chrome-small-promo.png', optimize=True)


if __name__ == '__main__':
    main()
