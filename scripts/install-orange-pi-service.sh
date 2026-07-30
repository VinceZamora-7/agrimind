#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

PROJECT_DIR=/home/orangepi/Agrimind

groupadd -f gpio
usermod -aG gpio,video orangepi

printf '%s\n' 'SUBSYSTEM=="gpio", KERNEL=="gpiochip*", GROUP="gpio", MODE="0660"' \
  > /etc/udev/rules.d/60-agrimind-gpio.rules
udevadm control --reload-rules
udevadm trigger --subsystem-match=gpio

install -m 0644 "$PROJECT_DIR/server/agrimind.service.example" \
  /etc/systemd/system/agrimind.service
systemctl daemon-reload
systemctl enable agrimind.service

echo "Agrimind service installed. Stop any manual server, then run:"
echo "  sudo systemctl start agrimind.service"
