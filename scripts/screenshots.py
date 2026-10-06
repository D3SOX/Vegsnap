#!/usr/bin/env python3
"""Capture real UI assets, render a review bundle, or apply a bundle with a signed commit."""
import argparse
from contextlib import contextmanager, ExitStack
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / 'artifacts/screenshots'
PACKAGE = 'app.veguide.screenshots'
KEYS = ('check', 'result', 'history', 'uncertain')


def run(args, cwd=ROOT, **kwargs):
    return subprocess.run([str(arg) for arg in args], cwd=cwd, check=True, **kwargs)


def read(args, cwd=ROOT):
    return run(args, cwd=cwd, capture_output=True, text=True).stdout.strip()


def expected_files():
    paths = set()
    for dark in (False, True):
        prefix = 'dark/' if dark else ''
        suffix = '-dark' if dark else ''
        for platform in ('android', 'extension'):
            for key in KEYS:
                paths.add(f'website/images/{prefix}screenshots/{platform}-{key}.png')
            for key in KEYS[:3]:
                formats = ('portrait', 'landscape') if platform == 'android' else ('',)
                for format in formats:
                    stem = key + (f'-{format}' if format else '')
                    paths.add(f'website/images/{prefix}store/{platform}/{stem}.png')
                    paths.add(f'marketing/sources/{platform}-{stem}{suffix}.svg')
        paths.add(f'website/images/{prefix}readme-preview.png')
        paths.add(f'marketing/sources/readme-preview{suffix}.svg')
    return paths


@contextmanager
def device_lock(serial, avd):
    if not re.fullmatch(r'emulator-\d+', serial):
        raise ValueError('Screenshot capture requires an emulator, never a physical device.')
    known = {'emulator-5556': 'api35', 'emulator-5558': 'api26'}
    name = known.get(serial, avd)
    if not name or not re.fullmatch(r'[\w-]+', name):
        raise ValueError('Pass --avd NAME for a nonbaseline emulator (and acquire its port lock).')
    # Same cooperative lock paths as the local Android lab; held throughout capture/restoration.
    locks = [f'/tmp/opentubex-android-{name}.lock']
    if serial not in known:
        locks.append(f'/tmp/opentubex-android-port-{serial.removeprefix("emulator-")}.lock')
    with ExitStack() as stack:
        for path in locks:
            handle = stack.enter_context(open(path, 'a'))
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise RuntimeError(f'Emulator is in use: {path}') from error
        yield


def capture_android(output, serial, avd):
    with device_lock(serial, avd):
        adb = ['adb', '-s', serial]
        if read(adb + ['shell', 'getprop', 'ro.build.version.sdk']) != '35':
            raise ValueError('Use API 35 for the screenshot environment.')
        if avd and read(adb + ['emu', 'avd', 'name']).splitlines()[0] != avd:
            raise ValueError('The requested serial belongs to a different AVD.')
        settings = [('system', 'font_scale', '1.0'), ('system', 'accelerometer_rotation', '0'),
                    ('system', 'user_rotation', '0'), ('global', 'sysui_demo_allowed', '1'),
                    ('global', 'window_animation_scale', '0'), ('global', 'transition_animation_scale', '0'),
                    ('global', 'animator_duration_scale', '0'),
                    ('secure', 'theme_customization_overlay_packages', json.dumps({
                        'android.theme.customization.system_palette': '355d40',
                        'android.theme.customization.accent_color': '355d40',
                        'android.theme.customization.color_source': 'preset'}))]
        originals = [(space, key, read(adb + ['shell', 'settings', 'get', space, key])) for space, key, _ in settings]
        size = read(adb + ['shell', 'wm', 'size'])
        density = read(adb + ['shell', 'wm', 'density'])
        night = read(adb + ['shell', 'cmd', 'uimode', 'night']).split(': ')[-1]
        timezone = read(adb + ['shell', 'getprop', 'persist.sys.timezone'])
        try:
            run([ROOT / 'android/gradlew', '-p', ROOT / 'android', '-PmarketingCapture',
                 'assembleDebug', 'assembleDebugAndroidTest', '-x', 'prepareOfflineSnapshot'])
            run(adb + ['install', '-r', ROOT / 'android/app/build/outputs/apk/debug/app-debug.apk'])
            run(adb + ['install', '-r', ROOT / 'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'])
            run(adb + ['shell', 'pm', 'clear', PACKAGE])
            for space, key, value in settings:
                # Shell arguments are quoted by adb's shell command transport only when explicitly escaped.
                import shlex
                run(adb + ['shell', 'settings', 'put', space, key, shlex.quote(value)])
            run(adb + ['shell', 'wm', 'size', '1080x2400'])
            run(adb + ['shell', 'wm', 'density', '420'])
            run(adb + ['shell', 'cmd', 'alarm', 'set-timezone', 'UTC'])
            for theme in ('light', 'dark'):
                run(adb + ['shell', 'cmd', 'uimode', 'night', 'yes' if theme == 'dark' else 'no'])
                for command, extras in [('clock', ['hhmm', '0941']), ('notifications', ['visible', 'false']),
                                        ('battery', ['level', '100', 'plugged', 'false']),
                                        ('network', ['wifi', 'show', 'level', '4', 'fully', 'true', 'mobile', 'hide']),
                                        ('status', ['rotate', 'hide', 'satellite', 'hide'])]:
                    arguments = ['-e', 'command', command]
                    for index in range(0, len(extras), 2):
                        arguments += ['-e', extras[index], extras[index + 1]]
                    run(adb + ['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo'] + arguments)
                result = read(adb + ['shell', 'am', 'instrument', '-w', '-r', '-e', 'class',
                                    'app.veguide.MarketingScreenshotTest', '-e', 'screenshotTheme', theme,
                                    PACKAGE + '.test/androidx.test.runner.AndroidJUnitRunner'])
                print(result)
                if 'OK (1 test)' not in result:
                    raise RuntimeError('Android capture failed; see instrumentation output above.')
                folder = output / 'website/images' / ('dark/screenshots' if theme == 'dark' else 'screenshots')
                folder.mkdir(parents=True, exist_ok=True)
                for key in KEYS:
                    with (folder / f'android-{key}.png').open('wb') as target:
                        run(adb + ['exec-out', 'run-as', PACKAGE, 'cat', f'files/marketing-screenshots/android-{key}.png'], stdout=target)
        finally:
            # Preserve the capture error if an emulator disconnect also prevents restoration.
            import shlex
            commands = [adb + ['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'exit']]
            for space, key, value in originals:
                operation = ['delete', space, key] if value == 'null' else ['put', space, key, shlex.quote(value)]
                commands.append(adb + ['shell', 'settings'] + operation)
            for command, previous in [('size', size), ('density', density)]:
                match = re.search(r'Override (?:size|density): (\S+)', previous)
                commands.append(adb + ['shell', 'wm', command, match[1] if match else 'reset'])
            commands += [adb + ['shell', 'cmd', 'uimode', 'night', night],
                         adb + ['shell', 'cmd', 'alarm', 'set-timezone', timezone]]
            error = sys.exception()
            for command in commands:
                try:
                    run(command)
                except subprocess.CalledProcessError:
                    message = 'Emulator disconnected; its settings could not be fully restored.'
                    if error:
                        print(message, file=sys.stderr)
                        break
                    raise RuntimeError(message)


def capture_source(root=ROOT):
    names = read(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], cwd=root).splitlines()
    prefixes = ('android/', 'extension/', 'packages/', 'data/', 'contracts/', 'scripts/screenshots')
    names = sorted(name for name in names if name.startswith(prefixes) or name in
                   ('package.json', 'bun.lock', 'scripts/render-marketing.py'))
    digest = hashlib.sha256()
    for name in names:
        path = root / name
        digest.update(name.encode() + b'\0')
        digest.update(path.read_bytes() if path.is_file() else b'<deleted>')
    return {'sourceCommit': read(['git', 'rev-parse', 'HEAD'], cwd=root), 'sourceFingerprint': digest.hexdigest()}


def render(output):
    from PIL import Image, ImageDraw
    source = capture_source()
    for platform in ('android', 'extension'):
        metadata = output / f'capture-{platform}.json'
        if not metadata.is_file() or json.loads(metadata.read_text()) != source:
            raise ValueError(f'{platform} captures are missing or from different source. Recapture before rendering.')
    for prefix in ('', 'dark/'):
        for platform in ('android', 'extension'):
            for key in KEYS:
                path = output / f'website/images/{prefix}screenshots/{platform}-{key}.png'
                with Image.open(path) as im:
                    expected = (1080, 2400) if platform == 'android' else (760, 880)
                    if im.size != expected:
                        raise ValueError(f'Wrong capture dimensions: {path}: {im.size}')
    run([sys.executable, ROOT / 'scripts/render-marketing.py', '--output-root', output])
    files = sorted(expected_files())
    for path in files:
        if path.endswith('.png'):
            with Image.open(output / path) as im:
                im.verify()
    # A compact review sheet of all original light/dark captures.
    sheet = Image.new('RGB', (1440, 900), '#183e2c')
    draw = ImageDraw.Draw(sheet)
    for index, path in enumerate(p for p in files if '/screenshots/' in p):
        x, y = (index % 8) * 180, (index // 8) * 450
        draw.text((x + 8, y + 8), ('Dark ' if '/dark/' in path else 'Light ') + Path(path).stem, fill='#c8dfa9')
        with Image.open(output / path) as im:
            im.thumbnail((164, 390))
            sheet.paste(im.convert('RGB'), (x + (180 - im.width) // 2, y + 36))
    sheet.save(output / 'contact-sheet.png')
    manifest = {**source,
                'sourceDirty': bool(read(['git', 'status', '--porcelain'])),
                'files': {path: hashlib.sha256((output / path).read_bytes()).hexdigest() for path in files}}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Review bundle: {output}\nContact sheet: {output / "contact-sheet.png"}')


def validate_bundle(bundle, root=ROOT):
    manifest = json.loads((bundle / 'manifest.json').read_text())
    if manifest['sourceCommit'] != read(['git', 'rev-parse', 'HEAD'], cwd=root):
        raise ValueError('Bundle was generated from another commit. Check out its source commit or regenerate it.')
    if manifest.get('sourceFingerprint') != capture_source(root)['sourceFingerprint']:
        raise ValueError('Capture source files changed since this bundle was generated. Regenerate it before applying.')
    if set(manifest['files']) != expected_files():
        raise ValueError('Bundle must contain exactly the expected screenshot and marketing files.')
    for path, expected in manifest['files'].items():
        source = bundle / path
        if source.is_symlink() or not source.is_file() or source.resolve() != bundle.resolve() / path:
            raise ValueError(f'Invalid bundle path: {path}')
        if hashlib.sha256(source.read_bytes()).hexdigest() != expected:
            raise ValueError(f'Bundle checksum mismatch: {path}')
    return manifest


def apply(bundle, commit=False, root=ROOT):
    manifest = validate_bundle(bundle, root)
    if read(['git', 'diff', '--cached', '--name-only'], cwd=root):
        raise ValueError('Unstage existing changes before applying; the signed commit must contain only these assets.')
    if read(['git', 'status', '--porcelain', '--', 'website/images', 'marketing/sources'], cwd=root):
        raise ValueError('Screenshot assets have local changes. Commit or stash them before applying.')
    for path in manifest['files']:
        target = root / path
        if target.resolve() != root.resolve() / path:
            raise ValueError(f'Asset destination is a symlink: {path}')
    changed = []
    for path in sorted(manifest['files']):
        source, target = bundle / path, root / path
        if target.is_file() and target.read_bytes() == source.read_bytes():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        changed.append(path)
    print(f'Applied {len(changed)} changed asset files.')
    if manifest.get('sourceDirty'):
        print('This bundle captured local uncommitted source changes; it does not represent a published release.')
    if commit and changed:
        run(['git', 'add', '--'] + changed, cwd=root)
        try:
            run(['git', 'commit', '-S', '-m', 'docs: refresh app screenshots'], cwd=root, timeout=60)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError('Signing timed out. Say continue to retry; the assets remain staged.') from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    capture = commands.add_parser('capture')
    capture.add_argument('--platform', choices=['all', 'android', 'extension'], default='all')
    capture.add_argument('--serial', default=os.environ.get('ANDROID_SERIAL', 'emulator-5556'))
    capture.add_argument('--avd')
    capture.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    rendering = commands.add_parser('render')
    rendering.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    applying = commands.add_parser('apply')
    source = applying.add_mutually_exclusive_group(required=True)
    source.add_argument('--bundle', type=Path)
    source.add_argument('--run', help='GitHub Actions run ID to download')
    applying.add_argument('--commit', action='store_true', help='Create a signed asset-only commit; never pushes')
    args = parser.parse_args()
    if args.command == 'capture':
        args.output = args.output.resolve()
        # A previous successful manifest must never survive a failed refresh.
        (args.output / 'manifest.json').unlink(missing_ok=True)
        source = capture_source()
        args.output.mkdir(parents=True, exist_ok=True)
        if args.platform in ('all', 'android'):
            (args.output / 'capture-android.json').unlink(missing_ok=True)
            capture_android(args.output, args.serial, args.avd)
            (args.output / 'capture-android.json').write_text(json.dumps(source))
        if args.platform in ('all', 'extension'):
            (args.output / 'capture-extension.json').unlink(missing_ok=True)
            run(['bun', 'x', 'wxt', 'build', '-b', 'chrome'], cwd=ROOT / 'extension')
            run(['bun', ROOT / 'scripts/screenshots/capture-extension.ts', args.output])
            (args.output / 'capture-extension.json').write_text(json.dumps(source))
        if args.platform == 'all':
            render(args.output)
    elif args.command == 'render':
        render(args.output.resolve())
    elif args.run:
        if not args.run.isdigit():
            raise ValueError('Run ID must be numeric.')
        with tempfile.TemporaryDirectory(prefix='veguide-screenshots-') as folder:
            run(['gh', 'run', 'download', args.run, '--name', 'veguide-screenshots', '--dir', folder])
            apply(Path(folder), args.commit)
    else:
        apply(args.bundle.resolve(), args.commit)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
