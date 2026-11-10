"""Build the app icons and splash screens from public/brand/a4y-mark.png.

Run from the repo root:  python3 mobile/make_icons.py
Needs Pillow (pip install pillow). Re-run it after replacing the mark with a sharper one —
the store icons are 1024 px, and the current mark is only 250 px wide, so a vector or
1024 px+ original gives a crisper icon.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MARK = Image.open(ROOT / 'public/brand/a4y-mark.png').convert('RGBA')
BG = (0, 0, 0, 255)


def tile(size, fill, bg=BG, offset_y=0.0):
    """mark centred on a square of `size`, taking `fill` of its width"""
    im = Image.new('RGBA', (size, size), bg)
    w = int(size * fill)
    h = int(MARK.height * w / MARK.width)
    m = MARK.resize((w, h), Image.LANCZOS)
    im.alpha_composite(m, ((size - w) // 2, (size - h) // 2 + int(size * offset_y)))
    return im


def save(im, path, rgb=False):
    path = ROOT / path
    path.parent.mkdir(parents=True, exist_ok=True)
    (im.convert('RGB') if rgb else im).save(path, optimize=True)
    print('wrote', path.relative_to(ROOT), im.size)


# web app (installable from the browser) — public/icons
save(tile(192, 0.78), 'public/icons/icon-192.png')
save(tile(512, 0.78), 'public/icons/icon-512.png')
save(tile(512, 0.58), 'public/icons/maskable-512.png')        # Android crops to a circle/squircle: keep the mark in the safe zone
save(tile(180, 0.74), 'public/icons/apple-touch-icon.png', rgb=True)

# store builds — mobile/assets, read by `npx @capacitor/assets generate`
save(tile(1024, 0.74), 'mobile/assets/icon-only.png', rgb=True)          # iOS: no transparency allowed
save(tile(1024, 0.58), 'mobile/assets/icon-foreground.png')              # Android adaptive icon, foreground layer
save(Image.new('RGBA', (1024, 1024), BG), 'mobile/assets/icon-background.png')
save(tile(2732, 0.22), 'mobile/assets/splash.png', rgb=True)
save(tile(2732, 0.22), 'mobile/assets/splash-dark.png', rgb=True)
save(tile(512, 0.74), 'mobile/store/play-icon-512.png', rgb=True)        # Play Console listing icon
