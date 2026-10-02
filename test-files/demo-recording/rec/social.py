"""The 1280x640 image GitHub shows when the repository link is shared."""
import json
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO = 'C:/Users/stick/Desktop/classic-asp-language-support'
OUT = sys.argv[1] if len(sys.argv) > 1 else 'social.png'
W, H = 1280, 640

CRUST, MANTLE, BASE = (17, 17, 27), (24, 24, 37), (30, 30, 46)
TEXT, SUBTEXT, OVERLAY, SURFACE = (205, 214, 244), (166, 173, 200), (108, 112, 134), (49, 50, 68)
MAUVE, PINK, TEAL, BLUE = (203, 166, 247), (245, 194, 231), (148, 226, 213), (137, 180, 250)

F = 'C:/Windows/Fonts/'
semibold = lambda s: ImageFont.truetype(F + 'seguisb.ttf', s)
bold = lambda s: ImageFont.truetype(F + 'segoeuib.ttf', s)
regular = lambda s: ImageFont.truetype(F + 'segoeui.ttf', s)

img = Image.new('RGB', (W, H), CRUST)

# Soft glows in the icon's pastel colours.
glow = Image.new('RGB', (W, H), CRUST)
g = ImageDraw.Draw(glow)
g.ellipse([-260, -320, 520, 420], fill=(70, 50, 100))
g.ellipse([820, 300, 1500, 900], fill=(30, 80, 80))
g.ellipse([480, -260, 1000, 200], fill=(85, 50, 80))
img = Image.blend(img, glow.filter(ImageFilter.GaussianBlur(160)), 0.85)

# A real frame of the extension at work, as a floating window on the right.
frames = json.load(open('frames.json'))
shot = Image.open(next(f['file'] for f in frames if f['scene'] == 'format')).convert('RGB')
shot = shot.crop((0, 0, 720, 590))
sw, sh = 600, 492
shot = shot.resize((sw, sh), Image.LANCZOS)
x0, y0 = 640, 92
shadow = Image.new('L', (W, H), 0)
ImageDraw.Draw(shadow).rounded_rectangle([x0 + 10, y0 + 24, x0 + sw + 10, y0 + sh + 24], radius=18, fill=170)
img.paste(Image.new('RGB', (W, H), (0, 0, 0)), (0, 0), shadow.filter(ImageFilter.GaussianBlur(26)))
mask = Image.new('L', (sw, sh), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, sw - 1, sh - 1], radius=14, fill=255)
img.paste(shot, (x0, y0), mask)
d = ImageDraw.Draw(img)
d.rounded_rectangle([x0, y0, x0 + sw - 1, y0 + sh - 1], radius=14, outline=SURFACE, width=2)

# Left column: logo, name, what it does.
icon = Image.open(f'{REPO}/images/icon.png').convert('RGBA').resize((112, 112), Image.LANCZOS)
img.paste(icon, (72, 78), icon)
d.text((72, 222), 'Classic ASP', font=bold(60), fill=TEXT)
d.text((72, 292), 'Language Support', font=bold(60), fill=TEXT)
d.text((74, 382), 'Formatter, IntelliSense and error checking', font=regular(25), fill=SUBTEXT)
d.text((74, 416), 'for Classic ASP and VBScript in VS Code', font=regular(25), fill=SUBTEXT)

chips = [('Format', MAUVE), ('IntelliSense', PINK), ('Go to Definition', BLUE), ('Rename', TEAL), ('Diagnostics', MAUVE)]
cx, cy = 74, 482
cf = semibold(19)
for label, colour in chips:
    tw = d.textlength(label, font=cf)
    if cx + tw + 28 > 610:
        cx, cy = 74, cy + 48
    d.rounded_rectangle([cx, cy, cx + tw + 28, cy + 36], radius=18, outline=colour, width=2, fill=BASE)
    d.text((cx + 14 + tw / 2, cy + 18), label, font=cf, fill=colour, anchor='mm')
    cx += tw + 28 + 10

img.save(OUT, optimize=True)
import os
print(OUT, f'{os.path.getsize(OUT) / 1e3:.0f} KB', img.size)
