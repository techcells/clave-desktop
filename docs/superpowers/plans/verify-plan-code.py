#!/usr/bin/env python3
"""Compare every path-labelled code block of a plan with the file on disk.

usage: verify-plan-code.py PLAN.md [TASK_NUMBER ...]
A block counts when the last non-empty line before its fence is exactly `path`: (one backticked path).
"Replace this / with this" blocks are not labelled that way and are skipped.
"""
import difflib, pathlib, re, sys

root = pathlib.Path(__file__).resolve().parents[3]
plan = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").split("\n")
wanted = set(sys.argv[2:])
LABEL = re.compile(r"^`((?:app|eval|docs)/[^`]+)`:$")

task, fence, bad, i = None, False, 0, 0
while i < len(plan):
    line = plan[i]
    if not fence:
        m = re.match(r"^### Task (\d+):", line)
        if m: task = m.group(1)
    if line.startswith("```"):
        if not fence and line != "```":
            j = i + 1
            while not plan[j].startswith("```"): j += 1
            k = i - 1
            while k >= 0 and plan[k].strip() == "": k -= 1
            label = LABEL.match(plan[k]) if k >= 0 else None
            if label and task and (not wanted or task in wanted):
                path = root / label.group(1)
                want = "\n".join(plan[i + 1:j]).rstrip("\n")
                if not path.exists():
                    bad += 1; print(f"task {task}: MISSING {label.group(1)}")
                else:
                    got = path.read_text(encoding="utf-8").rstrip("\n")
                    if got == want: print(f"task {task}: ok      {label.group(1)}")
                    else:
                        bad += 1; print(f"task {task}: DIFFERS {label.group(1)}")
                        for d in list(difflib.unified_diff(want.split("\n"), got.split("\n"), "plan", "disk", lineterm="", n=0))[:12]: print("    " + d)
            i = j
        else:
            fence = not fence
    i += 1
print("mismatches:", bad)
