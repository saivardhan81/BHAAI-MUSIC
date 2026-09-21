#!/usr/bin/env bash
# Sets up BHAAI Music on a Raspberry Pi 3/4/5 running Raspberry Pi OS (64-bit), as a service that
# starts on boot. Open it from any device on your home network at http://<pi-name>.local:3000.
# MP3 downloads save on the device you open it from, not on the Pi.
#
#   sudo bash deploy/raspberry-pi/setup.sh
#   sudo TAILSCALE=1 bash deploy/raspberry-pi/setup.sh    also reach it from outside home, privately, with Tailscale
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
[[ $(uname -m) == aarch64 ]] || { echo "Needs 64-bit Raspberry Pi OS (this is $(uname -m))."; exit 1; }
APP_DIR=$(cd "$(dirname "$0")/../.." && pwd)
RUN_AS=${SUDO_USER:-pi}
PORT=${PORT:-3000}

echo "==> Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl python3-venv python3-pip ffmpeg avahi-daemon

# yt-dlp runs YouTube's player checks with Node; the Node in Raspberry Pi OS can be too old.
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)' 2>/dev/null; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# 1 GB boards (Pi 3, Zero 2 W) run out of memory while converting MP3s.
if [[ $(awk '/MemTotal/{print $2}' /proc/meminfo) -lt 2000000 ]] && command -v dphys-swapfile >/dev/null; then
  echo "==> 1 GB swap"
  sed -i 's/^#\?CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
  dphys-swapfile setup && dphys-swapfile swapon
fi

echo "==> Python packages"
sudo -u "$RUN_AS" python3 -m venv "$APP_DIR/.venv"
sudo -u "$RUN_AS" "$APP_DIR/.venv/bin/python" -m pip install --upgrade pip
sudo -u "$RUN_AS" "$APP_DIR/.venv/bin/python" -m pip install -r "$APP_DIR/requirements.txt"

echo "==> Service"
cat > /etc/systemd/system/bhaai-music.service <<EOF
[Unit]
Description=BHAAI Music
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_AS
WorkingDirectory=$APP_DIR
Environment=HOST=0.0.0.0
Environment=PORT=$PORT
Environment=PATH=$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin
ExecStart=$APP_DIR/.venv/bin/python -u dev.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now bhaai-music
systemctl restart bhaai-music

if [[ -n "${TAILSCALE:-}" ]]; then
  echo "==> Tailscale"
  command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
  tailscale up   # prints a login link the first time
  tailscale serve --bg "$PORT"
fi

echo
echo "BHAAI Music is running. Open it from another device on your network:"
echo "  http://$(hostname).local:$PORT"
echo "  http://$(hostname -I | awk '{print $1}'):$PORT"
[[ -n "${TAILSCALE:-}" ]] && echo "  $(tailscale serve status 2>/dev/null | grep -o 'https://[^ ]*' | head -1)   (from anywhere, on your Tailscale devices)"
echo "Logs: journalctl -u bhaai-music -f"
