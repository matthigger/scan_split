#!/usr/bin/env bash
# Build the DEMO 101 page templates into ../templates (one PDF per question).
set -euo pipefail
cd "$(dirname "$0")"
tmp=$(mktemp -d)
build() {
  pdflatex -interaction=nonstopmode -halt-on-error -output-directory "$tmp" \
    -jobname="$1" "\\def\\ver{$2}\\def\\pg{$3}\\input{page}" > /dev/null
  cp "$tmp/$1.pdf" ../templates/
}
build cover a cover
for v in a b; do
  build "quiz1${v}_q1_coins" "$v" q1
  build "quiz1${v}_q2_boundary" "$v" q2
  build "quiz1${v}_q3_logistic" "$v" q3
done
rm -rf "$tmp"
ls ../templates
