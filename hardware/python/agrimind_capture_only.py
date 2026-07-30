#!/usr/bin/env python3
"""Capture one Orange Pi camera frame into Agrimind storage."""

import argparse
import os
from pathlib import Path
import subprocess
from datetime import datetime, timezone


DEFAULT_CAMERA = (
    "/dev/v4l/by-id/"
    "usb-Sonix_Technology_Co.__Ltd._REDRAGON_Live_Camera_SN0001-video-index0"
)
PROJECT_DIR = Path(__file__).resolve().parents[2]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--camera", default=os.getenv("CAMERA_DEVICE", DEFAULT_CAMERA))
    parser.add_argument("--output-dir", type=Path, default=PROJECT_DIR / "storage" / "captures")
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")[:-3]
    output = args.output_dir / f"camera_test_{stamp}.jpg"

    subprocess.run(
        ["fswebcam", "-q", "-d", args.camera, "-r", "640x480", "--no-banner", str(output)],
        check=True,
    )
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
