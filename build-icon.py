#!/usr/bin/env python3
"""Render icon.svg to the macOS tray template PNGs.

    python3 build-icon.py

Rasterises with sips (built into macOS, no extra dependency) and then
normalises the result to a proper template icon: every pixel forced to pure
black, with the shape carried entirely by the alpha channel. macOS inverts
template icons automatically for light and dark menu bars.

Requires: macOS (sips) and Pillow.
"""

import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).parent
SVG = ROOT / "icon.svg"
TARGETS = [(ROOT / "trayTemplate.png", 16), (ROOT / "trayTemplate@2x.png", 32)]


def render(svg: Path, out: Path, size: int) -> None:
    subprocess.run(
        ["sips", "-s", "format", "png",
         "--resampleHeightWidth", str(size), str(size),
         str(svg), "--out", str(out)],
        check=True, capture_output=True,
    )


def normalise(path: Path) -> None:
    """Force RGB to pure black, keep alpha as the shape."""
    img = Image.open(path).convert("RGBA")
    alpha = img.getchannel("A")
    black = Image.new("RGBA", img.size, (0, 0, 0, 0))
    black.putalpha(alpha)
    black.save(path, "PNG")


def main() -> int:
    if not SVG.exists():
        print(f"error: {SVG} not found", file=sys.stderr)
        return 1
    for out, size in TARGETS:
        render(SVG, out, size)
        normalise(out)
        print(f"wrote {out.name} ({size}x{size})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
