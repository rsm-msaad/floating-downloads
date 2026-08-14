#!/usr/bin/env python3
"""Render the SVG sources to the PNG and .icns assets.

    python3 build-icon.py

Rasterises with sips (built into macOS, no extra dependency) and builds the
.icns with iconutil (also built in).

Tray icons are normalised to macOS template form: every pixel forced to pure
black, with the shape carried entirely by the alpha channel, so macOS can
invert them for light and dark menu bars. The drag icon and the app icon are
NOT templates — a drag image and a Dock icon are drawn as-is — so their
colour is left alone.

Requires: macOS (sips, iconutil) and Pillow.
"""

import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).parent

# (source svg, output png, pixel size, force to template form)
JOBS = [
    ("icon.svg", "trayTemplate.png", 16, True),
    ("icon.svg", "trayTemplate@2x.png", 32, True),
    ("drag-icon.svg", "dragIcon.png", 64, False),
]

# The sizes macOS expects inside an .iconset. Each logical size needs both a
# 1x and a 2x rendering, and iconutil requires these exact filenames.
ICONSET = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]


def render(svg: Path, out: Path, size: int) -> None:
    subprocess.run(
        ["sips", "-s", "format", "png",
         "--resampleHeightWidth", str(size), str(size),
         str(svg), "--out", str(out)],
        check=True, capture_output=True,
    )


def to_template(path: Path) -> None:
    """Force RGB to pure black, keep alpha as the shape."""
    img = Image.open(path).convert("RGBA")
    black = Image.new("RGBA", img.size, (0, 0, 0, 0))
    black.putalpha(img.getchannel("A"))
    black.save(path, "PNG")


def build_icns() -> bool:
    svg = ROOT / "app-icon.svg"
    if not svg.exists():
        print(f"error: {svg} not found", file=sys.stderr)
        return False

    iconset = ROOT / "FloatingDownloads.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()

    for name, size in ICONSET:
        render(svg, iconset / name, size)

    subprocess.run(
        ["iconutil", "--convert", "icns", "--output", str(ROOT / "icon.icns"), str(iconset)],
        check=True, capture_output=True,
    )
    # The .iconset is scaffolding for iconutil; the .icns is the artifact.
    shutil.rmtree(iconset)
    print(f"wrote icon.icns ({len(ICONSET)} sizes, 16 through 1024)")
    return True


def main() -> int:
    for svg_name, out_name, size, template in JOBS:
        svg = ROOT / svg_name
        if not svg.exists():
            print(f"error: {svg} not found", file=sys.stderr)
            return 1
        out = ROOT / out_name
        render(svg, out, size)
        if template:
            to_template(out)
        kind = "template" if template else "colour"
        print(f"wrote {out_name} ({size}x{size}, {kind})")

    return 0 if build_icns() else 1


if __name__ == "__main__":
    sys.exit(main())
