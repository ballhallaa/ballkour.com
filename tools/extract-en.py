#!/usr/bin/env python3
"""Rebuild locales/en.json (Weblate's source file) from the English text in index.html.

Run from the website folder after changing any English text:
    python3 tools/extract-en.py            # reads index.html
    python3 tools/extract-en.py page.html  # or another file
"""
import html
import json
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parent.parent
src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / "index.html"
text = src.read_text(encoding="utf-8")
strings = {}


def add(key, value):
    value = re.sub(r"\s+", " ", value).strip()
    if key in strings and strings[key] != value:
        sys.exit(f"Key {key!r} has two different English texts:\n  {strings[key]!r}\n  {value!r}")
    strings.setdefault(key, value)


# Plain text: <tag data-i18n="key">Text</tag>
for m in re.finditer(r'<(\w+)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>(.*?)</\1>', text, re.S):
    add(m.group(2), html.unescape(re.sub(r"<[^>]+>", "", m.group(3))))
# Text with <b>/<code>: <tag data-i18n-html="key">Text <b>bold</b></tag>
for m in re.finditer(r'<(\w+)\b[^>]*\bdata-i18n-html="([^"]+)"[^>]*>(.*?)</\1>', text, re.S):
    add(m.group(2), m.group(3))
# Attributes: data-i18n-aria="key" aria-label="..." and data-i18n-alt="key" alt="..."
for m in re.finditer(r"<[^>]*>", text):
    tag = m.group(0)
    for kind, attr in (("aria", "aria-label"), ("alt", "alt")):
        k = re.search(rf'\bdata-i18n-{kind}="([^"]+)"', tag)
        v = re.search(rf'\s{attr}="([^"]*)"', tag)
        if k and v:
            add(k.group(1), html.unescape(v.group(1)))
# Strings the script builds
dyn = re.search(r'<script type="application/json" id="i18n-dynamic">(.*?)</script>', text, re.S)
if dyn:
    for k, v in json.loads(dyn.group(1)).items():
        add(k, v)

out = root / "locales" / "en.json"
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(strings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Wrote {len(strings)} strings to {out}")
