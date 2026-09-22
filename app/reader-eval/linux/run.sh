#!/usr/bin/env bash
# Linux text-recognition test: renders the staged pages in a Linux container, reads them with
# Tesseract (and, on a Mac, Apple Vision for reference), and scores both. See README.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
eval_dir="$(dirname "$here")"
out="$eval_dir/out/linux"
mkdir -p "$out"
docker build -q -t clave-tesseract-eval "$here" >/dev/null
run() { docker run --rm -v "$eval_dir:/w" "$@"; }
run clave-tesseract-eval python3 /w/linux/render.py
run -e OMP_THREAD_LIMIT=1 -e LANGS=por+eng clave-tesseract-eval python3 /w/linux/tesseract.py
run -e OMP_THREAD_LIMIT=1 -e LANGS=eng+por clave-tesseract-eval python3 /w/linux/tesseract.py
if [[ "$(uname)" == "Darwin" ]]; then swift "$here/vision.swift" "$out"; fi
python3 "$here/report.py"
