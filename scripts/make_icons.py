#!/usr/bin/env python3
"""Generate the PWA PNG icons from scratch with Pillow (no source artwork needed)."""

from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "source" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

SCALE = 4  # supersampling for smooth edges


def gradient(size, top=(28, 178, 165), bottom=(8, 104, 101)):
    strip = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        color = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
        strip.putpixel((0, y), color)
    return strip.resize((size, size)).convert("RGBA")


def build(size, maskable=False):
    dim = size * SCALE
    inset = int(dim * (0.13 if maskable else 0.0))
    base = dim - 2 * inset

    # Rounded-square teal background.
    mask = Image.new("L", (dim, dim), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (inset, inset, inset + base - 1, inset + base - 1),
        radius=int(base * 0.22), fill=255,
    )
    canvas = Image.new("RGBA", (dim, dim), (0, 0, 0, 0))
    canvas.paste(gradient(dim), (0, 0), mask)
    d = ImageDraw.Draw(canvas)

    # Fridge body (kept well inside the maskable safe zone).
    fw = int(base * 0.36)
    fh = int(base * 0.62)
    fx = (dim - fw) // 2
    fy = (dim - fh) // 2
    r = int(base * 0.055)
    body = (fx, fy, fx + fw, fy + fh)
    d.rounded_rectangle(body, radius=r, fill=(248, 255, 254, 255))

    # Divider between freezer and fridge compartments.
    split = fy + int(fh * 0.34)
    d.line((fx + 2, split, fx + fw - 2, split), fill=(193, 224, 221, 255), width=max(2, dim // 170))

    # Handles.
    hw = max(2, int(base * 0.018))
    hx = fx + int(fw * 0.76)
    d.rounded_rectangle((hx, fy + int(fh * 0.12), hx + hw, split - int(fh * 0.08)),
                        radius=hw // 2, fill=(14, 143, 138, 255))
    d.rounded_rectangle((hx, split + int(fh * 0.10), hx + hw, fy + int(fh * 0.84)),
                        radius=hw // 2, fill=(14, 143, 138, 255))

    # Small snowflake mark in the freezer door.
    cx = fx + int(fw * 0.34)
    cy = fy + int(fh * 0.17)
    arm = int(base * 0.018)
    d.line((cx - arm, cy, cx + arm, cy), fill=(14, 143, 138, 255), width=max(2, dim // 220))
    d.line((cx, cy - arm, cx, cy + arm), fill=(14, 143, 138, 255), width=max(2, dim // 220))

    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def main():
    targets = [
        (96, False, "icon-96.png"),
        (180, False, "icon-180.png"),
        (192, False, "icon-192.png"),
        (512, False, "icon-512.png"),
        (512, True, "icon-maskable-512.png"),
    ]
    for size, maskable, name in targets:
        path = OUT / name
        build(size, maskable).save(path, optimize=True)
        print(f"wrote {path.relative_to(ROOT)} ({size}x{size})")


if __name__ == "__main__":
    main()
