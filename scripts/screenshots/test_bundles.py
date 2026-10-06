"""Exercise bundle integrity and the asset-only signed apply operation."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('screenshots', Path(__file__).parents[1] / 'screenshots.py')
screenshots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screenshots)
COMMIT = 'a' * 40


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'repository'
        self.root.mkdir()
        self.bundle = Path(self.temp.name) / 'bundle'
        self.bundle.mkdir()
        files = {}
        for path in screenshots.expected_files():
            target = self.bundle / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(path.encode())
            files[path] = hashlib.sha256(target.read_bytes()).hexdigest()
        self.manifest = {'sourceCommit': COMMIT, 'sourceDirty': False, 'sourceFingerprint': hashlib.sha256().hexdigest(), 'files': files}
        self.write_manifest()
        self.git = patch.object(screenshots, 'read', side_effect=self.read_git)
        self.git.start()
        self.addCleanup(self.git.stop)

    def read_git(self, args, cwd=None):
        if args == ['git', 'rev-parse', 'HEAD']:
            return COMMIT
        return ''

    def write_manifest(self):
        (self.bundle / 'manifest.json').write_text(json.dumps(self.manifest))

    def test_apply_preserves_unrelated_files_and_signs_only_asset_commit(self):
        unrelated = self.root / 'application.ts'
        unrelated.write_text('uncommitted work')
        with patch.object(screenshots, 'run') as git:
            screenshots.apply(self.bundle, commit=True, root=self.root)
        self.assertEqual(unrelated.read_text(), 'uncommitted work')
        commands = [call.args[0] for call in git.call_args_list]
        self.assertEqual(set(commands[0][3:]), screenshots.expected_files())
        self.assertEqual(commands[0][:3], ['git', 'add', '--'])
        self.assertEqual(commands[1][:3], ['git', 'commit', '-S'])
        self.assertFalse(any('push' in command for command in commands))

    def test_tampered_file_rejected_before_any_assets_are_written(self):
        path = next(iter(self.manifest['files']))
        (self.bundle / path).write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            screenshots.apply(self.bundle, root=self.root)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_wrong_revision_rejected(self):
        self.manifest['sourceCommit'] = 'b' * 40
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'another commit'):
            screenshots.validate_bundle(self.bundle, self.root)

    def test_changed_source_rejected(self):
        self.manifest['sourceFingerprint'] = 'outdated'
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'source files changed'):
            screenshots.validate_bundle(self.bundle, self.root)

    def test_physical_device_rejected_before_any_commands(self):
        with self.assertRaisesRegex(ValueError, 'never a physical device'):
            with screenshots.device_lock('personal-phone', None):
                self.fail('Physical device was accepted')

    def test_unexpected_path_rejected(self):
        self.manifest['files']['../../application.ts'] = 'bad'
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'exactly the expected'):
            screenshots.validate_bundle(self.bundle, self.root)

    def test_staged_work_rejected(self):
        with patch.object(screenshots, 'read', side_effect=lambda args, cwd=None: COMMIT if 'rev-parse' in args else 'unrelated.ts'):
            with self.assertRaisesRegex(ValueError, 'Unstage existing'):
                screenshots.apply(self.bundle, commit=True, root=self.root)

    def test_symlink_destination_rejected_before_copying(self):
        elsewhere = Path(self.temp.name) / 'elsewhere'
        elsewhere.mkdir()
        (self.root / 'website').symlink_to(elsewhere, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'destination is a symlink'):
            screenshots.apply(self.bundle, root=self.root)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_missing_file_rejected(self):
        (self.bundle / next(iter(self.manifest['files']))).unlink()
        with self.assertRaisesRegex(ValueError, 'Invalid bundle path'):
            screenshots.validate_bundle(self.bundle, self.root)


if __name__ == '__main__':
    unittest.main()
