#!/usr/bin/env python3
"""Register an already-built native host for the current user; never needs root."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
from typing import Optional

FIREFOX_BROWSERS = ("firefox", "zen", "librewolf")


def manifest(binary: Path, browser: str, extension_id: str) -> dict:
    if not binary.is_absolute() or not binary.is_file():
        raise ValueError("--binary must name an existing absolute executable path")
    if not os.access(binary, os.X_OK):
        raise ValueError("The native host must be executable")
    result = {
        "name": "org.vegsnap.companion",
        "description": "Vegsnap optional ChatGPT connection",
        "path": str(binary),
        "type": "stdio",
    }
    if browser in FIREFOX_BROWSERS:
        if not extension_id or any(c.isspace() for c in extension_id):
            raise ValueError("Provide the Firefox add-on ID")
        result["allowed_extensions"] = [extension_id]
    else:
        if not re.fullmatch(r"[a-p]{32}", extension_id):
            raise ValueError("Chromium extension IDs contain 32 letters from a to p")
        result["allowed_origins"] = [f"chrome-extension://{extension_id}/"]
    return result


def destination(browser: str) -> Path:
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA")
        if not local or not Path(local).is_absolute():
            raise ValueError("LOCALAPPDATA must name an absolute current-user directory")
        return Path(local) / "Vegsnap/NativeMessagingHosts" / browser
    home = Path.home()
    if sys.platform == "linux":
        if browser in ("firefox", "zen"):
            return home / ".mozilla/native-messaging-hosts"
        if browser == "librewolf":
            return home / ".librewolf/native-messaging-hosts"
        config = Path(os.environ.get("XDG_CONFIG_HOME", str(home / ".config")))
        directory = {
            "chromium": "chromium",
            "chrome": "google-chrome",
            "brave": "BraveSoftware/Brave-Browser",
            "helium": "net.imput.helium",
            "vivaldi": "vivaldi",
            "edge": "microsoft-edge",
        }[browser]
        return config / directory / "NativeMessagingHosts"
    if sys.platform == "darwin":
        support = home / "Library/Application Support"
        # Brave explicitly looks in Chrome's directory on macOS.
        directory = {
            "firefox": "Mozilla",
            "chromium": "Chromium",
            "chrome": "Google/Chrome",
            "brave": "Google/Chrome",
            "helium": "net.imput.helium",
            "vivaldi": "Vivaldi",
            "edge": "Microsoft Edge",
            "zen": "Mozilla",
            "librewolf": "LibreWolf",
        }[browser]
        return support / directory / "NativeMessagingHosts"
    raise ValueError(f"Unsupported operating system: {sys.platform}")


def register_windows(browser: str, path: Path) -> None:
    import winreg

    # Brave, Helium and Vivaldi retain Chromium's Chrome registry fallback.
    key = {
        "firefox": r"Software\Mozilla\NativeMessagingHosts",
        "chrome": r"Software\Google\Chrome\NativeMessagingHosts",
        "chromium": r"Software\Chromium\NativeMessagingHosts",
        "brave": r"Software\Google\Chrome\NativeMessagingHosts",
        "helium": r"Software\Google\Chrome\NativeMessagingHosts",
        "vivaldi": r"Software\Google\Chrome\NativeMessagingHosts",
        "edge": r"Software\Microsoft\Edge\NativeMessagingHosts",
        "zen": r"Software\Mozilla\NativeMessagingHosts",
        "librewolf": r"Software\Mozilla\NativeMessagingHosts",
    }[browser] + r"\org.vegsnap.companion"
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_SET_VALUE) as registry:
        winreg.SetValueEx(registry, "", 0, winreg.REG_SZ, str(path))


def install(binary: Path, browser: str, extension_id: str, output: Optional[Path] = None) -> Path:
    data = manifest(binary, browser, extension_id)
    path = output or destination(browser) / "org.vegsnap.companion.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    if sys.platform == "win32" and output is None:
        register_windows(browser, path)
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--browser", choices=["firefox", "chromium", "chrome", "brave", "helium", "vivaldi", "edge", "zen", "librewolf"], required=True)
    parser.add_argument("--extension-id", required=True)
    parser.add_argument("--output", type=Path, help="Write the manifest here instead of registering it")
    args = parser.parse_args()
    try:
        path = install(args.binary, args.browser, args.extension_id, args.output)
        print(f"Wrote {path}")
    except (ValueError, OSError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
