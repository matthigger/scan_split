"""Build a shuffled scan stack and its expected sorted outputs.

Every input PDF is a duplex scan of one group (the group is the first two
characters of the file name, e.g. a1a3.pdf -> a1). Sheets (front + back page
pairs) are shuffled into one stack, test_in.pdf; each group's expected
output, test_out_<group>.pdf, lists that group's sheets in test_in order,
which is the order scan_split exports them. test_in_key.csv maps each
test_in sheet to its source:

    {sheet, group, file, pages}

Requires pypdf. Usage: python make_test_set.py in_dir out_dir [seed]
"""
import csv
import pathlib
import random
import sys

from pypdf import PdfReader, PdfWriter


def main():
    in_dir, out_dir = map(pathlib.Path, sys.argv[1:3])
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    out_dir.mkdir(parents=True, exist_ok=True)

    # (group, file name, reader, first page index)
    sheets = []
    for pdf in sorted(in_dir.glob('*.pdf')):
        reader = PdfReader(pdf)
        n = len(reader.pages)
        assert n % 2 == 0, f'{pdf.name}: odd page count, not a duplex scan'
        sheets += [(pdf.name[:2], pdf.name, reader, i) for i in range(0, n, 2)]
    random.Random(seed).shuffle(sheets)

    stack = PdfWriter()
    groups = {}
    for group, _, reader, i in sheets:
        stack.add_page(reader.pages[i])
        stack.add_page(reader.pages[i + 1])
        groups.setdefault(group, PdfWriter())
        groups[group].add_page(reader.pages[i])
        groups[group].add_page(reader.pages[i + 1])
    stack.write(out_dir / 'test_in.pdf')
    for group, writer in sorted(groups.items()):
        writer.write(out_dir / f'test_out_{group}.pdf')

    with open(out_dir / 'test_in_key.csv', 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['sheet', 'group', 'file', 'pages'])
        for k, (group, name, _, i) in enumerate(sheets, 1):
            w.writerow([k, group, name, f'{i + 1}-{i + 2}'])

    counts = {g: len(w.pages) // 2 for g, w in sorted(groups.items())}
    print(f'{len(sheets)} sheets -> test_in.pdf; per group: {counts}')


if __name__ == '__main__':
    main()
