#!/usr/bin/env python3
"""Check the site before it's merged or deployed (.github/workflows/check.yml runs this on every pull request).

    python3 tools/check.py

- The scripts in index.html and 404.html, and cloudflare/*.js, parse (with Node: node --check)
- The JSON in the pages (the English text, the link-preview data) parses
- cloudflare/wrangler.toml parses
- Every translation in locales/ is a string, keeps English's {placeholders}, and only uses the tags the site allows
  (<b>, <code>, <kbd>, and the in-game colors <fgRRGGBBAA>), so nothing shows up as code on the page

Missing translations are only listed: Weblate fills them in. Exits with 1 if anything else is wrong.
"""
import html.parser
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGES = ["index.html", "404.html"]
problems = []


def problem(where, what):
    problems.append(f"{where}: {what}")


class Scripts(html.parser.HTMLParser):
    """Every <script> in a page: its type, where it starts, and what's in it"""

    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.found, self.open = [], None

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            a = dict(attrs)
            self.open = {"type": (a.get("type") or "").lower(), "src": a.get("src"), "line": self.getpos()[0], "text": ""}

    def handle_data(self, data):
        if self.open is not None:
            self.open["text"] += data

    def handle_endtag(self, tag):
        if tag == "script" and self.open is not None:
            self.found.append(self.open)
            self.open = None


def node_check(path, label):
    out = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
    if out.returncode:
        # Node's message, with the temporary file's name swapped for where the script really is, and without Node's own
        # stack trace
        lines = [l for l in out.stderr.replace(str(path), label).splitlines() if not l.startswith(("    at ", "Node.js v"))]
        problem(label, "\n    ".join(l for l in lines if l.strip()))


def check_scripts(tmp):
    for page in PAGES:
        parser = Scripts()
        parser.feed((ROOT / page).read_text(encoding="utf-8"))
        for i, s in enumerate(parser.found):
            where = f"{page}:{s['line']}"
            if s["src"]:
                continue
            if s["type"] in ("", "text/javascript", "module"):
                f = tmp / f"{page}.{i}.{'mjs' if s['type'] == 'module' else 'js'}"
                # Blank lines first, so Node's line numbers are the page's
                f.write_text("\n" * (s["line"] - 1) + s["text"], encoding="utf-8")
                node_check(f, page)
            elif "json" in s["type"]:
                try:
                    json.loads(s["text"])
                except json.JSONDecodeError as e:
                    problem(where, f"its JSON doesn't parse: {e}")


def check_worker(tmp):
    # As .mjs, so any Node version reads them as modules
    for f in sorted((ROOT / "cloudflare").glob("*.js")):
        copy = tmp / (f.stem + ".mjs")
        shutil.copyfile(f, copy)
        node_check(copy, f"cloudflare/{f.name}")
    try:
        tomllib.loads((ROOT / "cloudflare/wrangler.toml").read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as e:
        problem("cloudflare/wrangler.toml", f"doesn't parse: {e}")


ALLOWED_TAGS = {"b", "code", "kbd"}


def placeholders(s):
    return sorted(set(re.findall(r"\{(\w+)\}", s)))


def tags(s):
    return sorted({t.lower() for t in re.findall(r"</?\s*([a-zA-Z][\w-]*)", s)})


def check_locales():
    en_path = ROOT / "locales/en.json"
    en = json.loads(en_path.read_text(encoding="utf-8"))
    missing = {}
    for path in sorted((ROOT / "locales").glob("*.json")):
        if path == en_path:
            continue
        where = f"locales/{path.name}"
        try:
            d = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            problem(where, f"doesn't parse: {e}")
            continue
        if not isinstance(d, dict):
            problem(where, "isn't a JSON object")
            continue
        for key, value in d.items():
            if key not in en:
                continue  # Weblate takes keys English no longer has out on its own
            if not isinstance(value, str):
                problem(where, f"{key} isn't text")
                continue
            if not value.strip():
                continue
            if placeholders(value) != placeholders(en[key]):
                problem(where, f"{key} has {placeholders(value)} where English has {placeholders(en[key])}: {value!r}")
            allowed = ALLOWED_TAGS | set(tags(en[key]))
            odd = [t for t in tags(value) if t not in allowed and not re.fullmatch(r"fg[0-9a-f]{8}", t)]
            if odd:
                problem(where, f"{key} uses <{'>, <'.join(odd)}>, which the site shows as plain text: {value!r}")
        gaps = [k for k in en if not (isinstance(d.get(k), str) and d[k].strip())]
        if gaps:
            missing[path.stem] = len(gaps)
    if missing:
        print("Not translated yet (Weblate fills these in): " + ", ".join(f"{k} {v}" for k, v in missing.items()))


with tempfile.TemporaryDirectory() as t:
    tmp = pathlib.Path(t)
    check_scripts(tmp)
    check_worker(tmp)
check_locales()

if problems:
    print(f"{len(problems)} problem{'s' if len(problems) != 1 else ''}:")
    for p in problems:
        print(f"  {p}")
    sys.exit(1)
print("All good: the scripts parse, and so do the settings and translations.")
