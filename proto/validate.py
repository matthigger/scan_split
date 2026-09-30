"""Validate format-free page matching on real scans (prototype for the web UI).

Nothing about the exam layout is assumed: no header crop, no template, no
page count. From the scan alone the pipeline

    1. features: grayscale, invert, shrink, blur, high-pass, z-normalize
    2. duplex: pages pair into sheets if lag-2 similarity >> lag-1; blank
       pages are zeroed, and each sheet's front is the side that resembles
       other pages (the back tags along, never classified)
    3. page types: bisecting spherical k-means on sheet fronts, split while
       the two halves' consensus images differ (NCC < split_ncc)
    4. exam length: period of the sheet-type sequence (collated stacks only)

Ground truth comes from the test file names: a1a* are question-1 sheets,
a2a* question-2, each file strictly duplex. Tests:

    as_is      the 15 files concatenated (uncollated: all Q1, then all Q2)
    collated   real sheets re-ordered into exams [Q1, Q2], 5% sheets dropped
    shuffled   all sheets in random order, 15% fed back-first
    paper      collated, re-tinted to simulate colored paper in a gray scan

Usage: python validate.py [test_dir]
"""
import glob
import pathlib
import re
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

DPI = 30
WIDTH = 128

# gray-scan luminance of common paper stocks (Rec. 601 luma of sRGB)
PAPER = {'white': 254, 'yellow': 245, 'green': 233, 'blue': 218,
         'pink': 217, 'goldenrod': 194}


def render(test_dir: pathlib.Path, out_dir: pathlib.Path) -> tuple:
    """Render every page of every PDF to a low-dpi grayscale image.

    Returns:
        imgs (list): (h, w) float in [0, 255] per page, stack order
        src (list): (file stem, page index) per page
    """
    imgs, src = [], []
    for pdf in sorted(test_dir.glob('*.pdf')):
        subprocess.run(['pdftoppm', '-r', str(DPI), '-gray', '-png',
                        str(pdf), str(out_dir / pdf.stem)], check=True)
        pngs = glob.glob(str(out_dir / f'{pdf.stem}-*.png'))
        pngs.sort(key=lambda f: int(re.findall(r'-(\d+)\.png$', f)[0]))
        for i, f in enumerate(pngs):
            imgs.append(np.asarray(Image.open(f).convert('L'), float))
            src.append((pdf.stem, i))
    return imgs, src


def feat(img, high_pass: bool = True):
    """Build a unit-norm feature vector from one page image.

    The high-pass (subtract a wide blur) removes paper tint and scanner
    shading gradients, which would otherwise correlate across pages.

    Args:
        img (np.array): (h, w) grayscale in [0, 255], paper bright

    Returns:
        v (np.array): (d,) zero-mean, unit-norm
        energy (float): std of the filtered image; near zero for blank paper
    """
    ink = 255 - img
    im = Image.fromarray(ink.clip(0, 255).astype(np.uint8))
    h = round(WIDTH * im.height / im.width)
    x = np.asarray(im.resize((WIDTH, h), Image.BILINEAR), float)
    x = gaussian_filter(x, 1.0)
    if high_pass:
        x = x - gaussian_filter(x, 8.0)
    v = x.ravel() - x.mean()
    return v / (np.linalg.norm(v) + 1e-12), float(x.std())


def blank_mask(energy, frac: float = 0.1):
    """Flag pages with almost no ink structure as blank.

    Relative threshold: under frac of the median energy among the more-inked
    half of the stack. Blank paper still carries faint, repeatable scanner
    texture, so without this blank pages look like near-copies of each other.

    Args:
        energy (np.array): (n,) per-page energy from feat

    Returns:
        blank (np.array): (n,) boolean
    """
    return energy < frac * np.median(energy[energy >= np.median(energy)])


def lag_sim(f, max_lag: int = 12):
    """Compute mean NCC between pages k apart, k = 1..max_lag.

    Args:
        f (np.array): (n, d) unit-norm page features

    Returns:
        sim (np.array): (max_lag,) mean NCC at each lag
    """
    return np.array([np.mean(np.sum(f[:-k] * f[k:], 1))
                     for k in range(1, max_lag + 1)])


def shift_sim(f, cons, r: int = 3):
    """Compute best NCC of each page to each consensus over small shifts.

    Absorbs scanner feed offsets (a sheet placed a few mm off). r is in
    feature-grid cells.

    Args:
        f (np.array): (n, d) unit-norm page features
        cons (np.array): (k, d) unit-norm consensus features

    Returns:
        sim (np.array): (n, k) max over shifts of the overlap dot product
    """
    h = f.shape[1] // WIDTH
    a = f.reshape(len(f), h, WIDTH)
    b = cons.reshape(len(cons), h, WIDTH)
    best = np.full((len(f), len(cons)), -np.inf)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            ya = slice(max(0, -dy), h - max(0, dy))
            yb = slice(max(0, dy), h - max(0, -dy))
            xa, xb = (slice(max(0, -dx), WIDTH - max(0, dx)),
                      slice(max(0, dx), WIDTH - max(0, -dx)))
            s = np.einsum('nyx,kyx->nk', a[:, ya, xa], b[:, yb, xb])
            best = np.maximum(best, s)
    return best


def _unit(c):
    """Center and normalize rows."""
    c = c - c.mean(-1, keepdims=True)
    return c / (np.linalg.norm(c, axis=-1, keepdims=True) + 1e-12)


def _two_means(f, n_iter: int = 20):
    """Split rows of f into two clusters by spherical k-means.

    Seeded by the sign of each row's projection on the principal direction
    (Boley 1998, principal direction divisive partitioning): a printed
    difference between versions is one consistent direction, while
    handwriting spreads over many.
    """
    x = f - f.mean(0)
    v = x[np.argmax((x ** 2).sum(1))]
    for _ in range(25):
        v = x.T @ (x @ v)
        v /= np.linalg.norm(v) + 1e-12
    lab = (x @ v > 0).astype(int)
    if lab.min() == lab.max():
        return lab, _unit(np.array([f.mean(0), f.mean(0)]))
    c = _unit(np.array([f[lab == k].mean(0) for k in range(2)]))
    for _ in range(n_iter):
        new = (f @ c.T).argmax(1)
        if new.min() == new.max():
            break
        lab = new
        c = _unit(np.array([f[lab == k].mean(0) for k in range(2)]))
    return lab, c


def page_types(f, split_ncc: float = 0.8, min_size: int = 3):
    """Cluster pages into types by bisecting spherical k-means.

    A cluster is split when its two halves' consensus images (mean of
    member features) correlate below split_ncc: handwriting averages out of
    a consensus, so two halves of one printed page stay highly correlated,
    while two different printed pages do not.

    Args:
        f (np.array): (n, d) unit-norm page features

    Returns:
        lab (np.array): (n,) int type label, 0..k-1
        cons (np.array): (k, d) unit-norm consensus image per type
    """
    lab = np.zeros(len(f), int)
    queue = [0]
    while queue:
        k = queue.pop()
        idx = np.flatnonzero(lab == k)
        if idx.size < 2 * min_size:
            continue
        sub, c = _two_means(f[idx])
        if min(np.bincount(sub, minlength=2)) < min_size:
            continue
        if c[0] @ c[1] < split_ncc:
            new = lab.max() + 1
            lab[idx[sub == 1]] = new
            queue += [k, new]
    cons = _unit(np.array([f[lab == k].mean(0) for k in range(lab.max() + 1)]))
    # final assignment to nearest consensus, shift-tolerant
    lab = shift_sim(f, cons).argmax(1)
    return lab, cons


def period(lab, max_p: int = 8) -> int:
    """Estimate exam length (in sheets) from the sheet-type sequence.

    Picks the smallest lag whose label-agreement rate is within 90% of the
    best, so multiples of the true period are not preferred.

    Args:
        lab (np.array): (n,) int type label per sheet
    """
    agree = np.array([np.mean(lab[:-p] == lab[p:]) for p in range(1, max_p)])
    return int(np.flatnonzero(agree >= .9 * agree.max())[0] + 1)


def front_side(f, k: int = 5):
    """Pick which side of each duplex sheet is its printed front.

    The front is the side that resembles other pages in the stack: a
    printed page has many near-copies, a blank or free-hand back has none.
    The other side tags along with it.

    Args:
        f (np.array): (n, d) unit-norm page features, n even

    Returns:
        side (np.array): (n // 2,) int, 0 if the first page of the sheet is
            the front, 1 if the sheet was scanned back-first
    """
    s = f @ f.T
    np.fill_diagonal(s, -1)
    typicality = np.sort(s, 1)[:, -k:].mean(1)
    return (typicality[1::2] > typicality[0::2]).astype(int)


def run(imgs, truth, name: str, high_pass: bool = True):
    """Run the pipeline on one stack and print how it matches the truth.

    Args:
        imgs (list): (h, w) page images in stack order
        truth (list): true type label per page ('q1F', 'q1B', ...)
    """
    f, energy = map(np.array, zip(*[feat(im, high_pass) for im in imgs]))
    blank = blank_mask(energy)
    # blank pages match nothing
    f[blank] = 0
    ls = lag_sim(f)
    duplex = ls[1] > 3 * max(ls[0], .02)
    print(f'\n== {name}: {len(imgs)} pages, high_pass={high_pass}')
    print('   lag NCC:', ' '.join(f'{k}:{x:.2f}' for k, x in
                                  enumerate(ls[:8], 1)))
    print(f'   duplex detected: {duplex}   blank pages: {int(blank.sum())}')
    if not duplex:
        return
    side = front_side(f)
    i_front = 2 * np.arange(len(side)) + side
    front, truth_f = f[i_front], np.array(truth)[i_front]
    wrong_side = int(sum(not t.endswith('F') for t in truth_f))
    print(f'   sheets scanned back-first: {int(side.sum())}   '
          f'front side misidentified: {wrong_side}')
    lab, cons = page_types(front)
    print(f'   sheet types found: {lab.max() + 1}   '
          f'consensus NCC between types: '
          f'{np.round(cons @ cons.T, 2)[np.triu_indices(len(cons), 1)]}')
    err = 0
    for k in range(lab.max() + 1):
        t, c = np.unique(truth_f[lab == k], return_counts=True)
        err += c.sum() - c.max()
        print(f'     type {k}: {dict(zip(t.tolist(), c.tolist()))}')
    margin = np.sort(shift_sim(front, cons), 1)
    margin = margin[:, -1] - margin[:, -2] if len(cons) > 1 else margin[:, -1]
    print(f'   misrouted sheets: {err}/{len(lab)}   '
          f'min / median top-2 margin: {margin.min():.2f} / '
          f'{np.median(margin):.2f}')
    print(f'   estimated exam length: {period(lab)} sheet(s)')


def tint(img, paper: float, grad: float, rng):
    """Simulate a gray scan of one page printed on colored paper.

    Ink is multiplicative (absorbs a fraction of the paper's reflectance);
    grad adds a linear lamp-falloff shading across the page, and the scan
    gets sensor noise and paper-fiber texture.

    Args:
        img (np.array): (h, w) white-paper scan in [0, 255]
        paper (float): paper luminance, 0..255
        grad (float): fractional brightness drop from top to bottom edge
    """
    h, w = img.shape
    shade = 1 - grad * np.linspace(0, 1, h)[:, None] * np.ones((1, w))
    fiber = gaussian_filter(rng.normal(0, 4, (h, w)), 1.5)
    out = (img / 255) * paper * shade + fiber + rng.normal(0, 2, (h, w))
    return out.clip(0, 255)


def main():
    test_dir = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else
                            pathlib.Path(__file__).parents[1] / 'test')
    rng = np.random.default_rng(0)
    with tempfile.TemporaryDirectory() as tmp:
        imgs, src = render(test_dir, pathlib.Path(tmp))
    truth = [('q1' if s.startswith('a1') else 'q2') + 'FB'[i % 2]
             for s, i in src]

    run(imgs, truth, 'as_is (15 files concatenated)')

    # regroup real pages into sheets, then into collated exams [Q1, Q2]
    sheets = {'q1': [], 'q2': []}
    for n in range(0, len(imgs), 2):
        sheets[truth[n][:2]].append((imgs[n], imgs[n + 1]))
    n_exam = min(map(len, sheets.values()))
    order = []
    for e in range(n_exam):
        for q in ('q1', 'q2'):
            if rng.random() > .05:
                order.append((q, e))
    col_imgs = [p for q, e in order for p in sheets[q][e]]
    col_truth = [q + fb for q, e in order for fb in 'FB']
    print(f'\n(collated: {n_exam} exams, '
          f'{2 * n_exam - len(order)} sheets dropped)')
    run(col_imgs, col_truth, 'collated')

    # every sheet from every file in random order, 15% fed back-first
    all_sheets = [(q, s) for q in sheets for s in sheets[q]]
    shuf_imgs, shuf_truth = [], []
    for i in rng.permutation(len(all_sheets)):
        q, (front, back) = all_sheets[i]
        pages = [(front, q + 'F'), (back, q + 'B')]
        if rng.random() < .15:
            pages.reverse()
        shuf_imgs += [p for p, _ in pages]
        shuf_truth += [t for _, t in pages]
    run(shuf_imgs, shuf_truth, 'shuffled sheets, 15% flipped')

    # colored paper; each case assigns a paper per sheet
    cases = {
        'all yellow': lambda q, e: 'yellow',
        'Q2 on blue (color per question)': lambda q, e: (
            'blue' if q == 'q2' else 'white'),
        'random color per exam': lambda q, e: list(PAPER)[e % len(PAPER)],
    }
    for grad in (0.0, 0.08):
        for label, pick in cases.items():
            tinted = []
            for q, e in order:
                for p in sheets[q][e]:
                    tinted.append(tint(p, PAPER[pick(q, e)], grad, rng))
            for hp in (True, False):
                run(tinted, col_truth, f'paper: {label}, shading {grad}', hp)


if __name__ == '__main__':
    main()
