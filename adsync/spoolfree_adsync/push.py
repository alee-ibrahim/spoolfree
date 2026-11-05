"""Sends snapshots and error reports to Spoolfree's internal endpoint."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request


class PushError(Exception):
    pass


def post_json(url: str, token: str, payload: dict, timeout: int = 60, attempts: int = 6, backoff: float = 5.0, sleep=time.sleep) -> dict:
    """POST with a bearer token. Retries connection errors and 5xx (the app may still be starting); 4xx are final."""
    body = json.dumps(payload, separators=(",", ":")).encode()
    last = ""
    for i in range(attempts):
        req = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}", "User-Agent": "spoolfree-adsync"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 (URL from config)
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            detail = e.read(500).decode("utf-8", "replace")
            last = f"HTTP {e.code}: {' '.join(detail.split())}"
            if e.code < 500:
                raise PushError(last) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            last = f"{getattr(e, 'reason', e)}"
        if i < attempts - 1:
            sleep(backoff)
    raise PushError(f"push to {url} failed after {attempts} attempts: {last}")
