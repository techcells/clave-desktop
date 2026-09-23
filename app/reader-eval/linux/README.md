# Linux text-recognition test

Can Tesseract, the recogniser a Linux build would ship, read screens as well as the Mac reader has to?
This renders the same staged pages the Mac accuracy run uses (`../truth`, the stylesheet from
`src/readerEval/pages.ts`) in Linux Chromium with Linux fonts, at 1x and 2x, light and dark, 14 and
11 px, plus a wide and a narrow terminal. Tesseract reads them, and the result is scored with the
reader's own scorer and thresholds (`src/readerEval/score.ts`, `thresholds.ts`).

Needs Docker. From the repo root:

    app/reader-eval/linux/run.sh

Images and results go to `app/reader-eval/out/linux/` (ignored by git). Takes about ten minutes on
an M2. On a Mac it also runs Apple Vision on the same images, as a rough reference only: its lines
are ordered by a simple sort there, not by the reader's own code.

> **Note, 2026-09-24 (Linux plan, Task 11):** the app no longer ships the models measured here. Live reads with
> `tessdata_best` `por+eng` ran past the read budget a third of the time, so the owner chose `tessdata_fast`
> `por` alone (accents 0.98 against a Linux bar of 0.97) with a 2.5 s Linux read budget. That model is measured
> by the reader's own opt-in test (`recognition_meets_the_thresholds` in `native/reader/src/linux/recognise.rs`),
> not by this Docker harness, which still measures the models below. Numbers:
> `docs/superpowers/reviews/2026-09-23-linux-measurements.md`.

## Result, 2026-09-23 (M2, arm64 Ubuntu 24.04 in Docker, Tesseract 5.3.4)

Passes every threshold at 1x and 2x with **tessdata_best models, languages `por+eng` (Portuguese
first), and the image prepared** (grayscale, dark themes inverted, 1x enlarged to 2x):

| group    | bar         | 1x                   | 2x                   |
|----------|-------------|----------------------|----------------------|
| chat     | 0.97        | 0.994                | 0.994                |
| ticket   | 0.97        | 0.998                | 0.998                |
| terminal | 0.95        | 0.988                | 0.990                |
| pt       | 0.95 + 1.00 | 1.000, accents 1.00  | 1.000, accents 1.00  |
| code     | 0.90        | 0.975                | 0.979                |

- `eng+por` (English first) loses Portuguese accents (está to esta, não to nao) and fails the pt bar.
- The packaged fast models fail code at 1x without preparation (0.76).
- The remaining errors are `I` read as `|` in chat, and dropped backticks and underscores in code.
- About 700 ms per frame on one thread (max about 1.25 s), against about 80 ms for Apple Vision.
  Engine load about 0.1 s; the two best models are 23 MB.

Not covered: real, messy screens; x64 timing; how a Linux build captures the focused window
(Wayland).
