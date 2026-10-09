"""The 1280x640 image GitHub shows when the repository link is shared."""
import json
import os
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO = 'C:/Users/stick/Desktop/classic-asp-language-support'
# Runs from anywhere (a terminal in any folder, or the editor's Run button): the
# output path is taken as given, then the script works from its own folder,
# where cast.json and the frames are. With no path it replaces images/social-preview.png.
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else f'{REPO}/images/social-preview.png'
os.chdir(os.path.dirname(os.path.abspath(__file__)))
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
# The last frame of the recording: the finished page, in Catppuccin Mocha.
frames = json.load(open('cast.json'))['frames']
shot = Image.open(frames[-1]['file']).convert('RGB')
shot = shot.crop((0, 0, 720, 590))
sw, sh = 600, 492
shot = shot.resize((sw, sh), Image.LANCZOS)
x0, y0 = 640, 72
shadow = Image.new('L', (W, H), 0)
ImageDraw.Draw(shadow).rounded_rectangle([x0 + 10, y0 + 24, x0 + sw + 10, y0 + sh + 24], radius=18, fill=170)
img.paste(Image.new('RGB', (W, H), (0, 0, 0)), (0, 0), shadow.filter(ImageFilter.GaussianBlur(26)))
mask = Image.new('L', (sw, sh), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, sw - 1, sh - 1], radius=14, fill=255)
img.paste(shot, (x0, y0), mask)
d = ImageDraw.Draw(img)
d.rounded_rectangle([x0, y0, x0 + sw - 1, y0 + sh - 1], radius=14, outline=SURFACE, width=2)

# Left column, top to bottom: logo with the name beside it, where to get it,
# what it does, the feature chips.
TOP = 72
icon = Image.open(f'{REPO}/images/icon.png').convert('RGBA').resize((112, 112), Image.LANCZOS)
img.paste(icon, (72, TOP), icon)

# The name, two lines beside the logo, as large as fits before the screenshot.
tx, room = 72 + 112 + 26, 640 - 40 - (72 + 112 + 26)
size = 60
while size > 30 and max(d.textlength(t, font=bold(size)) for t in ('Classic ASP', 'Language Support')) > room:
    size -= 2
line = size * 1.12
ty = TOP + 56 - line
d.text((tx, ty + line / 2), 'Classic ASP', font=bold(size), fill=TEXT, anchor='lm')
d.text((tx, ty + line * 1.5), 'Language Support', font=bold(size), fill=TEXT, anchor='lm')

# Where to get it: both stores, each logo on a white disc (the logos in icons/).
sf = semibold(26)
sx, sy = 74, TOP + 112 + 58
for i, (name, label) in enumerate((('vscode.png', 'VS Code Marketplace'), ('openvsx.png', 'Open VSX'))):
    if i:
        d.text((sx, sy), '·', font=sf, fill=OVERLAY, anchor='lm')
        sx += 26
    path = os.path.join('icons', name)
    if os.path.exists(path):
        d.ellipse([sx, sy - 21, sx + 42, sy + 21], fill=(255, 255, 255))
        logo = Image.open(path).convert('RGBA').resize((28, 28), Image.LANCZOS)
        img.paste(logo, (int(sx) + 7, sy - 14), logo)
        sx += 54
    d.text((sx, sy), label, font=sf, fill=TEXT, anchor='lm')
    sx += d.textlength(label, font=sf) + 18

d.text((74, sy + 50), 'Formatter, IntelliSense and error checking', font=regular(25), fill=SUBTEXT)
d.text((74, sy + 84), 'for Classic ASP and VBScript pages', font=regular(25), fill=SUBTEXT)

chips = [('Format', MAUVE), ('IntelliSense', PINK), ('Go to Definition', BLUE), ('Rename', TEAL), ('Diagnostics', MAUVE)]
cx, cy = 74, sy + 150
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
