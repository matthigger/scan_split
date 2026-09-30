"""Fake a scanned stack of filled-in DEMO 101 quizzes for the example.

Each fictional student's exam is three sheets (cover, Q1, Q2) of one quiz
version, printed on the front with a blank back. Question sheets get fake
handwriting (name, ID, working), then every sheet gets scan effects: slight rotation and
offset, paper tone, blur, noise and JPEG compression. The stack also
carries the mistakes scan_split should handle: one missing sheet, two
sheets fed back-first, and working written on some backs.

Writes demo_scans.pdf and demo_key.csv, one row per sheet in stack order:

    {sheet, student, version, page, flipped}

Usage: python make_scans.py fonts_dir [seed]
    fonts_dir holds handwriting .ttf files (e.g. Caveat, Gochi Hand, Kalam
    from Google Fonts, OFL); templates are read from ../templates.
"""
import csv
import glob
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

NAMES = ['Avery Chen', 'Jordan Blake', 'Priya Natarajan', 'Sam Okafor',
         'Riley Moreno', 'Taylor Brooks', 'Mina Haddad', 'Leo Fischer',
         'Kai Yamamoto', 'Noor Rahman', 'Elena Petrova', 'Diego Ramos',
         'Grace Kim', 'Omar Sutherland', 'Hana Novak', 'Felix Adeyemi',
         'Ines Duarte', 'Marcus Webb', 'Lena Hoffmann', 'Theo Castillo',
         'Asha Menon', 'Jonah Pierce', 'Sofia Lindqvist', 'Ravi Kapoor']

# answer snippets per (page, version); each is one written line
WORK = {
    ('q1', 'a'): ['P(L|K=2) = P(K=2|L) P(L) / P(K=2)', 'P(K=2) = .384(.4) + .375(.6)',
                  '= .1536 + .225 = .3786', '.1536 / .3786', '= 0.406', 'P(L) = 0.4'],
    ('q1', 'b'): ['P(H|K=3) = P(K=3|H) P(H) / P(K=3)', 'P(K=3) = .4116(.25) + .25(.75)',
                  '= .1029 + .1875 = .2904', '.1029 / .2904', '= 0.354', 'P(H) = 1/4'],
    ('q2', 'a'): ['slope = 8/5.5 ~ 1.45', 'x2 = 1.45 x1 - 0.1', 'w = [1.45, -1]',
                  'b = -0.1', 'w.x + b = 4.35 - 1 - .1 > 0 ??', 'flip sign: w = [-1.45, 1]',
                  'no - any c*w, c>0 works'],
    ('q2', 'b'): ['slope = -3.5/9 ~ -0.39', 'x2 = -0.39 x1 + 0.94', 'w = [0.39, 1]',
                  'b = -0.94', 'w.x + b = -.39 + 3 - .94 > 0', 'class 1 ok',
                  'not unique: scale by c > 0'],
    ('back', ''): ['(cont.)', 'check: .1536/.3786', 'redo arithmetic',
                   'w = [2, -3]?', 'scratch'],
}


def render_template(pdf):
    """Render a template's first page as ink in [0, 1] (1 = black)."""
    with tempfile.TemporaryDirectory() as t:
        subprocess.run(['pdftoppm', '-r', str(DPI), '-gray', '-png', '-f', '1',
                        '-l', '1', str(pdf), f'{t}/p'], check=True)
        img = Image.open(glob.glob(f'{t}/p*.png')[0]).convert('L')
    return 1 - np.asarray(img, float) / 255


class Hand:
    """One student's handwriting: font, size, slant and ink darkness."""

    def __init__(self, fonts, rng):
        self.font = ImageFont.truetype(str(rng.choice(fonts)), rng.randint(19, 25))
        self.slant = rng.uniform(-4, 3)
        # pencil to pen
        self.ink = rng.uniform(0.3, 0.6)
        self.rng = rng

    def write(self, ink, text, x, y):
        """Add text to an ink image at (x, y), jittering each character."""
        for ch in text:
            box = self.font.getbbox(ch)
            w = max(box[2], 1)
            if ch != ' ':
                glyph = Image.new('L', (w + 12, self.font.size + 20), 0)
                ImageDraw.Draw(glyph).text((6, 4), ch, fill=255, font=self.font)
                glyph = glyph.rotate(self.slant + self.rng.gauss(0, 3), resample=Image.BILINEAR)
                g = np.asarray(glyph, float) / 255 * self.ink
                gy = int(y + self.rng.gauss(0, 1.5))
                gx = int(x)
                h2, w2 = g.shape
                if 0 <= gy and gy + h2 < ink.shape[0] and 0 <= gx and gx + w2 < ink.shape[1]:
                    region = ink[gy:gy + h2, gx:gx + w2]
                    np.maximum(region, g, out=region)
            x += w * self.rng.uniform(0.92, 1.05)
        return x

    def strike(self, ink, x0, x1, y):
        """Cross out a stretch of a line."""
        pts = np.linspace(x0, x1, 40)
        for a, b in zip(pts[:-1], pts[1:]):
            yy = int(y + self.rng.gauss(0, 1))
            ink[yy:yy + 3, int(a):int(b) + 1] = np.maximum(ink[yy:yy + 3, int(a):int(b) + 1], self.ink)


def fill(ink, page, version, hand, name, sid, rng):
    """Write a student's name, ID and working onto one page (in place)."""
    H, W = ink.shape
    if page in ('q1', 'q2'):
        hand.write(ink, name, 0.20 * W, 0.075 * H)
        hand.write(ink, sid, 0.70 * W, 0.075 * H)
        top = 0.40 if page == 'q1' else 0.60
        work = WORK[(page, version)]
        keep = set(rng.sample(range(len(work)), rng.randint(3, len(work))))
        lines = [w for i, w in enumerate(work) if i in keep]
    elif page == 'cover':
        return
    else:
        top = 0.08
        lines = rng.sample(WORK[('back', '')], rng.randint(2, 4))
    y = top * H
    for line in lines:
        x0 = rng.uniform(0.08, 0.2) * W
        x1 = hand.write(ink, line, x0, y)
        if rng.random() < 0.12:
            hand.strike(ink, x0, x1, y + hand.font.size * 0.55)
        y += hand.font.size * rng.uniform(1.4, 1.9)
        if y > 0.88 * H:
            break


def scan(ink, rng):
    """Turn an ink image into a gray scanned page."""
    paper = rng.uniform(240, 252)
    img = Image.fromarray((paper * (1 - np.clip(ink, 0, 1) * 0.92)).astype(np.uint8))
    img = img.rotate(rng.uniform(-0.8, 0.8), resample=Image.BILINEAR,
                     translate=(rng.uniform(-7, 7), rng.uniform(-7, 7)), fillcolor=int(paper))
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    a = np.asarray(img, float) + np.random.default_rng(rng.randint(0, 10**9)).normal(0, 2.5, img.size[::-1])
    return Image.fromarray(a.clip(0, 255).astype(np.uint8))


def main():
    fonts = sorted(pathlib.Path(sys.argv[1]).glob('*.ttf'))
    assert fonts, 'no .ttf handwriting fonts found'
    rng = random.Random(int(sys.argv[2]) if len(sys.argv) > 2 else 4)
    tpl = {
        ('cover', 'a'): render_template(TEMPLATES / 'cover.pdf'),
        ('q1', 'a'): render_template(TEMPLATES / 'quiz1a_q1_coins.pdf'),
        ('q2', 'a'): render_template(TEMPLATES / 'quiz1a_q2_boundary.pdf'),
        ('q1', 'b'): render_template(TEMPLATES / 'quiz1b_q1_coins.pdf'),
        ('q2', 'b'): render_template(TEMPLATES / 'quiz1b_q2_boundary.pdf'),
    }
    tpl[('cover', 'b')] = tpl[('cover', 'a')]
    blank = np.zeros_like(tpl[('q1', 'a')])

    students = list(zip(NAMES, ['a', 'b'] * (len(NAMES) // 2)))
    rng.shuffle(students)
    sheets = [(n, v, p) for n, v in students for p in ('cover', 'q1', 'q2')]
    # one student lost their Q2 sheet; two sheets go through back-first
    sheets.remove(next(s for s in sheets if s[2] == 'q2' and s[0] == students[5][0]))
    flip = set(rng.sample(range(len(sheets)), 2))

    hands = {n: Hand(fonts, rng) for n, _ in students}
    ids = {n: f'00{rng.randint(1000000, 9999999)}' for n, _ in students}
    pages, key = [], []
    for k, (name, version, page) in enumerate(sheets):
        front = tpl[(page, version)].copy()
        fill(front, page, version, hands[name], name, ids[name], rng)
        back = blank.copy()
        if page != 'cover' and rng.random() < 0.25:
            fill(back, 'back', version, hands[name], name, ids[name], rng)
        pair = [scan(front, rng), scan(back, rng)]
        if k in flip:
            pair.reverse()
        pages += pair
        key.append([k + 1, name, version, page, int(k in flip)])

    pages[0].save(OUT / 'demo_scans.pdf', 'PDF', save_all=True, append_images=pages[1:],
                  resolution=DPI, quality=55)
    with open(OUT / 'demo_key.csv', 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['sheet', 'student', 'version', 'page', 'flipped'])
        w.writerows(key)
    print(f'{len(sheets)} sheets, {len(pages)} pages -> demo_scans.pdf')


if __name__ == '__main__':
    main()
