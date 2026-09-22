# Scores every result file in out/linux against the truth and the reader's own thresholds
# (src/readerEval/thresholds.ts): the lowest case in a group must reach the bar, and Portuguese must
# keep every accent.
import glob, json, os, statistics, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from score import accents, accuracy, between, word_diffs  # noqa: E402

EVAL = os.path.dirname(HERE)
OUT = os.path.join(EVAL, "out", "linux")
THRESHOLDS = {"chat": 0.97, "ticket": 0.97, "terminal": 0.95, "pt": 0.95, "code": 0.90}
PT_ACCENTS_MIN = 1.0
truth = {g: open(os.path.join(EVAL, "truth", f"{g}.txt"), encoding="utf-8").read() for g in THRESHOLDS}


def group(case):
    return case.split("@")[0].split("-")[0]


runs = {}
for path in sorted(glob.glob(os.path.join(OUT, "tesseract-*.json"))):
    data = json.load(open(path))
    for config in next(iter(data["reads"].values())):
        runs[f"{config} {data['langs']} t{data['threads']}"] = {c: r[config] for c, r in data["reads"].items()}
if os.path.exists(os.path.join(OUT, "vision.json")):
    runs["apple-vision (rough)"] = json.load(open(os.path.join(OUT, "vision.json")))
if not runs:
    raise SystemExit("no results in " + OUT)

for name, reads in runs.items():
    print(f"\n{name}")
    for scale in ("@1x", "@2x"):
        cells, passed, worst = [], True, None
        for g, bar in THRESHOLDS.items():
            scores = []
            for case in (c for c in reads if group(c) == g and c.endswith(scale)):
                body, found = between(reads[case]["text"])
                score = accuracy(body, truth[g]) if found else 0.0
                scores.append((score, accents(body, truth[g]), case, found))
            low = min(scores)
            ok = low[0] >= bar and (g != "pt" or min(s[1] for s in scores) >= PT_ACCENTS_MIN)
            passed &= ok
            cell = f"{g} {low[0]:.3f}" + (f" accents {min(s[1] for s in scores):.2f}" if g == "pt" else "")
            cells.append(cell + ("" if ok else " SHORT"))
            if not ok and worst is None:
                worst = low
        ms = [r["ms"] for c, r in reads.items() if c.endswith(scale)]
        print(f"  {scale} {'PASS ' if passed else 'SHORT'} {' | '.join(cells)}")
        print(f"      ms per frame: median {statistics.median(ms):.0f}, max {max(ms):.0f}")
        if worst is not None:
            body, found = between(reads[worst[2]]["text"])
            print(f"      first short case {worst[2]}: " + (str(word_diffs(body, truth[group(worst[2])])) if found else "markers not read"))
