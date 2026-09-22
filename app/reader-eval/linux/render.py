# Renders the staged accuracy pages in Linux Chromium with Linux fonts, at 1x and 2x.
# The page is the one src/readerEval/pages.ts serves: same stylesheet, same truth, same markers.
import html, os, re
from playwright.sync_api import sync_playwright

TRUTH = "/w/truth"
IMG = "/w/out/linux/img"
STYLE = """
body{margin:24px;font:14px -apple-system,Helvetica,Arial,sans-serif;background:#fff;color:#1d1c1d}
body.dark{background:#1a1d21;color:#d1d2d3}
.marker{font:12px Menlo,monospace;opacity:1;margin:8px 0}
.chat .l{padding:3px 0}.chat .l.name{font-weight:700;margin-top:10px}
.ticket .l{padding:4px 0;border-bottom:1px solid #8883}
.code .l,.terminal .l{font-family:Menlo,Monaco,monospace;white-space:pre}
"""
# A dark GNOME-style terminal, standing in for the Terminal.app cases.
TERM_STYLE = """body{margin:8px;background:#1e1e1e;color:#e6e6e6;font:14px 'Ubuntu Mono','DejaVu Sans Mono',monospace}
.l,.marker{white-space:pre-wrap;word-break:break-all;line-height:1.25}"""
NAME_ROW = re.compile(r"\d\d:\d\d$")


def lines_of(name):
    lines = open(f"{TRUTH}/{name}.txt", encoding="utf-8").read().split("\n")
    return lines[:-1] if lines and lines[-1] == "" else lines


def page(name, theme, size):
    kind = "chat" if name == "pt" else name
    rows = "".join(
        f'<div class="{"l name" if kind == "chat" and NAME_ROW.search(l) else "l"}">{html.escape(l)}</div>'
        for l in lines_of(name))
    cls = kind + (" dark" if theme == "dark" else "")
    return (f'<!doctype html><meta charset="utf-8"><style>{STYLE}</style>'
            f'<body class="{cls}" style="font-size:{size}px">'
            f'<div class="marker">STARTMARKER</div>{rows}<div class="marker">ENDMARKER</div>')


def terminal():
    rows = "".join(f'<div class="l">{html.escape(l)}</div>' for l in lines_of("terminal"))
    return (f'<!doctype html><meta charset="utf-8"><style>{TERM_STYLE}</style><body>'
            f'<div class="marker">STARTMARKER</div>{rows}<div class="marker">ENDMARKER</div>')


def shoot(browser, html_text, width, height, scale, path):
    ctx = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=scale)
    pg = ctx.new_page()
    pg.set_content(html_text)
    pg.screenshot(path=path)
    ctx.close()


os.makedirs(IMG, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch()
    for scale in (1, 2):
        for name in ("chat", "ticket", "code", "pt"):
            for theme in ("light", "dark"):
                for size in (14, 11):
                    shoot(browser, page(name, theme, size), 1160, 640, scale, f"{IMG}/{name}-{theme}-{size}@{scale}x.png")
        for tname, cols in (("terminal", 140), ("terminal-narrow", 72)):
            shoot(browser, terminal(), 16 + int(cols * 7.7), 480, scale, f"{IMG}/{tname}@{scale}x.png")
    browser.close()
print("rendered", len(os.listdir(IMG)), "images")
