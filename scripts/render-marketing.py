#!/usr/bin/env python3
"""Render editable SVG layouts with genuine, unmodified app captures."""
from pathlib import Path
from html import escape
import argparse
import base64
import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = ROOT
ASSETS = OUTPUT_ROOT / "marketing"
IMAGES = ROOT / "website" / "images"
GREEN = "#183e2c"
CREAM = "#f8f5e9"
SAGE = "#c8dfa9"
SANS = "DejaVu Sans"
SERIF = "DejaVu Serif"


def text(x, y, value, size=24, color=CREAM, weight="normal", serif=False, italic=False):
    return (f'<text x="{x}" y="{y}" fill="{color}" font-family="{SERIF if serif else SANS}" '
            f'font-size="{size}" font-weight="{weight}" font-style="{"italic" if italic else "normal"}">{escape(value)}</text>')


def image(path, x, y, width, height, clip=""):
    # Embed the originals so each SVG is portable and CairoSVG can load them.
    original = (OUTPUT_ROOT if path.startswith("website/images/") else ROOT) / path
    mime = "image/svg+xml" if original.suffix == ".svg" else "image/png"
    encoded = base64.b64encode(original.read_bytes()).decode("ascii")
    return f'<image xlink:href="data:{mime};base64,{encoded}" x="{x}" y="{y}" width="{width}" height="{height}" {clip}/>'


def save(name, width, height, content, destination):
    source = ASSETS / "sources" / f"{name}.svg"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{width}" height="{height}" viewBox="0 0 {width} {height}">{content}</svg>\n')
    output = IMAGES / destination
    output.parent.mkdir(parents=True, exist_ok=True)
    cairosvg.svg2png(url=str(source), write_to=str(output))
    # Store exports use RGB PNG, with no alpha channel.
    with Image.open(output) as rendered:
        rendered.convert("RGB").save(output, optimize=True)


def background(width, height):
    return (f'<rect width="{width}" height="{height}" fill="{GREEN}"/>'
            f'<circle cx="{width * .98}" cy="{height * .25}" r="{height * .72}" fill="#24543b"/>'
            f'<circle cx="{width * .98}" cy="{height * .25}" r="{height * .9}" fill="none" stroke="{SAGE}" stroke-opacity=".12" stroke-width="2"/>'
            f'<path d="M0 {height * .92} Q{width * .45} {height * .64} {width} {height * .97}" fill="none" stroke="{SAGE}" stroke-opacity=".15" stroke-width="2"/>')


def brand(x, y, scale=1):
    return (image("website/logo.svg", x, y, 52*scale, 52*scale)
            + text(x+68*scale, y+37*scale, "Vegsnap", 30*scale, weight="bold"))


def phone(path, x, y, width):
    height = width * 2400 / 1080
    pad = width * .022
    radius = width * .08
    return (f'<defs><clipPath id="phone"><rect x="{x}" y="{y}" width="{width}" height="{height}" rx="{radius}"/></clipPath></defs>'
            f'<rect x="{x-16}" y="{y+12}" width="{width+32}" height="{height+24}" rx="{radius+16}" fill="#0c241b" opacity=".4"/>'
            f'<rect x="{x-pad}" y="{y-pad}" width="{width+2*pad}" height="{height+2*pad}" rx="{radius+pad}" fill="#17241f" stroke="#6a8275" stroke-width="2"/>'
            + image(path, x, y, width, height, 'clip-path="url(#phone)"'))


def browser(path, x, y, width, dark=False):
    chrome = "#283c2d" if dark else "#e5ebdf"
    paper = "#1b2a21" if dark else CREAM
    label = SAGE if dark else GREEN
    height = width * 880 / 760
    return (f'<defs><clipPath id="browser"><rect x="{x}" y="{y}" width="{width}" height="{height+32}" rx="14"/></clipPath></defs>'
            f'<rect x="{x-12}" y="{y+12}" width="{width+24}" height="{height+40}" rx="22" fill="#0c241b" opacity=".4"/>'
            f'<g clip-path="url(#browser)"><rect x="{x}" y="{y}" width="{width}" height="{height+32}" fill="{paper}"/>'
            f'<rect x="{x}" y="{y}" width="{width}" height="32" fill="{chrome}"/>'
            + ''.join(f'<circle cx="{x+18+i*13}" cy="{y+16}" r="3.5" fill="#789180"/>' for i in range(3))
            + text(x+width/2-32, y+21, "Vegsnap", 11, label)
            + image(path, x, y+32, width, height) + '</g>')


PANELS = [
    ("check", "CHECK A PRODUCT", "Check the label", "before you buy.",
     ["Add a photo, enter ingredients", "or scan a barcode to start a check."],
     "while you browse.", ["Select ingredients or a product image", "on a webpage to start a check."]),
    ("result", "INGREDIENT FINDINGS", "Read the result", "and the reasons.",
     ["See which ingredients were flagged", "and what still needs checking."],
     "and the reasons.", ["See what the ingredient list tells you", "and what still needs checking."]),
    ("history", "SAVED ON YOUR DEVICE", "Find a product", "you checked before.",
     ["Look up a previous check", "without entering the label again."],
     "you checked before.", ["Search your history and open a past result.", "Your checks stay on your device."]),
]


def render_panels(dark=False):
    prefix = "dark/" if dark else ""
    suffix = "-dark" if dark else ""
    for key, eyebrow, title, subtitle, body, extension_subtitle, extension_body in PANELS:
        # Android portrait: a full, undistorted screen beneath the feature copy.
        canvas = background(1080, 1920) + brand(76, 62, 1.2)
        canvas += text(76, 206, eyebrow, 20, SAGE, "bold")
        canvas += text(76, 300, title, 76, weight="bold")
        canvas += text(76, 392, subtitle, 72, SAGE, serif=True, italic=True)
        canvas += ''.join(text(76, 458+i*36, line, 25) for i, line in enumerate(body))
        canvas += phone(f"website/images/{prefix}screenshots/android-{key}.png", 247, 570, 586)
        save(f"android-{key}-portrait{suffix}", 1080, 1920, canvas, f"{prefix}store/android/{key}-portrait.png")

        # Landscape version puts the explanatory copy beside the phone.
        canvas = background(1920, 1080) + brand(104, 84, 1.4)
        canvas += text(104, 290, eyebrow, 23, SAGE, "bold")
        canvas += text(104, 430, title, 105, weight="bold")
        canvas += text(104, 556, subtitle, 98, SAGE, serif=True, italic=True)
        canvas += ''.join(text(108, 658+i*49, line, 32) for i, line in enumerate(body))
        canvas += text(108, 956, "ANDROID  /  PHOTOS · TEXT · BARCODES", 21, SAGE)
        canvas += phone(f"website/images/{prefix}screenshots/android-{key}.png", 1338, 50, 438)
        save(f"android-{key}-landscape{suffix}", 1920, 1080, canvas, f"{prefix}store/android/{key}-landscape.png")

        canvas = background(1280, 800) + brand(54, 48)
        canvas += text(54, 214, eyebrow, 15, SAGE, "bold")
        canvas += text(54, 312, title, 54, weight="bold")
        canvas += text(54, 388, extension_subtitle, 49, SAGE, serif=True, italic=True)
        canvas += ''.join(text(56, 473+i*32, line, 19) for i, line in enumerate(extension_body))
        canvas += text(56, 706, "CHROMIUM + FIREFOX", 16, SAGE, "bold")
        canvas += browser(f"website/images/{prefix}screenshots/extension-{key}.png", 610, 38, 620, dark)
        save(f"extension-{key}{suffix}", 1280, 800, canvas, f"{prefix}store/extension/{key}.png")


def render_header(dark=False):
    prefix = "dark/" if dark else ""
    suffix = "-dark" if dark else ""
    # A compact image of both real interfaces for the README introduction.
    canvas = background(1400, 760)
    canvas += browser(f"website/images/{prefix}screenshots/extension-result.png", 135, 37, 575, dark)
    canvas += phone(f"website/images/{prefix}screenshots/android-result.png", 878, 35, 310)
    save(f"readme-preview{suffix}", 1400, 760, canvas, f"{prefix}readme-preview.png")


def render_badges():
    icons = {
        "website": '<circle cx="30" cy="30" r="13"/><ellipse cx="30" cy="30" rx="6" ry="13"/><path d="M17 30h26M20 23h20M20 37h20"/>',
        "android": '<path d="M18 25h24v17H18zM18 25a12 10 0 0 1 24 0M22 14l-3-5m19 5 3-5M14 27v12m32-12v12M23 42v7m14-7v7"/><path d="M24 20h1m10 0h1"/>',
        "obtainium": '<path d="M18 27a13 13 0 0 1 22-7l4 4M44 16v8h-8M42 35a13 13 0 0 1-22 7l-4-4M16 46v-8h8"/>',
        "extension": '<rect x="15" y="17" width="30" height="27" rx="4"/><path d="M15 25h30M21 21h1m4 0h1M25 31l-5 5 5 5m10-10 5 5-5 5"/>',
    }
    for key, label, action in [("website", "Vegsnap", "Visit the website"), ("android", "ANDROID APK", "Download releases"), ("extension", "BROWSER EXTENSION", "Install from releases"), ("obtainium", "OBTAINIUM", "Add to Obtainium")]:
        canvas = f'<rect x="1" y="1" width="218" height="62" rx="12" fill="{GREEN}" stroke="#789180"/>'
        canvas += f'<g stroke="{SAGE}" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round">{icons[key]}</g>'
        canvas += text(59, 25, label, 10, SAGE, "bold") + text(59, 44, action, 13, weight="bold")
        source = ASSETS / "badges" / f"{key}.svg"
        source.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="220" height="64" viewBox="0 0 220 64">{canvas}</svg>\n')

    # Preserve the licensed artwork with colors visible in either appearance.
    for platform, filename in [("android", "android.svg"), ("chromium", "chrome.svg"), ("firefox", "firefox-browser.svg")]:
        icon = (ROOT / "website" / "icons" / filename).read_text()
        icon = icon.replace('<svg ', '<svg x="10" y="10" width="28" height="28" ', 1).replace('fill="currentColor"', f'fill="{SAGE}"')
        canvas = f'<rect width="48" height="48" rx="12" fill="{GREEN}"/>' + icon
        (ASSETS / "badges" / f"{platform}-icon.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">{canvas}</svg>\n')


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, default=ROOT)
    args = parser.parse_args()
    OUTPUT_ROOT = args.output_root.resolve()
    ASSETS = OUTPUT_ROOT / "marketing"
    IMAGES = OUTPUT_ROOT / "website" / "images"
    (ASSETS / "badges").mkdir(parents=True, exist_ok=True)
    for dark in (False, True):
        render_panels(dark)
        render_header(dark)
    render_badges()
    print("Rendered website images, editable marketing sources, and README badges.")
