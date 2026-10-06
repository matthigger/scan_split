# scan_split

Sort scanned exam pages into one PDF per question, in the browser.

**Use it:** https://matthigger.github.io/scan_split/

Drop in the scanner's PDFs.
The page learns the layout from the scans themselves (no template, header, or page count to configure), groups pages into parts, and lets you route each part, or any single copy, to a named output PDF or discard it.
A part is one or more pages bound for one output (a question, even one spanning pages); a copy is one student's pages of it.
Optionally add page templates (the blank exam: one PDF of the whole exam, or one PDF per question): each sheet is then sorted to its closest template page, and any group of sheets no template matches is set aside as its own part.
Several template PDFs make a part each, named after the file; a single PDF makes a part per page, which you staple into multi-page parts on the page.
New users can try an example quiz (`demo/`), printed one-sided (blank backs scanned) or double-sided (questions on backs).
Exports copy the original scanned pages, so quality and file size are unchanged.
Nothing is uploaded; PDFs stay on your machine.

## How it matches pages

1. Each page is rendered small, inverted, blurred, high-passed (removes paper tint and scanner shading) and normalized; two pages' similarity is the dot product (normalized cross-correlation).
2. Near-empty pages are marked blank.
   In blank-back mode (detected when at least half of each file's page pairs 1-2, 3-4, … have a blank side; settable by hand) the scanner also captured each sheet's blank back, so consecutive pages pair into sheets: the front is the side with ink, and the back travels with it, even when a sheet was fed back-first.
   With blank-back mode off (backs carry questions or work), every page stands alone.
3. Fronts are clustered into layouts, one per printed page, by bisecting k-means, splitting while the two halves' average images differ.
   Handwriting averages out, so each layout's average is a clean picture of the printed page.
   Each sheet then goes to its closest layout, allowing a few mm of scanner offset.
   The splits form a tree built once: the default layouts stop where a split would only separate handwriting, and each one-page part's card can split further or merge back without resetting any routing.
4. Parts start as one layout each (or one template file each) and can be stapled (*staple to…*) into multi-page parts and unstapled again.
   Stapling is not merging: merge says two groups are the same printed page, staple says they are consecutive pages of one copy.
   A multi-page part's pages are assumed contiguous in the input: the stack is cut into copies, runs of consecutive sheets stepping through the part's pages in order (blank sheets skipped), and a run that breaks off or starts mid-part is flagged as an incomplete copy.
   Stapled pages take the templates' order, or else the order in which they most often follow each other in the stack; parts that never sit next to each other cannot be stapled.
   The comparison grid is fine enough to separate versions of one question that differ only in wording and numbers (quiz a vs b).

With templates, each sheet goes to its nearest template; within a template's sheets, a group (a genuine split of the same tree) whose average matches the template poorly, or clearly worse than the template's best group, is set aside, and set-aside sheets are grouped by their own tree.

Outputs keep the stack order, so each copy exports as a contiguous run (student A's pages of the part, then student B's, …), even when a student's other questions are elsewhere in the stack.
Re-routing any sheet of a multi-page copy moves the whole copy.

`proto/validate.py` is the reference implementation (its duplex test is broader than blank-back mode) and its validation on real scans (shuffled sheets, flipped sheets, missing sheets, simulated colored paper).

## Files

- `index.html`, `style.css`, `js/app.js`: interface
- `js/pipeline.js`: matching (port of `proto/validate.py`)
- `js/version.js`: footer build stamp; `.github/workflows/pages.yml` overwrites it with the commit and build time at deploy (`null` locally)
- `vendor/`: pdf.js 4.10.38 and pdf-lib 1.17.1, served locally
- `proto/make_test_set.py`: shuffle scans into one test stack plus its expected sorted outputs (needs pypdf)
- `demo/`: the examples: two fake scanned stacks of a fictional DEMO 101 quiz in two versions with a two-page Q3, printed one-sided (24 students) and double-sided (16 students), with generated handwriting (`src/make_scans.py`, needs handwriting .ttf fonts from Google Fonts, OFL or Apache 2.0, listed in its docstring); `*_key.csv` are their answer keys; `templates/` are the blank pages they are generated from (`src/page.tex`, `src/build.sh`); doodles come from the Quick, Draw! Dataset by Google, CC BY 4.0 (`src/doodles.json`, fetched by `src/fetch_doodles.py`)

Keep scans out of this repo: `test/` is git-ignored because real scans carry student names and IDs.

## Development

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/?src=test/a.pdf,test/b.pdf` to load local files by URL instead of dropping them; `&tpl=a.pdf,b.pdf` loads templates the same way, and `?example=one-sided` (or `double-sided`) loads an example.
