#!/usr/bin/env python3
"""Start the helper, shake hands with it, and report what came back — with nothing private in it.

Four scenarios, none of which reads a window:

  cold / warm  send one `permission`, close stdin. Expect `ready` first, then the answer, exit 0.
               Both runs are timed, because the first recognition of a fresh binary was measured at
               about 45 seconds in phase 0 and that cost must be paid before `ready`.
  noise        send a line that is not JSON and a line with an unknown op, then one `permission`.
               Expect exactly the same two lines back: the noise is ignored, not answered.
  shutdown     send `shutdown`. Expect `ready`, then exit 0.

Redaction: a line is printed verbatim only if it is one of the shapes that cannot contain anything
of the user's — `{"event": ...}` and `{"id": ..., "permission": ...}`. Anything else is reported by
its key names alone. The `read` and `frontWindow` ops are never sent.
"""

import json
import subprocess
import sys
import threading
import time

SAFE_TO_PRINT = ("event", "permission")
TIMEOUT_SECONDS = 180.0


def describe(line):
    """A printable form of one output line that cannot leak window text."""
    try:
        value = json.loads(line)
    except ValueError:
        return "<not json>"
    if not isinstance(value, dict):
        return "<not an object>"
    if any(key in value for key in SAFE_TO_PRINT) and "text" not in value and "window" not in value:
        return json.dumps(value, sort_keys=True)
    return "<object with keys %s>" % sorted(value)


def run(binary, sends, label):
    started = time.monotonic()
    process = subprocess.Popen(
        [binary],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=1,
        universal_newlines=True,
    )
    lines = []

    def reader():
        for line in process.stdout:
            lines.append((time.monotonic() - started, line.rstrip("\n")))

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()

    for message in sends:
        process.stdin.write(message + "\n")
        process.stdin.flush()
    process.stdin.close()

    try:
        process.wait(timeout=TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    thread.join(timeout=5.0)
    stderr = process.stderr.read()
    process.stderr.close()
    process.stdout.close()

    print("--- %s" % label)
    for elapsed, line in lines:
        print("    %7.3fs  %s" % (elapsed, describe(line)))
    print("    exit code: %s" % process.returncode)
    print("    stderr: %r" % stderr)
    return lines, process.returncode, stderr


def expect(condition, message):
    print("    %s %s" % ("PASS" if condition else "FAIL", message))
    return bool(condition)


def main():
    binary = sys.argv[1]
    ok = True

    for label in ("cold start", "warm start"):
        lines, code, stderr = run(binary, ['{"id":1,"op":"permission"}'], label)
        shapes = [describe(line) for _, line in lines]
        ok &= expect(shapes[:1] == ['{"event": "ready", "protocol": 2}'], "the first line is ready")
        ok &= expect(
            any(s.startswith('{"id": 1, "permission"') for s in shapes), "the permission answer came back"
        )
        ok &= expect(code == 0, "exit code 0 at stdin EOF")
        ok &= expect(stderr == "", "stderr is empty")
        if lines:
            print("    time to ready: %.3fs" % lines[0][0])

    lines, code, stderr = run(
        binary,
        ["this is not json", '{"id":2,"op":"explode"}', '{"op":"read"}', '{"id":3,"op":"permission"}'],
        "noise then one question",
    )
    shapes = [describe(line) for _, line in lines]
    ok &= expect(len(shapes) >= 2, "ready plus at least the one answer")
    ok &= expect(
        sum(1 for s in shapes if s.startswith('{"id": ')) == 1, "exactly one answer: the noise was ignored"
    )
    ok &= expect(any(s.startswith('{"id": 3, "permission"') for s in shapes), "and it is the answer to id 3")
    ok &= expect(code == 0, "exit code 0")
    ok &= expect(stderr == "", "stderr is empty")

    lines, code, stderr = run(binary, ['{"op":"shutdown"}'], "shutdown")
    shapes = [describe(line) for _, line in lines]
    ok &= expect(shapes[:1] == ['{"event": "ready", "protocol": 2}'], "the first line is ready")
    ok &= expect(not any(s.startswith('{"id": ') for s in shapes), "shutdown is not answered")
    ok &= expect(code == 0, "exit code 0")
    ok &= expect(stderr == "", "stderr is empty")

    print("\n%s" % ("ALL CHECKS PASSED" if ok else "SOME CHECKS FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
