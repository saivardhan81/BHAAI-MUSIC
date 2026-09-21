"""Run BHAAI Music on this computer the way Vercel runs it: public/ as static files and api/index.py for /api/*.

    python dev.py            then open http://localhost:3000   (set PORT to change it, HOST=0.0.0.0 to share it on the network)
"""
import mimetypes
import os
import socket
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from api.index import handler

PUBLIC = Path(__file__).resolve().parent / "public"


class DevHandler(handler):
    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return self._respond()
        target = (PUBLIC / unquote(path).lstrip("/")).resolve()
        if target.is_dir():
            target = target / "index.html"
        if not target.is_relative_to(PUBLIC) or not target.is_file():
            self.send_error(404)
            return
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


class DevServer(ThreadingHTTPServer):
    # Windows otherwise lets a second copy share a busy port while requests keep going to the old copy.
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    # HOST=0.0.0.0 lets other devices on the network open it (the Raspberry Pi setup does this).
    host = os.environ.get("HOST", "127.0.0.1")
    try:
        server = DevServer((host, port), DevHandler)
    except OSError:
        sys.exit("Port %d is already in use, probably by another BHAAI Music window. Close it (Ctrl+C) and start again." % port)
    print("BHAAI Music: http://localhost:%d  (Ctrl+C to stop)" % port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
