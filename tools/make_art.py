#!/usr/bin/env python3
"""Workshop art from real captures.

    python3 -I tools/make_art.py --explorer EXPLORER.png [--game GAME.png] [--panel PANEL.png]

Writes mod/preview.png (square, under 1 MB, required by the in-game uploader) and
workshop/screenshots/*.png (add those on the Steam page by hand). Point it at full-size
captures (4 px per cell) of the same world.
"""
import argparse
import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parent.parent
TITLE_FONT = "/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf"
TEXT_FONT = "/usr/share/fonts/opentype/inter/Inter-Medium.otf"
AMBER, AMBER_LIGHT, INK = (240, 177, 15), (255, 216, 77), (29, 21, 4)
SKY_TOP, SKY_HORIZON = (42, 111, 176), (159, 212, 240)


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def on_sky(im):
    """Flatten a transparent capture onto the sky gradient Cartographer uses."""
    if im.mode != "RGBA":
        return im.convert("RGB")
    w, h = im.size
    grad = Image.new("RGB", (1, 256))
    for y in range(256):
        t = y / 255
        grad.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(SKY_TOP, SKY_HORIZON)))
    bg = grad.resize((w, h))
    bg.paste(im, (0, 0), im)
    return bg


def logo(size):
    """The map logo from the in-game panel, drawn at `size` px."""
    s = size / 40
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=round(9 * s), fill=(26, 33, 51))
    P = lambda pts: [(x * s, y * s) for x, y in pts]
    d.polygon(P([(8, 11), (16, 8), (24, 11), (32, 8), (32, 29), (24, 32), (16, 29), (8, 32)]), fill=AMBER)
    d.polygon(P([(16, 8), (16, 29), (24, 32), (24, 11)]), fill=AMBER_LIGHT)
    for i in range(6):
        x = 11 + i * 3.6
        d.ellipse([x * s, (20 + (i % 2) * 1.5) * s, (x + 1.5) * s, (21.5 + (i % 2) * 1.5) * s], fill=INK)
    d.ellipse([(29 - 2.2) * s, (15 - 2.2) * s, (29 + 2.2) * s, (15 + 2.2) * s], fill=(217, 65, 43))
    return im


def fit_png(im, limit=1_000_000):
    """Save as PNG under `limit` bytes, quantising if needed."""
    for colors in (None, 256, 128):
        buf = io.BytesIO()
        (im if colors is None else im.quantize(colors=colors, method=Image.Quantize.FASTOCTREE)).save(buf, "PNG", optimize=True)
        if buf.tell() <= limit:
            return buf.getvalue()
    return buf.getvalue()


def busiest_square(im, side):
    """Square crop (in source px) around the most detailed area, preferring the top half."""
    small = im.convert("L").resize((im.width // 32, im.height // 32))
    edges = small.filter(ImageFilter.FIND_EDGES)
    k = side // 32
    best, best_xy = -1, (0, 0)
    for y in range(0, max(1, edges.height - k), max(1, k // 6)):
        for x in range(0, max(1, edges.width - k), max(1, k // 6)):
            score = sum(edges.crop((x, y, x + k, y + k)).getdata()) * (1.0 - 0.3 * y / edges.height)
            if score > best:
                best, best_xy = score, (x, y)
    return best_xy[0] * 32, best_xy[1] * 32


def preview(explorer, out):
    side = min(explorer.width, explorer.height, 6144)
    x, y = busiest_square(explorer, side)
    art = explorer.crop((x, y, x + side, y + side)).resize((1024, 1024), Image.LANCZOS)
    band = Image.new("RGBA", (1024, 250), (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    for i in range(250):
        bd.line([(0, i), (1024, i)], fill=(10, 13, 21, min(235, int(235 * (i / 120) ** 1.2))))
    art = art.convert("RGBA")
    art.alpha_composite(band, (0, 774))
    art.alpha_composite(logo(108), (52, 868))
    d = ImageDraw.Draw(art)
    d.text((182, 862), "CARTOGRAPHER", font=font(TITLE_FONT, 74), fill=(255, 255, 255))
    d.text((186, 948), "Your whole world, one picture", font=font(TEXT_FONT, 34), fill=AMBER_LIGHT)
    data = fit_png(art.convert("RGB"))
    out.write_bytes(data)
    return len(data)


def screenshots(explorer, game, panel, outdir):
    outdir.mkdir(parents=True, exist_ok=True)
    written = []
    def save(name, im):
        p = outdir / name
        im.save(p, "PNG", optimize=True)
        written.append(p.name)
    w = 1920
    save("01-explorer-whole-map.png", explorer.resize((w, round(explorer.height * w / explorer.width)), Image.LANCZOS))
    if game is not None:
        save("02-game-whole-map.png", game.resize((w, round(game.height * w / game.width)), Image.LANCZOS))
    x, y = busiest_square(explorer, 2048)
    save("03-full-detail.png", explorer.crop((x, y, x + 1920, y + 1080)))
    if panel is not None:
        save("04-panel.png", panel.convert("RGB").resize((1920, round(panel.height * 1920 / panel.width)), Image.LANCZOS))
    return written


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--explorer", required=True)
    ap.add_argument("--game")
    ap.add_argument("--panel")
    a = ap.parse_args()
    explorer = on_sky(Image.open(a.explorer))
    game = on_sky(Image.open(a.game)) if a.game else None
    panel = Image.open(a.panel) if a.panel else None
    size = preview(explorer, ROOT / "mod" / "preview.png")
    shots = screenshots(explorer, game, panel, ROOT / "workshop" / "screenshots")
    print(f"mod/preview.png {size / 1024:.0f} KB; screenshots: {', '.join(shots)}")


if __name__ == "__main__":
    main()
