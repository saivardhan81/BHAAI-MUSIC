#!/usr/bin/env bash
# Sets up BHAAI Music on an Ubuntu 22.04/24.04 server (Oracle Cloud Always Free, x86 or Ampere ARM).
# The app keeps listening on 127.0.0.1 only. Caddy serves it on https://DOMAIN with a free
# Let's Encrypt certificate and asks for a username and password first.
#
#   sudo DOMAIN=yourname.duckdns.org bash deploy/oracle/setup.sh
#
# Point DOMAIN at the server's public IP before running this, so Caddy can get the certificate.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
[[ -n "${DOMAIN:-}" ]] || { echo "Set DOMAIN, for example: sudo DOMAIN=yourname.duckdns.org bash $0"; exit 1; }
APP_DIR=$(cd "$(dirname "$0")/../.." && pwd)
RUN_AS=${SUDO_USER:-ubuntu}
PORT=${BHAAI_PORT:-3030}

if [[ -z "${BHAAI_USER:-}" ]]; then read -rp "Username for the site: " BHAAI_USER; fi
if [[ -z "${BHAAI_PASSWORD:-}" ]]; then read -rsp "Password for the site: " BHAAI_PASSWORD; echo; fi
[[ ${#BHAAI_PASSWORD} -ge 10 ]] || { echo "Use a password with at least 10 characters."; exit 1; }

echo "==> Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl git gpg python3-venv python3-pip debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)' 2>/dev/null; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "==> Caddy"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

# The 1 GB micro shape runs out of memory while yt-dlp and ytmusicapi load.
if [[ $(awk '/MemTotal/{print $2}' /proc/meminfo) -lt 2000000 && ! -f /swapfile ]]; then
  echo "==> 2 GB swap"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Python packages"
sudo -u "$RUN_AS" python3 -m venv "$APP_DIR/.venv"
sudo -u "$RUN_AS" "$APP_DIR/.venv/bin/python" -m pip install --upgrade pip
sudo -u "$RUN_AS" "$APP_DIR/.venv/bin/python" -m pip install -r "$APP_DIR/requirements.txt"

echo "==> Firewall (ports 80 and 443)"
# Oracle's Ubuntu images reject everything except SSH; insert the rules before that REJECT.
for port in 80 443; do
  if ! iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    line=$(iptables -L INPUT --line-numbers | awk '/REJECT/{print $1; exit}')
    iptables -I INPUT "${line:-1}" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  fi
done
netfilter-persistent save

echo "==> Service"
cat > /etc/systemd/system/bhaai-music.service <<EOF
[Unit]
Description=BHAAI Music
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_AS
WorkingDirectory=$APP_DIR
Environment=BHAAI_PORT=$PORT
ExecStart=$(command -v node) server.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# The app only answers requests addressed to 127.0.0.1 and rejects other origins, so Caddy
# rewrites Host, and rewrites Origin only when it is this site. Other sites stay blocked.
HASH=$(caddy hash-password --plaintext "$BHAAI_PASSWORD")
ESCAPED_DOMAIN=$(printf '%s' "$DOMAIN" | sed 's/[.]/[.]/g')
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	basic_auth {
		$BHAAI_USER $HASH
	}
	reverse_proxy 127.0.0.1:$PORT {
		header_up Host 127.0.0.1:$PORT
		header_up Origin "^https://$ESCAPED_DOMAIN\$" "http://127.0.0.1:$PORT"
		flush_interval -1
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

systemctl daemon-reload
systemctl enable --now bhaai-music
systemctl restart bhaai-music
systemctl reload caddy || systemctl restart caddy

echo
echo "BHAAI Music is running at https://$DOMAIN"
echo "Logs: journalctl -u bhaai-music -f    and    journalctl -u caddy -f"
