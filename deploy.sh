#!/usr/bin/env bash
# Installs (or updates the settings of) a church's captioning backend on Google Cloud Run.
# Safe to run again at any time. Normally run from Cloud Shell via the Setup page's
# "Install on Google Cloud" button.
#
#   ./deploy.sh                 install, or re-check an existing install
#   ./deploy.sh --new-key       replace the Soniox key
#   ./deploy.sh --rotate-token  issue a new sound desk link (the old one stops working)
#   ./deploy.sh --reselect      support use: pick the Cloud Run region again
#   REGION=europe-west2 ./deploy.sh   support use: force a region
set -euo pipefail
cd "$(dirname "$0")"

APP_URL="https://tobyfielding1.github.io/self-hosted-captioning/"
SERVICE="captioning"
LABEL="app=captioning"

NEW_KEY=false ROTATE=false RESELECT=false
for arg in "$@"; do
  case "$arg" in
    --new-key) NEW_KEY=true ;;
    --rotate-token) ROTATE=true ;;
    --reselect) RESELECT=true ;;
    *) echo "Unknown option: $arg"; exit 2 ;;
  esac
done

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
fail() {
  printf '\n\033[1;31m%s\033[0m\n' "$1"
  [ -n "${2:-}" ] && printf '%s\n' "$2"
  printf '\nWhen that is fixed, run this again:  ./deploy.sh\n\n'
  exit 1
}
STEP="starting"
trap 'fail "Something went wrong while ${STEP}." "Copy the text above and send it to your helper, or simply run the install again."' ERR

# --------------------------------------------------------------------------- project
STEP="finding your Google Cloud project"
bold "Setting up live captions"
ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
[ -n "$ACCOUNT" ] || fail "You're not signed in to Google Cloud." "Open this page from the church Google account: https://shell.cloud.google.com"

PROJECT="$(gcloud projects list --filter="labels.${LABEL/=/:}" --format='value(projectId)' --limit=1 2>/dev/null || true)"
if [ -z "$PROJECT" ]; then
  PROJECT="captioning-$(openssl rand -hex 3)"
  STEP="creating a Google Cloud project"
  note "Creating project ${PROJECT}..."
  gcloud projects create "$PROJECT" --name="Live captions" --labels="$LABEL" --quiet >/dev/null 2>&1 ||
    fail "Google wouldn't let this account create a new project." \
      "This usually means the account has reached its project limit or belongs to an organisation that restricts projects. Ask your helper, or try a different Google account."
fi
note "Project: ${PROJECT}"
gcloud config set project "$PROJECT" >/dev/null 2>&1

# --------------------------------------------------------------------------- billing
STEP="checking billing"
BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' 2>/dev/null || true)"
BILLING="${BILLING#billingAccounts/}"
if [ -z "$BILLING" ]; then
  mapfile -t ACCOUNTS < <(gcloud billing accounts list --filter=open=true --format='value(name.basename(),displayName)' 2>/dev/null || true)
  if [ "${#ACCOUNTS[@]}" -eq 0 ]; then
    fail "Billing isn't set up on this Google account." \
      "Open https://console.cloud.google.com/billing/create, add a card (normal use stays within the free tier), then run this again."
  elif [ "${#ACCOUNTS[@]}" -eq 1 ]; then
    BILLING="$(cut -f1 <<<"${ACCOUNTS[0]}")"
  else
    bold "Which billing account should pay for captions?"
    for i in "${!ACCOUNTS[@]}"; do printf '  %d) %s\n' "$((i + 1))" "$(cut -f2 <<<"${ACCOUNTS[$i]}")"; done
    read -rp "Type a number and press Enter: " CHOICE
    [[ "$CHOICE" =~ ^[0-9]+$ ]] && [ "$CHOICE" -ge 1 ] && [ "$CHOICE" -le "${#ACCOUNTS[@]}" ] || fail "That wasn't one of the numbers."
    BILLING="$(cut -f1 <<<"${ACCOUNTS[$((CHOICE - 1))]}")"
  fi
  gcloud billing projects link "$PROJECT" --billing-account="$BILLING" >/dev/null 2>&1 ||
    fail "Couldn't connect billing to the project." "Make sure this Google account can manage billing account ${BILLING}, then run this again."
fi
note "Billing: connected"

# --------------------------------------------------------------------------- services
STEP="turning on Google Cloud services"
note "Turning on services (this can take a minute the first time)..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  translate.googleapis.com billingbudgets.googleapis.com cloudresourcemanager.googleapis.com --quiet >/dev/null

# --------------------------------------------------------------------------- region
STEP="choosing the closest region"
REGION="${REGION:-}"
EXISTING_REGION="$(gcloud run services list --filter="metadata.name=${SERVICE}" --format='value(region)' --limit=1 2>/dev/null || true)"
if [ -z "$REGION" ] && [ -n "$EXISTING_REGION" ] && ! $RESELECT; then REGION="$EXISTING_REGION"; fi
if [ -z "$REGION" ]; then
  RUN_REGIONS="$(gcloud run regions list --format='value(locationId)')"
  # Cloud Shell is placed in the Google Cloud region closest to the person using it.
  ZONE="$(curl -sf -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/zone 2>/dev/null || true)"
  CANDIDATE="${ZONE##*/}"
  CANDIDATE="${CANDIDATE%-*}"
  if [ -n "$CANDIDATE" ] && grep -qx "$CANDIDATE" <<<"$RUN_REGIONS"; then
    REGION="$CANDIDATE"
  else
    note "Measuring which region is fastest from here..."
    BEST_MS=999999
    for r in $RUN_REGIONS; do
      t="$(curl -s -o /dev/null -m 3 -w '%{time_connect}' "https://${r}-run.googleapis.com/" 2>/dev/null || echo 9)"
      ms="$(awk -v t="$t" 'BEGIN { printf "%d", t * 1000 }')"
      if [ "$ms" -gt 0 ] && [ "$ms" -lt "$BEST_MS" ]; then BEST_MS="$ms" REGION="$r"; fi
    done
  fi
fi
[ -n "$REGION" ] || fail "Couldn't work out the closest region." "Ask your helper to run: REGION=<region> ./deploy.sh"
note "Region: ${REGION}"

# --------------------------------------------------------------------------- existing settings
STEP="reading the current settings"
CURRENT_ENV="{}"
if [ -n "$EXISTING_REGION" ]; then
  CURRENT_ENV="$(gcloud run services describe "$SERVICE" --region="$EXISTING_REGION" --format=json 2>/dev/null |
    python3 -c 'import json,sys; s=json.load(sys.stdin); c=s["spec"]["template"]["spec"]["containers"][0]; print(json.dumps({e["name"]: e.get("value","") for e in c.get("env",[])}))' 2>/dev/null || echo '{}')"
fi
env_value() { python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2], ""))' "$CURRENT_ENV" "$1"; }
KEY="$(env_value SONIOX_API_KEY)"
TOKEN="$(env_value SPEAKER_TOKEN)"

# --------------------------------------------------------------------------- Soniox key
STEP="checking your Soniox key"
REGIONS_LINE="$(grep -o 'SONIOX_REGIONS = \[[^]]*\]' backend/src/soniox.ts)"
mapfile -t SONIOX_REGIONS < <(grep -o '"[a-z]*"' <<<"$REGIONS_LINE" | tr -d '"')
key_works() {
  local r host
  for r in "${SONIOX_REGIONS[@]}"; do
    if [ -z "$r" ]; then host="api.soniox.com"; else host="api.${r}.soniox.com"; fi
    if [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' -H "Authorization: Bearer $1" "https://${host}/v1/models")" = "200" ]; then
      return 0
    fi
  done
  return 1
}
if [ -z "$KEY" ] || $NEW_KEY; then
  bold "Paste your Soniox API key and press Enter"
  note "(Nothing appears while you paste. That's normal.)"
  read -rsp "   Soniox key: " KEY
  echo
  KEY="$(tr -d '[:space:]' <<<"$KEY")"
  [ -n "$KEY" ] || fail "No key was pasted."
fi
key_works "$KEY" || fail "Soniox didn't accept that key." \
  "Copy the key again from https://console.soniox.com (API keys), check the account has credit, then run: ./deploy.sh --new-key"
note "Soniox key: OK"

# --------------------------------------------------------------------------- sound desk link
if [ -z "$TOKEN" ] || $ROTATE; then TOKEN="$(openssl rand -hex 16)"; fi

# --------------------------------------------------------------------------- service accounts
STEP="setting up permissions"
RUN_SA="captioning-run@${PROJECT}.iam.gserviceaccount.com"
BUILD_SA="captioning-build@${PROJECT}.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$RUN_SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create captioning-run --display-name="Captioning server" --quiet >/dev/null
gcloud iam service-accounts describe "$BUILD_SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create captioning-build --display-name="Captioning build" --quiet >/dev/null
grant() {
  local tries=0
  until gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$1" --role="$2" --condition=None --quiet >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 6 ] || return 1
    sleep 5 # new service accounts take a few seconds to appear
  done
}
grant "$RUN_SA" roles/cloudtranslate.user
grant "$BUILD_SA" roles/run.builder

# --------------------------------------------------------------------------- budget alert
STEP="creating a budget alert"
if [ -n "$BILLING" ] || BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName.basename())' 2>/dev/null)"; then
  if [ -z "$(gcloud billing budgets list --billing-account="$BILLING" --filter="displayName='Live captions alert'" --format='value(name)' 2>/dev/null || true)" ]; then
    CURRENCY="$(gcloud billing accounts describe "$BILLING" --format='value(currencyCode)' 2>/dev/null || echo GBP)"
    if gcloud billing budgets create --billing-account="$BILLING" --display-name="Live captions alert" \
      --budget-amount="5${CURRENCY}" --filter-projects="projects/${PROJECT}" \
      --threshold-rule=percent=0.5 --threshold-rule=percent=1.0 >/dev/null 2>&1; then
      note "Budget alert: you'll get an email if spending passes 5 ${CURRENCY} a month"
    else
      note "Budget alert: skipped (this account can't create budgets; that's fine)"
    fi
  fi
fi

# --------------------------------------------------------------------------- deploy
STEP="installing the captioning server"
bold "Installing the captioning server (about 3 minutes)..."
gcloud run deploy "$SERVICE" \
  --source backend \
  --region "$REGION" \
  --allow-unauthenticated \
  --max-instances=1 --min-instances=0 \
  --timeout=3600 --concurrency=1000 \
  --cpu=1 --memory=512Mi \
  --service-account="$RUN_SA" \
  --build-service-account="projects/${PROJECT}/serviceAccounts/${BUILD_SA}" \
  --update-env-vars="^@^SONIOX_API_KEY=${KEY}@SPEAKER_TOKEN=${TOKEN}" \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"

STEP="checking the server answers"
CODE="$(curl -s -o /dev/null -m 30 -w '%{http_code}' "${URL}/status" || true)"
if [ "$CODE" = "403" ]; then
  fail "The server is installed, but your organisation blocks public access to it." \
    "Phones need to reach it without signing in. Ask whoever manages this Google organisation to allow public Cloud Run services (the 'Domain restricted sharing' policy), or use a personal Google account."
fi

bold "Done! Open this link to finish:"
printf '\n   %s#setup&backend=%s&token=%s\n\n' "$APP_URL" "$URL" "$TOKEN"
note "Keep that link private: it includes the sound desk's access."
