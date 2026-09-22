#!/usr/bin/env python3
"""Installs the C-2b-1 payload over app/, byte for byte, or refuses.

  python3 install.py <repo root> --check            nothing is written; says what would happen
  python3 install.py <repo root> --apply <backup>   copies, after saving every replaced file under <backup>
  python3 install.py <repo root> --verify           every installed file equals MANIFEST.sha256

Refuses (exit 1, nothing written) unless EVERY target is exactly what this payload was verified
against (PRE-MANIFEST.sha256; ABSENT = the file must not exist yet) or is already the payload's
version. That check is what `patch` rejecting a hunk was in plan C-2a.
"""
import hashlib, os, shutil, sys

here = os.path.dirname(os.path.abspath(__file__))

def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()

def manifest(name):
    rows = {}
    for line in open(os.path.join(here, name), encoding="utf-8"):
        if line.strip():
            digest, rel = line.rstrip("\n").split("  ", 1)
            rows[rel] = digest
    return rows

def main():
    if len(sys.argv) < 3 or sys.argv[2] not in ("--check", "--apply", "--verify"):
        sys.exit(__doc__)
    root, mode = os.path.abspath(sys.argv[1]), sys.argv[2]
    pre, post = manifest("PRE-MANIFEST.sha256"), manifest("MANIFEST.sha256")
    assert pre.keys() == post.keys(), "the two manifests list different files"
    for rel, digest in post.items():
        assert sha(os.path.join(here, "files", rel)) == digest, "payload file does not match MANIFEST: " + rel
    todo, done, bad = [], [], []
    for rel in sorted(post):
        target = os.path.join(root, rel)
        now = sha(target) if os.path.isfile(target) else "ABSENT"
        (done if now == post[rel] else todo if now == pre[rel] else bad).append(rel)
    if mode == "--verify":
        for rel in todo + bad:
            print("NOT INSTALLED", rel)
        print("INSTALLED %d of %d" % (len(done), len(post)))
        sys.exit(0 if len(done) == len(post) else 1)
    for rel in bad:
        print("REFUSED: not the verified version and not the payload's:", rel)
    if bad:
        sys.exit(1)
    print("to install: %d, already installed: %d" % (len(todo), len(done)))
    if mode == "--check":
        return
    if len(sys.argv) < 4:
        sys.exit("--apply needs a backup folder")
    backup = os.path.abspath(sys.argv[3])
    for rel in todo:
        target = os.path.join(root, rel)
        if os.path.isfile(target):
            saved = os.path.join(backup, rel)
            os.makedirs(os.path.dirname(saved), exist_ok=True)
            shutil.copyfile(target, saved)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(os.path.join(here, "files", rel), target)
        assert sha(target) == post[rel], rel
    print("INSTALL_OK %d files; replaced files saved under %s" % (len(todo), backup))

main()
