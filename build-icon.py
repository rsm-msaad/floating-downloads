#!/usr/bin/env python3
"""Render the SVG sources to PNG assets.

    python3 build-icon.py

Rasterises with sips (built into macOS, no extra dependency).

Tray icons are normalised to macOS template form: every pixel forced to pure
black, with the shape carried entirely by the alpha channel, so macOS can
invert them for light and dark menu bars. The drag icon is NOT a template —
macOS draws a drag image as-is — so its colour is left alone.

Requires: macOS (sips) and Pillow.
"""

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
    return 0


if __name__ == "__main__":
    sys.exit(main())
