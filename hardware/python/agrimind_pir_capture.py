#!/usr/bin/env python3
"""Poll the Orange Pi PIR input and save a camera capture plus event JSON."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import time


DEFAULT_CAMERA = (
    "/dev/v4l/by-id/"
    "usb-Sonix_Technology_Co.__Ltd._REDRAGON_Live_Camera_SN0001-video-index0"
)
PROJECT_DIR = Path(__file__).resolve().parents[2]


def read_pir(chip: str, line: int) -> int:
    last_error = "GPIO read failed"
    for attempt in range(5):
        try:
            result = subprocess.run(
                ["gpioget", "--chip", chip, "--numeric", str(line)],
                check=True,
                capture_output=True,
                text=True,
            )
            return int(result.stdout.strip())
        except subprocess.CalledProcessError as error:
            last_error = error.stderr.strip() or last_error
            if "busy" not in last_error.lower():
                break
            time.sleep(0.1 * (attempt + 1))
    raise RuntimeError(
        f"{last_error}. Ensure the current user can read /dev/{chip}."
    )


def capture_event(camera: str, captures_dir: Path, logs_dir: Path) -> Path:
    now = datetime.now(timezone.utc)
    event_id = f"event_{now.strftime('%Y%m%d_%H%M%S_%f')[:-3]}"
    filename = f"{event_id}_frame_1.jpg"
    image_path = captures_dir / filename

    subprocess.run(
        ["fswebcam", "-q", "-d", camera, "-r", "640x480", "--no-banner", str(image_path)],
        check=True,
    )

    event = {
        "event_id": event_id,
        "timestamp": now.isoformat().replace("+00:00", "Z"),
        "trigger": "pir_motion_sensor",
        "camera_device": camera,
        "best_image": {"filename": filename, "url": f"/captures/{filename}"},
        "captured_images": [
            {
                "index": 1,
                "filename": filename,
                "url": f"/captures/{filename}",
                "file_size": image_path.stat().st_size,
            }
        ],
        "ai_result": None,
        "alert": {"sent": False, "channel": None, "recipient": None},
        "status": "captured_pending_ai_analysis",
    }

    event_path = logs_dir / f"{event_id}.json"
    latest_path = logs_dir / "latest_event.json"
    serialized = json.dumps(event, indent=2) + "\n"
    event_path.write_text(serialized, encoding="utf-8")
    latest_path.write_text(serialized, encoding="utf-8")
    print(f"Motion captured: {event_id}")
    return event_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chip", default=os.getenv("GPIO_CHIP", "gpiochip0"))
    parser.add_argument("--line", type=int, default=int(os.getenv("GPIO_LINE", "6")))
    parser.add_argument("--camera", default=os.getenv("CAMERA_DEVICE", DEFAULT_CAMERA))
    parser.add_argument("--poll-seconds", type=float, default=0.25)
    parser.add_argument("--cooldown-seconds", type=float, default=5.0)
    args = parser.parse_args()

    captures_dir = PROJECT_DIR / "storage" / "captures"
    logs_dir = PROJECT_DIR / "storage" / "logs"
    captures_dir.mkdir(parents=True, exist_ok=True)
    logs_dir.mkdir(parents=True, exist_ok=True)

    previous = read_pir(args.chip, args.line)
    print(f"Watching {args.chip} line {args.line}; initial state={previous}")

    try:
        while True:
            current = read_pir(args.chip, args.line)
            if current == 1 and previous == 0:
                capture_event(args.camera, captures_dir, logs_dir)
                time.sleep(args.cooldown_seconds)
                current = read_pir(args.chip, args.line)
            previous = current
            time.sleep(args.poll_seconds)
    except KeyboardInterrupt:
        print("Stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
