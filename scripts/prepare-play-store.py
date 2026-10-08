#!/usr/bin/env python3
"""Package Play listing text, reviewed graphics and a release bundle for manual submission."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def prepare(output: Path, bundle: Path | None, support_email: str | None):
    listing = json.loads((ROOT / 'android/play/listing.json').read_text())
    if support_email:
        if '@' not in support_email or any(char.isspace() for char in support_email):
            raise ValueError('Supply a valid public support email.')
        listing['support_email'] = support_email
    output.mkdir(parents=True, exist_ok=True)
    for locale, text in listing['locales'].items():
        for field, limit in [('title', 30), ('short_description', 80), ('full_description', 4000), ('release_notes', 500)]:
            if not 0 < len(text[field]) <= limit:
                raise ValueError(f'{locale}/{field} must contain 1–{limit} characters.')
            destination = output / locale / f'{field}.txt'
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(text[field] + '\n')
    for appearance in ('light', 'dark'):
        prefix = '' if appearance == 'light' else 'dark/'
        source = ROOT / f'website/images/{prefix}store/android'
        for name in ['feature-graphic.png', 'check-portrait.png', 'result-portrait.png', 'history-portrait.png']:
            destination = output / 'graphics' / appearance / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, destination)
    shutil.copyfile(ROOT / 'website/images/store/android/icon.png', output / 'graphics/icon.png')
    shutil.copyfile(ROOT / 'android/play/SUBMISSION.txt', output / 'SUBMISSION.txt')
    shutil.copyfile(ROOT / 'android/play/data-safety.json', output / 'data-safety.json')
    (output / 'listing.json').write_text(json.dumps(listing, indent=2, ensure_ascii=False) + '\n')
    shutil.copyfile(ROOT / 'website/privacy.html', output / 'privacy-policy.html')
    signed = False
    if bundle:
        with zipfile.ZipFile(bundle) as archive:
            if 'base/manifest/AndroidManifest.xml' not in archive.namelist():
                raise ValueError('Not an Android App Bundle.')
            signed = any(name.startswith('META-INF/') and name.endswith(('.RSA', '.EC', '.DSA')) for name in archive.namelist())
        shutil.copyfile(bundle, output / ('vegsnap.aab' if signed else 'vegsnap-unsigned.aab'))
    files = {}
    for path in sorted(output.rglob('*')):
        if path.is_file() and path.name != 'submission.json':
            files[str(path.relative_to(output))] = hashlib.sha256(path.read_bytes()).hexdigest()
    metadata = {
        'packageName': listing['package_name'], 'listing': listing,
        'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'sourceDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip()),
        'bundleHasSignature': signed,
        'remaining': [] +
            ([] if listing['support_email'] else ['Choose public support email']) +
            ([] if signed else ['Produce a release bundle signed with the registered upload key']) +
            ['Publish the Android privacy policy and reporting service', 'Verify live Vegsnap AI reviewer access',
             'Record the actual foreground-service declaration video',
             'Confirm Data safety against selected providers', 'Complete declarations and required closed testing'],
        'files': files,
    }
    (output / 'submission.json').write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + '\n')
    print(f'Prepared {len(files)} files in {output}. Bundle signature present: {signed}.')
    print('This package does not submit an app or certify Play approval. See SUBMISSION.txt for remaining steps.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/play-store')
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--support-email')
    args = parser.parse_args()
    prepare(args.output.resolve(), args.bundle.resolve() if args.bundle else None, args.support_email)
