#!/usr/bin/env bash
# Instalação do servidor Enif DOOH num Ubuntu 24.04 limpo (como root).
# Uso: bash instalar-servidor.sh enifdooh.pt [ramo]
# Pode ser executado outra vez sem estragar nada (atualiza o que faltar).
set -euo pipefail

DOMINIO="${1:-}"
RAMO="${2:-versao-real-v62}"
REPO="https://github.com/tiagooliveira-enif/enif-ooh"
APP=/opt/enif-ooh
DADOS=/var/lib/enif
CONF=/etc/enif

[ -n "$DOMINIO" ] || { echo "Uso: bash instalar-servidor.sh enifdooh.pt"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Execute como root."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> 1/7 Atualizar o sistema e instalar programas"
apt-get update -y
apt-get upgrade -y
apt-get install -y git curl ca-certificates ufw ffmpeg unattended-upgrades gnupg debian-keyring debian-archive-keyring apt-transport-https
if ! apt-get install -y caddy; then
  echo "    caddy não existe no Ubuntu; a usar o repositório oficial"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> 2/7 Node.js 22"
if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> 3/7 Utilizador e pastas"
id enif >/dev/null 2>&1 || useradd --system --home "$DADOS" --shell /usr/sbin/nologin enif
mkdir -p "$DADOS" "$CONF"
chown -R enif:enif "$DADOS"

echo "==> 4/7 Código da aplicação (ramo $RAMO)"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch origin "$RAMO"
  git -C "$APP" checkout -q "$RAMO" 2>/dev/null || git -C "$APP" checkout -q -b "$RAMO" "origin/$RAMO"
  git -C "$APP" reset --hard "origin/$RAMO"
else
  git clone -b "$RAMO" "$REPO" "$APP"
fi

echo "==> 5/7 Ficheiro de configuração (fica só no servidor)"
NOVO=0
if [ ! -f "$CONF/enif-config.json" ]; then
  cp "$APP/enif-config.example.json" "$CONF/enif-config.json"
  NOVO=1
fi
chown root:enif "$CONF/enif-config.json"
chmod 640 "$CONF/enif-config.json"

echo "==> 6/7 Arranque automático da aplicação"
cat > /etc/systemd/system/enif.service <<UNIT
[Unit]
Description=Enif DOOH
After=network-online.target
Wants=network-online.target

[Service]
User=enif
WorkingDirectory=$APP
Environment=DATA_DIR=$DADOS CONFIG_FILE=$CONF/enif-config.json TZ_NAME=Europe/Lisbon NODE_ENV=production PORT=8080
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DADOS

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable enif >/dev/null

cat > /usr/local/bin/enif-atualizar <<UPD
#!/usr/bin/env bash
# Atualiza a aplicação sem mexer em conteúdos, programação ou configuração.
set -euo pipefail
RAMO="\${1:-$RAMO}"
systemctl stop enif
mkdir -p $DADOS/antes-de-atualizar
D="$DADOS/antes-de-atualizar/\$(date +%Y%m%d-%H%M%S)"
mkdir -p "\$D"
cp -a $DADOS/enif-data.db* "\$D"/ 2>/dev/null || true
ls -1dt $DADOS/antes-de-atualizar/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf
git -C $APP fetch origin "\$RAMO"
git -C $APP reset --hard "origin/\$RAMO"
systemctl start enif
sleep 3
systemctl --no-pager --lines=5 status enif || true
UPD
chmod +x /usr/local/bin/enif-atualizar

echo "==> 7/7 HTTPS (Caddy) e firewall"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMINIO {
	reverse_proxy 127.0.0.1:8080
}

www.$DOMINIO {
	redir https://$DOMINIO{uri} permanent
}
CADDY
systemctl enable caddy >/dev/null
systemctl restart caddy

ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null

if grep -q "O seu nome" "$CONF/enif-config.json"; then
  echo
  echo "FALTA UM PASSO: preencher o ficheiro de configuração (administrador, e-mail, calendário)."
  echo "  nano $CONF/enif-config.json"
  echo "Depois de guardar (Ctrl+O, Enter, Ctrl+X):  systemctl restart enif"
else
  systemctl restart enif
  sleep 3
  systemctl --no-pager --lines=8 status enif || true
  echo
  echo "Pronto: https://$DOMINIO"
fi
[ "$NOVO" = 1 ] && echo "(ficheiro de configuração novo criado em $CONF/enif-config.json)"
exit 0
