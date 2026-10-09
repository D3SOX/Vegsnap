"""Store release integrity and API state transitions, without live submissions."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


publisher = module('publisher', 'publish-extension-stores.py')
packager = module('packager', 'prepare-extension-stores.py')
LISTING = json.loads((publisher.ROOT / 'extension/store-listing.json').read_text())


def revision(version, state):
    return {'state': state, 'distributionChannels': [{'crxVersion': version}]}


class FakeAPI:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, *args):
        self.calls.append(args)
        if not self.responses:
            raise AssertionError('Unexpected store API mutation')
        return self.responses.pop(0)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.chrome_manifest = {'version': '0.2.9'}
        self.firefox_manifest = {'version': '0.2.9', 'browser_specific_settings': {'gecko': {'id': 'vegsnap@vegsnap.app'}}}
        self.write_archive('vegsnap-chrome-store.zip', {'manifest.json': json.dumps(self.chrome_manifest)})
        self.write_archive('vegsnap-firefox.xpi', {'manifest.json': json.dumps(self.firefox_manifest)})
        self.write_archive('vegsnap-firefox-source.zip', {
            'extension/package.json': '{"version":"0.2.9"}', 'AMO-README.txt': 'Build instructions',
            'bun.lock': 'locked', 'data/offline/bundle.json': '{}',
        })
        (self.directory / 'store-listing.json').write_text(json.dumps(LISTING))
        self.checksums()

    def write_archive(self, name, contents):
        with zipfile.ZipFile(self.directory / name, 'w') as archive:
            for path, data in contents.items():
                archive.writestr(path, data)

    def checksums(self):
        metadata = {'version': '0.2.9', 'chromium_store_id': LISTING['chromium_store_id'], 'firefox_id': 'vegsnap@vegsnap.app',
                    'files': {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in self.directory.iterdir() if path.name != 'submission.json'}}
        (self.directory / 'submission.json').write_text(json.dumps(metadata))

    def submit(self, api):
        return publisher.publish_chrome(api, self.directory, '0.2.9', LISTING, sleep=lambda _: None)

    def test_validates_exact_release_assets(self):
        self.assertEqual(publisher.validate(self.directory, 'v0.2.9'), ('0.2.9', LISTING))

    def test_rejects_tag_mismatch_and_prereleases(self):
        for tag in ('v0.2.8', 'v0.2.9-beta.1', 'offline-data', '0.2.9'):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                publisher.validate(self.directory, tag)

    def test_rejects_modified_package_before_network_access(self):
        with (self.directory / 'vegsnap-chrome-store.zip').open('ab') as package:
            package.write(b'modified')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            publisher.validate(self.directory, 'v0.2.9')

    def test_rejects_keyed_chrome_package(self):
        self.chrome_manifest['key'] = 'sideload-public-key'
        self.write_archive('vegsnap-chrome-store.zip', {'manifest.json': json.dumps(self.chrome_manifest)})
        self.checksums()
        with self.assertRaisesRegex(ValueError, 'sideload key'):
            publisher.validate(self.directory, 'v0.2.9')

    def test_rejects_different_firefox_identity(self):
        self.firefox_manifest['browser_specific_settings']['gecko']['id'] = 'another-addon@example.com'
        self.write_archive('vegsnap-firefox.xpi', {'manifest.json': json.dumps(self.firefox_manifest)})
        self.checksums()
        with self.assertRaisesRegex(ValueError, 'add-on ID'):
            publisher.validate(self.directory, 'v0.2.9')

    def test_rejects_sources_from_another_version(self):
        self.write_archive('vegsnap-firefox-source.zip', {'extension/package.json': '{"version":"0.2.8"}'})
        self.checksums()
        with self.assertRaisesRegex(ValueError, 'sources must match'):
            publisher.validate(self.directory, 'v0.2.9')

    def test_uploads_binary_and_requests_review_with_auto_publication(self):
        api = FakeAPI({}, {'uploadState': 'SUCCEEDED', 'crxVersion': '0.2.9'}, {'state': 'PENDING_REVIEW'})
        self.assertEqual(self.submit(api), 'PENDING_REVIEW')
        self.assertIn('/upload/v2/publishers/', api.calls[1][0])
        self.assertEqual(api.calls[1][1], (self.directory / 'vegsnap-chrome-store.zip').read_bytes())
        self.assertEqual(api.calls[1][2], 'application/zip')
        self.assertEqual(json.loads(api.calls[2][1]), {'publishType': 'DEFAULT_PUBLISH', 'skipReview': False})

    def test_polls_the_actual_v2_async_upload_states(self):
        api = FakeAPI({}, {'uploadState': 'IN_PROGRESS'}, {'lastAsyncUploadState': 'IN_PROGRESS'}, {'lastAsyncUploadState': 'SUCCEEDED'}, {'state': 'PENDING_REVIEW'})
        self.assertEqual(self.submit(api), 'PENDING_REVIEW')
        self.assertTrue(api.calls[2][0].endswith(':fetchStatus'))

    def test_failed_or_timed_out_upload_is_never_published(self):
        for upload in ('FAILED', 'NOT_FOUND', 'UNKNOWN'):
            with self.subTest(upload=upload), self.assertRaisesRegex(ValueError, 'upload did not succeed'):
                self.submit(FakeAPI({}, {'uploadState': upload}))
        api = FakeAPI({}, {'uploadState': 'IN_PROGRESS'}, *[{'lastAsyncUploadState': 'IN_PROGRESS'}] * 60)
        with self.assertRaisesRegex(ValueError, 'IN_PROGRESS'):
            self.submit(api)
        self.assertFalse(any(call[0].endswith(':publish') for call in api.calls))

    def test_retries_pending_or_published_versions_without_mutations(self):
        for field, state in (('submittedItemRevisionStatus', 'PENDING_REVIEW'), ('publishedItemRevisionStatus', 'PUBLISHED')):
            api = FakeAPI({field: revision('0.2.9', state)})
            self.assertTrue(self.submit(api).startswith('Already'))
            self.assertEqual(len(api.calls), 1)

    def test_replaces_an_older_pending_version_after_canceling_review(self):
        submitted = revision('0.2.8', 'PENDING_REVIEW')
        submitted['distributionChannels'].append({'crxVersion': '0.2.8'})
        api = FakeAPI({'submittedItemRevisionStatus': submitted}, {},
                      {'uploadState': 'SUCCEEDED', 'crxVersion': '0.2.9'}, {'state': 'PENDING_REVIEW'})
        self.assertEqual(self.submit(api), 'Canceled pending review for 0.2.8; PENDING_REVIEW')
        self.assertEqual(api.calls[1], (f"{publisher.API}/v2/publishers/{LISTING['chromium_publisher_id']}/items/{LISTING['chromium_store_id']}:cancelSubmission", b''))
        self.assertIn('/upload/v2/publishers/', api.calls[2][0])
        self.assertEqual(api.calls[2][1], (self.directory / 'vegsnap-chrome-store.zip').read_bytes())
        self.assertEqual(json.loads(api.calls[3][1]), {'publishType': 'DEFAULT_PUBLISH', 'skipReview': False})

    def test_failed_cancellation_stops_before_uploading(self):
        api = FakeAPI()
        with patch.object(api, 'request', side_effect=[
                {'submittedItemRevisionStatus': revision('0.2.8', 'PENDING_REVIEW')},
                RuntimeError('Store API HTTP 429: cancellation limit reached'),
        ]) as request:
            with self.assertRaisesRegex(RuntimeError, 'cancellation limit'):
                self.submit(api)
        self.assertEqual(request.call_count, 2)
        self.assertTrue(request.call_args.args[0].endswith(':cancelSubmission'))

    def test_records_replaced_chrome_submission_in_workflow_summary(self):
        api = FakeAPI({'submittedItemRevisionStatus': revision('0.2.8', 'PENDING_REVIEW')}, {},
                      {'uploadState': 'SUCCEEDED', 'crxVersion': '0.2.9'}, {'state': 'PENDING_REVIEW'})
        summary = self.directory / 'summary.md'
        summary.write_text('Previous step\n')
        with patch.object(publisher, 'ChromeAPI', return_value=api), \
                patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': str(summary)}), \
                patch('sys.argv', ['publish-extension-stores.py', 'chrome', '--tag', 'v0.2.9', '--directory', str(self.directory)]):
            publisher.main()
        self.assertEqual(summary.read_text(), 'Previous step\nChrome 0.2.9: Canceled pending review for 0.2.8; PENDING_REVIEW\n')
        self.assertEqual(len(api.calls), 4)

    def test_does_not_overwrite_a_newer_pending_or_different_staged_version(self):
        for version, state in (('0.3.0', 'PENDING_REVIEW'), ('0.2.10', 'PENDING_REVIEW'), ('0.2.8', 'STAGED')):
            api = FakeAPI({'submittedItemRevisionStatus': revision(version, state)})
            with self.subTest(version=version, state=state), self.assertRaisesRegex(ValueError, 'Another Chrome version'):
                self.submit(api)
            self.assertEqual(len(api.calls), 1)

    def test_accepts_matching_versions_across_multiple_distribution_channels(self):
        for state in ('PENDING_REVIEW', 'STAGED'):
            submitted = revision('0.2.9', state)
            submitted['distributionChannels'].append({'crxVersion': '0.2.9'})
            api = FakeAPI({'submittedItemRevisionStatus': submitted}, {'state': 'PUBLISHED'})
            result = self.submit(api)
            self.assertEqual(result, 'Already pending review' if state == 'PENDING_REVIEW' else 'PUBLISHED')

    def test_rejects_empty_or_mixed_versions_in_pending_distribution_channels(self):
        for channels in ([], [{'crxVersion': '0.2.9'}, {'crxVersion': '0.3.0'}]):
            with self.subTest(channels=channels), self.assertRaisesRegex(ValueError, 'Another Chrome version'):
                self.submit(FakeAPI({'submittedItemRevisionStatus': {'state': 'PENDING_REVIEW', 'distributionChannels': channels}}))

    def test_prevents_downgrade_and_rejected_version_resubmission(self):
        for field, version, state in (('publishedItemRevisionStatus', '0.3.0', 'PUBLISHED'), ('submittedItemRevisionStatus', '0.2.9', 'REJECTED')):
            with self.subTest(state=state), self.assertRaises(ValueError):
                self.submit(FakeAPI({field: revision(version, state)}))

    def test_publishes_approved_staged_version_without_reuploading(self):
        api = FakeAPI({'submittedItemRevisionStatus': revision('0.2.9', 'STAGED')}, {'state': 'PUBLISHED'})
        self.assertEqual(self.submit(api), 'PUBLISHED')
        self.assertEqual(json.loads(api.calls[1][1])['publishType'], 'STAGED_PUBLISH')

    def test_policy_notices_and_failed_publish_are_reported(self):
        with self.assertRaisesRegex(ValueError, 'policy notice'):
            self.submit(FakeAPI({'takenDown': True}))
        with self.assertRaisesRegex(ValueError, 'REJECTED'):
            self.submit(FakeAPI({}, {'uploadState': 'SUCCEEDED', 'crxVersion': '0.2.9'}, {'state': 'REJECTED'}))

    def test_cancellation_posts_empty_body_and_accepts_empty_response(self):
        api = publisher.ChromeAPI.__new__(publisher.ChromeAPI)
        api.token = 'test-token'
        api.secrets = [api.token]
        for body in (b'', b'{}'):
            with self.subTest(body=body), patch.object(publisher.urllib.request, 'urlopen') as urlopen:
                urlopen.return_value.__enter__.return_value = io.BytesIO(body)
                self.assertEqual(api.request(f'{publisher.API}/v2/publishers/test/items/test:cancelSubmission', b''), {})
            request = urlopen.call_args.args[0]
            self.assertEqual(request.get_method(), 'POST')
            self.assertEqual(request.data, b'')
            self.assertEqual(request.get_header('Authorization'), 'Bearer test-token')

    def test_missing_credentials_and_error_redaction(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(ValueError, 'CHROME_CLIENT_ID'):
            publisher.ChromeAPI()
        secrets = {'CHROME_CLIENT_ID': 'private-id', 'CHROME_CLIENT_SECRET': 'private-secret', 'CHROME_REFRESH_TOKEN': 'private-refresh'}
        error = urllib.error.HTTPError('https://oauth2.googleapis.com/token', 400, 'Bad request', {}, io.BytesIO(b'{"error":"private-refresh private-secret private-id"}'))
        with patch.dict(os.environ, secrets), patch.object(publisher.urllib.request, 'urlopen', side_effect=error):
            with self.assertRaises(RuntimeError) as caught:
                publisher.ChromeAPI()
        self.assertNotIn('private-', str(caught.exception))
        self.assertIn('HTTP 400', str(caught.exception))


class PackagingTests(unittest.TestCase):
    def test_ci_packages_preserve_build_bytes_and_exact_offline_source_without_graphics(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            chrome = root / 'extension/.output/chrome-mv3'
            firefox = root / 'extension/.output/firefox-mv3'
            for folder in (chrome, firefox):
                folder.mkdir(parents=True)
                (folder / 'background.js').write_bytes(b'exact build bytes')
            (chrome / 'manifest.json').write_text(json.dumps({'version': '0.2.9', 'key': 'sideload-key'}))
            (firefox / 'manifest.json').write_text(json.dumps({'version': '0.2.9', 'browser_specific_settings': {'gecko': {'id': 'vegsnap@vegsnap.app'}}}))
            source = {'extension/package.json': '{"version":"0.2.9"}', 'extension/store-listing.json': json.dumps(LISTING),
                      'bun.lock': 'locked dependencies', 'data/offline/bundle.json': '{"exact":"snapshot"}'}
            for path, contents in source.items():
                destination = root / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text(contents)

            def command(args, **kwargs):
                if args[0] == 'git':
                    return ('\0'.join(source) + '\0').encode()
                return 'v24.21.0\n' if args[0] == 'node' else '1.4.1\n'

            with patch.object(packager, 'ROOT', root), patch.object(packager.subprocess, 'check_output', side_effect=command), \
                    patch.object(packager, 'prepare_graphics', side_effect=AssertionError('Graphics must not run in CI')), \
                    patch('sys.argv', ['prepare-extension-stores.py', '--packages-only', '--output', str(root / 'output')]):
                packager.main()
            output = root / 'output/v0.2.9'
            publisher.validate(output, 'v0.2.9')
            with zipfile.ZipFile(output / 'vegsnap-chrome-store.zip') as archive:
                self.assertNotIn('key', json.loads(archive.read('manifest.json')))
                self.assertEqual(archive.read('background.js'), b'exact build bytes')
            with zipfile.ZipFile(output / 'vegsnap-firefox.xpi') as archive:
                self.assertEqual(archive.read('manifest.json'), (firefox / 'manifest.json').read_bytes())
            with zipfile.ZipFile(output / 'vegsnap-firefox-source.zip') as archive:
                self.assertEqual(archive.read('data/offline/bundle.json'), source['data/offline/bundle.json'].encode())
                self.assertNotIn('extension/.output', '\n'.join(archive.namelist()))
                self.assertIn('Node.js v24.21.0', archive.read('AMO-README.txt').decode())
                self.assertIn('Install Bun 1.4.1', archive.read('AMO-README.txt').decode())
                self.assertIn('/bun-v1.4.1', archive.read('AMO-README.txt').decode())
            self.assertEqual((chrome / 'manifest.json').read_text(), json.dumps({'version': '0.2.9', 'key': 'sideload-key'}))


if __name__ == '__main__':
    unittest.main()
