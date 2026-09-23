# L7: Firefox's window-title strings in every language pack the installed snap carries.
# Firefox 156 titles a window "<page> — " + `browser-main-window-default-title` (normal) or
# "<page> — " + `browser-main-private-window-title` (private; the `other` platform variant on Linux).
# Checks, for every language, the rule "read a Firefox window only when its title is the brand or
# ends with ' — <brand>'": the default title must be exactly the brand, and no private title may end
# with ' — <brand>' or be the brand. These are Firefox's own strings, not user data.
import glob, os, re, sys, zipfile

root = next((a for a in sys.argv[1:] if not a.startswith("-")), "/snap/firefox/current/usr/lib/firefox")
packs = sorted(glob.glob(os.path.join(root, "distribution/extensions/*/*.xpi")) + glob.glob(os.path.join(root, "distribution/extensions/*.xpi")))
BRAND = "Mozilla Firefox"


def message(text, key):
    """The value of `key`, with a PLATFORM() selector reduced to its `other` (default) variant."""
    match = re.search(r"^" + re.escape(key) + r"\s*=(.*(?:\n[ \t]+.*)*)", text, re.M)
    if match is None:
        return None
    body = match.group(1).strip()
    if body.startswith("{") and "->" in body.splitlines()[0]:
        variant = re.search(r"\*\[other\]\s*(.+)", body)
        body = variant.group(1).strip() if variant else None
    return None if body is None else body.replace("{ -brand-full-name }", BRAND)


def is_normal(title):
    return title == BRAND or title.endswith(" — " + BRAND)


rows, missing = [], []
for pack in packs:
    locale = os.path.basename(pack).split("@")[0].replace("langpack-", "")
    with zipfile.ZipFile(pack) as z:
        names = [n for n in z.namelist() if n.endswith("/browser/browser.ftl")]
        text = z.read(names[0]).decode("utf-8") if names else ""
    default = message(text, "browser-main-window-default-title")
    private = message(text, "browser-main-private-window-title")
    if default is None or private is None:
        missing.append(locale)
        continue
    rows.append((locale, default, private))

print("language packs:", len(packs), "| both strings found:", len(rows), "| missing:", missing)
print("default title not exactly the brand:", [(l, d) for l, d, _ in rows if d != BRAND])
print("private titles the rule would READ:", [(l, p) for l, _, p in rows if is_normal(p) or is_normal("<PAGE> — " + p)])
print("private titles that contain the English marker 'Private Browsing':", sum("Private Browsing" in p for _, _, p in rows))
if "-v" in sys.argv:
    for row in rows:
        print(row)
