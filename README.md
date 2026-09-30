# scan_split

Sort scanned exam pages into one PDF per question, in the browser.

**Use it:** https://matthigger.github.io/scan_split/

Drop in the scanner's PDFs.
The page learns the layout from the scans themselves (no template, header, or page count to configure), groups pages into page types, and lets you route each type, or any single sheet, to a named output PDF or discard it.
Exports copy the original scanned pages, so quality and file size are unchanged.
Nothing is uploaded; PDFs stay on your machine.

## How it matches pages

1. Each page is rendered small, inverted, blurred, high-passed (removes paper tint and scanner shading) and normalized; two pages' similarity is the dot product (normalized cross-correlation).
2. Near-empty pages are marked blank.
   In a duplex scan, consecutive pages pair into sheets; a sheet's front is the side with near-copies elsewhere in the stack, and the back always travels with it, even when a sheet was fed back-first.
3. Fronts are clustered into page types by bisecting k-means, splitting while the two halves' average images differ.
   Handwriting averages out, so each type's average is a clean picture of the printed page.

`proto/validate.py` is the reference implementation and its validation on real scans (shuffled sheets, flipped sheets, missing sheets, simulated colored paper).

## Files

- `index.html`, `style.css`, `js/app.js`: interface
- `js/pipeline.js`: matching (port of `proto/validate.py`)
- `vendor/`: pdf.js 4.10.38 and pdf-lib 1.17.1, served locally

Keep scans out of this repo: `test/` is git-ignored because real scans carry student names and IDs.

## Development

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/?src=test/a.pdf,test/b.pdf` to load local files by URL instead of dropping them.
