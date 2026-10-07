#!/usr/bin/env python3
"""Validate release assets and submit an existing Chrome Web Store listing via API v2."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
API = 'https://chromewebstore.googleapis.com'


def validate(directory, tag):
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag):
        raise ValueError('Only stable vX.Y.Z releases can be submitted to the stores')
    version = tag[1:]
    metadata = json.loads((directory / 'submission.json').read_text())
    expected_listing = json.loads((ROOT / 'extension/store-listing.json').read_text())
    listing = json.loads((directory / 'store-listing.json').read_text())
    if metadata['version'] != version:
        raise ValueError('Release tag must match the extension package version')
    for key in ('chromium_store_id', 'chromium_publisher_id'):
        if listing[key] != expected_listing[key]:
            raise ValueError(f'Unexpected {key}; refusing to submit to another listing')
    if metadata['chromium_store_id'] != listing['chromium_store_id'] or metadata['firefox_id'] != 'vegsnap@vegsnap.app':
        raise ValueError('Unexpected extension identity in submission metadata')
    for name in ('vegsnap-chrome-store.zip', 'vegsnap-firefox.xpi', 'vegsnap-firefox-source.zip', 'store-listing.json'):
        if hashlib.sha256((directory / name).read_bytes()).hexdigest() != metadata['files'][name]:
            raise ValueError(f'Release asset checksum mismatch: {name}')
    for name in ('vegsnap-chrome-store.zip', 'vegsnap-firefox.xpi'):
        with zipfile.ZipFile(directory / name) as archive:
            if archive.testzip():
                raise ValueError(f'Corrupt archive: {name}')
            manifest = json.loads(archive.read('manifest.json'))
        if manifest['version'] != version:
            raise ValueError(f'Manifest version does not match release tag: {name}')
        if name.endswith('.zip') and 'key' in manifest:
            raise ValueError('Chrome Web Store package must not contain the sideload key')
        if name.endswith('.xpi') and manifest['browser_specific_settings']['gecko']['id'] != metadata['firefox_id']:
            raise ValueError('Firefox manifest has an unexpected add-on ID')
    with zipfile.ZipFile(directory / 'vegsnap-firefox-source.zip') as archive:
        if archive.testzip():
            raise ValueError('Corrupt Firefox source archive')
        if json.loads(archive.read('extension/package.json'))['version'] != version:
            raise ValueError('Firefox sources must match the submitted extension version')
        for name in ('AMO-README.txt', 'bun.lock', 'data/offline/bundle.json'):
            archive.getinfo(name)
    return version, listing


class ChromeAPI:
    def __init__(self):
        names = ('CHROME_CLIENT_ID', 'CHROME_CLIENT_SECRET', 'CHROME_REFRESH_TOKEN')
        missing = [name for name in names if not os.environ.get(name)]
        if missing:
            raise ValueError('Missing repository secrets: ' + ', '.join(missing))
        self.secrets = [os.environ[name] for name in names]
        credentials = {name.removeprefix('CHROME_').lower(): os.environ[name] for name in names}
        credentials['grant_type'] = 'refresh_token'
        response = self.request('https://oauth2.googleapis.com/token', urllib.parse.urlencode(credentials).encode(), 'application/x-www-form-urlencoded')
        self.token = response['access_token']
        self.secrets.append(self.token)

    def request(self, url, data=None, content_type='application/json'):
        headers = {'Content-Type': content_type}
        if hasattr(self, 'token'):
            headers['Authorization'] = f'Bearer {self.token}'
        request = urllib.request.Request(url, data=data, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors='replace')
            for secret in self.secrets:
                detail = detail.replace(secret, '[redacted]')
            raise RuntimeError(f'Store API HTTP {error.code}: {detail}') from None


def revision_versions(revision):
    return [channel['crxVersion'] for channel in revision.get('distributionChannels', [])]


def publish_chrome(api, directory, version, listing, sleep=time.sleep):
    name = f"publishers/{listing['chromium_publisher_id']}/items/{listing['chromium_store_id']}"
    base = f'{API}/v2/{name}'
    status = api.request(f'{base}:fetchStatus')
    if status.get('takenDown') or status.get('warned'):
        raise ValueError('Resolve the Chrome Web Store policy notice in the developer dashboard first')
    published = status.get('publishedItemRevisionStatus', {})
    if version in revision_versions(published) and published.get('state') == 'PUBLISHED':
        return 'Already published'
    target = tuple(map(int, version.split('.')))
    if any(tuple(map(int, old.split('.'))) >= target for old in revision_versions(published)):
        raise ValueError('Refusing to replace an equal or newer published Chrome version')
    submitted = status.get('submittedItemRevisionStatus', {})
    if submitted.get('state') in ('PENDING_REVIEW', 'STAGED'):
        submitted_versions = set(revision_versions(submitted))
        if submitted_versions != {version}:
            if submitted['state'] == 'PENDING_REVIEW' and len(submitted_versions) == 1:
                pending_version = next(iter(submitted_versions))
                if tuple(map(int, pending_version.split('.'))) < target:
                    return f'Skipped: Chrome {pending_version} is still pending review; retry {version} after it finishes'
            raise ValueError('Another Chrome version is under review or staged; finish it in the dashboard first')
        if submitted['state'] == 'PENDING_REVIEW':
            return 'Already pending review'
        publish_type = 'STAGED_PUBLISH'
    else:
        if submitted.get('state') == 'REJECTED' and version in revision_versions(submitted):
            raise ValueError('This Chrome version was rejected; inspect the review before retrying')
        uploaded = api.request(f'{API}/upload/v2/{name}:upload', (directory / 'vegsnap-chrome-store.zip').read_bytes(), 'application/zip')
        state = uploaded.get('uploadState')
        if state == 'SUCCEEDED' and uploaded.get('crxVersion') != version:
            raise ValueError('Chrome reported a different uploaded version')
        for _ in range(60):
            if state != 'IN_PROGRESS':
                break
            sleep(10)
            state = api.request(f'{base}:fetchStatus').get('lastAsyncUploadState')
        if state != 'SUCCEEDED':
            raise ValueError(f'Chrome package upload did not succeed: {state}')
        publish_type = 'DEFAULT_PUBLISH'
    response = api.request(f'{base}:publish', json.dumps({'publishType': publish_type, 'skipReview': False}).encode())
    if response.get('state') not in ('PENDING_REVIEW', 'PUBLISHED'):
        raise ValueError(f"Chrome submission did not succeed: {response.get('state')}")
    return response['state']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('validate', 'chrome'))
    parser.add_argument('--tag', required=True)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    version, listing = validate(args.directory, args.tag)
    if args.command == 'chrome':
        result = f'Chrome {version}: {publish_chrome(ChromeAPI(), args.directory, version, listing)}'
        print(result)
        if summary := os.environ.get('GITHUB_STEP_SUMMARY'):
            with Path(summary).open('a') as output:
                output.write(result + '\n')
    else:
        print(f'Validated store release {version}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, RuntimeError, OSError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
