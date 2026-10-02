"""Turns the screencast and its timeline into the README demo GIF.

Adds an eased mouse pointer, click ripples, captions placed where they cover
no code, cross-fades at the marked transitions, and an end card.
"""
import json
import math
import os
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO = 'C:/Users/stick/Desktop/classic-asp-language-support'
OUT = sys.argv[1] if len(sys.argv) > 1 else 'demo.gif'
FPS = 25
STEP = 1000 / FPS
FAST = 4.0          # how much faster a marked wait plays
GLOW = (110, 170, 255)  # caption border and glow

F = 'C:/Windows/Fonts/'
SEMI = ImageFont.truetype(F + 'seguisb.ttf', 17)
SUB = ImageFont.truetype(F + 'segoeui.ttf', 16)
KEY = ImageFont.truetype(F + 'CascadiaCode.ttf', 15)

data = json.load(open('cast.json'))
t0 = data['t0']
frames = [(f['t'] - t0, f['file']) for f in data['frames']]
events = sorted(({**e, 't': e['t'] - t0} for e in data['timeline']), key=lambda e: e['t'])
end_ev = next((e for e in events if e['type'] == 'end'), None)
END_REAL = end_ev['t'] if end_ev else max(frames[-1][0], events[-1]['t']) + 600


def ease(k):
    k = max(0.0, min(1.0, k))
    return 4 * k ** 3 if k < 0.5 else 1 - (-2 * k + 2) ** 3 / 2


# ── Time warp: marked waits play FAST times quicker ────────────────────────────
spans, start = [], None
for e in events:
    if e['type'] == 'fast':
        if e['on']:
            start = e['t']
        elif start is not None:
            spans.append((start, e['t']))
            start = None


def real_of(out_ms):
    """The recording time shown at a given GIF time."""
    real, out = 0.0, 0.0
    for a, b in spans:
        if out_ms <= out + (a - real):
            return real + (out_ms - out)
        out += a - real
        real = a
        span_out = (b - a) / FAST
        if out_ms <= out + span_out:
            return real + (out_ms - out) * FAST
        out += span_out
        real = b
    return real + (out_ms - out)


out_total = END_REAL - sum((b - a) * (1 - 1 / FAST) for a, b in spans)

# ── Base frames and cross-fades ────────────────────────────────────────────────
cache = {}


def load(path):
    if path not in cache:
        if len(cache) > 40:
            cache.clear()
        cache[path] = Image.open(path).convert('RGB')
    return cache[path]


def frame_index(t):
    lo, hi = 0, len(frames) - 1
    if t < frames[0][0]:
        return 0
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if frames[mid][0] <= t:
            lo = mid
        else:
            hi = mid - 1
    return lo


fades = []   # (start, dur, frame index before the change)
for e in events:
    if e['type'] == 'xfade':
        i = next((i for i, (ft, _) in enumerate(frames) if ft >= e['t']), None)
        if i is not None and i > 0:
            fades.append((frames[i][0], e['dur'], i - 1))


def base_at(t):
    img = load(frames[frame_index(t)][1])
    for start, dur, before in fades:
        if start <= t < start + dur:
            return Image.blend(load(frames[before][1]), img, ease((t - start) / dur))
    return img


# ── Pointer ────────────────────────────────────────────────────────────────────
moves = [e for e in events if e['type'] == 'move']
clicks = [e for e in events if e['type'] == 'click']
first = next(e for e in events if e['type'] == 'pointer')['at']


def pointer_at(t):
    pos = (first['x'], first['y'])
    for m in moves:
        if t < m['t']:
            break
        k = (t - m['t']) / m['dur']
        e = ease(k)
        pos = (m['from']['x'] + (m['to']['x'] - m['from']['x']) * e,
               m['from']['y'] + (m['to']['y'] - m['from']['y']) * e)
    return pos


ARROW = [(0, 0), (0, 17.5), (4.2, 13.6), (7.2, 20.4), (9.8, 19.3), (6.9, 12.6), (12.4, 12.6)]


def draw_pointer(img, x, y, scale):
    s = 1.25 * scale
    pts = [(x + px * s, y + py * s) for px, py in ARROW]
    shadow = Image.new('L', img.size, 0)
    ImageDraw.Draw(shadow).polygon([(px + 1.5, py + 2.5) for px, py in pts], fill=120)
    img.paste((0, 0, 0), (0, 0), shadow.filter(ImageFilter.GaussianBlur(2.2)))
    d = ImageDraw.Draw(img)
    d.polygon(pts, fill=(255, 255, 255), outline=(10, 10, 10))
    d.line(pts + [pts[0]], fill=(10, 10, 10), width=1)


def draw_ripples(img, t):
    over = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    drew = False
    for c in clicks:
        k = (t - c['t']) / 420
        if 0 <= k <= 1:
            r = 5 + 20 * ease(k)
            a = int(170 * (1 - k))
            x, y = c['at']['x'], c['at']['y']
            d.ellipse([x - r, y - r, x + r, y + r], outline=(120, 180, 255, a), width=3)
            d.ellipse([x - r * 0.45, y - r * 0.45, x + r * 0.45, y + r * 0.45], fill=(120, 180, 255, a // 3))
            drew = True
    if drew:
        img.paste(over, (0, 0), over)


def press_scale(t):
    for c in clicks:
        k = (t - c['t']) / 160
        if 0 <= k <= 1:
            return 1 - 0.12 * math.sin(math.pi * k)
    return 1.0


# ── Captions ───────────────────────────────────────────────────────────────────
def caption_image(parts):
    d0 = ImageDraw.Draw(Image.new('RGB', (1, 1)))
    pieces, x = [], 0
    for p in parts:
        if p.get('plus'):
            w = d0.textlength('+', font=SEMI)
            pieces.append(('plus', x, w)); x += w + 6
        elif 'k' in p:
            w = d0.textlength(p['k'], font=KEY) + 16
            pieces.append(('key', x, w, p['k'])); x += w + 6
        elif 's' in p:
            x += 4 if pieces and pieces[-1][0] in ('key', 'plus') else 0
            w = d0.textlength(p['s'], font=SEMI)
            pieces.append(('text', x, w, p['s'])); x += w + 8
        elif 'sub' in p:
            w = d0.textlength(p['sub'], font=SUB) + 18
            pieces.append(('sub', x + 2, w, p['sub'])); x += w + 10
    pad_x, pad_y, h_in = 13, 9, 26
    w, h = int(x - 8 + pad_x * 2), h_in + pad_y * 2
    shadow_pad = 14
    size = (w + shadow_pad * 2, h + shadow_pad * 2)
    # A soft blue glow around the box, so it stands out on dark and light themes alike.
    glow = Image.new('L', size, 0)
    ImageDraw.Draw(glow).rounded_rectangle([shadow_pad - 1, shadow_pad - 1, shadow_pad + w + 1, shadow_pad + h + 1], radius=12, fill=200)
    img = Image.new('RGBA', size, GLOW + (0,))
    img.putalpha(glow.filter(ImageFilter.GaussianBlur(5)))
    d = ImageDraw.Draw(img)
    ox, oy = shadow_pad, shadow_pad
    d.rounded_rectangle([ox, oy, ox + w, oy + h], radius=11, fill=(26, 27, 34, 250), outline=GLOW + (255,), width=2)
    cy = oy + h / 2
    for piece in pieces:
        kind, px = piece[0], ox + pad_x + piece[1]
        if kind == 'plus':
            d.text((px, cy), '+', font=SEMI, fill=(150, 150, 160), anchor='lm')
        elif kind == 'key':
            kw, label = piece[2], piece[3]
            d.rounded_rectangle([px, cy - 13, px + kw, cy + 12], radius=5, fill=(70, 70, 80), outline=(110, 110, 122))
            d.line([px + 4, cy + 12, px + kw - 4, cy + 12], fill=(40, 40, 46), width=2)
            d.text((px + kw / 2, cy - 1), label, font=KEY, fill=(240, 240, 245), anchor='mm')
        elif kind == 'text':
            d.text((px, cy), piece[3], font=SEMI, fill=(245, 245, 250), anchor='lm')
        elif kind == 'sub':
            sw, label = piece[2], piece[3]
            d.rounded_rectangle([px, cy - 12, px + sw, cy + 12], radius=12, fill=(46, 60, 86, 255), outline=(98, 140, 200, 255))
            d.text((px + sw / 2, cy), label, font=SUB, fill=(200, 225, 255), anchor='mm')
    return img, w, h, shadow_pad


def overlaps(a, b, m=9):
    return a[0] < b[0] + b[2] + m and b[0] < a[0] + a[2] + m and a[1] < b[1] + b[3] + m and b[1] < a[1] + a[3] + m


def place(w, h, anchor, obstacles, pointer):
    ax, ay = anchor['x'], anchor['y']
    x0, y0, x1, y1 = obstacles['area']
    rects = list(obstacles['rects']) + [[pointer[0] - 4, pointer[1] - 4, 24, 32]]
    want = (ax + 26, ay - h / 2)
    best, best_cost = None, None
    for y in range(int(y0), int(y1 - h), 6):
        for x in range(int(x0), int(x1 - w), 8):
            cand = (x, y, w, h)
            if any(overlaps(cand, r) for r in rects):
                continue
            cost = math.hypot(x - want[0], (y - want[1]) * 1.4)
            if x + w < ax:
                cost += 80      # prefer to the right of what it talks about
            if best_cost is None or cost < best_cost:
                best, best_cost = (x, y), cost
    return best or want


captions = []   # resolved: (t, image, x, y, key) or (t, None)
for e in events:
    if e['type'] != 'caption':
        continue
    if not e['parts']:
        captions.append({'t': e['t'], 'img': None})
        continue
    img, w, h, pad = caption_image(e['parts'])
    prev = captions[-1] if captions else None
    if prev and prev['img'] is not None and prev['lead'] == e['parts'][0]:
        # A caption that only changes its ending (the theme name) stays put.
        x, y = prev['x'] + pad, prev['y'] + pad
    else:
        x, y = place(w, h, e['anchor'], e['obstacles'], pointer_at(e['t']))
    captions.append({'t': e['t'], 'img': img, 'x': x - pad, 'y': y - pad, 'key': json.dumps(e['parts']), 'lead': e['parts'][0]})


def draw_captions(img, t):
    shown = [c for c in captions if c['t'] <= t]
    if not shown:
        return
    cur = shown[-1]
    prev = shown[-2] if len(shown) > 1 else None
    since = t - cur['t']
    layers = []
    same = prev and prev['img'] is not None and cur['img'] is not None and prev['key'] == cur['key']
    if same:
        k = ease(since / 300)
        layers.append((cur['img'], prev['x'] + (cur['x'] - prev['x']) * k, prev['y'] + (cur['y'] - prev['y']) * k, 1.0))
    else:
        if prev and prev['img'] is not None and since < 160:
            layers.append((prev['img'], prev['x'], prev['y'], 1 - since / 160))
        if cur['img'] is not None:
            k = ease((since - 60) / 200)
            layers.append((cur['img'], cur['x'], cur['y'] + 6 * (1 - k), k))
    for im, x, y, a in layers:
        if a <= 0:
            continue
        if a < 1:
            im = im.copy()
            im.putalpha(im.getchannel('A').point(lambda v: int(v * a)))
        img.paste(im, (int(round(x)), int(round(y))), im)


# ── End card ───────────────────────────────────────────────────────────────────
def end_card(last):
    w, h = last.size
    bg = Image.blend(last.filter(ImageFilter.GaussianBlur(7)), Image.new('RGB', last.size, (14, 14, 20)), 0.8)
    icon = Image.open(f'{REPO}/images/icon.png').convert('RGBA').resize((150, 150), Image.LANCZOS)
    cy = h // 2 - 60
    bg.paste(icon, (w // 2 - 75, cy - 150), icon)
    d = ImageDraw.Draw(bg)
    d.text((w // 2, cy + 30), 'Classic ASP Language Support', font=ImageFont.truetype(F + 'seguisb.ttf', 40), fill=(235, 235, 245), anchor='mm')
    d.text((w // 2, cy + 80), 'Formatter · IntelliSense · Go to Definition · Rename · Diagnostics',
           font=ImageFont.truetype(F + 'segoeui.ttf', 20), fill=(180, 184, 200), anchor='mm')
    pill, pf = 'Free on the VS Code Marketplace', ImageFont.truetype(F + 'seguisb.ttf', 20)
    tw = d.textlength(pill, font=pf)
    d.rounded_rectangle([w // 2 - tw / 2 - 22, cy + 122, w // 2 + tw / 2 + 22, cy + 166], radius=22, fill=(203, 166, 247))
    d.text((w // 2, cy + 144), pill, font=pf, fill=(17, 17, 27), anchor='mm')
    return bg


# ── Render ─────────────────────────────────────────────────────────────────────
seq = []
n = int(out_total / STEP)
for i in range(n):
    t = real_of(i * STEP)
    img = base_at(t).copy()
    draw_ripples(img, t)
    px, py = pointer_at(t)
    draw_pointer(img, px, py, press_scale(t))
    draw_captions(img, t)
    seq.append(img)

last = seq[-1]
card = end_card(last)
for k in range(1, 8):
    seq.append(Image.blend(last, card, ease(k / 8)))
hold_card = len(seq)
seq.append(card)

# One palette, built from frames across every theme.
picks = [seq[int(len(seq) * f)] for f in (0.02, 0.15, 0.4, 0.62, 0.8, 0.86, 0.9, 0.95)] + [card]
sample = Image.new('RGB', (picks[0].width, picks[0].height * len(picks)))
for j, p in enumerate(picks):
    sample.paste(p, (0, p.height * j))
palette = sample.quantize(colors=255, method=Image.Quantize.MEDIANCUT)

out, durs, prev_bytes = [], [], None
for j, im in enumerate(seq):
    q = im.quantize(palette=palette, dither=Image.Dither.NONE)
    b = q.tobytes()
    dur = 2800 if j == hold_card else STEP
    if b == prev_bytes:
        durs[-1] += dur
    else:
        out.append(q); durs.append(dur); prev_bytes = b
durs[-1] = max(durs[-1], 2800)
durs = [int(round(d / 10) * 10) for d in durs]

out[0].save(OUT, save_all=True, append_images=out[1:], duration=durs, loop=0, optimize=True, disposal=1)
print(OUT, f'{os.path.getsize(OUT) / 1e6:.2f} MB', len(out), 'frames', f'{sum(durs) / 1000:.1f} s')
