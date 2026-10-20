#!/usr/bin/env bash
# Unauthenticated live probe harness for the deployed BLIP brain worker.
# Every call here needs NO secret: body-validation returns before auth on
# /api/decide, and the router-error branch echoes the router status. Uses only
# throwaway placeholder strings, never a real key.
set -u
BASE="${BASE:-https://agent-federation.agent-federation.workers.dev}"

say(){ printf '\n=== %s ===\n' "$1"; }
probe(){ # name  data  [content-type]
  local name="$1" data="$2" ct="${3:-application/json}"
  say "$name"
  curl -s -o /tmp/probe.json -w "HTTP %{http_code} | %{time_total}s\n" \
       -X POST "$BASE/api/decide" -H "content-type: $ct" -d "$data"
  head -c 400 /tmp/probe.json; echo
}

say "GET /health"
curl -s -o /tmp/h.json -w "HTTP %{http_code} | %{time_total}s\n" "$BASE/health"
head -c 200 /tmp/h.json; echo

say "/api/decide  invalid-JSON (expect 400, body-validation BEFORE auth)"
curl -s -o /tmp/a.json -w "HTTP %{http_code} | %{time_total}s\n" \
     -X POST "$BASE/api/decide" -H 'content-type: application/json' -d '{bad json'
head -c 300 /tmp/a.json; echo

say "/api/decide  empty-context (expect 400 context required)"
probe "empty" '{}'

say "/api/decide  missing-context (expect 400 context required)"
probe "missing" '{"foo":"bar"}'

say "/api/decide  VALID-context (reaches router, error may leak router status)"
probe "valid" '{"context":"checking the mail"}'

say "/api/decide  form-encoded content-type (expect 400 invalid JSON body)"
probe "form" 'context=hi' 'application/x-www-form-urlencoded'

say "/api/sessions  invalid-JSON no-auth (expect 401: auth precedes the body)"
curl -s -o /tmp/m.json -w "HTTP %{http_code}\n" -X POST "$BASE/api/sessions" \
     -H 'content-type: application/json' -d '{bad'
head -c 200 /tmp/m.json; echo
