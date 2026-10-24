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

# gcloud must never stop to ask a question: its output is hidden, so a prompt would look like a hang.
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
LOG="$HOME/captioning-install.log"
printf '=== %s install started\n' "$(date -u +%FT%TZ)" >"$LOG"
WORK="$(mktemp -d)"

# A spinner with a seconds counter, so quiet steps never look frozen. Any output stops it.
SPIN_PID=""
spin() {
  spin_stop
  printf '%s %s\n' "$(date -u +%T)" "$1" >>"$LOG"
  if [ ! -t 1 ]; then printf '   %s...\n' "$1"; return 0; fi
  (
    frames='|/-\' i=0 start=$SECONDS
    while :; do
      printf '\r   %s %s... %ds ' "${frames:$((i++ % 4)):1}" "$1" $((SECONDS - start))
      sleep 0.2
    done
  ) &
  SPIN_PID=$!
}
spin_stop() {
  [ -n "$SPIN_PID" ] || return 0
  kill "$SPIN_PID" 2>/dev/null || true
  wait "$SPIN_PID" 2>/dev/null || true
  SPIN_PID=""
  printf '\r\033[K'
}

BG_PID=""
cleanup() {
  spin_stop
  if [ -n "$BG_PID" ] && kill -0 "$BG_PID" 2>/dev/null; then
    pkill -P "$BG_PID" 2>/dev/null || true
    kill "$BG_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

bold() { spin_stop; printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { spin_stop; printf '   %s\n' "$*"; }
fail() {
  spin_stop
  printf '\n\033[1;31m%s\033[0m\n' "$1"
  [ -n "${2:-}" ] && printf '%s\n' "$2"
  printf '\nDetails for your helper are saved in %s\n' "$LOG"
  printf '\nWhen that is fixed, run this again:  ./deploy.sh\n\n'
  exit 1
}
STEP="starting"
trap 'fail "Something went wrong while ${STEP}." "Copy the text above and send it to your helper, or simply run the install again."' ERR

# --------------------------------------------------------------------------- project
STEP="finding your Google Cloud project"
bold "Setting up live captions"
ACCOUNT="$(gcloud config get-value account 2>>"$LOG" || true)"
[ -n "$ACCOUNT" ] || fail "You're not signed in to Google Cloud." "Open this page from the church Google account: https://shell.cloud.google.com"

spin "Looking for your captions project"
PROJECT="$(gcloud projects list --filter="labels.${LABEL/=/:}" --format='value(projectId)' --limit=1 2>>"$LOG" || true)"
if [ -z "$PROJECT" ]; then
  PROJECT="captioning-$(openssl rand -hex 3)"
  STEP="creating a Google Cloud project"
  note "Creating project ${PROJECT}..."
  gcloud projects create "$PROJECT" --name="Live captions" --labels="$LABEL" --quiet >/dev/null 2>>"$LOG" ||
    fail "Google wouldn't let this account create a new project." \
      "This usually means the account has reached its project limit or belongs to an organisation that restricts projects. Ask your helper, or try a different Google account."
fi
note "Project: ${PROJECT}"
gcloud config set project "$PROJECT" >/dev/null 2>>"$LOG"

# --------------------------------------------------------------------------- billing
STEP="checking billing"
spin "Checking billing"
BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' 2>>"$LOG" || true)"
BILLING="${BILLING#billingAccounts/}"
if [ -z "$BILLING" ]; then
  mapfile -t ACCOUNTS < <(gcloud billing accounts list --filter=open=true --format='value(name.basename(),displayName)' 2>>"$LOG" || true)
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
  gcloud billing projects link "$PROJECT" --billing-account="$BILLING" >/dev/null 2>>"$LOG" ||
    fail "Couldn't connect billing to the project." "Make sure this Google account can manage billing account ${BILLING}, then run this again."
fi
note "Billing: connected"

# --------------------------------------------------------------------------- existing install
# Fails fast (no prompts) when Cloud Run isn't turned on yet, which means there's no install.
STEP="checking for an existing install"
spin "Checking for an existing install"
EXISTING_REGION="$(timeout 60 gcloud run services list --filter="metadata.name=${SERVICE}" --format='value(region)' --limit=1 2>>"$LOG" || true)"
CURRENT_ENV="{}"
if [ -n "$EXISTING_REGION" ]; then
  CURRENT_ENV="$(timeout 60 gcloud run services describe "$SERVICE" --region="$EXISTING_REGION" --format=json 2>>"$LOG" |
    python3 -c 'import json,sys; s=json.load(sys.stdin); c=s["spec"]["template"]["spec"]["containers"][0]; print(json.dumps({e["name"]: e.get("value","") for e in c.get("env",[])}))' 2>>"$LOG" || echo '{}')"
fi
env_value() { python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2], ""))' "$CURRENT_ENV" "$1"; }
KEY="$(env_value SONIOX_API_KEY)"
TOKEN="$(env_value SPEAKER_TOKEN)"
if [ -z "$TOKEN" ] || $ROTATE; then TOKEN="$(openssl rand -hex 16)"; fi
REGION="${REGION:-}"
if [ -z "$REGION" ] && [ -n "$EXISTING_REGION" ] && ! $RESELECT; then REGION="$EXISTING_REGION"; fi

# --------------------------------------------------------------------------- Google Cloud, in the background
# Everything here is slow but needs nothing from the person, so it runs while they get a Soniox key.
# Progress goes to the log; the current step is in $WORK/step and any failure in $WORK/failed.
background() {
  set +e
  step() { printf '%s [background] %s\n' "$(date -u +%T)" "$1"; printf '%s' "$1" >"$WORK/step"; }
  die() { printf '%s' "$1" >"$WORK/failed"; exit 1; }

  step "Turning on Google Cloud services"
  gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
    translate.googleapis.com billingbudgets.googleapis.com cloudresourcemanager.googleapis.com --quiet ||
    die "turning on Google Cloud services"

  if [ -z "$REGION" ]; then
    step "Choosing the closest region"
    local run_regions zone candidate best_ms=999999 r t ms
    run_regions="$(timeout 120 gcloud run regions list --format='value(locationId)')"
    # Cloud Shell is placed in the Google Cloud region closest to the person using it.
    zone="$(curl -sf -m 3 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/zone)"
    candidate="${zone##*/}"
    candidate="${candidate%-*}"
    echo "cloud shell zone=${zone} regions=$(wc -w <<<"$run_regions")"
    if [ -n "$candidate" ] && { [ -z "$run_regions" ] || grep -qx "$candidate" <<<"$run_regions"; }; then
      REGION="$candidate"
    else
      for r in $run_regions; do
        t="$(curl -s -o /dev/null -m 3 -w '%{time_connect}' "https://${r}-run.googleapis.com/" || echo 9)"
        ms="$(awk -v t="$t" 'BEGIN { printf "%d", t * 1000 }')"
        if [ "$ms" -gt 0 ] && [ "$ms" -lt "$best_ms" ]; then best_ms="$ms" REGION="$r"; fi
      done
    fi
    [ -n "$REGION" ] || die "choosing the closest region"
  fi
  printf '%s' "$REGION" >"$WORK/region"

  step "Setting up permissions"
  local run_sa="captioning-run@${PROJECT}.iam.gserviceaccount.com"
  local build_sa="captioning-build@${PROJECT}.iam.gserviceaccount.com"
  gcloud iam service-accounts describe "$run_sa" >/dev/null ||
    gcloud iam service-accounts create captioning-run --display-name="Captioning server" --quiet ||
    die "setting up permissions"
  gcloud iam service-accounts describe "$build_sa" >/dev/null ||
    gcloud iam service-accounts create captioning-build --display-name="Captioning build" --quiet ||
    die "setting up permissions"
  grant() {
    local tries=0
    until gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$1" --role="$2" --condition=None --quiet >/dev/null; do
      tries=$((tries + 1))
      [ "$tries" -lt 6 ] || return 1
      sleep 5 # new service accounts take a few seconds to appear
    done
  }
  grant "$run_sa" roles/cloudtranslate.user || die "setting up permissions"
  grant "$build_sa" roles/run.builder || die "setting up permissions"

  step "Checking the budget alert"
  if [ -z "$(gcloud billing budgets list --billing-account="$BILLING" --filter="displayName='Live captions alert'" --format='value(name)')" ]; then
    local currency
    currency="$(gcloud billing accounts describe "$BILLING" --format='value(currencyCode)' || echo GBP)"
    if gcloud billing budgets create --billing-account="$BILLING" --display-name="Live captions alert" \
      --budget-amount="5${currency}" --filter-projects="projects/${PROJECT}" \
      --threshold-rule=percent=0.5 --threshold-rule=percent=1.0 >/dev/null; then
      printf "Budget alert: you'll get an email if spending passes 5 %s a month" "$currency" >"$WORK/budget"
    else
      printf "Budget alert: skipped (this account can't create budgets; that's fine)" >"$WORK/budget"
    fi
  fi

  # The Soniox key is added afterwards (a quick settings change), so the build doesn't wait for it.
  step "Building the captioning server (about 3 minutes)"
  gcloud run deploy "$SERVICE" \
    --source backend \
    --region "$REGION" \
    --allow-unauthenticated \
    --max-instances=1 --min-instances=0 \
    --timeout=3600 --concurrency=1000 \
    --cpu=1 --memory=512Mi \
    --service-account="$run_sa" \
    --build-service-account="projects/${PROJECT}/serviceAccounts/${build_sa}" \
    --update-env-vars="SPEAKER_TOKEN=${TOKEN}" \
    --quiet ||
    die "building the captioning server"
}
background >>"$LOG" 2>&1 &
BG_PID=$!

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

ASK_KEY=false
if [ -z "$KEY" ] || $NEW_KEY; then
  ASK_KEY=true
else
  spin "Checking your Soniox key"
  if key_works "$KEY"; then
    note "Soniox key: OK"
  else
    note "Your saved Soniox key no longer works, so you'll need a new one."
    ASK_KEY=true
  fi
fi

if $ASK_KEY; then
  bold "Now get a Soniox key. Google Cloud carries on setting up while you do."
  note "Soniox turns speech into captions and translations."
  note ""
  note "1. Open https://console.soniox.com and sign up, or sign in."
  note "2. Add some credit under Billing (prices: https://soniox.com/pricing)."
  note "3. Click \"API keys\", then \"Create API key\", and copy it."
  note "4. Come back here, paste it below and press Enter."
  TRIES=0
  while :; do
    printf '\n'
    note "(Nothing appears while you paste. That's normal.)"
    read -rsp "   Soniox key: " KEY
    printf '\n'
    KEY="$(tr -d '[:space:]' <<<"$KEY")"
    if [ -z "$KEY" ]; then
      note "Nothing was pasted. Paste your key when you have it."
      continue
    fi
    spin "Checking your Soniox key"
    if key_works "$KEY"; then
      note "Soniox key: OK"
      break
    fi
    TRIES=$((TRIES + 1))
    [ "$TRIES" -lt 5 ] || fail "Soniox didn't accept that key." \
      "Copy the key again from https://console.soniox.com (API keys), check the account has credit, then run: ./deploy.sh --new-key"
    note "Soniox didn't accept that key. Copy it again from \"API keys\" and check the account has credit, then paste it here."
  done
fi

# --------------------------------------------------------------------------- wait for Google Cloud
LAST=""
while kill -0 "$BG_PID" 2>/dev/null; do
  NOW="$(cat "$WORK/step" 2>/dev/null || true)"
  if [ -n "$NOW" ] && [ "$NOW" != "$LAST" ]; then spin "$NOW"; LAST="$NOW"; fi
  sleep 1
done
wait "$BG_PID" || true
BG_PID=""
spin_stop
if [ -f "$WORK/failed" ]; then
  printf '\n'
  tail -n 15 "$LOG"
  fail "Something went wrong while $(cat "$WORK/failed")." \
    "The lines above say why. Copy them to your helper, or simply run the install again."
fi
REGION="$(cat "$WORK/region")"
note "Region: ${REGION}"
[ -f "$WORK/budget" ] && note "$(cat "$WORK/budget")"
note "Captioning server: built"

if $ASK_KEY; then
  STEP="switching on captions with your Soniox key"
  spin "Switching on captions with your Soniox key"
  gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars="SONIOX_API_KEY=${KEY}" --quiet >/dev/null 2>>"$LOG"
fi

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)' 2>>"$LOG")"

STEP="checking the server answers"
spin "Checking the server answers"
CODE="$(curl -s -o /dev/null -m 30 -w '%{http_code}' "${URL}/status" || true)"
if [ "$CODE" = "403" ]; then
  fail "The server is installed, but your organisation blocks public access to it." \
    "Phones need to reach it without signing in. Ask whoever manages this Google organisation to allow public Cloud Run services (the 'Domain restricted sharing' policy), or use a personal Google account."
fi

bold "Done! Open this link to finish:"
printf '\n   %s#setup&backend=%s&token=%s\n\n' "$APP_URL" "$URL" "$TOKEN"
note "Keep that link private: it includes the sound desk's access."
