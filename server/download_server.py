#!/usr/bin/env python3
"""Local yt-dlp download server for the YouTubExt extension.

Run with:
    python server/download_server.py

Requires:
    pip install yt-dlp
    ffmpeg available on PATH for muxing / audio extraction.
"""
from __future__ import annotations

import json
import logging
import mimetypes
import threading
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict
from urllib.parse import parse_qs, urlparse

try:
    from yt_dlp import YoutubeDL  # type: ignore
except ImportError as exc:  # pragma: no cover - import guard
    raise SystemExit(
        "yt-dlp is required. Install with `pip install yt-dlp`."
    ) from exc

HOST = "127.0.0.1"
PORT = 8777
DOWNLOAD_ROOT = Path.home() / "Downloads"
LOG = logging.getLogger("youtubext-server")

JOBS_LOCK = threading.Lock()
DOWNLOAD_JOBS: Dict[str, Dict[str, Any]] = {}


def ensure_download_dir() -> None:
    DOWNLOAD_ROOT.mkdir(parents=True, exist_ok=True)


def build_video_url(video_id: str, page_url: str | None = None) -> str:
    if page_url:
        return page_url
    return f"https://www.youtube.com/watch?v={video_id}"


def progress_hook_factory(job_id: str) -> Any:
    def hook(status: Dict[str, Any]) -> None:
        state = status.get("status")
        if state == "downloading":
            downloaded = status.get("downloaded_bytes") or 0
            total = status.get("total_bytes") or status.get("total_bytes_estimate") or 0
            progress = 0
            if total:
                progress = max(0, min(100, int(downloaded * 100 / total)))
            update_job(job_id, status="downloading", progress=progress, message="Téléchargement…")
        elif state == "finished":
            filename = status.get("filename")
            update_job(
                job_id,
                status="processing",
                progress=100,
                message="Finalisation…",
                filePath=str(Path(filename).resolve()) if filename else None,
            )

    return hook


def sanitize_title(value: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        return "youtube"
    sanitized = "".join(ch if ch.isalnum() or ch in "-_. " else " " for ch in cleaned)
    collapsed = " ".join(part for part in sanitized.split() if part)
    return collapsed[:120] or "youtube"


def prepare_options(job_id: str, mode: str, title: str | None = None) -> Dict[str, Any]:
    ensure_download_dir()
    safe_title = sanitize_title(title or "")
    if mode == "audio":
        base_name = f"[AUDIO] {safe_title}"
    else:
        base_name = safe_title or "video"
    output_template = str(DOWNLOAD_ROOT / f"{base_name}.%(ext)s")

    common: Dict[str, Any] = {
        "outtmpl": output_template,
        "nooverwrites": False,
        "noplaylist": True,
        "quiet": True,
        "nocheckcertificate": True,
        "retries": 3,
        "fragment_retries": 5,
        "ignoreerrors": False,
        "progress_hooks": [progress_hook_factory(job_id)],
    }

    if mode == "audio":
        common.update(
            {
                "format": "bestaudio/best",
                "postprocessors": [
                    {
                        "key": "FFmpegExtractAudio",
                        "preferredcodec": "mp3",
                        "preferredquality": "0",
                    }
                ],
            }
        )
    else:
        common.update(
            {
                "format": "bestvideo+bestaudio/best",
                "merge_output_format": "mp4",
            }
        )

    return common


def update_job(job_id: str, **fields: Any) -> Dict[str, Any]:
    with JOBS_LOCK:
        job = DOWNLOAD_JOBS.setdefault(job_id, {"jobId": job_id, "status": "queued", "progress": 0})
        job.update(fields)
        return dict(job)


def get_job(job_id: str) -> Dict[str, Any] | None:
    with JOBS_LOCK:
        job = DOWNLOAD_JOBS.get(job_id)
        return dict(job) if job else None


def run_download(job_id: str, payload: Dict[str, Any]) -> None:
    video_id = payload.get("videoId") or ""
    if not video_id:
        LOG.error("Missing videoId in payload: %s", payload)
        return

    mode = payload.get("mode", "video")
    title = payload.get("title")
    page_url = payload.get("pageUrl")

    url = build_video_url(video_id, page_url)
    opts = prepare_options(job_id, mode, title)
    quality = payload.get("quality")
    if quality:
        LOG.info("Requesting %s download for %s (%s)", mode, url, quality)
    else:
        LOG.info("Requesting %s download for %s", mode, url)

    update_job(job_id, status="downloading", progress=0, message="Téléchargement…")

    try:
        with YoutubeDL(opts) as ydl:
            ydl.download([url])
        LOG.info("yt-dlp completed successfully")
        job = get_job(job_id) or {}
        file_path = Path(job.get("filePath") or '').resolve() if job.get("filePath") else None
        final_path = file_path if file_path and file_path.exists() else None
        final_message = "Téléchargement terminé"
        download_url = None
        if final_path:
            download_url = f"http://{HOST}:{PORT}/file?job={job_id}"
        update_job(
            job_id,
            status="finished",
            progress=100,
            message=final_message,
            filePath=str(final_path) if final_path else job.get("filePath"),
            downloadUrl=download_url,
        )
    except Exception as exc:  # pragma: no cover - runtime logging
        LOG.exception("yt-dlp download failed")
        update_job(job_id, status="error", progress=0, message=str(exc))


class DownloadRequestHandler(BaseHTTPRequestHandler):
    server_version = "YouTubExtDownload/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D401 - mimic BaseHTTPRequestHandler
        LOG.debug("HTTP: " + fmt, *args)

    def _set_cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self) -> None:  # noqa: N802 - handler name defined by BaseHTTPRequestHandler
        self.send_response(HTTPStatus.NO_CONTENT)
        self._set_cors()
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/download":
            self.send_response(HTTPStatus.NOT_FOUND)
            self._set_cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{\"success\": false, \"error\": \"not found\"}")
            return

        length = int(self.headers.get("Content-Length") or 0)
        raw_body = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw_body.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self.send_response(HTTPStatus.BAD_REQUEST)
            self._set_cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{\"success\": false, \"error\": \"invalid json\"}")
            return

        video_id = payload.get("videoId")
        if not video_id:
            self.send_response(HTTPStatus.BAD_REQUEST)
            self._set_cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{\"success\": false, \"error\": \"missing videoId\"}")
            return

        request_id = payload.get("requestId") or None
        job_id = request_id or str(uuid.uuid4())
        payload["jobId"] = job_id
        update_job(job_id, status="queued", progress=0, message="En attente…")

        threading.Thread(target=run_download, args=(job_id, payload), daemon=True).start()

        self.send_response(HTTPStatus.ACCEPTED)
        self._set_cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        response = {"success": True, "message": "Download started", "jobId": job_id}
        self.wfile.write(json.dumps(response).encode("utf-8"))

    def do_HEAD(self) -> None:  # noqa: N802
        self._serve_file(head_only=True)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/status":
            return self._serve_status(parsed)
        if parsed.path == "/file":
            return self._serve_file()
        self.send_response(HTTPStatus.NOT_FOUND)
        self._set_cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{\"success\": false, \"error\": \"not found\"}")

    def _serve_status(self, parsed):
        params = parse_qs(parsed.query or "")
        job_id = params.get("job", [""])[0]
        if not job_id:
            self.send_response(HTTPStatus.BAD_REQUEST)
            self._set_cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{\"success\": false, \"error\": \"missing job id\"}")
            return

        job = get_job(job_id)
        if not job:
            self.send_response(HTTPStatus.NOT_FOUND)
            self._set_cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{\"success\": false, \"error\": \"job not found\"}")
            return

        self.send_response(HTTPStatus.OK)
        self._set_cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        payload = {"success": True, **job}
        self.wfile.write(json.dumps(payload).encode("utf-8"))

    def _serve_file(self, head_only: bool = False):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query or "")
        job_id = params.get("job", [""])[0]
        if not job_id:
            self.send_response(HTTPStatus.BAD_REQUEST)
            self._set_cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            if not head_only:
                self.wfile.write(b"{\"success\": false, \"error\": \"missing job id\"}")
            return

        job = get_job(job_id)
        file_path = Path(job.get("filePath")) if job and job.get("filePath") else None
        if not file_path or not file_path.exists():
            self.send_response(HTTPStatus.NOT_FOUND)
            self._set_cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            if not head_only:
                self.wfile.write(b"{\"success\": false, \"error\": \"file not found\"}")
            return

        mime_type, _ = mimetypes.guess_type(str(file_path))
        self.send_response(HTTPStatus.OK)
        self._set_cors()
        self.send_header(
            "Content-Type",
            mime_type or "application/octet-stream",
        )
        self.send_header("Content-Length", str(file_path.stat().st_size))
        self.send_header("Content-Disposition", f"inline; filename=\"{file_path.name}\"")
        self.end_headers()
        if head_only:
            return
        with file_path.open("rb") as stream:
            while True:
                chunk = stream.read(1024 * 64)
                if not chunk:
                    break
                self.wfile.write(chunk)


def run_server() -> None:
    logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s %(name)s: %(message)s")
    ensure_download_dir()
    server = ThreadingHTTPServer((HOST, PORT), DownloadRequestHandler)
    LOG.info("Server listening on http://%s:%s", HOST, PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:  # pragma: no cover - interactive shutdown
        LOG.info("Shutting down server")
    finally:
        server.server_close()


if __name__ == "__main__":
    run_server()
