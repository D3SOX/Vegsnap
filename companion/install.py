#!/usr/bin/env python3
"""Register an already-built native host for the current user; never needs root."""
import argparse
import json
import os
from pathlib import Path
import re
import sys


def manifest(binary: Path, browser: str, extension_id: str) -> dict:
    if not binary.is_absolute() or not binary.is_file():
        raise ValueError("--binary must name an existing absolute executable path")
    if not os.access(binary, os.X_OK):
        raise ValueError("The native host must be executable")
    result = {
        "name": "org.veguide.companion",
        "description": "Veguide optional ChatGPT connection",
        "path": str(binary),
        "type": "stdio",
    }
    if browser == "firefox":
        if not extension_id or any(c.isspace() for c in extension_id):
            raise ValueError("Provide the Firefox add-on ID")
        result["allowed_extensions"] = [extension_id]
    else:
        if not re.fullmatch(r"[a-p]{32}", extension_id):
            raise ValueError("Chromium extension IDs contain 32 letters from a to p")
        result["allowed_origins"] = [f"chrome-extension://{extension_id}/"]
    return result


def destination(browser: str) -> Path:
    home = Path.home()
    if sys.platform == "linux":
        if browser == "firefox":
            return home / ".mozilla/native-messaging-hosts"
        config = Path(os.environ.get("XDG_CONFIG_HOME", str(home / ".config")))
        return config / ("chromium" if browser == "chromium" else "google-chrome") / "NativeMessagingHosts"
    if sys.platform == "darwin":
        support = home / "Library/Application Support"
        return support / {"firefox": "Mozilla/NativeMessagingHosts", "chromium": "Chromium/NativeMessagingHosts", "chrome": "Google/Chrome/NativeMessagingHosts"}[browser]
    raise ValueError("On Windows use --output and register that manifest path as described in the repository README")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--browser", choices=["firefox", "chromium", "chrome"], required=True)
    parser.add_argument("--extension-id", required=True)
    parser.add_argument("--output", type=Path, help="Write the manifest here instead of registering it")
    args = parser.parse_args()
    try:
        data = manifest(args.binary, args.browser, args.extension_id)
        path = args.output or destination(args.browser) / "org.veguide.companion.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2) + "\n")
        print(f"Wrote {path}")
    except (ValueError, OSError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
