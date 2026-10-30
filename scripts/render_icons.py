"""Peakaboo のアイコン PNG を assets/peakaboo.svg と同じ幾何で描く（PIL のみ、8 倍で描いて縮小）
Render the Peakaboo icon PNGs with the same geometry as assets/peakaboo.svg (PIL only, 8x supersampling).
Usage: python scripts/render_icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SS = 8  # supersampling / 描画倍率

def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

def vgrad(img, box, top, bottom, radius):
    """縦グラデーションの角丸矩形を描く / draw a rounded rect filled with a vertical gradient"""
    x0, y0, x1, y1 = box
    grad = Image.new('RGBA', (x1 - x0, y1 - y0))
    px = grad.load()
    h = y1 - y0
    for y in range(h):
        c = lerp(top, bottom, y / max(1, h - 1)) + (255,)
        for x in range(x1 - x0):
            px[x, y] = c
    mask = Image.new('L', grad.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, grad.size[0] - 1, grad.size[1] - 1), radius=radius, fill=255)
    img.paste(grad, (x0, y0), mask)

def render(size):
    s = size * SS / 64.0  # SVG 1 unit → px / one SVG unit in pixels
    W = size * SS
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    vgrad(img, (0, 0, W, W), hex_rgb('#1c2033'), hex_rgb('#15182a'), round(14 * s))
    d = ImageDraw.Draw(img)
    bars = [  # x, y, w, h, rx, color (None = peak gradient) / 棒の定義
        (9, 42, 8, 14, 2.5, '#34477a'),
        (19, 34, 8, 22, 2.5, '#4a69b0'),
        (29, 14, 10, 42, 3.0, None),
        (41, 36, 8, 20, 2.5, '#4262a6'),
        (51, 46, 6, 10, 2.5, '#2f416f'),
    ]
    for x, y, w, h, rx, color in bars:
        box = (round(x * s), round(y * s), round((x + w) * s), round((y + h) * s))
        if color is None:
            vgrad(img, box, hex_rgb('#8fd0ff'), hex_rgb('#2d8ceb'), round(rx * s))
        else:
            d.rounded_rectangle((box[0], box[1], box[2] - 1, box[3] - 1), radius=round(rx * s), fill=hex_rgb(color) + (255,))
    return img.resize((size, size), Image.LANCZOS)

def main():
    out = {
        ROOT / 'extension' / 'icons': (16, 32, 48, 128),
        ROOT / 'service' / 'web' / 'icons': (32, 192),
        ROOT / 'panel' / 'icons': (23, 46),  # CEP の通常 / Retina / CEP normal and retina sizes
    }
    for folder, sizes in out.items():
        folder.mkdir(parents=True, exist_ok=True)
        for n in sizes:
            path = folder / f'peakaboo-{n}.png'
            render(n).save(path, optimize=True)
            print(path.relative_to(ROOT), n)

if __name__ == '__main__':
    main()
