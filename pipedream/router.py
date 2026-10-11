# Pipedream Python workflow step: OpenAI-compatible model router.
# Paste this whole file into the Pipedream code step (Python 3.12).
# Entrypoint: handler(pd). It reads the trigger event from
# pd.steps["trigger"]["event"] and sends the HTTP response with pd.respond(),
# so the HTTP trigger must be set to allow custom responses (otherwise
# Pipedream returns its default body instead of the OpenAI JSON).
# handler() also accepts a raw event dict for direct testing.
#
# Pipedream provides `requests` in the runtime; urllib is used as a fallback
# so the step still runs if requests is unavailable.
#
# Contract (must match the Cloudflare Worker side):
#   POST {ROUTER_URL} with an OpenAI chat-completions JSON body
#   + header "X-Tier: primary|cheap|jev"
#   -> standard OpenAI chat-completions JSON, non-streaming.
#   Optional auth: if ROUTER_KEY is set, the Authorization bearer must match.
#
# Workflow env vars (set in the Pipedream workflow settings):
#   ROUTER_KEY     optional shared secret (checked if set)
#   PRIMARY_BASE_URL, PRIMARY_API_KEY, PRIMARY_MODEL
#   CHEAP_BASE_URL,  CHEAP_API_KEY,  CHEAP_MODEL
#   JEV_BASE_URL,    JEV_API_KEY,    JEV_MODEL   (optional tier)

import json
import os
import urllib.error
import urllib.request

try:
    import requests  # Pipedream provides this
except Exception:
    requests = None  # fall back to urllib


# Tier -> env var prefix. Fail closed on anything else.
TIER_PREFIX = {
    "primary": "PRIMARY",
    "cheap": "CHEAP",
    "jev": "JEV",
}


def _env(name, default=None):
    return os.environ.get(name, default)


def _event_from(source):
    """Pipedream passes the pd helper; direct tests may pass the raw event dict."""
    if isinstance(source, dict):
        return source
    try:
        return source.steps["trigger"]["event"] or {}
    except Exception:
        pass
    try:
        return source.steps.trigger.event or {}
    except Exception:
        return {}


def _respond(source, status, payload):
    """Send the HTTP response via pd.respond and return it as the step output."""
    response = {
        "status": status,
        "headers": {"Content-Type": "application/json"},
        "body": payload,
    }
    respond = getattr(source, "respond", None)
    if callable(respond):
        respond(response)
    return response


def _get_env_trio(tier):
    """Return (base_url, api_key, model) for a tier, or None if not configured."""
    prefix = TIER_PREFIX[tier]
    base_url, api_key = _env(prefix + "_BASE_URL"), _env(prefix + "_API_KEY")
    model = _env(prefix + "_MODEL")
    if not base_url or not model:
        return None
    return base_url, api_key, model


def _check_router_key(event):
    """Optional shared-secret check. Passes when ROUTER_KEY is unset."""
    expected = _env("ROUTER_KEY")
    if not expected:
        return True
    headers = event.get("headers") or {}
    # Header names are case-insensitive; normalize.
    auth = None
    for k, v in headers.items():
        if str(k).lower() == "authorization":
            auth = v
            break
    if not auth:
        return False
    return str(auth).strip() == "Bearer " + expected


def _read_body(event):
    """Pipedream passes the body as a dict, a JSON string, or None."""
    body = event.get("body")
    if body is None:
        return {}
    if isinstance(body, (dict, list)):
        return body
    if isinstance(body, bytes):
        body = body.decode("utf-8", "replace")
    try:
        return json.loads(body)
    except Exception:
        return {}


def _is_health(event, body):
    # "/health" in the path, or {"health": true} / {"op": "health"} in the body.
    path = str(event.get("path") or event.get("pathname") or "")
    if path.rstrip("/").endswith("/health"):
        return True
    if isinstance(body, dict):
        return body.get("health") is True or body.get("op") == "health"
    return False


def _forward(base_url, api_key, model, body):
    """POST the rewritten OpenAI body to the provider. Returns (status, payload)."""
    # Normalize the base URL so we always hit /chat/completions exactly once.
    base = base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        url = base
    else:
        url = base + "/chat/completions"

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key

    # Rewrite the model field to the tier model (the whole point of the router).
    out = dict(body)
    out["model"] = model
    # Streaming is an optional bonus; this MVP is non-streaming.
    out.pop("stream", None)
    data = json.dumps(out).encode("utf-8")

    if requests is not None:
        try:
            r = requests.post(url, headers=headers, data=data, timeout=60)
            try:
                payload = r.json()
            except Exception:
                payload = {"error": {"message": r.text[:500]}}
            # Pass provider status through unmodified (errors included).
            return r.status_code, payload
        except Exception as exc:
            return 502, {"error": {"message": "provider request failed: %s" % exc}}

    # urllib fallback
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw)
        except Exception:
            return exc.code, {"error": {"message": raw[:500]}}
    except Exception as exc:
        return 502, {"error": {"message": "provider request failed: %s" % exc}}


def handler(pd):
    """Main entrypoint for the Pipedream HTTP workflow step.

    `pd` is the Pipedream helper; a raw event dict is also accepted so the
    router can be unit-tested outside Pipedream.
    """
    try:
        event = _event_from(pd)
        body = _read_body(event)

        # Health check: cheap and side-effect free.
        if _is_health(event, body):
            return _respond(pd, 200, {"ok": True, "service": "router"})

        # Optional shared-secret auth.
        if not _check_router_key(event):
            return _respond(pd, 401, {"error": {"message": "unauthorized"}})

        # Resolve the tier from the X-Tier header (default: primary).
        headers = event.get("headers") or {}
        tier = "primary"
        for k, v in headers.items():
            if str(k).lower() == "x-tier":
                tier = str(v).strip().lower()
                break

        # Fail closed: unknown tier -> 400.
        if tier not in TIER_PREFIX:
            return _respond(pd, 400, {"error": {"message": "unknown tier: %s" % tier}})

        trio = _get_env_trio(tier)
        if trio is None:
            # Tier exists but is not configured (e.g. jev left optional).
            return _respond(pd, 400, {"error": {"message": "tier %s not configured" % tier}})

        if not isinstance(body, dict) or "messages" not in body:
            return _respond(
                pd,
                400,
                {"error": {"message": "body must be an OpenAI chat body with 'messages'"}},
            )

        base_url, api_key, model = trio
        status, payload = _forward(base_url, api_key, model, body)
        # Provider response (including errors) is passed through unmodified.
        return _respond(pd, status, payload)

    except Exception as exc:
        return _respond(pd, 500, {"error": {"message": "router internal error: %s" % exc}})
