#!/usr/bin/env python3
"""Reachr local campaign control tool.

A conservative operations CLI for keeping Reachr/Amplr campaign state usable when
Supabase/Auth/dashboard sessions are unreliable. It never prints tokens, never
stores refresh/access tokens in snapshots, and queues only actor-scoped local
fallback jobs for the existing Amplr Chrome extension runner.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import re
import socket
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

SUPABASE_URL = "https://xacehhtgvubcqdoltazg.supabase.co"
CHROME_DEBUG_URL = "http://127.0.0.1:9223"
AMPLR_EXTENSION_ID = "nglcanaclcaahancoecenliekemolfgp"
DEFAULT_STATE_DIR = Path.home() / ".reachrctl"
DEFAULT_SNAPSHOT_DIR = DEFAULT_STATE_DIR / "snapshots"
LOCAL_QUEUE_KEY = "amplr_local_fallback_jobs"
LOCAL_RESULTS_KEY = "amplr_local_fallback_results"
SECRET_KEYS = {
    "accessToken", "access_token", "refreshToken", "refresh_token", "token",
    "apiKey", "api_key", "apikey", "password", "secret", "jwt",
}
EXCLUDED_EMPTY_SLOT_RE = re.compile(
    r"\b(lost|missing|found|rescue|adoption|adopt|shelter|rehom(?:e|ing)|breeder|buy\s*/?\s*sell)\b",
    re.I,
)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def classify_http_result(label: str, ok: bool, status: Optional[int] = None, body: str = "", error: str = "") -> Dict[str, Any]:
    detail = error or (f"HTTP {status}" if status else "ok")
    if body and (status and status >= 400):
        detail = f"{detail}: {body[:160]}"
    if ok:
        return {"label": label, "ok": True, "state": "healthy", "detail": detail}
    if status in (401, 403):
        return {"label": label, "ok": False, "state": "auth_required", "detail": detail}
    if status in (408, 425, 429, 500, 502, 503, 504, 522, 523, 524) or "timed out" in detail.lower():
        return {"label": label, "ok": False, "state": "degraded", "detail": detail}
    return {"label": label, "ok": False, "state": "unreachable", "detail": detail}


def http_probe(label: str, url: str, timeout: int = 12, headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            body = res.read(300).decode("utf-8", "replace")
            return classify_http_result(label, True, res.status, body)
    except urllib.error.HTTPError as e:
        body = e.read(300).decode("utf-8", "replace")
        # REST root often returns 401 without an API key; that still proves the origin is alive.
        return classify_http_result(label, False, e.code, body)
    except Exception as e:  # noqa: BLE001 - CLI diagnostic should catch all probe failures
        return classify_http_result(label, False, error=f"{type(e).__name__}: {e}")


def chrome_targets() -> List[Dict[str, Any]]:
    with urllib.request.urlopen(f"{CHROME_DEBUG_URL}/json/list", timeout=8) as res:
        return json.loads(res.read().decode("utf-8"))


def chrome_status() -> Dict[str, Any]:
    try:
        with urllib.request.urlopen(f"{CHROME_DEBUG_URL}/json/version", timeout=5) as res:
            version = json.loads(res.read().decode("utf-8"))
        targets = chrome_targets()
        return {
            "ok": True,
            "state": "healthy",
            "browser": version.get("Browser"),
            "target_count": len(targets),
            "has_amplr_service_worker": any(AMPLR_EXTENSION_ID in t.get("url", "") and t.get("type") == "service_worker" for t in targets),
            "dashboard_tabs": [t.get("url") for t in targets if "fb-autoposter" in t.get("url", "") or "jsw-multipost" in t.get("url", "")],
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "state": "unreachable", "detail": f"{type(e).__name__}: {e}"}


def sanitize(value: Any) -> Any:
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for k, v in value.items():
            if k in SECRET_KEYS or any(s in k.lower() for s in ("token", "password", "secret", "apikey", "api_key")):
                continue
            out[k] = sanitize(v)
        return out
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    return value


def normalize_group(group: Any, fallback_identity: Optional[str] = None) -> Optional[Dict[str, Any]]:
    if isinstance(group, str):
        if not group.strip():
            return None
        return {"url": group.strip(), "name": group.strip(), "identity_name": fallback_identity}
    if not isinstance(group, dict):
        return None
    url = group.get("url") or group.get("group_url")
    name = group.get("name") or group.get("group_name") or url
    if not url and not name:
        return None
    return sanitize({
        "id": group.get("id"),
        "url": url,
        "name": name,
        "identity_name": group.get("identity_name") or group.get("profile_name") or group.get("page_name") or group.get("joined_as") or fallback_identity,
        "identity_key": group.get("identity_key") or group.get("profile_key") or group.get("page_key") or group.get("joined_as_key"),
        "composerIdentityVerified": bool(group.get("composerIdentityVerified")),
        "tags": group.get("tags") if isinstance(group.get("tags"), list) else [],
    })


def normalize_campaign(post: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    text = post.get("text") or post.get("message") or ""
    identity = post.get("identity_name") or post.get("identityName") or post.get("actor")
    groups = [g for g in (normalize_group(x, identity) for x in post.get("groups", []) or []) if g]
    if not text and post.get("message") not in ("__join_groups__", "__probe_global_identity_switch__"):
        return None
    return sanitize({
        "id": post.get("id") or post.get("slug") or f"campaign_{abs(hash(text))}",
        "name": post.get("name") or post.get("title") or post.get("campaign_name") or (text[:48] + ("…" if len(text) > 48 else "")),
        "enabled": post.get("enabled", post.get("is_active", True)) is not False,
        "text": text,
        "message": post.get("message") or text,
        "identity_name": identity,
        "groups": groups,
        "ai_enabled": bool(post.get("ai_enabled", post.get("aiEnabled", False))),
        "first_comment": post.get("first_comment") or post.get("firstComment") or None,
        "schedule": post.get("schedule"),
        "days": post.get("days"),
        "time": post.get("time"),
        "repeat_days": post.get("repeat_days"),
        "repeat_time": post.get("repeat_time"),
    })


def build_snapshot(raw: Dict[str, Any], source: str) -> Dict[str, Any]:
    posts = raw.get("posts") or raw.get("campaigns") or []
    groups = raw.get("groups") or []
    identities = raw.get("postingIdentities") or raw.get("posting_identities") or []
    campaigns = [c for c in (normalize_campaign(p) for p in posts if isinstance(p, dict)) if c]
    normalized_groups = [g for g in (normalize_group(x) for x in groups) if g]
    return {
        "schema": "reachrctl.snapshot.v1",
        "created_at": utc_now(),
        "source": source,
        "user": sanitize(raw.get("user") or {}),
        "campaigns": campaigns,
        "groups": normalized_groups,
        "posting_identities": sanitize(identities),
        "settings": sanitize(raw.get("settings") or {}),
        "notes": "Sanitized local snapshot; no auth tokens or passwords are stored.",
    }


class SnapshotStore:
    def __init__(self, root: Path = DEFAULT_SNAPSHOT_DIR):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def save(self, snapshot: Dict[str, Any]) -> Path:
        ts = snapshot.get("created_at") or utc_now()
        safe_ts = re.sub(r"[^0-9A-Za-z_.-]", "-", ts)
        path = self.root / f"{safe_ts}.json"
        path.write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\n")
        latest = self.root / "latest.json"
        latest.write_text(path.read_text())
        return path

    def latest(self) -> Path:
        path = self.root / "latest.json"
        if not path.exists():
            raise FileNotFoundError(f"No snapshot found at {path}. Run `reachrctl snapshot` after signing into the dashboard once.")
        return path

    def load_latest(self) -> Dict[str, Any]:
        return json.loads(self.latest().read_text())


def group_identity(group: Dict[str, Any]) -> Optional[str]:
    return group.get("identity_name") or group.get("profile_name") or group.get("page_name") or group.get("joined_as")


def filter_groups_for_campaign(groups: List[Dict[str, Any]], actor: str, campaign: str = "") -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    allowed: List[Dict[str, Any]] = []
    rejected: List[Dict[str, Any]] = []
    for g in groups:
        gid = group_identity(g)
        if actor and gid and gid.lower() != actor.lower():
            rejected.append({"group": g, "reason": "wrong_actor"})
            continue
        haystack = " ".join(str(g.get(k) or "") for k in ("name", "url"))
        if campaign == "empty-slot-pet-owner-groups" or actor.lower() == "empty slot":
            if EXCLUDED_EMPTY_SLOT_RE.search(haystack):
                rejected.append({"group": g, "reason": "excluded_lost_pet_or_rescue"})
                continue
        allowed.append(g)
    return allowed, rejected


def build_local_fallback_job(campaign: Dict[str, Any], user_id: str, due_now: bool = True, max_groups: Optional[int] = None) -> Dict[str, Any]:
    identity = campaign.get("identity_name") or campaign.get("identityName")
    groups = [dict(g) for g in campaign.get("groups", [])]
    for g in groups:
        if identity and not g.get("identity_name"):
            g["identity_name"] = identity
    if max_groups is not None:
        groups = groups[:max_groups]
    now_ms = int(time.time() * 1000)
    scheduled_for = None if due_now else campaign.get("scheduled_for")
    return sanitize({
        "id": f"local_reachr_{campaign.get('id', 'campaign')}_{now_ms}",
        "user_id": user_id,
        "message": campaign.get("message") or campaign.get("text"),
        "image_url": campaign.get("image_url"),
        "groups": groups,
        "identity_name": identity,
        "delay": max(int(campaign.get("delay") or 120), 90),
        "ai_enabled": bool(campaign.get("ai_enabled", False)),
        "ai_prompt": campaign.get("ai_prompt"),
        "first_comment": campaign.get("first_comment"),
        "status": "pending",
        "scheduled_for": scheduled_for,
        "created_at": utc_now(),
        "updated_at": utc_now(),
        "local_fallback": True,
        "local_fallback_synced": False,
        "result": {
            "campaign_name": campaign.get("name") or campaign.get("id"),
            "text": campaign.get("text") or campaign.get("message"),
        },
    })


# Minimal Chrome DevTools Protocol WebSocket client (stdlib only).
def _read_frame(sock: socket.socket) -> bytes:
    header = sock.recv(2)
    if not header:
        return b""
    _b1, b2 = header
    length = b2 & 127
    if length == 126:
        length = struct.unpack(">H", sock.recv(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", sock.recv(8))[0]
    if b2 & 128:
        mask = sock.recv(4)
        data = bytearray(sock.recv(length))
        for i in range(len(data)):
            data[i] ^= mask[i % 4]
        return bytes(data)
    chunks = b""
    while len(chunks) < length:
        part = sock.recv(length - len(chunks))
        if not part:
            break
        chunks += part
    return chunks


def _send_frame(sock: socket.socket, payload: Dict[str, Any]) -> None:
    data = json.dumps(payload).encode("utf-8")
    head = bytearray([129])
    length = len(data)
    if length < 126:
        head.append(128 | length)
    elif length < 65536:
        head.append(128 | 126)
        head += struct.pack(">H", length)
    else:
        head.append(128 | 127)
        head += struct.pack(">Q", length)
    mask = os.urandom(4)
    head += mask
    sock.sendall(head + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def _connect_ws(ws_url: str) -> socket.socket:
    parsed = urllib.parse.urlparse(ws_url)
    path = parsed.path + (("?" + parsed.query) if parsed.query else "")
    sock = socket.create_connection((parsed.hostname, parsed.port), timeout=8)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {parsed.hostname}:{parsed.port}\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
    sock.sendall(req.encode("ascii"))
    resp = sock.recv(4096)
    if b"101" not in resp.split(b"\r\n", 1)[0]:
        raise RuntimeError(f"WebSocket upgrade failed: {resp[:160]!r}")
    return sock


def cdp_eval(ws_url: str, expression: str) -> Any:
    sock = _connect_ws(ws_url)
    try:
        _send_frame(sock, {"id": 1, "method": "Runtime.evaluate", "params": {"expression": expression, "awaitPromise": True, "returnByValue": True}})
        while True:
            raw = _read_frame(sock)
            if not raw:
                raise RuntimeError("empty CDP response")
            msg = json.loads(raw.decode("utf-8", "replace"))
            if msg.get("id") == 1:
                if "exceptionDetails" in msg:
                    raise RuntimeError(json.dumps(msg["exceptionDetails"])[:1200])
                return msg.get("result", {}).get("result", {}).get("value")
    finally:
        sock.close()


def find_extension_worker() -> Dict[str, Any]:
    for t in chrome_targets():
        if t.get("type") == "service_worker" and AMPLR_EXTENSION_ID in t.get("url", ""):
            return t
    raise RuntimeError("Amplr extension service worker not found on Chrome debug port 9223")


def dashboard_snapshot_from_cdp() -> Dict[str, Any]:
    targets = chrome_targets()
    pages = [t for t in targets if t.get("type") == "page" and ("fb-autoposter/dashboard.html" in t.get("url", "") or "jsw-multipost/dashboard.html" in t.get("url", ""))]
    if not pages:
        raise RuntimeError("No Reachr/Amplr dashboard tab found in runner Chrome. Open the dashboard and sign in once.")
    expr = r'''
    (async()=>{
      let session=null;
      try { session=(await sb?.auth?.getSession())?.data?.session || null; } catch(e) { session={error:e.message}; }
      let stored=null;
      try { stored=JSON.parse(localStorage.getItem('reachr_local_campaign_snapshot') || 'null'); } catch(e) { stored=null; }
      const live = {
        user: (typeof user==='object' && user) ? {id:user.id,email:user.email} : (session?.user ? {id:session.user.id,email:session.user.email} : null),
        posts: (typeof cachedData==='object' && cachedData?.posts) || [],
        groups: (typeof cachedData==='object' && cachedData?.groups) || [],
        settings: (typeof cachedData==='object' && cachedData?.settings) || {},
        postingIdentities: (typeof cachedData==='object' && cachedData?.postingIdentities) || [],
      };
      const liveHasState = (live.posts && live.posts.length) || (live.groups && live.groups.length);
      const raw = liveHasState ? live : (stored || live);
      raw.hasSession = !!session?.access_token;
      raw.sessionError = session?.error || null;
      raw.location = location.href;
      raw.title = document.title;
      raw.snapshotSource = liveHasState ? 'dashboard-live' : (stored ? 'dashboard-localStorage' : 'dashboard-empty');
      return raw;
    })()
    '''
    errors = []
    for page in pages:
        try:
            raw = cdp_eval(page["webSocketDebuggerUrl"], expr)
            if raw and (raw.get("posts") or raw.get("groups") or raw.get("hasSession")):
                snap = build_snapshot(raw, source=raw.get("location") or page.get("url") or "dashboard-cdp")
                snap["dashboard"] = {"title": raw.get("title"), "has_session": bool(raw.get("hasSession")), "session_error": raw.get("sessionError")}
                return snap
            errors.append(f"{page.get('url')}: no dashboard state loaded")
        except Exception as e:  # noqa: BLE001
            errors.append(f"{page.get('url')}: {e}")
    raise RuntimeError("Could not read dashboard state: " + "; ".join(errors))


def extension_local_queue_summary() -> Dict[str, Any]:
    worker = find_extension_worker()
    expr = f'''
    (async()=>{{
      const got = await chrome.storage.local.get(['{LOCAL_QUEUE_KEY}','{LOCAL_RESULTS_KEY}','jsw_session']);
      const jobs = got['{LOCAL_QUEUE_KEY}'] || [];
      const results = got['{LOCAL_RESULTS_KEY}'] || [];
      const session = got.jsw_session || null;
      return {{
        job_count: jobs.length,
        pending_count: jobs.filter(j=>j.status==='pending').length,
        processing_count: jobs.filter(j=>j.status==='processing').length,
        result_count: results.length,
        has_session: !!(session && session.accessToken),
        session_user: session ? {{userId:session.userId,email:session.email,expiresAt:session.expiresAt}} : null,
        active_jobs: jobs.filter(j=>j.status==='pending' || j.status==='processing').slice(0,20).map(j=>({{id:j.id,status:j.status,identity_name:j.identity_name,message:(j.message||'').slice(0,80),groups:(j.groups||[]).length,scheduled_for:j.scheduled_for}}))
      }};
    }})()
    '''
    return cdp_eval(worker["webSocketDebuggerUrl"], expr)


def inject_local_jobs(jobs: List[Dict[str, Any]]) -> Dict[str, Any]:
    worker = find_extension_worker()
    expr = f'''
    (async()=>{{
      const incoming = {json.dumps(jobs)};
      const got = await chrome.storage.local.get(['{LOCAL_QUEUE_KEY}']);
      const existing = Array.isArray(got['{LOCAL_QUEUE_KEY}']) ? got['{LOCAL_QUEUE_KEY}'] : [];
      const ids = new Set(existing.map(j=>j.id));
      const merged = existing.slice();
      for (const job of incoming) {{ if (!ids.has(job.id)) merged.push(job); }}
      await chrome.storage.local.set({{'{LOCAL_QUEUE_KEY}': merged}});
      try {{ await chrome.alarms.create('poll-jobs', {{periodInMinutes: 0.5}}); }} catch(e) {{}}
      return {{ok:true, added: incoming.filter(j=>!ids.has(j.id)).length, total: merged.length, ids: incoming.map(j=>j.id)}};
    }})()
    '''
    return cdp_eval(worker["webSocketDebuggerUrl"], expr)


def cmd_status(_args: argparse.Namespace) -> int:
    status = {
        "time": utc_now(),
        "supabase": {
            "rest": http_probe("supabase_rest", f"{SUPABASE_URL}/rest/v1/"),
            "auth": http_probe("supabase_auth", f"{SUPABASE_URL}/auth/v1/health"),
        },
        "chrome": chrome_status(),
        "snapshot": None,
        "extension_queue": None,
    }
    try:
        p = SnapshotStore().latest()
        snap = json.loads(p.read_text())
        status["snapshot"] = {"path": str(p), "created_at": snap.get("created_at"), "campaigns": len(snap.get("campaigns", [])), "groups": len(snap.get("groups", []))}
    except Exception as e:  # noqa: BLE001
        status["snapshot"] = {"state": "missing", "detail": str(e)}
    if status["chrome"].get("has_amplr_service_worker"):
        try:
            status["extension_queue"] = extension_local_queue_summary()
        except Exception as e:  # noqa: BLE001
            status["extension_queue"] = {"state": "unreadable", "detail": str(e)}
    print(json.dumps(status, indent=2, sort_keys=True))
    return 0


def cmd_snapshot(args: argparse.Namespace) -> int:
    if args.input:
        raw = json.loads(Path(args.input).read_text())
        snap = build_snapshot(raw, source=f"file:{args.input}")
    else:
        snap = dashboard_snapshot_from_cdp()
    path = SnapshotStore(Path(args.dir) if args.dir else DEFAULT_SNAPSHOT_DIR).save(snap)
    print(json.dumps({"ok": True, "path": str(path), "campaigns": len(snap.get("campaigns", [])), "groups": len(snap.get("groups", [])), "created_at": snap.get("created_at")}, indent=2))
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    snap = SnapshotStore(Path(args.dir) if args.dir else DEFAULT_SNAPSHOT_DIR).load_latest()
    rows = []
    for c in snap.get("campaigns", []):
        if args.actor and (c.get("identity_name") or "").lower() != args.actor.lower():
            continue
        rows.append({"id": c.get("id"), "name": c.get("name"), "enabled": c.get("enabled"), "actor": c.get("identity_name"), "groups": len(c.get("groups", [])), "text": (c.get("text") or "")[:100]})
    print(json.dumps({"snapshot_created_at": snap.get("created_at"), "campaigns": rows}, indent=2, sort_keys=True))
    return 0


def cmd_queue_local(args: argparse.Namespace) -> int:
    snap = SnapshotStore(Path(args.dir) if args.dir else DEFAULT_SNAPSHOT_DIR).load_latest()
    campaigns = snap.get("campaigns", [])
    campaign = next((c for c in campaigns if str(c.get("id")) == args.campaign_id or c.get("name") == args.campaign_id), None)
    if not campaign:
        raise SystemExit(f"Campaign not found in latest snapshot: {args.campaign_id}")
    actor = args.actor or campaign.get("identity_name")
    if not actor:
        raise SystemExit("Refusing to queue without an actor. Pass --actor or snapshot a campaign with identity_name.")
    allowed, rejected = filter_groups_for_campaign(campaign.get("groups", []), actor=actor, campaign=args.campaign or "")
    if not allowed:
        raise SystemExit(f"No safe groups remain after filtering. Rejected: {json.dumps(rejected[:5], indent=2)}")
    campaign = dict(campaign)
    campaign["identity_name"] = actor
    campaign["groups"] = allowed[: args.max_groups]
    user_id = (snap.get("user") or {}).get("id") or args.user_id
    if not user_id:
        raise SystemExit("No user_id in snapshot. Pass --user-id.")
    job = build_local_fallback_job(campaign, user_id=user_id, due_now=not args.future, max_groups=args.max_groups)
    plan = {"ok": True, "dry_run": not args.execute, "job": {k: job[k] for k in ("id", "identity_name", "message", "status", "scheduled_for")}, "group_count": len(job["groups"]), "rejected": rejected}
    if not args.execute:
        print(json.dumps(plan, indent=2, sort_keys=True))
        return 0
    result = inject_local_jobs([job])
    plan["injected"] = result
    print(json.dumps(plan, indent=2, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Reachr durable local campaign control tool")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("status", help="Check Supabase, runner Chrome, latest snapshot, and local extension queue")
    s.set_defaults(func=cmd_status)
    s = sub.add_parser("snapshot", help="Create sanitized local campaign snapshot from signed-in dashboard or JSON input")
    s.add_argument("--input", help="Raw JSON file for tests/manual import instead of CDP dashboard")
    s.add_argument("--dir", help="Snapshot directory override")
    s.set_defaults(func=cmd_snapshot)
    s = sub.add_parser("list", help="List campaigns from latest local snapshot")
    s.add_argument("--actor", help="Filter by actor identity")
    s.add_argument("--dir", help="Snapshot directory override")
    s.set_defaults(func=cmd_list)
    s = sub.add_parser("queue-local", help="Queue one campaign from latest snapshot into extension local fallback queue")
    s.add_argument("campaign_id", help="Campaign id or exact name from `reachrctl list`")
    s.add_argument("--actor", help="Required actor override/confirmation")
    s.add_argument("--campaign", default="", help="Campaign playbook name for filters, e.g. empty-slot-pet-owner-groups")
    s.add_argument("--max-groups", type=int, default=5, help="Conservative group cap for local fallback")
    s.add_argument("--future", action="store_true", help="Preserve campaign scheduled_for instead of due-now")
    s.add_argument("--user-id", help="User id if latest snapshot does not contain one")
    s.add_argument("--execute", action="store_true", help="Actually inject into extension queue; otherwise dry-run")
    s.add_argument("--dir", help="Snapshot directory override")
    s.set_defaults(func=cmd_queue_local)
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e), "type": type(e).__name__}, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
