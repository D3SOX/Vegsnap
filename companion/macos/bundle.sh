#!/bin/sh
# Wraps the companion in an app bundle, so Finder opens its setup window.
# AppIcon.icns is extension/public/icons/vegsnap.svg on the macOS icon grid.
# Usage: bundle.sh EXECUTABLE OUTPUT_DIRECTORY
set -eu
here=$(cd "$(dirname "$0")" && pwd)
version=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$here/../Cargo.toml" | head -n 1)
app="$2/Vegsnap Companion.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$1" "$app/Contents/MacOS/vegsnap-companion"
cp "$here/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>vegsnap-companion</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>org.vegsnap.companion</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Vegsnap Companion</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$version</string>
  <key>CFBundleVersion</key>
  <string>${version%%-*}</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$app"
codesign --verify --strict "$app"
