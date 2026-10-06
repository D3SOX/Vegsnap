import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location("veguide_installer", Path(__file__).with_name("install.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.binary = self.root / "veguide-companion.exe"
        self.binary.write_text("test executable")
        self.binary.chmod(0o700)
        self.registry = MagicMock()
        self.registry.HKEY_CURRENT_USER = "HKCU"
        self.registry.KEY_SET_VALUE = 2
        self.registry.REG_SZ = 1

    def test_windows_registers_each_browser_for_current_user(self):
        expected = {
            "firefox": r"Software\Mozilla\NativeMessagingHosts\org.veguide.companion",
            "chrome": r"Software\Google\Chrome\NativeMessagingHosts\org.veguide.companion",
            "chromium": r"Software\Chromium\NativeMessagingHosts\org.veguide.companion",
        }
        paths = []
        with patch.object(sys, "platform", "win32"), patch.dict(os.environ, {"LOCALAPPDATA": str(self.root)}), patch.dict(sys.modules, {"winreg": self.registry}):
            for browser, key in expected.items():
                extension_id = "veguide@veguide.app" if browser == "firefox" else "a" * 32
                path = installer.install(self.binary, browser, extension_id)
                paths.append(path)
                self.assertEqual(path.parent, self.root / "Veguide/NativeMessagingHosts" / browser)
                self.registry.CreateKeyEx.assert_called_with("HKCU", key, 0, 2)
                handle = self.registry.CreateKeyEx.return_value.__enter__.return_value
                self.registry.SetValueEx.assert_called_with(handle, "", 0, 1, str(path))
                data = json.loads(path.read_text())
                self.assertEqual(data["path"], str(self.binary))
                self.assertEqual("allowed_extensions" in data, browser == "firefox")
                self.assertEqual("allowed_origins" in data, browser != "firefox")
        self.assertEqual(len(set(paths)), 3)
        self.assertEqual(json.loads(paths[0].read_text())["allowed_extensions"], ["veguide@veguide.app"])

    def test_output_only_writes_requested_manifest_without_registration(self):
        output = self.root / "custom.json"
        with patch.object(sys, "platform", "win32"), patch.dict(sys.modules, {"winreg": self.registry}), patch.object(installer, "destination") as destination:
            self.assertEqual(installer.install(self.binary, "firefox", "veguide@veguide.app", output), output)
        self.registry.CreateKeyEx.assert_not_called()
        destination.assert_not_called()
        self.assertTrue(output.is_file())

    def test_bad_binary_and_extension_do_not_register(self):
        with patch.object(sys, "platform", "win32"), patch.dict(sys.modules, {"winreg": self.registry}):
            with self.assertRaises(ValueError):
                installer.install(self.root / "missing.exe", "firefox", "veguide@veguide.app")
            with self.assertRaises(ValueError):
                installer.install(self.binary, "chrome", "invalid")
            with patch.object(os, "access", return_value=False), self.assertRaises(ValueError):
                installer.install(self.binary, "firefox", "veguide@veguide.app")
        self.registry.CreateKeyEx.assert_not_called()

    def test_missing_windows_user_directory_is_reported(self):
        with patch.object(sys, "platform", "win32"), patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "LOCALAPPDATA"):
                installer.destination("firefox")

    def test_linux_uses_browser_directories_and_xdg_config(self):
        with patch.object(sys, "platform", "linux"), patch.object(Path, "home", return_value=self.root), patch.dict(os.environ, {"XDG_CONFIG_HOME": str(self.root / "config")}):
            self.assertEqual(installer.destination("firefox"), self.root / ".mozilla/native-messaging-hosts")
            self.assertEqual(installer.destination("chrome"), self.root / "config/google-chrome/NativeMessagingHosts")
            self.assertEqual(installer.destination("chromium"), self.root / "config/chromium/NativeMessagingHosts")

    def test_macos_uses_browser_directories(self):
        with patch.object(sys, "platform", "darwin"), patch.object(Path, "home", return_value=self.root):
            support = self.root / "Library/Application Support"
            self.assertEqual(installer.destination("firefox"), support / "Mozilla/NativeMessagingHosts")
            self.assertEqual(installer.destination("chrome"), support / "Google/Chrome/NativeMessagingHosts")
            self.assertEqual(installer.destination("chromium"), support / "Chromium/NativeMessagingHosts")


if __name__ == "__main__":
    unittest.main()
