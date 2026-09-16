#!/usr/bin/env bash
#
# Builds the machine that holds Grace's voice open.
#
# Run this in Google Cloud Shell, which already has gcloud installed and is
# already signed in as you. Nothing needs installing on your own computer, and
# nothing here touches it.
#
#   bash setup.sh
#
# It is safe to run more than once. Everything it creates is checked for first,
# so a second run repairs rather than duplicates — which matters, because the
# usual reason to run it again is that something went wrong halfway.

set -euo pipefail

# Everything this needs is settled before anything is created.
#
# It used to read the token near the end, when it was writing the service
# file — which meant a missing one failed *after* building a virtual machine,
# leaving a half-made thing behind and no clue which half. Anything that can
# be checked before the first side effect is checked here.
#
# Asking is deliberate rather than requiring an exported variable: the first
# attempt at this had people copy a placeholder in angle brackets straight
# into the shell, where `<` is a redirect, and the error it produced said
# nothing whatsoever about tokens.

if [ -z "${GRACE_URL:-}" ]; then
  read -rp "Grace's address [https://grace-vercel.vercel.app]: " GRACE_URL
  GRACE_URL="${GRACE_URL:-https://grace-vercel.vercel.app}"
fi

if [ -z "${GRACE_OUTPOST_TOKEN:-}" ]; then
  echo
  echo "The token is in Grace's side panel, under the section about your phone."
  echo "It is the same one Siri uses. Paste it here (it will not be shown):"
  read -rs GRACE_OUTPOST_TOKEN
  echo
fi

case "$GRACE_URL" in
  https://*) ;;
  *) echo "Grace's address must start with https:// — got '$GRACE_URL'" >&2; exit 1 ;;
esac

if [ "${#GRACE_OUTPOST_TOKEN}" -lt 16 ]; then
  # Long enough to be the real thing. A placeholder, a shell error or an empty
  # paste all land here, and all of them would otherwise build a machine that
  # silently refuses every connection.
  echo "That does not look like the token (too short). Copy it from the side panel." >&2
  exit 1
fi

export GRACE_URL GRACE_OUTPOST_TOKEN

echo "Checking that address and token actually work before building anything..."
if ! curl -fsS -X POST "${GRACE_URL%/}/api/relay" \
  -H 'content-type: application/json' \
  -d "{\"token\":\"${GRACE_OUTPOST_TOKEN}\",\"probe\":true}" >/dev/null 2>&1; then
  echo >&2
  echo "Grace refused that token, or could not be reached at $GRACE_URL." >&2
  echo "Nothing has been created. Check the token in her side panel and try again." >&2
  exit 1
fi
echo "Good — she recognised it."

PROJECT="${GCP_PROJECT_ID:-ai-agents-508818}"
ZONE="${GCE_ZONE:-europe-north1-b}"
NAME="${GCE_NAME:-grace-outpost}"
ACCOUNT="grace-outpost"
# e2-small, not e2-micro. The free-tier micro has 1GB of memory and spends it
# on the operating system; Node plus a browser for the web agent will not fit,
# and discovering that as random out-of-memory kills weeks later is worse than
# the few pounds a month this costs.
MACHINE="${GCE_MACHINE:-e2-small}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Using project $PROJECT, zone $ZONE"
gcloud config set project "$PROJECT" --quiet

say "Turning on the services this needs"
gcloud services enable compute.googleapis.com aiplatform.googleapis.com --quiet

say "Making an identity for the machine"
# The VM gets its own service account rather than carrying a copy of the key
# Vercel uses. It can then ask Google for a fresh token whenever it needs one,
# so there is no key file on a machine that sits on the public internet.
if ! gcloud iam service-accounts describe \
  "${ACCOUNT}@${PROJECT}.iam.gserviceaccount.com" --quiet >/dev/null 2>&1; then
  gcloud iam service-accounts create "$ACCOUNT" \
    --display-name="Grace's outpost" --quiet
fi

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${ACCOUNT}@${PROJECT}.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user" --quiet >/dev/null

say "Opening the one port the browser needs"
if ! gcloud compute firewall-rules describe grace-outpost-web --quiet >/dev/null 2>&1; then
  # 443 only. Not 22 from anywhere, not the port the service actually listens
  # on — that stays bound to localhost, with Caddy in front of it holding the
  # certificate. The only thing reachable from outside is HTTPS.
  gcloud compute firewall-rules create grace-outpost-web \
    --allow=tcp:443 --target-tags=grace-outpost \
    --description="Grace's voice, over TLS" --quiet
fi

say "Reserving a permanent address"
# Without this the address is temporary, and a temporary address is released
# the moment the machine is stopped — which is exactly what you are told to do
# to save money overnight. You would stop it, start it the next morning, and
# find her voice pointing at an address that now belongs to a stranger.
#
# A reserved address costs a few pence a month while the machine is off and
# nothing at all while it is running.
if ! gcloud compute addresses describe "$NAME" --region="${ZONE%-*}" \
  --quiet >/dev/null 2>&1; then
  gcloud compute addresses create "$NAME" --region="${ZONE%-*}" --quiet
fi
RESERVED="$(gcloud compute addresses describe "$NAME" --region="${ZONE%-*}" \
  --format='get(address)')"

say "Creating the machine (this takes a minute)"
if ! gcloud compute instances describe "$NAME" --zone="$ZONE" --quiet >/dev/null 2>&1; then
  gcloud compute instances create "$NAME" \
    --zone="$ZONE" \
    --machine-type="$MACHINE" \
    --image-family=debian-12 \
    --image-project=debian-cloud \
    --boot-disk-size=20GB \
    --tags=grace-outpost \
    --service-account="${ACCOUNT}@${PROJECT}.iam.gserviceaccount.com" \
    --scopes=https://www.googleapis.com/auth/cloud-platform \
    --address="$RESERVED" \
    --quiet
fi

# A machine created before this script reserved addresses is still on a
# temporary one. Moving it over is two operations and saves the address
# changing under her the first time you stop the machine overnight.
CURRENT="$(gcloud compute instances describe "$NAME" --zone="$ZONE" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
if [ "$CURRENT" != "$RESERVED" ]; then
  say "Moving the machine onto the permanent address"
  gcloud compute instances delete-access-config "$NAME" --zone="$ZONE" \
    --access-config-name="external-nat" --quiet
  gcloud compute instances add-access-config "$NAME" --zone="$ZONE" \
    --access-config-name="external-nat" --address="$RESERVED" --quiet
fi

IP="$(gcloud compute instances describe "$NAME" --zone="$ZONE" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"

# nip.io turns an address into a name that resolves back to it, which is what
# Let's Encrypt needs to issue a certificate. Browsers refuse an insecure
# socket from a secure page, so the voice needs real TLS — and this gets it
# without buying a domain. Point a real subdomain here later if you'd rather.
HOST="${GRACE_OUTPOST_HOST:-${IP//./-}.nip.io}"

say "The machine is at $IP, and will answer to $HOST"
say "Installing everything on it"

gcloud compute ssh "$NAME" --zone="$ZONE" --quiet --command "bash -s" <<REMOTE
set -euo pipefail
sudo apt-get update -qq
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
sudo apt-get install -y -qq nodejs caddy >/dev/null 2>&1 || {
  sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq caddy
}
sudo mkdir -p /opt/grace-outpost
sudo chown -R \$USER /opt/grace-outpost
REMOTE

say "Copying the service across"
gcloud compute scp outpost.mjs package.json "$NAME":/opt/grace-outpost/ \
  --zone="$ZONE" --quiet

say "Starting it"
gcloud compute ssh "$NAME" --zone="$ZONE" --quiet --command "bash -s" <<REMOTE
set -euo pipefail
cd /opt/grace-outpost
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1

sudo tee /etc/grace-outpost.env >/dev/null <<ENV
GCP_PROJECT_ID=${PROJECT}
GCP_LOCATION=${GCP_LOCATION:-global}
GRACE_URL=${GRACE_URL}
GRACE_OUTPOST_TOKEN=${GRACE_OUTPOST_TOKEN}
PORT=8787
ENV
sudo chmod 600 /etc/grace-outpost.env

sudo tee /etc/systemd/system/grace-outpost.service >/dev/null <<'UNIT'
[Unit]
Description=Grace's outpost
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/grace-outpost.env
WorkingDirectory=/opt/grace-outpost
ExecStart=/usr/bin/node outpost.mjs
Restart=always
RestartSec=3
# A voice that stays down after one bad night is not a voice. Restarting
# forever is right here: there is no state to corrupt and nothing to lose by
# trying again, and the alternative is finding out it died three days ago.
[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
${HOST} {
  reverse_proxy 127.0.0.1:8787
}
CADDY

sudo systemctl daemon-reload
sudo systemctl enable --now grace-outpost
sudo systemctl restart caddy
REMOTE

say "Done."
cat <<DONE

  Grace's outpost is at:  https://${HOST}
  Health check:           https://${HOST}/health

  Add this to Vercel, then redeploy:

    GRACE_OUTPOST_URL = wss://${HOST}/voice

  To stop it costing anything while you are not using it:
    gcloud compute instances stop ${NAME} --zone=${ZONE}

DONE
