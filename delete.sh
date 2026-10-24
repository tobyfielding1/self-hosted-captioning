#!/usr/bin/env bash
# Removes the church's captioning project from Google Cloud.
# Safe leftovers: the Soniox account and the Google billing account, which this
# script did not create. Normally run from Cloud Shell via the captions website.
set -euo pipefail
cd "$(dirname "$0")"

SERVICE="captioning"
LABEL="app=captioning"

export CLOUDSDK_CORE_DISABLE_PROMPTS=1
LOG="$HOME/captioning-delete.log"
printf '=== %s delete started\n' "$(date -u +%FT%TZ)" >"$LOG"

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
trap spin_stop EXIT

bold() { spin_stop; printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { spin_stop; printf '   %s\n' "$*"; }
fail() {
  spin_stop
  printf '\n\033[1;31m%s\033[0m\n' "$1"
  [ -n "${2:-}" ] && printf '%s\n' "$2"
  printf '\nDetails for your helper are saved in %s\n' "$LOG"
  exit 1
}
STEP="starting"
trap 'fail "Something went wrong while ${STEP}." "Copy the text above and send it to your helper."' ERR

bold "Remove live captions from Google Cloud"
ACCOUNT="$(gcloud config get-value account 2>>"$LOG" || true)"
[ -n "$ACCOUNT" ] || fail "You're not signed in to Google Cloud." "Open this page from the church Google account: https://shell.cloud.google.com"

STEP="finding your Google Cloud project"
spin "Looking for your captions project"
PROJECT="$(gcloud projects list --filter="labels.${LABEL/=/:}" --format='value(projectId)' --limit=1 2>>"$LOG" || true)"
[ -n "$PROJECT" ] || fail "There's no captions project on this Google account." "Nothing to delete. If captions were installed on a different Google account, sign in as that account and run this again."
note "Project: ${PROJECT}"

BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' 2>>"$LOG" || true)"
BILLING="${BILLING#billingAccounts/}"

printf '\n'
note "This deletes Google Cloud project ${PROJECT} — the captioning server and everything the install created there."
note "Google keeps a deleted project for 30 days if you change your mind."
note ""
note "This does not close your Soniox account or your Google billing account."
printf '\n'
read -rp "   Type the project name to confirm: " CONFIRM
[ "$(tr -d '[:space:]' <<<"$CONFIRM")" = "$PROJECT" ] || fail "That didn't match. Nothing was deleted."

if [ -n "$BILLING" ]; then
  STEP="removing the budget alert"
  spin "Removing the budget alert"
  BUDGET="$(gcloud billing budgets list --billing-account="$BILLING" --filter="displayName='Live captions alert'" --format='value(name)' --limit=1 2>>"$LOG" || true)"
  if [ -n "$BUDGET" ]; then
    gcloud billing budgets delete "$BUDGET" --billing-account="$BILLING" --quiet >/dev/null 2>>"$LOG" ||
      note "Couldn't remove the budget alert (that's fine; you can delete it later in Billing)."
  fi
fi

STEP="deleting the Google Cloud project"
spin "Deleting project ${PROJECT}"
gcloud projects delete "$PROJECT" --quiet >/dev/null 2>>"$LOG" ||
  fail "Google wouldn't delete the project." "Open https://console.cloud.google.com/home/dashboard?project=${PROJECT} and shut it down there, or try this again."

spin_stop
bold "Done. The captioning server is gone."
note ""
note "Still there, because the install didn't create them:"
note "  • Soniox account — https://console.soniox.com/org/settings"
note "  • Google billing account — https://console.cloud.google.com/billing"
note "    (pick the account, then Account management → Close billing account)."
note "    Only close that if you created it for captions and nothing else uses it."
note ""
note "The captions website on your computers still remembers the old links. They stop working."
printf '\n'
