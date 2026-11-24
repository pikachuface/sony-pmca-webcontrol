#!/usr/bin/env python3
"""Host companion server for Sony PMCA WebControl.

Provides:
  1. Static serving of web-client/dist/index.html
  2. Streaming HTTP reverse proxy for /api/* -> camera
  3. HTTPS (self-signed), so browsers allow showDirectoryPicker Auto-Save over the LAN
  4. Live view relay: /api/liveview.mjpeg and /api/output.mjpeg are read from the camera once
     each and shared by any number of viewers (web UI, OBS, VLC). The camera sends at most
     about 1.8 MB/s in all; one viewer gets its 23 fps evenly, but two or three direct viewers
     made every stream jerk.
  5. Optional plain HTTP on localhost (--http-port), so OBS and other local players need no
     certificate.
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
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


class MjpegRelay:
    """One camera MJPEG stream shared by any number of viewers.

    The upstream connection opens with the first viewer and closes a few seconds after the
    last one leaves, so it does not hold one of the camera's three stream slots. Each viewer
    always gets the newest frame; a slow viewer skips frames instead of delaying the others.
    """

    IDLE_STOP_S = 5.0
    UPSTREAM_TIMEOUT_S = 10.0

    def __init__(self, camera_url: str, path: str, cid: str) -> None:
        self.camera_url = camera_url
        self.path = path
        self.cid = cid
        self.cond = threading.Condition()
        self.frame: bytes | None = None
        self.seq = 0
        self.viewers = 0
        self.running = False

    def subscribe(self) -> None:
        with self.cond:
            self.viewers += 1
            if not self.running:
                self.running = True
                threading.Thread(target=self._run, name=f"relay{self.path}", daemon=True).start()

    def unsubscribe(self) -> None:
        with self.cond:
            self.viewers -= 1
            self.cond.notify_all()

    def wait_frame(self, last_seq: int, timeout: float) -> tuple[int, bytes | None]:
        with self.cond:
            self.cond.wait_for(lambda: self.seq != last_seq, timeout)
            return self.seq, self.frame

    def _idle_too_long(self, idle_since: list[float | None]) -> bool:
        """Called with the lock held; tracks how long nobody has watched."""
        if self.viewers > 0:
            idle_since[0] = None
            return False
        if idle_since[0] is None:
            idle_since[0] = time.monotonic()
        return time.monotonic() - idle_since[0] > self.IDLE_STOP_S

    def _run(self) -> None:
        idle_since: list[float | None] = [None]
        while True:
            with self.cond:
                if self._idle_too_long(idle_since):
                    self.running = False
                    self.frame = None
                    return
            try:
                self._read_upstream(idle_since)
            except Exception as exc:
                sys.stderr.write(f"[host-server] relay {self.path}: {exc}\n")
                time.sleep(1.0)

    def _read_upstream(self, idle_since: list[float | None]) -> None:
        cam = urllib.parse.urlparse(self.camera_url)
        conn_cls = http.client.HTTPSConnection if cam.scheme == "https" else http.client.HTTPConnection
        conn = conn_cls(cam.hostname or "127.0.0.1", cam.port or (443 if cam.scheme == "https" else 80),
                        timeout=self.UPSTREAM_TIMEOUT_S)
        try:
            conn.request("GET", f"{self.path}?cid={urllib.parse.quote(self.cid)}")
            resp = conn.getresponse()
            if resp.status != 200:
                raise RuntimeError(f"camera answered HTTP {resp.status}")
            fp = resp.fp
            while True:
                # Part: --frame, headers with Content-Length, blank line, JPEG, CRLF.
                length = -1
                while True:
                    line = fp.readline(1024)
                    if not line:
                        raise RuntimeError("camera closed the stream")
                    line = line.strip()
                    if not line:
                        if length >= 0:
                            break
                        continue
                    if line.lower().startswith(b"content-length:"):
                        length = int(line.split(b":", 1)[1])
                jpeg = fp.read(length)
                if len(jpeg) != length:
                    raise RuntimeError("camera closed the stream mid-frame")
                with self.cond:
                    self.frame = jpeg
                    self.seq += 1
                    self.cond.notify_all()
                    if self._idle_too_long(idle_since):
                        return
        finally:
            conn.close()


class ServerState:
    def __init__(self, camera_url: str, web_index: Path) -> None:
        self.camera_url = camera_url.rstrip("/")
        self.web_index = web_index
        self.relays = {
            path: MjpegRelay(self.camera_url, path, f"host-relay-{name}")
            for path, name in (("/api/liveview.mjpeg", "liveview"), ("/api/output.mjpeg", "output"))
        }


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

        relay = self.app_state.relays.get(path)
        if relay is not None:
            self._serve_relay(relay)
            return

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

    def _serve_relay(self, relay: MjpegRelay) -> None:
        relay.subscribe()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            last = -1
            while True:
                seq, frame = relay.wait_frame(last, 5.0)
                if frame is None or seq == last:
                    continue
                last = seq
                self.wfile.write(
                    b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                    + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n"
                )
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError, OSError):
            pass
        finally:
            relay.unsubscribe()

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
        "--http-port",
        type=int,
        default=0,
        help="Also serve plain HTTP on this port (e.g. 8001 for OBS); 0 = off",
    )
    parser.add_argument(
        "--http-host",
        default="127.0.0.1",
        help="Bind host for --http-port (default: 127.0.0.1, this computer only)",
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
    if args.http_port:
        plain = ThreadingHTTPServer((args.http_host, args.http_port), CompanionHandler)
        plain.daemon_threads = True
        plain.app_state = state  # type: ignore[attr-defined]
        threading.Thread(target=plain.serve_forever, name="plain-http", daemon=True).start()
        print(f"Plain HTTP on http://{args.http_host}:{args.http_port}")
    print(f"Camera target : {state.camera_url}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
