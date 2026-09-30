"""Cut the world map into small WebP images the browser can decode quickly.

The source map is 8192x8192; decoding it in the browser blocks the page for seconds.
Instead the page loads img/map/overview.webp (2048 px) and, when zoomed in, the
full-resolution tiles img/map/tile-<col>-<row>.webp (GRID x GRID of 2048 px).

Usage: python tools/build-maptiles.py [path-to-map-image]   (needs Pillow with AVIF support)
Default source: img/map.avif (downloaded by tools/build-mapdata.js).
"""
import os
import sys

from PIL import Image

GRID = 4
OVERVIEW = 2048
QUALITY = 82

root = os.path.join(os.path.dirname(__file__), '..')
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, 'img', 'map.avif')
out = os.path.join(root, 'img', 'map')
os.makedirs(out, exist_ok=True)

img = Image.open(src)
img.load()
img = img.convert('RGBA' if 'A' in img.getbands() else 'RGB')
w, h = img.size
print(f'source {w}x{h} {img.mode}')

img.resize((OVERVIEW, OVERVIEW), Image.LANCZOS).save(os.path.join(out, 'overview.webp'), quality=QUALITY, method=6)
tw, th = w // GRID, h // GRID
for i in range(GRID):
    for j in range(GRID):
        tile = img.crop((i * tw, j * th, (i + 1) * tw, (j + 1) * th))
        tile.save(os.path.join(out, f'tile-{i}-{j}.webp'), quality=QUALITY, method=6)
print(f'wrote overview + {GRID * GRID} tiles to {out}')
