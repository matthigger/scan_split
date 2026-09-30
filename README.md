# scan_split

Sort scanned exam pages into one PDF per question, in the browser.

**Use it:** https://matthigger.github.io/scan_split/

Drop in the scanner's PDFs.
The page learns the layout from the scans themselves (no template, header, or page count to configure), groups pages into page types, and lets you route each type, or any single sheet, to a named output PDF or discard it.
Optionally add page templates (the blank exam pages, one PDF per page or per question): each sheet is then sorted to its closest template and named after it, and any group of sheets no template matches is set aside as its own type.
New users can click **load example** to try a fictional quiz stack (`demo/`).
Exports copy the original scanned pages, so quality and file size are unchanged.
Nothing is uploaded; PDFs stay on your machine.

## How it matches pages

1. Each page is rendered small, inverted, blurred, high-passed (removes paper tint and scanner shading) and normalized; two pages' similarity is the dot product (normalized cross-correlation).
2. Near-empty pages are marked blank.
   When the scanner also captured each sheet's (blank or written-on) back, consecutive pages pair into sheets; a sheet's front is the side with near-copies elsewhere in the stack, and the back always travels with it, even when a sheet was fed back-first.
3. Fronts are clustered into page types by bisecting k-means, splitting while the two halves' average images differ.
   Handwriting averages out, so each type's average is a clean picture of the printed page.
   Each sheet then goes to its closest type, allowing a few mm of scanner offset.
   The splits form a tree built once: the default types stop where a split would only separate handwriting, and each type card can split further or merge back without resetting any routing.
   The comparison grid is fine enough to separate versions of one question that differ only in wording and numbers (quiz a vs b).

With templates, each sheet goes to its nearest template; within a template's sheets, a group (a genuine split of the same tree) whose average matches the template poorly, or clearly worse than the template's best group, is set aside, and set-aside sheets are grouped by their own tree.

A question spanning several pages works too: route all of its page types to one output.
Outputs keep the stack order, so a stack of per-student runs (student A's question pages, then student B's, …) exports as the same contiguous runs, even when a student's other questions are elsewhere in the stack.

`proto/validate.py` is the reference implementation and its validation on real scans (shuffled sheets, flipped sheets, missing sheets, simulated colored paper).

## Files

- `index.html`, `style.css`, `js/app.js`: interface
- `js/pipeline.js`: matching (port of `proto/validate.py`)
- `vendor/`: pdf.js 4.10.38 and pdf-lib 1.17.1, served locally
- `proto/make_test_set.py`: shuffle scans into one test stack plus its expected sorted outputs (needs pypdf)
- `demo/`: the example: fictional DEMO 101 templates (`src/page.tex`, `src/build.sh`) and a fake scanned stack of 24 students with generated handwriting (`src/make_scans.py`, needs handwriting .ttf fonts such as Caveat, Gochi Hand, Kalam from Google Fonts); `demo_key.csv` is its answer key

Keep scans out of this repo: `test/` is git-ignored because real scans carry student names and IDs.

## Development

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/?src=test/a.pdf,test/b.pdf` to load local files by URL instead of dropping them; `&tpl=a.pdf,b.pdf` loads templates the same way, and `?example=templates` (or `scans`) loads the example.
