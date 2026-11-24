"""Generate neutral BookReader app & taskbar icons (open book + sound waves)."""

from pathlib import Path
from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def render_icon(size: int) -> Image.Image:
    # Supersample 4x for crisp anti-aliased lines and curves
    scale = 4
    w = size * scale
    img = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Neutral dark charcoal squircle background with subtle stone border
    pad = int(w * 0.05)
    radius = int(w * 0.22)
    draw.rounded_rectangle(
        [pad, pad, w - pad, w - pad],
        radius=radius,
        fill=(34, 34, 32, 255),
        outline=(68, 69, 65, 255),
        width=max(2, int(w * 0.014)),
    )

    # Subtle inner highlight ring
    inner_pad = pad + max(2, int(w * 0.018))
    draw.rounded_rectangle(
        [inner_pad, inner_pad, w - inner_pad, w - inner_pad],
        radius=max(4, radius - int(w * 0.018)),
        outline=(48, 49, 46, 200),
        width=max(1, int(w * 0.008)),
    )

    cx = w * 0.50

    # Three neutral sound wave arcs emanating upward from the open book spine
    wave_cy = w * 0.43
    wave_specs = [
        (0.14, (190, 193, 184, 240), 0.036),
        (0.225, (148, 152, 143, 225), 0.033),
        (0.31, (108, 112, 104, 200), 0.030),
    ]
    for r_frac, color, width_frac in wave_specs:
        r = w * r_frac
        stroke = max(2, int(w * width_frac))
        bbox = [cx - r, wave_cy - r, cx + r, wave_cy + r]
        draw.arc(bbox, start=218, end=322, fill=color, width=stroke)

    # Open book silhouette in warm neutral stone (#E5E5E0)
    # Left & right open pages angled upward cleanly toward center spine
    book_top_y = w * 0.50
    book_bot_y = w * 0.77
    spine_dip_y = w * 0.54
    spine_bot_y = w * 0.805
    left_x = w * 0.20
    right_x = w * 0.80
    spine_gap = w * 0.016

    page_fill = (229, 229, 224, 255)
    page_shade = (196, 197, 190, 255)
    cover_color = (142, 145, 138, 255)
    line_color = (118, 120, 114, 210)

    # Subtle outer cover cradle underneath pages
    cover_pad_x = w * 0.028
    cover_pad_y = w * 0.030
    draw.polygon(
        [
            (left_x - cover_pad_x, book_top_y + cover_pad_y * 0.9),
            (cx, spine_dip_y + cover_pad_y * 1.15),
            (right_x + cover_pad_x, book_top_y + cover_pad_y * 0.9),
            (right_x + cover_pad_x, book_bot_y + cover_pad_y),
            (cx, spine_bot_y + cover_pad_y * 1.15),
            (left_x - cover_pad_x, book_bot_y + cover_pad_y),
        ],
        fill=cover_color,
    )

    # Left page
    draw.polygon(
        [
            (left_x, book_top_y),
            (cx - spine_gap, spine_dip_y),
            (cx - spine_gap, spine_bot_y),
            (left_x, book_bot_y),
        ],
        fill=page_fill,
    )

    # Right page (slightly softer stone tone for subtle depth)
    draw.polygon(
        [
            (cx + spine_gap, spine_dip_y),
            (right_x, book_top_y),
            (right_x, book_bot_y),
            (cx + spine_gap, spine_bot_y),
        ],
        fill=page_shade,
    )

    # Spine crease accent
    draw.line(
        [(cx, spine_dip_y), (cx, spine_bot_y)],
        fill=(64, 65, 61, 255),
        width=max(2, int(w * 0.014)),
    )

    # Subtle text lines on pages (only drawn cleanly when icon >= 24px equivalent)
    if size >= 24:
        line_w = max(2, int(w * 0.016))
        for i in range(3):
            t = 0.28 + i * 0.24
            ly_outer = book_top_y + (book_bot_y - book_top_y) * t
            ly_inner = spine_dip_y + (spine_bot_y - spine_dip_y) * t
            lx1 = left_x + (cx - spine_gap - left_x) * 0.18
            lx2 = left_x + (cx - spine_gap - left_x) * 0.80
            draw.line(
                [
                    (lx1, ly_outer + (ly_inner - ly_outer) * 0.18),
                    (lx2, ly_outer + (ly_inner - ly_outer) * 0.80),
                ],
                fill=line_color,
                width=line_w,
            )
            rx1 = cx + spine_gap + (right_x - (cx + spine_gap)) * 0.20
            rx2 = cx + spine_gap + (right_x - (cx + spine_gap)) * 0.82
            draw.line(
                [
                    (rx1, ly_inner + (ly_outer - ly_inner) * 0.20),
                    (rx2, ly_inner + (ly_outer - ly_inner) * 0.82),
                ],
                fill=line_color,
                width=line_w,
            )

    return img.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    render_icon(32).save(OUT_DIR / "32x32.png", format="PNG")
    render_icon(128).save(OUT_DIR / "128x128.png", format="PNG")
    render_icon(256).save(OUT_DIR / "128x128@2x.png", format="PNG")
    icon_512 = render_icon(512)
    icon_512.save(OUT_DIR / "icon.png", format="PNG")

    # Multi-resolution Windows .ico for crisp taskbar, Alt+Tab, and Explorer rendering
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    icon_512.save(OUT_DIR / "icon.ico", format="ICO", sizes=ico_sizes)

    # Multi-resolution macOS .icns from 1024x1024 master
    icon_1024 = render_icon(1024)
    icon_1024.save(OUT_DIR / "icon.icns", format="ICNS")
    print(f"Generated icons in {OUT_DIR}")


if __name__ == "__main__":
    main()
