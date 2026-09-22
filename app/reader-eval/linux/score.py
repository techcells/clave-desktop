# The scorer from src/readerEval/score.ts (itself a port of the phase-0 score.py), so these numbers
# compare with the Mac reader's: norm, lev, between, accuracy, accents.
import difflib, re, unicodedata

ACCENTED = "".join(map(chr, [0xe1, 0xe0, 0xe2, 0xe3, 0xe7, 0xe9, 0xea, 0xed, 0xf3, 0xf4, 0xf5, 0xfa,
                             0xc1, 0xc0, 0xc2, 0xc3, 0xc7, 0xc9, 0xca, 0xcd, 0xd3, 0xd4, 0xd5, 0xda]))


def norm(s):
    s = re.sub(r"\s+", " ", unicodedata.normalize("NFC", s))
    if s.startswith(" "):
        s = s[1:]
    if s.endswith(" "):
        s = s[:-1]
    return s


def lev(a, b):
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i]
        for j in range(1, len(b) + 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1])))
        prev = cur
    return prev[len(b)]


def between(text):
    m = re.search(r"STARTMARKER(.*)ENDMARKER", text, re.S | re.I)
    return (m.group(1), True) if m else (text, False)


def accuracy(ocr, truth):
    o, t = norm(ocr), norm(truth)
    return max(0.0, 1 - lev(o, t) / max(1, len(t)))


def accents(ocr, truth):
    o, t = unicodedata.normalize("NFC", ocr), unicodedata.normalize("NFC", truth)
    want = sum(t.count(c) for c in ACCENTED)
    got = sum(min(o.count(c), t.count(c)) for c in ACCENTED)
    return 1.0 if want == 0 else got / want


def word_diffs(ocr, truth, n=8):
    """The first few word-level differences, for reading why a case fell short."""
    a, b = norm(truth).split(" "), norm(ocr).split(" ")
    ops = difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()
    return [(" ".join(a[i1:i2]), " ".join(b[j1:j2])) for tag, i1, i2, j1, j2 in ops if tag != "equal"][:n]
