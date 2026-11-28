"""Generate official BookReader closed-book + cyan-spark icons for Windows, macOS, Android, and Web UI."""

from pathlib import Path
import json
import numpy as np
from PIL import Image, ImageDraw, ImageEnhance

REPO_ROOT = Path(__file__).resolve().parent.parent
ICONS_DIR = REPO_ROOT / "src-tauri" / "icons"
MASTER_PATH = ICONS_DIR / "icon_master.png"
WEB_ICON_PATH = REPO_ROOT / "src" / "assets" / "app-icon.png"

BG_RGB = (18, 18, 17)  # #121211 (--bg-app)
RIM_BORDER_RGBA = (42, 60, 72, 255)  # Subtle dark cyan-slate squircle edge


def extract_book_crop(master: Image.Image) -> tuple[Image.Image, Image.Image]:
    """Tightly crop the book + bookmark + glowing spark, returning (#121211-blended RGB, feathered RGBA)."""
    arr = np.array(master.convert("RGB"), dtype=np.float32)
    h, w = arr.shape[:2]

    # Measure background color from outer border strips of master
    border_samples = np.concatenate(
        [
            arr[0:max(1, h // 40), :, :].reshape(-1, 3),
            arr[h - max(1, h // 40) : h, :, :].reshape(-1, 3),
            arr[:, 0:max(1, w // 40), :].reshape(-1, 3),
            arr[:, w - max(1, w // 40) : w, :].reshape(-1, 3),
        ],
        axis=0,
    )
    measured_bg = np.median(border_samples, axis=0).astype(np.float32)
    target_bg = np.array(BG_RGB, dtype=np.float32)

    diff = np.max(np.abs(arr - measured_bg), axis=2)
    ys, xs = np.where(diff > 18.0)
    if xs.size == 0 or ys.size == 0:
        x_min, x_max, y_min, y_max = 0, w - 1, 0, h - 1
    else:
        x_min, x_max = int(xs.min()), int(xs.max())
        y_min, y_max = int(ys.min()), int(ys.max())
    cx = (x_min + x_max) / 2.0
    cy = (y_min + y_max) / 2.0
    span = max(x_max - x_min + 1, y_max - y_min + 1)
    side = max(1, int(round(span * 1.14)))
    half = side // 2

    # Sample crop onto a square canvas padded with measured_bg so non-square masters never clip
    raw_x0 = int(round(cx)) - half
    raw_y0 = int(round(cy)) - half
    raw_x1 = raw_x0 + side
    raw_y1 = raw_y0 + side

    crop = np.broadcast_to(measured_bg, (side, side, 3)).copy()
    src_x0 = max(0, raw_x0)
    src_y0 = max(0, raw_y0)
    src_x1 = min(w, raw_x1)
    src_y1 = min(h, raw_y1)
    if src_x1 > src_x0 and src_y1 > src_y0:
        dst_x0 = src_x0 - raw_x0
        dst_y0 = src_y0 - raw_y0
        crop[dst_y0 : dst_y0 + (src_y1 - src_y0), dst_x0 : dst_x0 + (src_x1 - src_x0)] = arr[
            src_y0:src_y1, src_x0:src_x1
        ]
    ch, cw = crop.shape[:2]

    # Smooth radial edge blend to exact #121211 near the crop border
    yy, xx = np.mgrid[0:ch, 0:cw]
    dist_edge = np.minimum(np.minimum(xx, cw - 1 - xx), np.minimum(yy, ch - 1 - yy))
    edge_t = np.clip(dist_edge / max(1.0, cw * 0.08), 0.0, 1.0)
    edge_t = edge_t * edge_t * (3.0 - 2.0 * edge_t)

    # Smoothstep foreground alpha based on perceptual distance from measured background
    color_dist = np.linalg.norm(crop - measured_bg, axis=2)
    fg_raw = np.clip((color_dist - 8.0) / 18.0, 0.0, 1.0)
    fg_alpha = fg_raw * fg_raw * (3.0 - 2.0 * fg_raw) * edge_t

    rgb_blended = crop * edge_t[:, :, None] + target_bg * (1.0 - edge_t[:, :, None])
    rgb_im = Image.fromarray(np.clip(np.round(rgb_blended), 0, 255).astype(np.uint8), mode="RGB")

    rgba_arr = np.zeros((ch, cw, 4), dtype=np.uint8)
    rgba_arr[:, :, :3] = np.clip(np.round(crop), 0, 255).astype(np.uint8)
    rgba_arr[:, :, 3] = np.clip(np.round(fg_alpha * 255.0), 0, 255).astype(np.uint8)
    fg_im = Image.fromarray(rgba_arr, mode="RGBA")
    return rgb_im, fg_im


def render_squircle_icon(cropped_rgb: Image.Image, size: int, sharpen_small: bool = False) -> Image.Image:
    """Render tightly-cropped closed book + spark inside a crisp #121211 rounded squircle."""
    base = 1024
    canvas = Image.new("RGBA", (base, base), (0, 0, 0, 0))

    # Rounded squircle clip mask
    pad = int(round(base * 0.02))
    radius = int(round(base * 0.22))
    mask = Image.new("L", (base, base), 0)
    ImageDraw.Draw(mask).rounded_rectangle([pad, pad, base - pad, base - pad], radius=radius, fill=255)

    # Solid #121211 interior with tight artwork filling ~92% of squircle width
    sq_bg = Image.new("RGBA", (base, base), (*BG_RGB, 255))
    art_size = int(round(base * 0.90))
    art = cropped_rgb.resize((art_size, art_size), Image.Resampling.LANCZOS).convert("RGBA")
    offset = (base - art_size) // 2
    sq_bg.alpha_composite(art, dest=(offset, offset))

    canvas.paste(sq_bg, (0, 0), mask)
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(
        [pad, pad, base - pad, base - pad],
        radius=radius,
        outline=RIM_BORDER_RGBA,
        width=max(2, int(round(base * 0.010))),
    )

    if size == base:
        return canvas
    out = canvas.resize((size, size), Image.Resampling.LANCZOS)
    if sharpen_small and size <= 32:
        out = ImageEnhance.Sharpness(out).enhance(1.25)
    return out


def render_android_adaptive(cropped_fg: Image.Image) -> tuple[Image.Image, Image.Image]:
    """Generate 1024x1024 solid #121211 background + safe-zone foreground for Android."""
    size = 1024
    bg = Image.new("RGBA", (size, size), (*BG_RGB, 255))
    fg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    art_size = int(round(size * 0.66))
    art = cropped_fg.resize((art_size, art_size), Image.Resampling.LANCZOS)
    offset = (size - art_size) // 2
    fg.alpha_composite(art, dest=(offset, offset))
    return bg, fg


def main() -> None:
    if not MASTER_PATH.exists():
        raise FileNotFoundError(f"Missing master artwork: {MASTER_PATH}")

    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    WEB_ICON_PATH.parent.mkdir(parents=True, exist_ok=True)

    master = Image.open(MASTER_PATH)
    cropped_rgb, cropped_fg = extract_book_crop(master)

    icon_1024 = render_squircle_icon(cropped_rgb, 1024)
    icon_1024.save(ICONS_DIR / "icon.png", format="PNG")

    render_squircle_icon(cropped_rgb, 32, sharpen_small=True).save(ICONS_DIR / "32x32.png", format="PNG")
    render_squircle_icon(cropped_rgb, 128).save(ICONS_DIR / "128x128.png", format="PNG")
    icon_256 = render_squircle_icon(cropped_rgb, 256)
    icon_256.save(ICONS_DIR / "128x128@2x.png", format="PNG")
    icon_256.save(WEB_ICON_PATH, format="PNG")

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_frames = [render_squircle_icon(cropped_rgb, s, sharpen_small=(s <= 32)) for s in ico_sizes]
    ico_frames[-1].save(
        ICONS_DIR / "icon.ico",
        format="ICO",
        append_images=ico_frames[:-1],
    )

    icon_1024.save(ICONS_DIR / "icon.icns", format="ICNS")

    android_bg, android_fg = render_android_adaptive(cropped_fg)
    android_bg.save(ICONS_DIR / "android-bg.png", format="PNG")
    android_fg.save(ICONS_DIR / "android-fg.png", format="PNG")

    manifest = {
        "default": "icon.png",
        "bg_color": "#121211",
        "android_bg": "android-bg.png",
        "android_fg": "android-fg.png",
        "android_fg_scale": 100,
    }
    (ICONS_DIR / "icon-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Generated closed-book icons in {ICONS_DIR} and {WEB_ICON_PATH}")


if __name__ == "__main__":
    main()
