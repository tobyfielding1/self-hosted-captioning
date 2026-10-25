#!/usr/bin/env bash
# Installs (or updates the settings of) a venue's captioning backend on Google Cloud Run.
# Safe to run again at any time. Normally run from Cloud Shell via the captions website's
# "Install on Google Cloud" button.
#
#   ./setup.sh                 install, or re-check an existing install. The last line sets up another venue.
#   ./setup.sh --new-project   skip the venue list and set up another one
#   ./setup.sh --new-key       replace the Soniox key
#   ./setup.sh --rotate-token  issue a new sound desk link (the old one stops working)
#   ./setup.sh --reselect      support use: pick the Cloud Run region again
#   REGION=europe-west2 ./setup.sh   support use: force a region
set -euo pipefail
cd "$(dirname "$0")"

APP_URL="https://tobyfielding1.github.io/self-hosted-captioning/"
SERVICE="captioning"
LABEL="app=captioning"

NEW_KEY=false ROTATE=false RESELECT=false NEW_PROJECT=false
for arg in "$@"; do
  case "$arg" in
    --new-key) NEW_KEY=true ;;
    --new-project) NEW_PROJECT=true ;;
    --rotate-token) ROTATE=true ;;
    --reselect) RESELECT=true ;;
    *) echo "Unknown option: $arg"; exit 2 ;;
  esac
done
if $NEW_PROJECT && $ROTATE; then
  echo "Use either --new-project or --rotate-token."
  exit 2
fi

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
  printf '\nWhen that is fixed, run this again:  ./setup.sh\n\n'
  exit 1
}
STEP="starting"
trap 'fail "Something went wrong while ${STEP}." "Copy the text above and send it to your helper, or simply run the install again."' ERR

# --------------------------------------------------------------------------- project
STEP="finding your Google Cloud project"
bold "Setting up live captions"
spin "Checking your Google account"
ACCOUNT="$(gcloud config get-value account 2>>"$LOG" || true)"
spin_stop
[ -n "$ACCOUNT" ] || fail "You're not signed in to Google Cloud." "Open this page from the venue Google account: https://shell.cloud.google.com"
note "Signed in as ${ACCOUNT}"

# Google Cloud project names are 4–30 characters: letters, numbers, spaces, hyphens, apostrophes, exclamation marks.
ask_venue_name() {
  note "What should this venue be called? For example, Main hall or Room 2."
  note "Press Enter to keep the name \"Live captions\"."
  local name
  while true; do
    read -rp "   Name: " name
    name="${name#"${name%%[![:space:]]*}"}"
    name="${name%"${name##*[![:space:]]}"}"
    [ -z "$name" ] && name="Live captions"
    if [ "${#name}" -ge 4 ] && [ "${#name}" -le 30 ] && printf '%s' "$name" | grep -Eq "^[A-Za-z0-9 !'-]+$"; then
      VENUE_NAME="$name"
      return 0
    fi
    note "Use 4 to 30 characters: letters, numbers, spaces, hyphens, apostrophes or exclamation marks."
  done
}
create_project() {
  ask_venue_name
  local display="$VENUE_NAME"
  DISPLAY="$display"
  PROJECT="captioning-$(openssl rand -hex 3)"
  STEP="creating a Google Cloud project"
  spin "Creating ${display}"
  gcloud projects create "$PROJECT" --name="$display" --labels="$LABEL" --quiet >/dev/null 2>>"$LOG" ||
    fail "Google wouldn't let this account create a new project." \
      "This usually means the account has reached its project limit or belongs to an organisation that restricts projects. Ask your helper, or try a different Google account."
}
# A new venue picks a billing account first, then the project is created and that account is attached.
start_new_venue() {
  if [ "${#NAMES[@]}" -gt 0 ]; then
    note "The same billing account and Soniox account are fine. A new Soniox key is recommended."
  fi
  choose_billing
  create_project
}
load_billing_accounts() {
  mapfile -t ACCOUNTS < <(gcloud billing accounts list --filter=open=true --format='value(name.basename(),displayName)' 2>>"$LOG" || true)
}
# A new account can take a minute to show up. Poll until one id appears that was not already listed.
# Sets BILLING and returns 0 when exactly one new account appears. Several new accounts returns 1
# so the caller can show the list.
look_for_new_billing() {
  local -a previous=("$@") found=()
  local deadline id row p known name
  while true; do
    deadline=$((SECONDS + 60))
    spin "Looking for the new billing account"
    while (( SECONDS < deadline )); do
      load_billing_accounts
      found=()
      if [ "${#ACCOUNTS[@]}" -gt 0 ]; then
        for row in "${ACCOUNTS[@]}"; do
          id="$(cut -f1 <<<"$row")"
          known=false
          if [ "${#previous[@]}" -gt 0 ]; then
            for p in "${previous[@]}"; do
              [ "$p" = "$id" ] && known=true
            done
          fi
          $known || found+=("$row")
        done
      fi
      if [ "${#found[@]}" -eq 1 ]; then
        spin_stop
        BILLING="$(cut -f1 <<<"${found[0]}")"
        name="$(cut -f2 <<<"${found[0]}")"
        [ -n "$name" ] || name="$BILLING"
        note "Using ${name}."
        return 0
      fi
      [ "${#found[@]}" -le 1 ] || { spin_stop; return 1; }
      (( SECONDS >= deadline )) && break
      sleep 5
    done
    spin_stop
    note "The new billing account hasn't appeared yet. Press Enter to look again."
    read -rp "   Press Enter: " _
  done
}
# Sets BILLING. Creating an account happens on Google's page; this waits and lists again.
choose_billing() {
  local n extra i name
  local -a seen=()
  while true; do
    STEP="checking billing"
    spin "Checking billing"
    load_billing_accounts
    spin_stop
    n="${#ACCOUNTS[@]}"
    extra=$((n + 1))
    if [ "$n" -eq 0 ]; then
      note "This Google account has no billing account yet."
      note "Google Cloud needs one before it will host anything, even on the free tier."
      note "Open https://console.cloud.google.com/billing/create and add a card."
      note "Normal use stays in the free tier. The install emails you if this venue passes £5 a month."
      note "When that is done, press Enter."
      read -rp "   Press Enter: " _
      look_for_new_billing && return 0
      continue
    fi
    bold "Which billing account should this venue use?"
    seen=()
    for i in "${!ACCOUNTS[@]}"; do
      seen+=("$(cut -f1 <<<"${ACCOUNTS[$i]}")")
      name="$(cut -f2 <<<"${ACCOUNTS[$i]}")"
      [ -n "$name" ] || name="${seen[$i]}"
      printf '  %d) %s\n' "$((i + 1))" "$name"
    done
    printf '  %d) None of these. Create a new billing account.\n' "$extra"
    read -rp "   Number: " CHOICE
    if [ "$CHOICE" = "$extra" ]; then
      note "Open https://console.cloud.google.com/billing/create and add a card."
      note "Normal use stays in the free tier. The install emails you if this venue passes £5 a month."
      note "When that is done, press Enter."
      read -rp "   Press Enter: " _
      look_for_new_billing "${seen[@]}" && return 0
      continue
    fi
    [[ "$CHOICE" =~ ^[0-9]+$ ]] && [ "$CHOICE" -ge 1 ] && [ "$CHOICE" -le "$n" ] || fail "That wasn't one of the numbers."
    BILLING="$(cut -f1 <<<"${ACCOUNTS[$((CHOICE - 1))]}")"
    return 0
  done
}
load_projects() {
  PROJECTS=()
  NAMES=()
  local id name
  while IFS=$'\t' read -r id name; do
    [ -n "${id:-}" ] || continue
    PROJECTS+=("$id")
    NAMES+=("${name:-Live captions}")
  done < <(gcloud projects list --filter="labels.${LABEL/=/:}" --format='value(projectId,name)' 2>>"$LOG" || true)
}
# Unique names are enough. Two venues with the same name also show the server address.
project_choices() {
  local -A count=()
  local name url i dup=false
  for name in "${NAMES[@]}"; do count["$name"]=$(( ${count["$name"]:-0} + 1 )); done
  for name in "${NAMES[@]}"; do [ "${count[$name]}" -gt 1 ] && dup=true; done
  if $dup; then spin "Looking up each captions server"; else spin_stop; fi
  LINES=()
  for i in "${!PROJECTS[@]}"; do
    name="${NAMES[$i]}"
    if [ "${count[$name]}" -gt 1 ]; then
      url="$(timeout 20 gcloud run services list --project="${PROJECTS[$i]}" --filter="metadata.name=${SERVICE}" --format='value(status.url)' --limit=1 2>>"$LOG" || true)"
      if [ -n "$url" ]; then LINES+=("${name} — ${url}"); else LINES+=("${name} — ${PROJECTS[$i]}"); fi
    else
      LINES+=("$name")
    fi
  done
  if $dup; then spin_stop; fi
}

BILLING=""
spin "Looking for your captions project"
load_projects
spin_stop
if $NEW_PROJECT; then
  start_new_venue
elif $ROTATE || $NEW_KEY; then
  if [ "${#PROJECTS[@]}" -eq 0 ]; then
    fail "There's no captioning server on this Google account." "Install first, or sign in as the venue Google account that did."
  elif [ "${#PROJECTS[@]}" -eq 1 ]; then
    PROJECT="${PROJECTS[0]}"
    DISPLAY="${NAMES[0]}"
  else
    project_choices
    bold "This Google account has more than one venue."
    for i in "${!PROJECTS[@]}"; do printf '  %d) %s\n' "$((i + 1))" "${LINES[$i]}"; done
    note "Type the number of the one you want."
    read -rp "   Number: " CHOICE
    [[ "$CHOICE" =~ ^[0-9]+$ ]] && [ "$CHOICE" -ge 1 ] && [ "$CHOICE" -le "${#PROJECTS[@]}" ] || fail "That wasn't one of the numbers."
    PROJECT="${PROJECTS[$((CHOICE - 1))]}"
    DISPLAY="${NAMES[$((CHOICE - 1))]}"
  fi
elif [ "${#PROJECTS[@]}" -eq 0 ]; then
  start_new_venue
else
  project_choices
  if [ "${#PROJECTS[@]}" -eq 1 ]; then
    bold "This Google account already has a venue."
  else
    bold "This Google account has more than one venue."
  fi
  for i in "${!PROJECTS[@]}"; do printf '  %d) %s\n' "$((i + 1))" "${LINES[$i]}"; done
  extra=$(( ${#PROJECTS[@]} + 1 ))
  printf '  %d) None of these. Set up another venue.\n' "$extra"
  note "Type a number and press Enter."
  read -rp "   Number: " CHOICE
  if [ "$CHOICE" = "$extra" ]; then
    start_new_venue
  else
    [[ "$CHOICE" =~ ^[0-9]+$ ]] && [ "$CHOICE" -ge 1 ] && [ "$CHOICE" -le "${#PROJECTS[@]}" ] || fail "That wasn't one of the numbers."
    PROJECT="${PROJECTS[$((CHOICE - 1))]}"
    DISPLAY="${NAMES[$((CHOICE - 1))]}"
  fi
fi
note "Project: ${DISPLAY} (${PROJECT})"
STEP="preparing the project"
spin "Preparing ${DISPLAY}"
gcloud config set project "$PROJECT" >/dev/null 2>>"$LOG"

# --------------------------------------------------------------------------- billing
# A venue that already pays for captions keeps that billing account.
STEP="checking billing"
spin "Checking billing"
linked="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' 2>>"$LOG" || true)"
linked="${linked#billingAccounts/}"
spin_stop
if [ -n "$linked" ]; then
  BILLING="$linked"
else
  [ -n "$BILLING" ] || choose_billing
  STEP="connecting billing"
  spin "Connecting billing"
  gcloud billing projects link "$PROJECT" --billing-account="$BILLING" >/dev/null 2>>"$LOG" ||
    fail "Couldn't connect billing to the project." "Make sure this Google account can manage billing account ${BILLING}, then run this again."
  spin_stop
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

if $ROTATE; then
  [ -n "$EXISTING_REGION" ] || fail "There's no captioning server on this Google account." "Install first, or sign in as the venue Google account that did."
  STEP="issuing a new sound desk link"
  spin "Issuing a new sound desk link"
  gcloud run services update "$SERVICE" --region "$EXISTING_REGION" --update-env-vars="SPEAKER_TOKEN=${TOKEN},BILLING_ACCOUNT=${BILLING}" --quiet >/dev/null 2>>"$LOG" ||
    fail "Couldn't update the captioning server." "Try this again, or run the install."
  URL="$(gcloud run services describe "$SERVICE" --region "$EXISTING_REGION" --format='value(status.url)' 2>>"$LOG")"
  bold "Done! The old sound desk link no longer works. Open this new one:"
  printf '\n   %s#backend=%s&token=%s\n\n' "$APP_URL" "${URL#https://}" "$TOKEN"
  note "Keep that link private. Open it once on each sound desk computer and bookmark it again."
  note "The QR code and audience link stay the same."
  exit 0
fi

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
  # A new build account is often denied for a minute or two after its role is granted.
  step "Building the captioning server (about 3 minutes)"
  local attempt=0
  while :; do
    if gcloud run deploy "$SERVICE" \
      --source backend \
      --region "$REGION" \
      --allow-unauthenticated \
      --max-instances=1 --min-instances=0 \
      --timeout=3600 --concurrency=1000 \
      --cpu=1 --memory=512Mi \
      --service-account="$run_sa" \
      --build-service-account="projects/${PROJECT}/serviceAccounts/${build_sa}" \
      --update-env-vars="^@^SPEAKER_TOKEN=${TOKEN}@BILLING_ACCOUNT=${BILLING}@VENUE_NAME=${DISPLAY}" \
      --quiet >"$WORK/deploy.out" 2>&1; then
      cat "$WORK/deploy.out"
      break
    fi
    cat "$WORK/deploy.out"
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 6 ] || ! grep -q "missing required IAM permissions" "$WORK/deploy.out"; then
      die "building the captioning server"
    fi
    step "Waiting for Google to apply the new permissions"
    sleep 30
    step "Building the captioning server (about 3 minutes)"
  done
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
  note "Soniox turns speech into captions. This is the part that costs money."
  note "You choose how much credit to add, and it is only used while someone is being captioned."
  note "That costs less than a captioning service you subscribe to."
  note ""
  note "1. Open https://console.soniox.com and sign up, or sign in."
  note "2. Add a small amount of credit under Billing (prices: https://soniox.com/pricing)."
  note "   Quiet audio isn't sent, and a language runs only while someone is reading it."
  note "   Autopay is optional. It tops up by an amount you set, so captions don't stop in the middle when the credit runs out."
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
      "Copy the key again from https://console.soniox.com (API keys), check the account has credit, then run: ./setup.sh --new-key"
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
printf '\n   %s#backend=%s&token=%s\n\n' "$APP_URL" "${URL#https://}" "$TOKEN"
note "Keep that link private: it includes the sound desk's access."
