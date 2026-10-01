"""Fake a scanned stack of filled-in DEMO 101 quizzes for the example.

Each fictional student's exam is five sheets of one quiz version: cover,
Q1, Q2 and the two pages of Q3, printed on the front with a blank back.
Question pages get messy fake handwriting: name and ID, several lines of
working with uneven baselines and pen pressure, crossed-out and scribbled
lines, arrows, circled answers, notes in the margins, a sketch on each
page's figure, the odd doodle, and erased pencil. Every page then gets scan
effects: slight rotation and offset, lamp shading, paper tone, blur, noise
and JPEG compression.

The stack carries the mistakes scan_split should handle: a missing Q2
sheet, a copy of Q3 missing its continuation page (an incomplete copy), two
sheets fed back-first, work continued on some backs, one skewed sheet and
one darker scan. Each student's sheets are contiguous and in order.

Writes demo_scans.pdf and demo_key.csv, one row per sheet in stack order:

    {sheet, student, version, page, flipped, back_work, scan}

    page (str): cover, q1, q2, q3p1 or q3p2
    flipped, back_work (int): 1 if fed back-first / back carries work
    scan (str): normal, skewed or dark

Usage: python make_scans.py fonts_dir [seed]
    fonts_dir holds handwriting .ttf files: Architects Daughter, Caveat,
    Covered By Your Grace, Gloria Hallelujah, Gochi Hand, Handlee, Indie
    Flower, Kalam, Nanum Pen Script, Nothing You Could Do, Patrick Hand,
    Reenie Beanie, Shadows Into Light (OFL), Homemade Apple, Just Another
    Hand, Schoolbell (Apache 2.0), all from Google Fonts. Templates are read
    from ../templates; doodles.json (see fetch_doodles.py) holds doodles
    from the Quick, Draw! Dataset (Google, CC BY 4.0).
"""
import csv
import glob
import json
import pathlib
import random
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

DPI = 100
HERE = pathlib.Path(__file__).parent
TEMPLATES = HERE.parent / 'templates'
OUT = HERE.parent
PAGES = ('cover', 'q1', 'q2', 'q3p1', 'q3p2')
# (page, version) -> (template file, page index)
TEMPLATE = {('cover', 'a'): ('cover.pdf', 0), ('cover', 'b'): ('cover.pdf', 0)}
for _v in 'ab':
    TEMPLATE |= {('q1', _v): (f'quiz1{_v}_q1_coins.pdf', 0),
                 ('q2', _v): (f'quiz1{_v}_q2_boundary.pdf', 0),
                 ('q3p1', _v): (f'quiz1{_v}_q3_logistic.pdf', 0),
                 ('q3p2', _v): (f'quiz1{_v}_q3_logistic.pdf', 1)}
# figure axes in px per unit at DPI, by version, from the tikz scales in
# page.tex
CM = DPI / 2.54
AXES = {'q2': {'a': (0.85 * CM, 0.85 * CM), 'b': (0.7 * CM, 0.7 * CM)},
        'q3p2': {'a': (1.6 * CM, 4.2 * CM), 'b': (1.25 * CM, 3.6 * CM)}}
# row of the name box's write-in rules, as a fraction of page height
NAME_RULE = 0.108

NAMES = ['Avery Chen', 'Jordan Blake', 'Priya Natarajan', 'Sam Okafor',
         'Riley Moreno', 'Taylor Brooks', 'Mina Haddad', 'Leo Fischer',
         'Kai Yamamoto', 'Noor Rahman', 'Elena Petrova', 'Diego Ramos',
         'Grace Kim', 'Omar Sutherland', 'Hana Novak', 'Felix Adeyemi',
         'Ines Duarte', 'Marcus Webb', 'Lena Hoffmann', 'Theo Castillo',
         'Asha Menon', 'Jonah Pierce', 'Sofia Lindqvist', 'Ravi Kapoor']

# working per (page, version): one block of lines per free band of the
# page, top to bottom; a block's last line is its answer
WORK = {
    ('q1', 'a'): [[
        'P(L|K=2) = P(K=2|L) P(L) / P(K=2)',
        'P(K=2|L) = .384    P(K=2|F) = .375',
        'P(K=2) = P(K=2|L)P(L) + P(K=2|F)P(F)',
        '= .384(.4) + .375(.6)', '= .1536 + .225', '= .3786',
        'P(L|K=2) = .1536 / .3786', '~ 0.406']],
    ('q1', 'b'): [[
        'P(H|K=3) = P(K=3|H) P(H) / P(K=3)',
        'P(K=3|H) = .4116    P(K=3|G) = .25',
        'P(K=3) = P(K=3|H)P(H) + P(K=3|G)P(G)',
        '= .4116(.25) + .25(.75)', '= .1029 + .1875', '= .2904',
        'P(H|K=3) = .1029 / .2904', '~ 0.354']],
    ('q2', 'a'): [[
        'slope = (5 - (-3)) / (3.5 - (-2))', '= 8 / 5.5 ~ 1.45',
        'x2 + 3 = 1.45 (x1 + 2)', 'x2 = 1.45 x1 - 0.09',
        'w = [1.45, -1], b = -0.09', 'x = [3,1]: 4.36 - 1 - .09 > 0',
        '-> class 1, wrong side! flip', '(b) no, any c > 0 scales (w, b)',
        'w = [-1.45, 1], b = 0.09']],
    ('q2', 'b'): [[
        'slope = (-1 - 2.5) / (5 - (-4))', '= -3.5 / 9 ~ -0.39',
        'x2 - 2.5 = -0.39 (x1 + 4)', 'x2 = -0.39 x1 + 0.94',
        'x = [-1,3]: -.39 + 3 - .94', '= 1.67 > 0 -> class 1 ok',
        '(b) not unique: c w, c b, c > 0', 'w = [0.39, 1], b = -0.94']],
    ('q3p1', 'a'): [
        ['z = 0.8(3) - 2 = 0.4', 'sigma(0.4) = 1 / (1 + e^-0.4)',
         '= 1 / 1.670', 'P(pass | x=3) ~ 0.60'],
        ['z = -1.2, -0.4, 1.2, 2', 'p = .231, .401, .769, .881',
         'L = -[ln(.769) + ln(.599) + ln(.769) + ln(.881)]',
         '= .263 + .513 + .263 + .127', 'L ~ 1.17']],
    ('q3p1', 'b'): [
        ['z = 0.5(4) - 1.5 = 0.5', 'sigma(0.5) = 1 / (1 + e^-0.5)',
         '= 1 / 1.607', 'P(pass | x=4) ~ 0.62'],
        ['z = -1, -.5, 0, 1, 1.5', 'p = .269, .378, .5, .731, .818',
         'L = -[ln(.731) + ln(.622) + ln(.5) + ln(.731) + ln(.818)]',
         '= .313 + .475 + .693 + .313 + .201', 'L ~ 2.00']],
    ('q3p2', 'a'): [
        ['dL/dw = .231(1) + .401(2) - .231(4) - .119(5)',
         '= .231 + .802 - .924 - .595 = -.486',
         'dL/db = .231 + .401 - .231 - .119 = .282',
         'w = .8 - .1(-.486) = .849', 'b = -2 - .1(.282) = -2.03'],
        ['switch where wx + b = 0', 'x = 2 / 0.8 = 2.5 hours']],
    ('q3p2', 'b'): [
        ['dL/dw = .269 + .378(2) - .5(3) - .269(5) - .182(6)',
         '= .269 + .756 - 1.5 - 1.345 - 1.092 = -2.91',
         'dL/db = .269 + .378 - .5 - .269 - .182 = -.304',
         'w = .5 - .05(-2.91) = .646', 'b = -1.5 - .05(-.304) = -1.48'],
        ['P = .5 where z = 0', 'x = 1.5 / .5 = 3 hours']],
}
# plausible wrong lines, crossed out where they were written
WRONG = {
    'q1': ['P(L|K=2) = .384', '= .384(.6) + .375(.4)', 'P(K=2) = .759',
           '3C2 (.8)^2 (.2) = ', 'P(H|K=3) = .4116', '4C3 (.7)^3 (.3)'],
    'q2': ['slope = 5.5/8', 'w = [1, 1.45]', 'b = 3', 'w.x + b < 0 ?',
           'w = [9, 3.5]'],
    'q3p1': ['sigma(0.4) = 0.4', 'L = .231 + .401 + .769', 'p = e^z',
             'ln(0) ??'],
    'q3p2': ['w = .8 + .1(-.486)', 'dL/dw = .282', 'x = 0.5',
             'b = -2 + .03'],
}
MARGIN_NOTES = ['?', 'check', 'units?', 'ans', 'redo', '!!', 'hmm', '<-',
                'see below', 'x2?']
SCRATCH = ['.384 x .4 = .1536', '.6 x .375 = .225', 'e^-0.4 = .670',
           '1 + 1.49 = 2.49', '1/2.49 = .401', 'ln .5 = -.693',
           '3.5/9 = .389', '8/5.5 = 1.4545', '.1029/.2904', '2 x .378 = .756']


def render_template(pdf: pathlib.Path, page: int):
    """Render one template page as ink in [0, 1] (1 = black).

    Returns:
        ink (np.array): (H, W) float
    """
    with tempfile.TemporaryDirectory() as t:
        subprocess.run(['pdftoppm', '-r', str(DPI), '-gray', '-png', '-f',
                        str(page + 1), '-l', str(page + 1), str(pdf),
                        f'{t}/p'], check=True)
        img = Image.open(glob.glob(f'{t}/p*.png')[0]).convert('L')
    return 1 - np.asarray(img, float) / 255


def free_bands(tpl, min_h: int = 90) -> list:
    """Find the blank horizontal bands of a page, where students write.

    Args:
        tpl (np.array): (H, W) template ink

    Returns:
        bands (list): (y0, y1) px per band, top to bottom
    """
    H, W = tpl.shape
    empty = tpl[:, int(0.1 * W):int(0.9 * W)].max(1) < 0.15
    bands, y, stop = [], int(0.13 * H), int(0.89 * H)
    while y < stop:
        if empty[y]:
            y1 = y
            while y1 < stop and empty[y1]:
                y1 += 1
            if y1 - y >= min_h:
                bands.append((y + 8, y1 - 4))
            y = y1
        y += 1
    return bands


def origin(tpl) -> tuple:
    """Locate a figure's axes origin: where the thickest lines cross.

    Returns:
        ox, oy (int): px column of the x2 / P axis, row of the x1 / x axis
    """
    H, _ = tpl.shape
    dark = tpl > 0.8
    # below the name box, whose frame is the other long dark line
    lo = int(0.2 * H)
    oy = lo + int(dark[lo:].sum(1).argmax())
    ox = int(dark[lo:].sum(0).argmax())
    return ox, oy


def smooth_field(shape: tuple, rng: random.Random, cell: int = 60,
                 lo: float = 0.6, hi: float = 1.05):
    """Draw a smooth random field, the pen pressure across a page.

    Returns:
        f (np.array): shape, float in [lo, hi]
    """
    H, W = shape
    g = np.random.default_rng(rng.randint(0, 10**9)).uniform(
        0, 255, (H // cell + 2, W // cell + 2)).astype(np.uint8)
    f = np.asarray(Image.fromarray(g).resize((W, H), Image.BICUBIC), float)
    return lo + (hi - lo) * f / 255


def stamp(cov, patch, x: float, y: float, gain: float = 1.0):
    """Max-composite a coverage patch into cov with its top-left at (x, y).

    Parts falling off the page are clipped.
    """
    H, W = cov.shape
    h, w = patch.shape
    x, y = int(x), int(y)
    x0, y0, x1, y1 = max(x, 0), max(y, 0), min(x + w, W), min(y + h, H)
    if x0 >= x1 or y0 >= y1:
        return
    region = cov[y0:y1, x0:x1]
    np.maximum(region, gain * patch[y0 - y:y1 - y, x0 - x:x1 - x],
               out=region)


class Hand:
    """One student's handwriting and pen.

    Attributes:
        font (ImageFont.FreeTypeFont): sized so a digit's height and width
            average cap px, which evens out tall-narrow and short-wide fonts
        cap (float): nominal character size, px
        slant (float): mean glyph rotation, degrees
        tilt (float): mean baseline slope, px per px
        pencil (bool): pencil (light, grainy, erasable) rather than pen
        ink (float): darkness of a full-pressure stroke, 0..1
        pen (int): stroke width, px
        pitch (float): line spacing over cap
    """

    def __init__(self, fonts: list, rng: random.Random):
        path = rng.choice(fonts)
        self.cap = rng.uniform(11, 15)
        probe = ImageFont.truetype(str(path), 100)
        box = probe.getbbox('0')
        size = round(100 * self.cap / np.sqrt((box[3] - box[1])
                                              * probe.getlength('0')))
        self.font = ImageFont.truetype(str(path), size)
        self.slant = rng.uniform(-5, 4)
        self.tilt = rng.gauss(0, 0.012)
        self.pencil = rng.random() < 0.35
        self.ink = (rng.uniform(0.42, 0.6) if self.pencil
                    else rng.uniform(0.6, 0.85))
        self.pen = rng.choice([2, 2, 3])
        self.pitch = rng.uniform(2.0, 2.6)
        self.rng = rng
        self._glyphs = {}

    def glyph(self, ch: str) -> Image.Image:
        """Render one character, cached, on a padded canvas."""
        if ch not in self._glyphs:
            w = int(self.font.getlength(ch)) + 12
            g = Image.new('L', (w, int(self.font.size * 1.5) + 12), 0)
            ImageDraw.Draw(g).text((6, 6), ch, fill=255, font=self.font)
            self._glyphs[ch] = g
        return self._glyphs[ch]

    def line(self, text: str):
        """Render a line of text with a wandering, curved baseline.

        Each character is rotated and nudged on its own; the whole line is
        then sheared along a slope and a bow, so baselines are uneven.

        Returns:
            patch (np.array): (h, w) coverage in [0, 1]
            top (int): rows above the line's start that the shear added
        """
        rng = self.rng
        gh = int(self.font.size * 1.5) + 12
        width = int(sum(self.font.getlength(c) for c in text) * 1.12) + 24
        flat = np.zeros((gh + 8, width))
        x = 4.0
        for ch in text:
            adv = self.font.getlength(ch) * rng.uniform(0.9, 1.08)
            if ch != ' ':
                g = self.glyph(ch).rotate(self.slant + rng.gauss(0, 2.5),
                                          resample=Image.BILINEAR)
                a = np.asarray(g, float) / 255
                gy = int(np.clip(4 + rng.gauss(0, 1.3), 0, 8))
                w = min(a.shape[1], width - int(x))
                if w > 0:
                    region = flat[gy:gy + gh, int(x):int(x) + w]
                    np.maximum(region, a[:, :w], out=region)
            x += adv
        flat = flat[:, :int(x) + 8]
        w = flat.shape[1]
        u = np.arange(w)
        slope = self.tilt + rng.gauss(0, 0.012)
        bow = rng.gauss(0, 3)
        off = slope * u + bow * 4 * (u / w) * (1 - u / w)
        off = np.round(off - off.min()).astype(int)
        top = int(off[0])
        out = np.zeros((flat.shape[0] + off.max() + 1, w))
        rows = np.arange(flat.shape[0])[:, None] + off[None, :]
        out[rows, np.broadcast_to(u, flat.shape)] = flat
        return out, top

    def write(self, cov, text: str, x: float, y: float,
              gain: float = 1.0) -> tuple:
        """Write text with its baseline starting near (x, y + cap).

        Returns:
            box (tuple): (x0, y0, x1, y1) px bounding box of the line
        """
        patch, top = self.line(text)
        y0 = y - top - 6
        stamp(cov, patch, x, y0, gain * self.rng.uniform(0.85, 1.0))
        return x, y - 2, x + patch.shape[1] - 8, y + self.cap + 6

    def stroke(self, draw: ImageDraw.ImageDraw, pts, amp: float = 1.0,
               width: int = 0, gain: float = 1.0):
        """Draw a polyline by hand: densified, jittered and smoothed."""
        rng = self.rng
        pts = np.asarray(pts, float)
        seg = np.hypot(*np.diff(pts, axis=0).T)
        n = max(int(seg.sum() / 4), 5)
        t = np.interp(np.linspace(0, seg.sum(), n),
                      np.concatenate([[0], np.cumsum(seg)]),
                      np.arange(len(pts)))
        i = np.minimum(t.astype(int), len(pts) - 2)
        f = (t - i)[:, None]
        p = pts[i] * (1 - f) + pts[i + 1] * f
        jit = np.array([[rng.gauss(0, amp), rng.gauss(0, amp)]
                        for _ in range(n)])
        k = np.ones(5) / 5
        jit = np.stack([np.convolve(jit[:, j], k, 'same') for j in (0, 1)],
                       1)
        p = p + jit
        fill = int(255 * gain * rng.uniform(0.8, 1.0))
        draw.line([tuple(q) for q in p], fill=fill, width=width or self.pen,
                  joint='curve')

    def arrow(self, draw, a, b):
        """Draw an arrow from a to b."""
        a, b = np.asarray(a, float), np.asarray(b, float)
        self.stroke(draw, [a, (a + b) / 2 + self.rng.gauss(0, 4), b])
        d = (a - b) / (np.hypot(*(a - b)) + 1e-9) * 11
        for s in (0.5, -0.5):
            c, sn = np.cos(s), np.sin(s)
            self.stroke(draw, [b, b + [c * d[0] - sn * d[1],
                                       sn * d[0] + c * d[1]]], amp=0.3)

    def circle(self, draw, box):
        """Loop a wobbly ellipse around a box, overshooting its start."""
        x0, y0, x1, y1 = box
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        rx, ry = (x1 - x0) / 2 + 10, (y1 - y0) / 2 + 8
        a0 = self.rng.uniform(0, 2 * np.pi)
        t = np.linspace(a0, a0 + 2 * np.pi + self.rng.uniform(0.2, 0.6), 60)
        r = 1 + 0.06 * np.sin(3 * t + self.rng.uniform(0, 6))
        self.stroke(draw, np.stack([cx + rx * r * np.cos(t),
                                    cy + ry * r * np.sin(t)], 1), amp=0.6)

    def strike(self, draw, box, mode: str, doodles: list):
        """Cross out a box: one or two lines, a zigzag or a scribble."""
        rng = self.rng
        x0, y0, x1, y1 = box
        ym = (y0 + y1) / 2
        if mode == 'line':
            for k in range(rng.choice([1, 1, 2])):
                dy = 4 * k + rng.gauss(0, 2)
                self.stroke(draw, [(x0 - 4, ym + dy),
                                   (x1 + 4, ym + dy + rng.gauss(0, 3))])
        elif mode == 'zigzag':
            n = max(int((x1 - x0) / rng.uniform(5, 9)), 2)
            xs = np.linspace(x0, x1, n)
            ys = np.where(np.arange(n) % 2, y0 + 2, y1 - 2)
            self.stroke(draw, np.stack([xs, ys], 1), amp=1.2)
        else:
            d = rng.choice(doodles)
            sx, sy = (x1 - x0) / 255, (y1 - y0 + 6) / 255
            for xs, ys in d['drawing']:
                if len(xs) > 1:
                    self.stroke(draw, [(x0 + sx * u, y0 - 3 + sy * v)
                                       for u, v in zip(xs, ys)], amp=0.4)

    def doodle(self, draw, d: dict, x: float, y: float, size: float):
        """Draw a Quick, Draw! sketch scaled to size px at (x, y)."""
        s = size / 255
        for xs, ys in d['drawing']:
            if len(xs) > 1:
                self.stroke(draw, [(x + s * u, y + s * v)
                                   for u, v in zip(xs, ys)], amp=0.3)


def write_block(cov, draw, hand: Hand, lines: list, band: tuple,
                wrong: list, doodles: list, rng: random.Random,
                answer: bool = True) -> float:
    """Write one block of working down a band of the page.

    Some lines are skipped, wrong lines get written and crossed out, '='
    continuations are indented, a few lines run into the right margin,
    and the answer (last line, if answer) may be circled or boxed.

    Returns:
        y (float): px row below the last line written
    """
    H, W = cov.shape
    y0, y1 = band
    pitch = hand.cap * hand.pitch
    y = y0 + rng.uniform(4, 0.25 * pitch)
    left = rng.uniform(0.06, 0.15) * W
    keep = [ln for k, ln in enumerate(lines)
            if k == len(lines) - 1 or rng.random() > 0.15]
    if len(lines) > 3 and rng.random() < 0.35:
        keep.insert(rng.randint(0, len(keep) - 1), rng.choice(wrong))
    box = None
    for k, ln in enumerate(keep):
        if y + hand.cap > y1:
            break
        x = left + (rng.uniform(25, 45) if ln.startswith('=') else 0)
        x += rng.gauss(0, 6)
        # every so often a long line is squeezed in starting near the edge
        if rng.random() < 0.08:
            x = rng.uniform(0.02, 0.05) * W
        box = hand.write(cov, ln, x, y)
        if ln in wrong:
            hand.strike(draw, box, rng.choice(['line', 'zigzag', 'scribble']),
                        doodles)
        elif rng.random() < 0.06 and k < len(keep) - 1:
            # scratch out the last word only
            cut = box[0] + (box[2] - box[0]) * rng.uniform(0.6, 0.8)
            hand.strike(draw, (cut, box[1], box[2], box[3]),
                        rng.choice(['line', 'scribble']), doodles)
        elif rng.random() < 0.08:
            note = rng.choice(MARGIN_NOTES)
            nx = rng.uniform(0.86, 0.93) * W
            hand.write(cov, note, nx, y + rng.gauss(0, 6))
            if nx - 220 < box[2] < nx - 40:
                hand.arrow(draw, (box[2] + 6, (box[1] + box[3]) / 2),
                           (nx - 6, y + hand.cap / 2))
        y += pitch * rng.uniform(0.85, 1.2)
    if answer and box and box[1] >= y0:
        r = rng.random()
        if r < 0.35:
            hand.circle(draw, box)
        elif r < 0.55:
            x0, by0, x1, by1 = box
            hand.stroke(draw, [(x0 - 6, by0 - 4), (x1 + 6, by0 - 6),
                               (x1 + 8, by1 + 4), (x0 - 5, by1 + 6),
                               (x0 - 6, by0 - 6)], amp=0.6)
    return y


def sketch_tree(cov, draw, hand: Hand, version: str, x: float, y: float):
    """Sketch a Q1 probability tree with its top-left near (x, y)."""
    loaded, fair, p, k = (('L', 'F', '.4', '2') if version == 'a'
                          else ('H', 'G', '.25', '3'))
    c = hand.cap
    for dy, lab in ((-1, f'{loaded} {p}'), (1, fair)):
        hand.stroke(draw, [(x, y + 3 * c), (x + 6 * c, y + 3 * c + dy * 2.2
                                                * c)])
        hand.write(cov, lab, x + 6.5 * c, y + 2.4 * c + dy * 2.2 * c)
        hand.stroke(draw, [(x + 11 * c, y + 3 * c + dy * 2.2 * c),
                           (x + 15 * c, y + 3 * c + dy * 2.2 * c)])
        hand.write(cov, f'K={k}', x + 15.5 * c, y + 2.4 * c + dy * 2.2 * c)


def sketch_plot(cov, draw, hand: Hand, page: str, version: str, geo: dict,
                rng: random.Random):
    """Draw on a page's printed figure: Q2's normal vector, Q3's curve."""
    ox, oy = geo['origin']
    sx, sy = AXES[page][version]

    def px(u, v):
        return ox + sx * u, oy - sy * v

    if page == 'q2':
        mid, w = (((0.75, 1.0), (-1.45, 1.0)) if version == 'a'
                  else ((0.5, 0.75), (0.39, 1.0)))
        w = np.array(w) / np.hypot(*w) * rng.uniform(1.2, 1.8)
        if rng.random() < 0.25:
            w = -w
        tip = (mid[0] + w[0], mid[1] + w[1])
        hand.arrow(draw, px(*mid), px(*tip))
        tx, ty = px(*tip)
        hand.write(cov, 'w', tx + 6, ty - hand.cap)
        if rng.random() < 0.15:
            # hatch the side w points to
            d = np.array([w[1], -w[0]]) / np.hypot(*w)
            n = w / np.hypot(*w) * 0.35
            for t in np.linspace(-2, 2, rng.randint(4, 7)):
                a = np.array(mid) + d * t
                hand.stroke(draw, [px(*a), px(*(a + n + d * 0.2))], amp=0.4)
    else:
        w0, b0, xs, xmax = ((0.8, -2.0, 2.5, 7) if version == 'a'
                            else (0.5, -1.5, 3.0, 9))
        if rng.random() < 0.9:
            k = rng.uniform(0.7, 1.4)
            u = np.linspace(0, xmax, 40)
            v = 1 / (1 + np.exp(-k * (w0 * u + b0 + rng.gauss(0, 0.3))))
            hand.stroke(draw, [px(a, b) for a, b in zip(u, v)], amp=1.5)
        if rng.random() < 0.9:
            hand.stroke(draw, [px(xs, 0), px(xs, 0.55)], amp=0.6)
            x, y = px(xs, 0.6)
            hand.write(cov, f'{xs:g}', x - 8, y - hand.cap - 4)
        if rng.random() < 0.15:
            data = ([1, 2, 4, 5], [0, 0, 1, 1]) if version == 'a' else (
                [1, 2, 3, 5, 6], [0, 0, 1, 1, 1])
            for a, b in zip(*data):
                x, y = px(a, b)
                hand.stroke(draw, [(x - 5, y - 5), (x + 5, y + 5)], amp=0.3)
                hand.stroke(draw, [(x + 5, y - 5), (x - 5, y + 5)], amp=0.3)


def erase(cov, hand: Hand, text: str, x: float, y: float):
    """Leave a faint, smeared ghost of erased pencil."""
    patch, top = hand.line(text)
    img = Image.fromarray((patch * 255).astype(np.uint8))
    ghost = np.asarray(img.filter(ImageFilter.GaussianBlur(1.6)), float) / 255
    stamp(cov, ghost, x, y - top - 6, 0.22)


def fill(page: str, version: str, hand: Hand, name: str, sid: str,
         geo: dict, doodles: dict, back_work: bool, rng: random.Random):
    """Write a student's name, ID and working on one page.

    Args:
        page (str): one of PAGES, or 'back' for the back of a question page
        geo (dict): the (front) page's template and layout,
            {tpl, shape, bands, origin?, work?, q?, wrong?}; see main
        doodles (dict): 'sketch' and 'scribble' lists of doodles.json
        back_work (bool): the back carries work, so the front may say so

    Returns:
        ink (np.array): (H, W) handwriting darkness in [0, 1]
    """
    H, W = geo['shape']
    cov = np.zeros((H, W))
    layer = Image.new('L', (W, H), 0)
    draw = ImageDraw.Draw(layer)
    sketches = doodles['sketch']
    if page == 'cover':
        if rng.random() < 0.15:
            hand.doodle(draw, rng.choice(sketches), rng.uniform(0.7, 0.85) * W,
                        rng.uniform(0.85, 0.9) * H, rng.uniform(40, 70))
    elif page == 'back':
        y = rng.uniform(0.05, 0.08) * H
        hand.write(cov, rng.choice(['(cont.)', 'cont. from front',
                                    f'Q{geo["q"]} cont.']), 0.08 * W, y)
        pool = [ln for b in geo['work'] for ln in b] + SCRATCH
        lines = rng.sample(pool, min(len(pool), rng.randint(4, 11)))
        band = (y + hand.cap * hand.pitch, rng.uniform(0.45, 0.85) * H)
        write_block(cov, draw, hand, lines, band, WRONG[geo['wrong']],
                    doodles['scribble'], rng, answer=rng.random() < 0.3)
    else:
        rule = NAME_RULE * H - hand.cap - 3
        hand.write(cov, name, rng.uniform(0.2, 0.25) * W,
                   rule + rng.gauss(0, 2.5))
        hand.write(cov, sid, rng.uniform(0.71, 0.74) * W,
                   rule + rng.gauss(0, 2.5))
        blocks = WORK[(page, version)]
        bands = geo['bands']
        y = None
        for block, band in zip(blocks, bands):
            if page == 'q1' and rng.random() < 0.3:
                sketch_tree(cov, draw, hand, version,
                            rng.uniform(0.5, 0.65) * W,
                            rng.uniform(band[0], band[1] - 0.12 * H))
            y = write_block(cov, draw, hand, block, band, WRONG[page],
                            doodles['scribble'], rng)
            if rng.random() < 0.5 and y + 2 * hand.cap < band[1]:
                side = rng.sample(SCRATCH, rng.randint(1, 3))
                y = write_block(cov, draw, hand, side,
                                (y, band[1]), WRONG[page],
                                doodles['scribble'], rng, answer=False)
        if page in AXES:
            sketch_plot(cov, draw, hand, page, version, geo, rng)
        if back_work and y is not None and rng.random() < 0.7:
            x = rng.uniform(0.55, 0.65) * W
            yb = min(y, 0.9 * H)
            box = hand.write(cov, 'see back', x, yb)
            hand.arrow(draw, (box[2] + 4, yb + hand.cap / 2),
                       (box[2] + 50, yb + hand.cap / 2 + rng.gauss(0, 6)))
        if hand.pencil and rng.random() < 0.4:
            erase(cov, hand, rng.choice(blocks[0]), 0.1 * W,
                  rng.uniform(*bands[-1]))
        if rng.random() < 0.12:
            hand.doodle(draw, rng.choice(sketches),
                        rng.choice([0.01, 0.9]) * W,
                        rng.uniform(0.3, 0.85) * H, rng.uniform(30, 55))
    hw = np.maximum(cov, np.asarray(layer, float) / 255)
    hw *= smooth_field((H, W), rng)
    if hand.pencil:
        grain = np.random.default_rng(rng.randint(0, 10**9)).uniform(
            0.7, 1.0, (H, W))
        hw *= grain
    return np.clip(hw * hand.ink, 0, 1)


def scan(ink, rng: random.Random, kind: str = 'normal', skew: float = 0.0):
    """Turn an ink image into a gray scanned page.

    Args:
        ink (np.array): (H, W) darkness in [0, 1]
        kind (str): normal, skewed or dark (an over-dark exposure)
        skew (float): extra rotation for a skewed sheet, degrees

    Returns:
        img (Image.Image): (H, W) 8-bit gray scan
    """
    H, W = ink.shape
    paper = rng.uniform(205, 215) if kind == 'dark' else rng.uniform(240, 252)
    shade = 1 - rng.uniform(0, 0.05) * np.linspace(0, 1, H)[:, None]
    a = paper * shade * (1 - np.clip(ink, 0, 1) * 0.92)
    if kind == 'dark':
        # crushed shadows: ink goes nearly black
        a = 255 * (a / 255) ** 1.35
    img = Image.fromarray(a.clip(0, 255).astype(np.uint8))
    # feed jitter stays under a mm: the layout tree's split score is not
    # shift-tolerant, so larger offsets split a text-heavy page by offset
    img = img.rotate(rng.uniform(-0.4, 0.4) + skew, resample=Image.BILINEAR,
                     translate=(rng.uniform(-3, 3), rng.uniform(-3, 3)),
                     fillcolor=int(paper))
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    noise = np.random.default_rng(rng.randint(0, 10**9)).normal(
        0, 2.5, (H, W))
    return Image.fromarray((np.asarray(img, float) + noise).clip(0, 255)
                           .astype(np.uint8))


def main():
    fonts = sorted(pathlib.Path(sys.argv[1]).glob('*.ttf'))
    assert fonts, 'no .ttf handwriting fonts found'
    rng = random.Random(int(sys.argv[2]) if len(sys.argv) > 2 else 4)
    doodles = {'sketch': [], 'scribble': []}
    for d in json.loads((HERE / 'doodles.json').read_text()):
        doodles[d['kind']].append(d)
    geo = {}
    for (page, version), (pdf, k) in TEMPLATE.items():
        tpl = render_template(TEMPLATES / pdf, k)
        g = {'tpl': tpl, 'shape': tpl.shape, 'bands': free_bands(tpl)}
        if page in AXES:
            g['origin'] = origin(tpl)
        if page != 'cover':
            g |= {'work': WORK[(page, version)], 'q': page[1],
                  'wrong': page}
        geo[(page, version)] = g
    blank = np.zeros(geo[('q1', 'a')]['shape'])

    students = list(zip(NAMES, ['a', 'b'] * (len(NAMES) // 2)))
    rng.shuffle(students)
    sheets = [(n, v, p) for n, v in students for p in PAGES]
    # one student lost their Q2 sheet, another Q3's continuation page
    sheets.remove((*students[5], 'q2'))
    sheets.remove((*students[11], 'q3p2'))
    flip = set(rng.sample(range(len(sheets)), 2))
    odd = rng.sample([k for k in range(len(sheets)) if k not in flip], 2)
    kinds = {odd[0]: 'skewed', odd[1]: 'dark'}

    hands = {n: Hand(fonts, rng) for n, _ in students}
    ids = {n: f'00{rng.randint(1000000, 9999999)}' for n, _ in students}
    pages, key = [], []
    for k, (name, version, page) in enumerate(sheets):
        g = geo[(page, version)]
        on_back = page != 'cover' and rng.random() < 0.3
        front = np.maximum(g['tpl'], fill(page, version, hands[name], name,
                                          ids[name], g, doodles, on_back,
                                          rng))
        back = blank
        if on_back:
            back = fill('back', version, hands[name], name, ids[name], g,
                        doodles, False, rng)
        kind = kinds.get(k, 'normal')
        skew = 0.0
        if kind == 'skewed':
            skew = rng.choice([-1, 1]) * rng.uniform(1.5, 2)
        pair = [scan(front, rng, kind, skew), scan(back, rng, kind, skew)]
        if k in flip:
            pair.reverse()
        pages += pair
        key.append([k + 1, name, version, page, int(k in flip),
                    int(on_back), kind])

    pages[0].save(OUT / 'demo_scans.pdf', 'PDF', save_all=True,
                  append_images=pages[1:], resolution=DPI, quality=50)
    with open(OUT / 'demo_key.csv', 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['sheet', 'student', 'version', 'page', 'flipped',
                    'back_work', 'scan'])
        w.writerows(key)
    print(f'{len(sheets)} sheets, {len(pages)} pages -> demo_scans.pdf')


if __name__ == '__main__':
    main()
