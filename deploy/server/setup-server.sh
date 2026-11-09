#!/usr/bin/env bash
# One-time server setup for the CI/CD deploy. Run it once on the server, as an administrator:
#
#   nano setup-server.sh        (paste this file, save with Ctrl+O, Enter, Ctrl+X)
#   sudo bash setup-server.sh
#
# It creates:
#   - the user "deploy" (member of the docker group) with an SSH key that only GitHub uses,
#   - the settings file /home/deploy/padi-mcp/.env (it asks for the administrator account and
#     the local port; when 3000 is taken, for example by MCP for iCloud, it offers the next one),
#   - /root/padi-mcp-github-secrets.txt with the two GitHub secrets and the encryption key.
# At the end it prints a few facts about Docker on this server (no secrets) to send to Claude.
#
# Running it again is safe: an existing user, key or .env is kept as it is.

# Started with "sh"? Run again with bash, which this script needs.
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -euo pipefail
umask 077

DEPLOY_USER=${DEPLOY_USER:-deploy}
HOST_PORT=${HOST_PORT:-3000}
KEY_COMMENT="github-deploy padi-mcp"
SECRETS_FILE=${SECRETS_FILE:-/root/padi-mcp-github-secrets.txt}

say() { printf '\n== %s\n' "$*"; }
die() {
  printf '\nerror: %s\n' "$*" >&2
  exit 1
}
# The first port from $1 upwards that nothing listens on (or $1 when ss is missing).
free_port() {
  local p=$1
  if command -v ss >/dev/null 2>&1; then
    while ss -ltn "sport = :$p" | grep -q LISTEN; do p=$((p + 1)); done
  fi
  printf '%s' "$p"
}
ask() { # ask VAR "question" [default]
  local answer
  read -r -p "$2${3:+ [$3]}: " answer || true
  printf -v "$1" '%s' "${answer:-${3:-}}"
}

[ "$(id -u)" = 0 ] || die "run this with sudo: sudo bash $0"
command -v docker >/dev/null 2>&1 || die "Docker is not installed (https://docs.docker.com/engine/install/ubuntu/)"
docker info >/dev/null 2>&1 || die "Docker is installed but not running (sudo systemctl start docker)"
if ! docker compose version >/dev/null 2>&1; then
  die "the Docker Compose plugin is missing. Install it with: sudo apt-get install -y docker-compose-plugin (or docker-compose-v2 if Docker came from Ubuntu's own packages), then run this again"
fi
command -v ssh-keygen >/dev/null 2>&1 || die "ssh-keygen is missing (sudo apt-get install -y openssh-client)"
command -v openssl >/dev/null 2>&1 || die "openssl is missing (sudo apt-get install -y openssl)"

home="/home/$DEPLOY_USER"
app="$home/padi-mcp"

say "Questions"
ask SSH_HOST "Host name GitHub uses to reach this server over SSH" "nebula.visin.ch"
ask DOMAIN "Public host name of the PADI service" "padi.mcp.visin.ch"
[[ $SSH_HOST =~ ^[A-Za-z0-9.-]+$ ]] || die "not a host name: $SSH_HOST"
[[ $DOMAIN =~ ^[A-Za-z0-9.-]+$ ]] || die "not a host name: $DOMAIN"
if [ -f "$app/.env" ]; then
  HOST_PORT=$(sed -n 's/^HOST_PORT=\([0-9]*\)$/\1/p' "$app/.env" | tail -n 1)
  HOST_PORT=${HOST_PORT:-3000}
else
  ask HOST_PORT "Local port of the service (your reverse proxy forwards to it)" "$(free_port "$HOST_PORT")"
  [[ $HOST_PORT =~ ^[0-9]{1,5}$ ]] && [ "$HOST_PORT" -ge 1024 ] && [ "$HOST_PORT" -le 65535 ] ||
    die "not a port from 1024 to 65535: $HOST_PORT"
  ask ADMIN_EMAIL "Administrator e-mail (to sign in to the service)"
  [[ $ADMIN_EMAIL =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "not an e-mail address: $ADMIN_EMAIL"
  while :; do
    read -r -s -p "Administrator password (at least 10 characters, no ' character): " ADMIN_PASSWORD || true
    echo
    read -r -s -p "Repeat the password: " again || true
    echo
    if [ "$ADMIN_PASSWORD" != "$again" ]; then
      echo "The passwords do not match. Try again."
    elif [ "${#ADMIN_PASSWORD}" -lt 10 ] || [ "${#ADMIN_PASSWORD}" -gt 200 ]; then
      echo "Use 10 to 200 characters. Try again."
    elif [[ $ADMIN_PASSWORD == *"'"* ]]; then
      echo "Please do not use the ' character. Try again."
    else
      break
    fi
  done
fi

say "User $DEPLOY_USER"
if id "$DEPLOY_USER" >/dev/null 2>&1; then
  echo "The user exists already."
else
  useradd -m -s /bin/bash "$DEPLOY_USER"
  echo "Created the user."
fi
usermod -aG docker "$DEPLOY_USER"
echo "The user is in the docker group (this gives it root-level control over Docker)."

say "SSH key for GitHub"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$home/.ssh"
touch "$home/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
private_key=""
if grep -qF "$KEY_COMMENT" "$home/.ssh/authorized_keys"; then
  echo "A GitHub key is already installed. To make a new one, remove its line from"
  echo "$home/.ssh/authorized_keys and run this again."
else
  tmp=$(mktemp -d)
  ssh-keygen -q -t ed25519 -N "" -C "$KEY_COMMENT" -f "$tmp/key"
  # "restrict": no port forwarding, no agent, no terminal. The deploy only runs commands.
  printf 'restrict %s\n' "$(cat "$tmp/key.pub")" >>"$home/.ssh/authorized_keys"
  private_key=$(cat "$tmp/key")
  rm -rf "$tmp"
  echo "Created a new key and allowed it for $DEPLOY_USER."
fi

say "Settings in $app/.env"
install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$app"
master_key=""
if [ -f "$app/.env" ]; then
  echo "$app/.env exists already and was not changed."
else
  master_key=$(openssl rand -hex 32)
  cat >"$app/.env" <<EOF
# Settings for the MCP for PADI service (see .env.example after the first deploy).
DOMAIN=$DOMAIN
HOST_PORT=$HOST_PORT
TRUST_PROXY=1
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD='$ADMIN_PASSWORD'
MASTER_KEY=$master_key
EOF
  echo "Created it."
fi
chown "$DEPLOY_USER:$DEPLOY_USER" "$app/.env"
chmod 600 "$app/.env"

say "GitHub secrets"
port=$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }') || true
port=${port:-22}
known_host=$SSH_HOST
if [ "$port" != 22 ]; then known_host="[$SSH_HOST]:$port"; fi
if [ -z "$private_key" ] && [ -z "$master_key" ] && [ -f "$SECRETS_FILE" ]; then
  echo "Kept the existing $SECRETS_FILE (it may still hold the only copy of the key)."
else
{
  echo "Add these in GitHub: repository > Settings > Secrets and variables > Actions > New repository secret."
  echo "Delete this file afterwards: sudo rm $SECRETS_FILE"
  echo
  echo "===== Secret name: DEPLOY_KNOWN_HOSTS (copy all lines between the markers)"
  for f in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub /etc/ssh/ssh_host_rsa_key.pub; do
    if [ -f "$f" ]; then printf '%s %s\n' "$known_host" "$(awk '{ print $1 " " $2 }' "$f")"; fi
  done
  echo "===== end"
  echo
  if [ -n "$private_key" ]; then
    echo "===== Secret name: DEPLOY_SSH_KEY (copy all lines between the markers, including BEGIN and END)"
    printf '%s\n' "$private_key"
    echo "===== end"
  else
    echo "DEPLOY_SSH_KEY: not shown, because the key was created earlier (see above)."
  fi
  if [ -n "$master_key" ]; then
    echo
    echo "MASTER_KEY (not for GitHub): save it in your password manager. It decrypts the stored"
    echo "PADI sign-ins (refresh tokens), so you need it to restore a backup."
    echo "$master_key"
  fi
  if [ "$port" != 22 ]; then
    echo
    echo "SSH listens on port $port: also add the repository variable DEPLOY_PORT=$port."
  fi
} >"$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"
echo "Written to $SECRETS_FILE (only root can read it)."
fi

say "Facts for Claude (no secrets, you can copy this part)"
grep -E '^PRETTY_NAME=' /etc/os-release || true
echo "arch: $(uname -m)"
docker compose version
echo "--- containers"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
echo "--- networks"
docker network ls --format 'table {{.Name}}\t{{.Driver}}'
echo "--- port $HOST_PORT"
if ! command -v ss >/dev/null 2>&1; then
  echo "could not check (ss is missing)"
elif ss -ltn "sport = :$HOST_PORT" | grep -q LISTEN; then
  echo "port $HOST_PORT is in use"
else
  echo "port $HOST_PORT is free"
fi
echo "--- ssh port: $port"
echo "--- end of facts"

say "Next steps"
echo "1. sudo cat $SECRETS_FILE   and add the secrets in GitHub, then: sudo rm $SECRETS_FILE"
echo "2. Add a DNS record: A $DOMAIN -> this server's public IP address."
echo "3. Point your reverse proxy at http://127.0.0.1:$HOST_PORT for $DOMAIN (see README.md)."
echo "4. Send the 'Facts for Claude' part above to Claude."
