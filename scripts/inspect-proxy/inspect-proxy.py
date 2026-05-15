#!/usr/bin/env python3
"""inspect-proxy: read-only credential broker for CouchDB inspection.

Listens on 127.0.0.1:9999 and forwards GET/HEAD requests to a remote CouchDB
with Basic Auth injected from environment. Capability-scoped to read-only —
PUT/POST/DELETE return 405. Each invocation requires the X-Inspect-Token
header (generated at startup, printed to stderr).

Credential lifecycle:
    - Read once from env at startup (recommend running via `bw run` wrapper)
    - Held in process memory (Basic header pre-encoded)
    - Never written to disk
    - Dies with the process

Usage:
    See start-broker.ps1 in the same directory.
"""
import os
import sys
import base64
import secrets
import ssl
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from datetime import datetime


def must_env(key):
    v = os.environ.get(key)
    if not v:
        sys.stderr.write(f"FATAL: env var {key} is required\n")
        sys.exit(1)
    return v


UPSTREAM = must_env("COUCHSYNC_URI").rstrip("/")
USER = must_env("COUCHSYNC_USER")
PASS = must_env("COUCHSYNC_PASSWORD")
AUTH_HEADER = "Basic " + base64.b64encode(f"{USER}:{PASS}".encode()).decode()
del USER, PASS  # only the encoded header is retained from here on

TOKEN = secrets.token_urlsafe(24)
ALLOWED_METHODS = {"GET", "HEAD"}
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = int(os.environ.get("BROKER_PORT", "9999"))
HOP_BY_HOP = {"connection", "transfer-encoding", "keep-alive", "proxy-authenticate",
              "proxy-authorization", "te", "trailers", "upgrade"}


class Proxy(BaseHTTPRequestHandler):
    server_version = "CouchInspectBroker/1.0"
    sys_version = ""

    def _check_token(self):
        if self.headers.get("X-Inspect-Token") != TOKEN:
            self.send_error(401, "Inspect token missing or invalid")
            return False
        return True

    def _proxy(self, method):
        if method not in ALLOWED_METHODS:
            self.send_error(405, f"{method} not allowed (read-only broker)")
            return
        if not self._check_token():
            return

        url = UPSTREAM + self.path
        forwarded_headers = {
            "Authorization": AUTH_HEADER,
            "Accept-Encoding": self.headers.get("Accept-Encoding", "identity"),
        }
        if self.headers.get("Accept"):
            forwarded_headers["Accept"] = self.headers["Accept"]

        req = urllib.request.Request(url, method=method, headers=forwarded_headers)
        try:
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, context=ctx, timeout=120) as resp:
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() in HOP_BY_HOP:
                        continue
                    self.send_header(k, v)
                self.end_headers()
                while True:
                    chunk = resp.read(8192)
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        break
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            for k, v in e.headers.items():
                if k.lower() in HOP_BY_HOP:
                    continue
                self.send_header(k, v)
            self.end_headers()
            try:
                self.wfile.write(e.read())
            except Exception:
                pass
        except Exception as e:
            self.send_error(502, f"Upstream error: {type(e).__name__}: {e}")

    def do_GET(self):
        self._proxy("GET")

    def do_HEAD(self):
        self._proxy("HEAD")

    def do_POST(self):
        self._proxy("POST")

    def do_PUT(self):
        self._proxy("PUT")

    def do_DELETE(self):
        self._proxy("DELETE")

    def log_message(self, fmt, *args):
        ts = datetime.now().strftime("%H:%M:%S")
        msg = fmt % args
        sys.stderr.write(f"[{ts}] {self.command} {self.path} :: {msg}\n")


def main():
    print("=" * 60)
    print("CouchDB inspect broker (read-only)")
    print("=" * 60)
    print(f"Upstream: {UPSTREAM}")
    print(f"Listen:   http://{LISTEN_HOST}:{LISTEN_PORT}")
    print(f"Methods:  {sorted(ALLOWED_METHODS)}")
    print()
    print("X-Inspect-Token (paste this when granting access to the agent):")
    print(f"  {TOKEN}")
    print()
    print("Example client call:")
    print(f'  curl -H "X-Inspect-Token: {TOKEN}" http://{LISTEN_HOST}:{LISTEN_PORT}/_all_dbs')
    print()
    print("Press Ctrl+C to stop and revoke access.")
    print("-" * 60)
    try:
        HTTPServer((LISTEN_HOST, LISTEN_PORT), Proxy).serve_forever()
    except KeyboardInterrupt:
        print("\nbroker stopped, access revoked.")


if __name__ == "__main__":
    main()
