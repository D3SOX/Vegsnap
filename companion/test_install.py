import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location("vegsnap_installer", Path(__file__).with_name("install.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.binary = self.root / "vegsnap-companion.exe"
        self.binary.write_text("test executable")
        self.binary.chmod(0o700)
        self.registry = MagicMock()
        self.registry.HKEY_CURRENT_USER = "HKCU"
        self.registry.KEY_SET_VALUE = 2
        self.registry.REG_SZ = 1

    def test_windows_registers_each_browser_for_current_user(self):
        expected = {
            "firefox": r"Software\Mozilla\NativeMessagingHosts\org.vegsnap.companion",
            "chrome": r"Software\Google\Chrome\NativeMessagingHosts\org.vegsnap.companion",
            "chromium": r"Software\Chromium\NativeMessagingHosts\org.vegsnap.companion",
            "brave": r"Software\Google\Chrome\NativeMessagingHosts\org.vegsnap.companion",
            "helium": r"Software\Google\Chrome\NativeMessagingHosts\org.vegsnap.companion",
            "vivaldi": r"Software\Google\Chrome\NativeMessagingHosts\org.vegsnap.companion",
            "edge": r"Software\Microsoft\Edge\NativeMessagingHosts\org.vegsnap.companion",
            "zen": r"Software\Mozilla\NativeMessagingHosts\org.vegsnap.companion",
            "librewolf": r"Software\Mozilla\NativeMessagingHosts\org.vegsnap.companion",
        }
        paths = []
        with patch.object(sys, "platform", "win32"), patch.object(Path, "home", side_effect=RuntimeError("Home is not required on Windows")), patch.dict(os.environ, {"LOCALAPPDATA": str(self.root)}), patch.dict(sys.modules, {"winreg": self.registry}):
            for browser, key in expected.items():
                firefox_family = browser in ("firefox", "zen", "librewolf")
                extension_id = "vegsnap@vegsnap.app" if firefox_family else "a" * 32
                path = installer.install(self.binary, browser, extension_id)
                paths.append(path)
                self.assertEqual(path.parent, self.root / "Vegsnap/NativeMessagingHosts" / browser)
                self.registry.CreateKeyEx.assert_called_with("HKCU", key, 0, 2)
                handle = self.registry.CreateKeyEx.return_value.__enter__.return_value
                self.registry.SetValueEx.assert_called_with(handle, "", 0, 1, str(path))
                data = json.loads(path.read_text())
                self.assertEqual(data["path"], str(self.binary))
                self.assertEqual("allowed_extensions" in data, firefox_family)
                if firefox_family:
                    self.assertEqual(data["allowed_extensions"], [extension_id])
                    self.assertNotIn("allowed_origins", data)
                else:
                    self.assertEqual(data["allowed_origins"], [f"chrome-extension://{extension_id}/"])
        self.assertEqual(len(set(paths)), 9)
        self.assertEqual(json.loads(paths[0].read_text())["allowed_extensions"], ["vegsnap@vegsnap.app"])

    def test_output_only_writes_requested_manifest_without_registration(self):
        output = self.root / "custom.json"
        with patch.object(sys, "platform", "win32"), patch.dict(sys.modules, {"winreg": self.registry}), patch.object(installer, "destination") as destination:
            self.assertEqual(installer.install(self.binary, "firefox", "vegsnap@vegsnap.app", output), output)
        self.registry.CreateKeyEx.assert_not_called()
        destination.assert_not_called()
        self.assertTrue(output.is_file())

    def test_bad_binary_and_extension_do_not_register(self):
        with patch.object(sys, "platform", "win32"), patch.dict(sys.modules, {"winreg": self.registry}):
            with self.assertRaises(ValueError):
                installer.install(self.root / "missing.exe", "firefox", "vegsnap@vegsnap.app")
            with self.assertRaises(ValueError):
                installer.install(self.binary, "chrome", "invalid")
            with patch.object(os, "access", return_value=False), self.assertRaises(ValueError):
                installer.install(self.binary, "firefox", "vegsnap@vegsnap.app")
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
            self.assertEqual(installer.destination("brave"), self.root / "config/BraveSoftware/Brave-Browser/NativeMessagingHosts")
            self.assertEqual(installer.destination("helium"), self.root / "config/net.imput.helium/NativeMessagingHosts")
            self.assertEqual(installer.destination("vivaldi"), self.root / "config/vivaldi/NativeMessagingHosts")
            self.assertEqual(installer.destination("edge"), self.root / "config/microsoft-edge/NativeMessagingHosts")
            self.assertEqual(installer.destination("zen"), self.root / ".mozilla/native-messaging-hosts")
            self.assertEqual(installer.destination("librewolf"), self.root / ".librewolf/native-messaging-hosts")

    def test_linux_defaults_to_home_config(self):
        with patch.object(sys, "platform", "linux"), patch.object(Path, "home", return_value=self.root), patch.dict(os.environ, {}, clear=True):
            self.assertEqual(installer.destination("brave"), self.root / ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts")
            self.assertEqual(installer.destination("helium"), self.root / ".config/net.imput.helium/NativeMessagingHosts")

    def test_macos_uses_browser_directories(self):
        with patch.object(sys, "platform", "darwin"), patch.object(Path, "home", return_value=self.root):
            support = self.root / "Library/Application Support"
            self.assertEqual(installer.destination("firefox"), support / "Mozilla/NativeMessagingHosts")
            self.assertEqual(installer.destination("chrome"), support / "Google/Chrome/NativeMessagingHosts")
            self.assertEqual(installer.destination("chromium"), support / "Chromium/NativeMessagingHosts")
            self.assertEqual(installer.destination("brave"), support / "Google/Chrome/NativeMessagingHosts")
            self.assertEqual(installer.destination("helium"), support / "net.imput.helium/NativeMessagingHosts")
            self.assertEqual(installer.destination("vivaldi"), support / "Vivaldi/NativeMessagingHosts")
            self.assertEqual(installer.destination("edge"), support / "Microsoft Edge/NativeMessagingHosts")
            self.assertEqual(installer.destination("zen"), support / "Mozilla/NativeMessagingHosts")
            self.assertEqual(installer.destination("librewolf"), support / "LibreWolf/NativeMessagingHosts")

    def test_cli_accepts_every_browser_with_the_correct_manifest_format(self):
        for browser in ["firefox", "chromium", "chrome", "brave", "helium", "vivaldi", "edge", "zen", "librewolf"]:
            with self.subTest(browser=browser):
                output = self.root / f"{browser}.json"
                firefox_family = browser in ("firefox", "zen", "librewolf")
                extension_id = "vegsnap@vegsnap.app" if firefox_family else "a" * 32
                result = subprocess.run([
                    sys.executable, str(Path(installer.__file__)),
                    "--binary", str(self.binary), "--browser", browser,
                    "--extension-id", extension_id, "--output", str(output),
                ], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                data = json.loads(output.read_text())
                if firefox_family:
                    self.assertEqual(data["allowed_extensions"], [extension_id])
                    self.assertNotIn("allowed_origins", data)
                else:
                    self.assertEqual(data["allowed_origins"], [f"chrome-extension://{extension_id}/"])


if __name__ == "__main__":
    unittest.main()
