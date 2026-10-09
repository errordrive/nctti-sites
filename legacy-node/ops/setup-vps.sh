#!/usr/bin/env bash
# NCTTI Sites — VPS setup (Ubuntu 22.04/24.04). Run as root.
# You need: a Cloudflare API token with DNS:Edit on nctti.tech (for wildcard SSL).
set -euo pipefail

APP_DIR="/opt/nctti-sites"
SITES_ROOT="/var/www/sites"
DOMAIN="sites.nctti.tech"

echo "==> Installing Node 22, nginx, certbot..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs nginx certbot python3-certbot-dns-cloudflare unzip
npm i -g pm2

echo "==> Creating directories..."
mkdir -p "$APP_DIR" "$SITES_ROOT" /var/log/nctti-sites
chown -R www-data:www-data "$SITES_ROOT"

echo "==> Wildcard SSL (needs ~/.secrets/cloudflare.ini with dns_cloudflare_api_token)..."
if [ ! -f ~/.secrets/cloudflare.ini ]; then
  echo "!! Create ~/.secrets/cloudflare.ini first:"
  echo '   dns_cloudflare_api_token = YOUR_TOKEN'
  exit 1
fi
chmod 600 ~/.secrets/cloudflare.ini
certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials ~/.secrets/cloudflare.ini \
  -d "$DOMAIN" -d "*.$DOMAIN" \
  --non-interactive --agree-tos -m admin@nctti.tech || true

echo "==> nginx config..."
cp ops/nginx-sites.conf /etc/nginx/sites-available/nctti-sites
ln -sf /etc/nginx/sites-available/nctti-sites /etc/nginx/sites-enabled/nctti-sites
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> DNS (do this in Cloudflare dashboard)..."
echo "   A   $DOMAIN          -> <this VPS IP>   (DNS only / grey cloud)"
echo "   A   *.$DOMAIN        -> <this VPS IP>   (DNS only / grey cloud)"
echo "   (Grey cloud because nginx serves the wildcard directly.)"

echo "==> Deploy the app code to $APP_DIR, copy .env, then:"
echo "   cd $APP_DIR && pm2 start server.js --name nctti-sites && pm2 save && pm2 startup"
echo "Done."
