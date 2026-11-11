#!/usr/bin/env python3
"""Preview the site from this folder, with the live leaderboards.

    python3 tools/serve.py            # then open http://localhost:8000 (only this computer can)
    python3 tools/serve.py 8080       # another port

It serves your copy of the site at the same addresses as ballkour.com (/leaderboards/6, /faq/pausing, /runs/<id>,
/stats/2026-11-05, /my-stats, /players/<number or name>, …) and gets /data/*.json (the boards, Discord names, member
count), /api/run (a run's numbers from when it was sent), /api/comments (a run's YouTube comments), and /api/visits
(the page views in Stats) from ballkour.com, so you see your changes with real data.
Signing in and sending runs only work on the real site, so the form shows the Discord ticket instead.
"""
import http.server
import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
# The addresses that are the home page, like the Worker and Cloudflare's rules serve them
PAGES = re.compile(r"^/(?:(courses|leaderboards|submit|features|faq|source-code|translations|runs|my-stats|players)(/[^/]+(/legacy|/assisted|/global|/\d+|/runs)?)?"
                   r"|stats(/\d{4}-\d{2}-\d{2})?(/day|/week|/3-months|/6-months|/12-months)?)/?$", re.I)


# My profile and a player's panel at their links since November 2026 (/my-stats and /players/<…> before, in PAGES)
PROFILE = re.compile(r"^/profile(/[^/]+(/runs)?)?/?$", re.I)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/data/") or path in ("/api/run", "/api/comments", "/api/visits"):
            try:
                live = path if path.startswith("/data/") else self.path  # /api/run?id=…, /api/comments?v=…
                req = urllib.request.Request("https://ballkour.com" + live, headers={"User-Agent": "ballkour.com preview"})
                with urllib.request.urlopen(req, timeout=10) as r:
                    body = r.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:  # offline: the page falls back to the runs written into it
                self.send_error(503, f"ballkour.com can't be reached: {e}")
            return
        if PAGES.match(path) or PROFILE.match(path):
            self.path = "/index.html"
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")  # always your newest edits
        super().end_headers()


print(f"Previewing {ROOT} at http://localhost:{PORT}  (Ctrl+C to stop)")
# 127.0.0.1: only this computer, so nobody else on the same network can browse the folder
http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
