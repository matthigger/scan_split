"""Fetch a few Quick, Draw! doodles for the fake scans (doodles.json).

The Quick, Draw! Dataset (Google, CC BY 4.0,
https://github.com/googlecreativelab/quickdraw-dataset) holds 50 million
crowd-drawn sketches. Reads only the head of each category's simplified
ndjson (a ranged request, not the full file) and keeps the first recognized
drawings past the floors in WANT: dense scribbles to scratch out work, and
small sketches for the margins. Only strokes and key_id are kept.

Writes doodles.json, a list of records:

    {word, key_id, kind, drawing}

    kind (str): 'scribble' or 'sketch'
    drawing (list): strokes, each [xs, ys], ints in 0..255

Usage: python fetch_doodles.py
"""
import json
import pathlib
import urllib.parse
import urllib.request

URL = ('https://storage.googleapis.com/quickdraw_dataset/full/simplified/'
       '{}.ndjson')
# word -> (kind, number kept, min total stroke length in 0..255 units,
# min strokes); the length floor keeps scribbles dense enough to pass for
# scratched-out work, the stroke floor keeps smileys with eyes
WANT = {'squiggle': ('scribble', 6, 1500, 1),
        'hurricane': ('scribble', 3, 1500, 1),
        'zigzag': ('scribble', 3, 1500, 1),
        'star': ('sketch', 4, 0, 1),
        'smiley face': ('sketch', 3, 0, 4),
        'flower': ('sketch', 3, 0, 2),
        'sun': ('sketch', 3, 0, 6)}


def path_len(drawing) -> float:
    """Sum the lengths of a drawing's strokes."""
    total = 0.0
    for xs, ys in drawing:
        for i in range(1, len(xs)):
            total += ((xs[i] - xs[i - 1]) ** 2
                      + (ys[i] - ys[i - 1]) ** 2) ** 0.5
    return total


def head(word: str, n_bytes: int = 600_000) -> list:
    """Read the complete records in the first n_bytes of a category."""
    req = urllib.request.Request(URL.format(urllib.parse.quote(word)),
                                 headers={'Range': f'bytes=0-{n_bytes}'})
    with urllib.request.urlopen(req) as r:
        lines = r.read().decode().split('\n')[:-1]
    return [json.loads(line) for line in lines]


def main():
    out = []
    for word, (kind, n, min_len, min_strokes) in WANT.items():
        kept = 0
        for rec in head(word, 2_000_000):
            d = rec['drawing']
            if (rec['recognized'] and len(d) >= min_strokes
                    and path_len(d) >= min_len):
                out.append({'word': word, 'key_id': rec['key_id'],
                            'kind': kind, 'drawing': d})
                kept += 1
            if kept == n:
                break
    path = pathlib.Path(__file__).parent / 'doodles.json'
    path.write_text(json.dumps(out, separators=(',', ':')))
    print(f'{len(out)} doodles -> {path.name}')


if __name__ == '__main__':
    main()
