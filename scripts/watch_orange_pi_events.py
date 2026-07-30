#!/usr/bin/env python3
"""Maintain one live Agrimind result window on this laptop."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import threading
import time
from websockets.sync.server import serve


PROJECT_DIR = Path(__file__).resolve().parents[1]
TERMINAL_STATUSES = {
    "analyzed", "analysis_failed", "captured_duplicate",
    "duplicate_reused_analysis", "captured_not_analyzed", "captured_only",
    "captured_pending_manual_analysis",
}


def run(*command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, capture_output=True, text=True)


def write_monitor_page(destination: Path, websocket_port: int) -> None:
    document = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Agrimind Monitor</title><style>
*{box-sizing:border-box} body{margin:0;background:#0f172a;color:#f8fafc;font:15px system-ui,sans-serif}
.card{min-height:100vh;background:#1e293b;display:flex;flex-direction:column} img{width:100%;height:52vh;object-fit:contain;background:#020617}
.info{padding:18px 20px}.badge{display:inline-block;padding:7px 14px;border-radius:999px;font-size:21px;font-weight:800;letter-spacing:.05em}
.human{color:#991b1b;background:#fee2e2}.animal{color:#92400e;background:#fef3c7}.none{color:#166534;background:#dcfce7}
.unknown{color:#334155;background:#e2e8f0}h1{margin:12px 0 5px;font-size:20px}p{margin:5px 0;color:#cbd5e1}.meta{font-size:12px;color:#94a3b8}
.waiting{display:grid;place-items:center;height:52vh;background:#020617;color:#94a3b8;font-size:18px}
</style></head><body><main class="card">
<div id="waiting" class="waiting">Waiting for an Agrimind capture…</div><img id="capture" hidden alt="Latest Agrimind capture">
<section class="info"><span id="badge" class="badge unknown">WAITING</span><h1 id="confidence">No result yet</h1>
<p id="reason">The window will update automatically after movement is captured and analyzed.</p><p id="meta" class="meta"></p><p id="reused" class="meta"></p></section>
</main><script>
let currentEvent = null;
function showEvent(event){
  if(event.event_id===currentEvent)return; currentEvent=event.event_id;
  const image=document.getElementById('capture'); image.src='/'+encodeURIComponent(event.image)+'?event='+encodeURIComponent(event.event_id); image.hidden=false;
  document.getElementById('waiting').hidden=true; const badge=document.getElementById('badge'); badge.textContent=event.display_label;
  badge.className='badge '+event.css_label; document.getElementById('confidence').textContent=event.confidence;
  document.getElementById('reason').textContent=event.reason; document.getElementById('meta').textContent=event.timestamp+' · '+event.event_id;
  document.getElementById('reused').textContent=event.reused||''; document.title='Agrimind — '+event.display_label;
}
function connect(){
  const socket=new WebSocket('ws://127.0.0.1:__WEBSOCKET_PORT__');
  socket.onmessage=message=>{try{showEvent(JSON.parse(message.data))}catch(error){}};
  socket.onclose=()=>setTimeout(connect,1500); socket.onerror=()=>socket.close();
}
connect();
</script></body></html>"""
    (destination / "monitor.html").write_text(
        document.replace("__WEBSOCKET_PORT__", str(websocket_port)), encoding="utf-8"
    )


def start_server(destination: Path, port: int) -> ThreadingHTTPServer:
    handler = partial(SimpleHTTPRequestHandler, directory=str(destination))
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class WebSocketHub:
    def __init__(self, port: int):
        self.port = port
        self.clients = set()
        self.latest_payload = None
        self.lock = threading.Lock()
        self.server = None

    def handler(self, connection) -> None:
        with self.lock:
            self.clients.add(connection)
            payload = self.latest_payload
        try:
            if payload:
                connection.send(payload)
            for _message in connection:
                pass
        finally:
            with self.lock:
                self.clients.discard(connection)

    def start(self) -> None:
        self.server = serve(self.handler, "127.0.0.1", self.port)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def broadcast(self, event: dict) -> None:
        payload = json.dumps(event)
        with self.lock:
            self.latest_payload = payload
            clients = list(self.clients)
        for connection in clients:
            try:
                connection.send(payload)
            except Exception:
                with self.lock:
                    self.clients.discard(connection)

    def shutdown(self) -> None:
        if self.server:
            self.server.shutdown()


def open_monitor(port: int) -> None:
    url = f"http://127.0.0.1:{port}/monitor.html"
    try:
        browser = run("xdg-settings", "get", "default-web-browser").stdout.strip()
    except subprocess.CalledProcessError:
        browser = ""
    if browser == "com.google.Chrome.desktop":
        command = ["flatpak", "run", "com.google.Chrome", f"--app={url}", "--window-size=520,720"]
    else:
        command = ["xdg-open", url]
    subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def publish_event(event: dict, destination: Path, args: argparse.Namespace) -> tuple[str, dict]:
    filename = Path(event["best_image"]["filename"]).name
    local_image = destination / filename
    remote_image = f"{args.host}:/home/orangepi/Agrimind/storage/captures/{filename}"
    run("scp", "-i", str(args.key), "-o", "BatchMode=yes", remote_image, str(local_image))
    result = event.get("ai_result") or {}
    label = str(result.get("label") or "unknown").lower()
    if label == "nothing":
        label = "none"
    display_label = {"animal": "PET / ANIMAL", "human": "HUMAN", "none": "NONE"}.get(label, "NOT ANALYZED")
    confidence = result.get("confidence")
    data = {
        "event_id": event["event_id"], "timestamp": event.get("timestamp", ""), "image": filename,
        "display_label": display_label, "css_label": label if label in {"human", "animal", "none"} else "unknown",
        "confidence": f"{confidence}% confidence" if confidence is not None else "No confidence score",
        "reason": result.get("reason") or event.get("ai_error") or event.get("ai_skip_reason") or "No analysis details available.",
        "reused": f"Reused classification from {result['reused_from_event_id']}" if result.get("reused_from_event_id") else "",
    }
    temporary = destination / "latest-event-data.json.tmp"
    temporary.write_text(json.dumps(data), encoding="utf-8")
    temporary.replace(destination / "latest-event-data.json")
    for old_image in destination.glob("*.jpg"):
        if old_image != local_image:
            old_image.unlink(missing_ok=True)
    return display_label, data


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--host",
        default=os.environ.get("AGRIMIND_ORANGE_PI_HOST", "orangepi@192.168.18.5"),
        help="SSH target; can also be set with AGRIMIND_ORANGE_PI_HOST",
    )
    parser.add_argument("--key", type=Path, default=Path.home() / ".ssh" / "orangepi_agrimind")
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--websocket-port", type=int, default=8766)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()
    destination = PROJECT_DIR / "resources" / "images" / "live"
    destination.mkdir(parents=True, exist_ok=True)
    write_monitor_page(destination, args.websocket_port)
    server = start_server(destination, args.port)
    websocket_hub = WebSocketHub(args.websocket_port)
    websocket_hub.start()
    if not args.no_open:
        open_monitor(args.port)
    latest_event_path = "/home/orangepi/Agrimind/storage/logs/latest_event.json"
    last_event_id = None
    print(f"Agrimind monitor: http://127.0.0.1:{args.port}/monitor.html; WebSocket: ws://127.0.0.1:{args.websocket_port}", flush=True)
    try:
        while True:
            try:
                result = run("ssh", "-i", str(args.key), "-o", "BatchMode=yes", args.host,
                             "test -f " + latest_event_path + " && cat " + latest_event_path)
                if result.stdout.strip():
                    event = json.loads(result.stdout)
                    event_id = event["event_id"]
                    if event_id != last_event_id and event.get("status") in TERMINAL_STATUSES:
                        label, data = publish_event(event, destination, args)
                        websocket_hub.broadcast(data)
                        last_event_id = event_id
                        print(f"Updated {event_id}: {label} ({event.get('status')})", flush=True)
            except (subprocess.CalledProcessError, json.JSONDecodeError, KeyError, OSError) as error:
                print(f"Watcher retry: {error}", flush=True)
            time.sleep(args.poll_seconds)
    finally:
        websocket_hub.shutdown()
        server.shutdown()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Stopped")
