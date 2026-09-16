from PIL import Image, ImageDraw
import os
import math

OUT = os.path.dirname(os.path.abspath(__file__))

BG = (10, 14, 20)       # app dark navy
RING = (214, 40, 40)     # speed-limit-sign red
FACE = (247, 249, 251)   # near-white sign face
NEEDLE = (18, 22, 28)    # near-black speedometer needle
TICK = (198, 203, 210)   # light gauge ticks


def draw_needle_layer(size, length):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = size / 2, size / 2
    width = size * 0.045
    needle = [
        (cx, cy - length),
        (cx + width / 2, cy - length * 0.12),
        (cx - width / 2, cy - length * 0.12),
    ]
    d.polygon(needle, fill=NEEDLE)
    return layer


def draw_icon(size, pad_ratio):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = int(size * pad_ratio)
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=int(size * 0.2), fill=BG)

    cx, cy = size / 2, size / 2
    avail = (size - 2 * pad) / 2
    R = avail * 0.86
    ring_w = R * 0.2

    d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=RING)
    inner_r = R - ring_w
    d.ellipse([cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r], fill=FACE)

    # Gauge tick marks around the inner face.
    for deg in range(0, 360, 30):
        rad = math.radians(deg)
        x1 = cx + math.sin(rad) * inner_r * 0.82
        y1 = cy - math.cos(rad) * inner_r * 0.82
        x2 = cx + math.sin(rad) * inner_r * 0.95
        y2 = cy - math.cos(rad) * inner_r * 0.95
        d.line([x1, y1, x2, y2], fill=TICK, width=max(1, int(size * 0.008)))

    # Needle pointing toward the upper-right "high speed" zone, rotated onto the icon.
    needle_layer = draw_needle_layer(size, inner_r * 0.88)
    needle_layer = needle_layer.rotate(-55, resample=Image.BICUBIC, center=(size / 2, size / 2))
    img.alpha_composite(needle_layer)

    hub_r = inner_r * 0.1
    d.ellipse([cx - hub_r, cy - hub_r, cx + hub_r, cy + hub_r], fill=NEEDLE)

    return img


for name, size, pad_ratio in [
    ("icon-192.png", 192, 0.0),
    ("icon-512.png", 512, 0.0),
    ("icon-maskable-192.png", 192, 0.12),
    ("icon-maskable-512.png", 512, 0.12),
    ("apple-touch-icon.png", 180, 0.0),
    ("favicon-32.png", 32, 0.0),
]:
    icon = draw_icon(size, pad_ratio)
    icon.save(os.path.join(OUT, name))
    print("wrote", name)
