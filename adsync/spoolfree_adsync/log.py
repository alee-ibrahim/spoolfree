"""One JSON object per line on stderr. Never pass secrets to these functions."""

from __future__ import annotations

import json
import sys
import time


def log(level: str, msg: str, **fields) -> None:
    rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "level": level, "msg": msg, **fields}
    print(json.dumps(rec, default=str), file=sys.stderr, flush=True)


def info(msg: str, **fields) -> None:
    log("info", msg, **fields)


def warn(msg: str, **fields) -> None:
    log("warn", msg, **fields)


def error(msg: str, **fields) -> None:
    log("error", msg, **fields)
