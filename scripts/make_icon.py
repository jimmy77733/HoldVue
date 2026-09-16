"""Generate HoldVue app icon with perfectly clean alpha edges."""
from PIL import Image, ImageDraw, ImageFilter
import os

ROOT = r"c:\Users\jimmy\Downloads\HoldVue\assets"
OUT_PNG = os.path.join(ROOT, "holdvue.png")
OUT_ICO = os.path.join(ROOT, "holdvue.ico")
SIZE = 1024
SCALE = 4  # heavy supersample for clean curves
W = SIZE * SCALE

BG = (12, 16, 14, 255)
ACCENT = (46, 229, 157, 255)


def rounded_rect_mask(size, radius):
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    # inset by 0 so AA sits inside; use exact bounds
    d.rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def ellipse_ring(draw, bbox, width, fill):
    """Clean ring via outer fill minus inner hole (no polyline jaggies)."""
    x0, y0, x1, y1 = bbox
    # temporary layer
    pass


def make_ring(size, cx, cy, rx, ry, stroke, color):
    """Return RGBA layer with a smooth elliptical ring."""
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    outer = [cx - rx, cy - ry, cx + rx, cy + ry]
    d.ellipse(outer, fill=color)
    # punch hole
    hole = Image.new("L", size, 0)
    hd = ImageDraw.Draw(hole)
    inset_x = stroke
    inset_y = stroke * (ry / rx) if rx else stroke
    # keep similar visual stroke on both axes
    inset_y = stroke
    inner = [cx - rx + inset_x, cy - ry + inset_y, cx + rx - inset_x, cy + ry - inset_y]
    hd.ellipse(inner, fill=255)
    # clear inner pixels
    clear = Image.new("RGBA", size, (0, 0, 0, 0))
    layer = Image.composite(clear, layer, hole)
    return layer


def draw_icon(canvas_size):
    size = (canvas_size, canvas_size)
    radius = int(canvas_size * 0.22)
    cx = cy = canvas_size / 2

    # Transparent canvas + squircle base
    base = Image.new("RGBA", size, (0, 0, 0, 0))
    bd = ImageDraw.Draw(base)
    bd.rounded_rectangle([0, 0, canvas_size - 1, canvas_size - 1], radius=radius, fill=BG)
    mask = rounded_rect_mask(size, radius)

    # Soft ambient glow (blurred circle), clipped
    glow = Image.new("RGBA", size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    r = canvas_size * 0.34
    gd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(46, 229, 157, 40))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=canvas_size * 0.08))
    glow_c = Image.new("RGBA", size, (0, 0, 0, 0))
    glow_c.paste(glow, (0, 0), mask)

    img = Image.alpha_composite(base, glow_c)

    # Eye ring — almond-ish by using wider ellipse (clean geometry)
    rx = canvas_size * 0.31
    ry = canvas_size * 0.168
    stroke = canvas_size * 0.034
    ring = make_ring(size, cx, cy, rx, ry, stroke, ACCENT)

    # Bars — perfectly centered in the eye
    logo = Image.new("RGBA", size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(logo)
    bar_w = canvas_size * 0.058
    gap = canvas_size * 0.048
    heights = [canvas_size * 0.105, canvas_size * 0.16, canvas_size * 0.22]
    total_w = 3 * bar_w + 2 * gap
    x0 = cx - total_w / 2
    max_h = heights[-1]
    base_y = cy + max_h / 2
    corner = max(3, int(bar_w * 0.42))
    for i, h in enumerate(heights):
        x = x0 + i * (bar_w + gap)
        ld.rounded_rectangle([x, base_y - h, x + bar_w, base_y], radius=corner, fill=ACCENT)

    logo = Image.alpha_composite(ring, logo)

    # Soft logo bloom (blur then composite), clipped to squircle
    bloom = logo.filter(ImageFilter.GaussianBlur(radius=canvas_size * 0.022))
    # tone down bloom alpha
    bloom_data = bloom.split()
    if len(bloom_data) == 4:
        r, g, b, a = bloom_data
        a = a.point(lambda v: int(v * 0.55))
        bloom = Image.merge("RGBA", (r, g, b, a))
    bloom_c = Image.new("RGBA", size, (0, 0, 0, 0))
    bloom_c.paste(bloom, (0, 0), mask)

    img = Image.alpha_composite(img, bloom_c)
    img = Image.alpha_composite(img, logo)

    # Final hard clip — zero exterior fringe
    out = Image.new("RGBA", size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def scrub_halo(im, threshold=10):
    """Remove near-transparent fringe pixels outside the icon body."""
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if 0 < a < threshold:
                px[x, y] = (0, 0, 0, 0)
    return im


def main():
    hi = draw_icon(W)
    final = hi.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    r = int(SIZE * 0.22)
    m = rounded_rect_mask((SIZE, SIZE), r)
    clean = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    clean.paste(final, (0, 0), m)
    clean = scrub_halo(clean, threshold=14)
    # re-apply mask after scrub
    boxed = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    boxed.paste(clean, (0, 0), m)
    boxed.save(OUT_PNG, "PNG", optimize=True)

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    images = []
    for s in ico_sizes:
        im = boxed.resize((s, s), Image.Resampling.LANCZOS)
        mm = rounded_rect_mask((s, s), max(2, int(s * 0.22)))
        c = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        c.paste(im, (0, 0), mm)
        c = scrub_halo(c, threshold=20 if s <= 32 else 12)
        images.append(c)
    images[-1].save(OUT_ICO, format="ICO", sizes=[(s, s) for s in ico_sizes])
    print("Wrote", OUT_PNG)
    print("Wrote", OUT_ICO)


if __name__ == "__main__":
    main()
