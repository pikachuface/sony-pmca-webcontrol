#!/usr/bin/env python3
"""Host companion server for Sony PMCA WebControl.

Provides:
  1. Static serving of web-client/dist/index.html
  2. Streaming HTTP reverse proxy for /api/* -> camera
  3. HTTPS (self-signed), so browsers allow showDirectoryPicker Auto-Save over the LAN
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import shutil
import ssl
import subprocess
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


class ServerState:
    def __init__(self, camera_url: str, web_index: Path) -> None:
        self.camera_url = camera_url.rstrip("/")
        self.web_index = web_index


class CompanionHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PMCAHostBackend/1.0"

    @property
    def app_state(self) -> ServerState:
        return self.server.app_state  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write(f"[host-server] {self.address_string()} - {format % args}\n")

    def _send_json(self, status: int, payload: Any) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(raw)

    def _drain_request_body(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length > 0:
            self.rfile.read(length)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/"):
            self._proxy_camera("GET")
            return

        if path in ("/", "/index.html"):
            if not self.app_state.web_index.is_file():
                msg = b"web-client/dist/index.html not found. Run 'npm run build' in web-client/."
                self.send_response(404)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
                return
            data = self.app_state.web_index.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        self._send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/"):
            self._proxy_camera("POST")
            return

        self._drain_request_body()
        self._send_json(404, {"error": "Not found"})

    def do_DELETE(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._proxy_camera("DELETE")
            return

        self._drain_request_body()
        self._send_json(404, {"error": "Not found"})

    def _proxy_camera(self, method: str) -> None:
        cam = urllib.parse.urlparse(self.app_state.camera_url)
        host = cam.hostname or "127.0.0.1"
        port = cam.port or (443 if cam.scheme == "https" else 80)

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length > 0 else None

        fwd_headers: dict[str, str] = {}
        for k in ("Content-Type", "Accept", "Cache-Control"):
            v = self.headers.get(k)
            if v:
                fwd_headers[k] = v

        conn: http.client.HTTPConnection | None = None
        try:
            conn_cls = http.client.HTTPSConnection if cam.scheme == "https" else http.client.HTTPConnection
            conn = conn_cls(host, port, timeout=30)
            conn.request(method, self.path, body=body, headers=fwd_headers)
            resp = conn.getresponse()

            self.send_response(resp.status, resp.reason)
            hop_by_hop = {"transfer-encoding", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "upgrade"}
            has_content_length = False
            content_type = ""
            for k, v in resp.getheaders():
                kl = k.lower()
                if kl in hop_by_hop:
                    continue
                if kl == "content-length":
                    has_content_length = True
                elif kl == "content-type":
                    content_type = v.lower()
                self.send_header(k, v)
            is_stream = (
                not has_content_length
                or "text/event-stream" in content_type
                or "multipart/x-mixed-replace" in content_type
            )
            if not has_content_length:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()

            if is_stream and conn.sock is not None:
                conn.sock.settimeout(None)

            while True:
                chunk = resp.read1(16384)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            try:
                self._send_json(502, {"error": f"Camera proxy error: {exc}"})
            except Exception:
                pass
        finally:
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass


def ensure_self_signed_cert(cert_path: Path, key_path: Path) -> tuple[Path, Path]:
    """Generate a reusable self-signed TLS certificate via openssl if missing."""
    if cert_path.is_file() and key_path.is_file():
        return cert_path, key_path
    cert_path.parent.mkdir(parents=True, exist_ok=True)
    openssl_bin = shutil.which("openssl")
    if not openssl_bin:
        raise RuntimeError(
            "openssl not found in PATH; install openssl or pass --cert/--key."
        )
    cmd = [
        openssl_bin,
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        str(key_path),
        "-out",
        str(cert_path),
        "-days",
        "365",
        "-subj",
        "/CN=pmca-webcontrol",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        # Retry without -addext for older OpenSSL versions
        fallback_cmd = cmd[:-2]
        proc = subprocess.run(fallback_cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip()
            raise RuntimeError(f"Failed to generate self-signed certificate: {detail}")
    return cert_path, key_path


class HttpsThreadingServer(ThreadingHTTPServer):
    """ThreadingHTTPServer that performs TLS handshakes inside worker threads."""

    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            request.settimeout(10.0)
            request.do_handshake()
            request.settimeout(None)
        except Exception:
            self.shutdown_request(request)
            return
        super().process_request_thread(request, client_address)


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    cache_dir = Path.home() / ".cache" / "pmca-webcontrol"
    parser = argparse.ArgumentParser(description="Sony PMCA WebControl host companion server")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8000, help="Bind port (default: 8000)")
    parser.add_argument(
        "--cert",
        default=str(cache_dir / "cert.pem"),
        help="Path to TLS certificate PEM (default: ~/.cache/pmca-webcontrol/cert.pem)",
    )
    parser.add_argument(
        "--key",
        default=str(cache_dir / "key.pem"),
        help="Path to TLS private key PEM (default: ~/.cache/pmca-webcontrol/key.pem)",
    )
    parser.add_argument(
        "--camera",
        default=os.environ.get("CAMERA_URL", "http://192.168.0.250:8080"),
        help="Camera base URL (default: http://192.168.0.250:8080)",
    )
    parser.add_argument(
        "--web-dist",
        default=str(repo_root / "web-client" / "dist" / "index.html"),
        help="Path to built web-client/dist/index.html",
    )
    args = parser.parse_args()

    state = ServerState(
        camera_url=args.camera,
        web_index=Path(args.web_dist).expanduser().resolve(),
    )

    server = HttpsThreadingServer((args.host, args.port), CompanionHandler)
    server.app_state = state  # type: ignore[attr-defined]

    cert_path, key_path = ensure_self_signed_cert(
        Path(args.cert).expanduser(),
        Path(args.key).expanduser(),
    )
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
    server.socket = ctx.wrap_socket(
        server.socket,
        server_side=True,
        do_handshake_on_connect=False,
    )

    print(f"PMCA Host Backend listening on https://{args.host}:{args.port}")
    print(f"Camera target : {state.camera_url}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
