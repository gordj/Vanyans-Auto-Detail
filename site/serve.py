"""Local dev server for the Van Wash site.

Plain `python -m http.server` lets Chrome cache HTML and CSS, which means you can
look at a page after a rebuild and still be shown the previous version. That has
already caused a fix to look broken more than once. This sends no-store on every
response so a normal reload always gets the current build.

    python serve.py           # serves dist/ on http://127.0.0.1:8080
    python serve.py 8090      # different port
"""
import http.server
import os
import socketserver
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def translate_path(self, path):
        # Mirror Cloudflare Pages clean URLs: /services serves services.html.
        full = super().translate_path(path)
        if not os.path.exists(full) and os.path.exists(full + ".html"):
            return full + ".html"
        return full

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *a):
        pass


socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), NoCacheHandler) as httpd:
    print("Van Wash serving %s on http://127.0.0.1:%d  (no-cache)" % (ROOT, PORT))
    httpd.serve_forever()
