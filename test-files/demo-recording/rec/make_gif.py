"""Turns the recorded frames into the README demo GIF."""
import json
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

REPO = 'C:/Users/stick/Desktop/classic-asp-language-support'
OUT = sys.argv[1] if len(sys.argv) > 1 else 'demo.gif'
SCALE = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0

# Catppuccin Mocha
CRUST, MANTLE, BASE = (17, 17, 27), (24, 24, 37), (30, 30, 46)
TEXT, SUBTEXT, OVERLAY = (205, 214, 244), (166, 173, 200), (108, 112, 134)
MAUVE, PINK, TEAL = (203, 166, 247), (245, 194, 231), (148, 226, 213)

F = 'C:/Windows/Fonts/'
semibold = lambda s: ImageFont.truetype(F + 'seguisb.ttf', s)
regular = lambda s: ImageFont.truetype(F + 'segoeui.ttf', s)
mono = lambda s: ImageFont.truetype(F + 'CascadiaCode.ttf', s)

CAPTIONS = {
    'intro':        (None, ''),
    'before':       (None, 'A messy Classic ASP page'),
    'format':       ('Alt+Shift+F', 'Formats VBScript, HTML, CSS and JS in one go'),
    'intellisense': ('rs.', 'Knows every ADODB.Recordset member'),
    'missingset':   ('Ctrl+.', 'Catches a missing Set, and fixes it'),
    'rename':       ('F2', 'Renames rs everywhere it is used'),
    'renamed':      ('F2', 'Renames rs everywhere it is used'),
}
BAND = 64


def band(img, scene):
    w, h = img.size
    out = Image.new('RGB', (w, h + BAND), CRUST)
    out.paste(img, (0, 0))
    d = ImageDraw.Draw(out)
    d.line([(0, h), (w, h)], fill=MANTLE, width=1)
    chip, text = CAPTIONS[scene]
    x, cy = 24, h + BAND // 2
    if chip:
        cf = mono(19)
        tw = d.textlength(chip, font=cf)
        d.rounded_rectangle([x, cy - 17, x + tw + 24, cy + 17], radius=8, fill=MAUVE)
        d.text((x + 12, cy), chip, font=cf, fill=CRUST, anchor='lm')
        x += tw + 24 + 16
    d.text((x, cy), text, font=semibold(21), fill=TEXT, anchor='lm')
    brand = 'Classic ASP Language Support'
    end = x + d.textlength(text, font=semibold(21))
    if end + 32 < w - 24 - d.textlength(brand, font=regular(16)):
        d.text((w - 24, cy), brand, font=regular(16), fill=OVERLAY, anchor='rm')
    return out


def end_card(last):
    w, h = last.size
    bg = last.filter(ImageFilter.GaussianBlur(6))
    bg = Image.blend(bg, Image.new('RGB', bg.size, CRUST), 0.78)
    icon = Image.open(f'{REPO}/images/icon.png').convert('RGBA').resize((150, 150), Image.LANCZOS)
    card = bg.copy()
    cy = h // 2 - 60
    card.paste(icon, (w // 2 - 75, cy - 150), icon)
    d = ImageDraw.Draw(card)
    d.text((w // 2, cy + 30), 'Classic ASP Language Support', font=semibold(40), fill=TEXT, anchor='mm')
    d.text((w // 2, cy + 80), 'Formatter · IntelliSense · Go to Definition · Rename · Diagnostics',
           font=regular(20), fill=SUBTEXT, anchor='mm')
    pill = 'Free on the VS Code Marketplace'
    pf = semibold(20)
    tw = d.textlength(pill, font=pf)
    d.rounded_rectangle([w // 2 - tw / 2 - 22, cy + 122, w // 2 + tw / 2 + 22, cy + 166], radius=22, fill=MAUVE)
    d.text((w // 2, cy + 144), pill, font=pf, fill=CRUST, anchor='mm')
    return card


frames = json.load(open('frames.json'))
seq = []   # (image, ms)
for i, f in enumerate(frames):
    img = Image.open(f['file']).convert('RGB')
    if f['scene'] == 'format' and seq:
        # Cross-fade from the messy page into the formatted one.
        prev = Image.open(frames[i - 1]['file']).convert('RGB')
        for t in (0.2, 0.4, 0.6, 0.8):
            seq.append((band(Image.blend(prev, img, t), 'format'), 60))
    seq.append((band(img, f['scene']), f['ms']))

last = seq[-1][0]
card = end_card(last)
for t in (0.33, 0.66):
    seq.append((Image.blend(last, card, t), 70))
seq.append((card, 2800))

if SCALE != 1.0:
    seq = [(im.resize((round(im.width * SCALE), round(im.height * SCALE)), Image.LANCZOS), ms) for im, ms in seq]

# One palette for every frame keeps colours steady and the file small.
sample = Image.new('RGB', (seq[0][0].width, seq[0][0].height * 4))
for n, k in enumerate([0, len(seq) // 3, (2 * len(seq)) // 3, len(seq) - 1]):
    sample.paste(seq[k][0], (0, seq[0][0].height * n))
palette = sample.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
pal_frames = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im, _ in seq]

pal_frames[0].save(OUT, save_all=True, append_images=pal_frames[1:], duration=[ms for _, ms in seq],
                   loop=0, optimize=True, disposal=1)
import os
print(OUT, f'{os.path.getsize(OUT) / 1e6:.2f} MB', len(seq), 'frames', f'{sum(ms for _, ms in seq) / 1000:.1f} s',
      seq[0][0].size)
