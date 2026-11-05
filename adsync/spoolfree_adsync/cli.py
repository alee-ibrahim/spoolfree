"""spoolfree-adsync: python -m spoolfree_adsync [--once] [--dry-run] [--snapshot-file FILE]"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
import time

from . import __version__, log
from .config import Config, ConfigError, load
from .directory import Connection, DirectoryError, counts
from .krb import Kerberos, KerberosError, read_secret_file
from .push import PushError, post_json

_stop = threading.Event()


def _on_signal(signum, _frame):
    log.info("stopping", signal=signum)
    _stop.set()


def read_directory(cfg: Config, krb: Kerberos) -> tuple[dict, dict]:
    krb.login()
    with Connection(cfg) as c:
        snapshot = c.read()
        meta = {"server": c.host, "ssf": c.ssf}
        if cfg.kvno is None:
            try:
                kvno = c.own_kvno()
            except Exception as e:  # informational only
                kvno = None
                log.warn("could not read msDS-KeyVersionNumber", error=str(e)[:200])
            if kvno and krb.set_kvno(kvno):
                log.info("keytab rebuilt with the account's kvno", kvno=kvno)
        meta["kvno"] = krb.kvno
    return snapshot, meta


def write_heartbeat(cfg: Config, snapshot_counts: dict) -> None:
    try:
        path = os.path.join(cfg.runtime_dir, "last-success")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"at": int(time.time()), **snapshot_counts}, f)
    except OSError:
        pass


def report_error(cfg: Config, message: str) -> None:
    if not cfg.token_file:
        return
    try:
        token = read_secret_file(cfg.token_file)
        post_json(cfg.push_url, token, {"version": 1, "status": "error", "error": message[:1000]}, attempts=2, backoff=2)
    except (KerberosError, PushError) as e:
        log.warn("could not report the error to Spoolfree", error=str(e)[:300])


def run_once(cfg: Config, krb: Kerberos | None, dry_run: bool, snapshot_file: str | None) -> bool:
    started = time.monotonic()
    try:
        if snapshot_file:
            with open(snapshot_file, encoding="utf-8") as f:
                snapshot, meta = json.load(f), {"server": "file"}
        else:
            snapshot, meta = read_directory(cfg, krb)
        c = counts(snapshot)
        if dry_run:
            print(json.dumps({**c, **meta}), flush=True)
            return True
        token = read_secret_file(cfg.token_file)
        res = post_json(cfg.push_url, token, snapshot)
        write_heartbeat(cfg, c)
        log.info("snapshot pushed", **c, **meta, stored=res, seconds=round(time.monotonic() - started, 1))
        return True
    except (KerberosError, DirectoryError, PushError, OSError, ValueError) as e:
        msg = " ".join(str(e).split())[:1000]
        log.error("sync failed", error=msg)
        if not dry_run and not isinstance(e, PushError):
            report_error(cfg, msg)
        return False


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="spoolfree-adsync", description="Sync AD OUs and computers into Spoolfree over Kerberos.")
    p.add_argument("--once", action="store_true", help="run one sync and exit (exit code 1 on failure)")
    p.add_argument("--dry-run", action="store_true", help="read AD and print counts only; push nothing")
    p.add_argument("--snapshot-file", help="testing: push this JSON snapshot instead of reading AD")
    p.add_argument("--version", action="version", version=__version__)
    args = p.parse_args(argv)

    try:
        cfg = load(need_push=not args.dry_run, need_ldap=not args.snapshot_file)
    except ConfigError as e:
        print(f"configuration error: {e}", file=sys.stderr)
        return 2

    krb = None
    if not args.snapshot_file:
        krb = Kerberos(cfg)
        krb.prepare()

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    log.info(
        "spoolfree-adsync starting",
        version=__version__,
        ldap=list(cfg.ldap_urls),
        realm=cfg.realm,
        principal=cfg.principal,
        interval=cfg.interval_seconds,
        once=args.once,
        dry_run=args.dry_run,
    )

    if args.once or args.dry_run:
        return 0 if run_once(cfg, krb, args.dry_run, args.snapshot_file) else 1
    while not _stop.is_set():
        run_once(cfg, krb, False, args.snapshot_file)
        _stop.wait(cfg.interval_seconds)
    return 0
