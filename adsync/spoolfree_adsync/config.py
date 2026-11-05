"""Configuration from environment variables. Secrets are only ever read from files."""

from __future__ import annotations

import ipaddress
import os
import re
from dataclasses import dataclass
from urllib.parse import urlsplit


class ConfigError(Exception):
    pass


DEFAULT_ENCTYPES = ("aes256-cts-hmac-sha1-96", "aes128-cts-hmac-sha1-96")
_ENCTYPE_RE = re.compile(r"^[a-z0-9-]+$")


@dataclass(frozen=True)
class Config:
    ldap_urls: tuple[str, ...]
    base_dn: str
    realm: str
    principal: str
    password_file: str
    kdcs: tuple[str, ...]
    enctypes: tuple[str, ...] = DEFAULT_ENCTYPES
    kvno: int | None = None  # None = auto (read msDS-KeyVersionNumber after the first bind)
    interval_seconds: int = 300
    push_url: str = "http://127.0.0.1:3000/api/internal/directory-snapshot"
    token_file: str | None = None
    page_size: int = 500
    timeout_seconds: int = 30
    min_ssf: int = 128
    runtime_dir: str = "/tmp/adsync"

    @property
    def sam_account_name(self) -> str:
        return self.principal.split("@", 1)[0]


def _split(v: str | None) -> list[str]:
    return [x for x in re.split(r"[\s,]+", v or "") if x]


def _host_of(url: str) -> str:
    u = urlsplit(url)
    if u.scheme not in ("ldap", "ldaps") or not u.hostname:
        raise ConfigError(f"not an ldap:// or ldaps:// URL: {url}")
    host = u.hostname
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        # Kerberos needs the service principal ldap/<fqdn>; an IP gives ldap/<ip>, which AD does not have.
        raise ConfigError(f"use the domain controller's FQDN, not an IP address: {url}")
    if "." not in host:
        raise ConfigError(f"use the domain controller's fully qualified name: {url}")
    return host.lower()


def _int(env: dict, name: str, default: int, minimum: int = 1) -> int:
    raw = env.get(name)
    if raw in (None, ""):
        return default
    try:
        v = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be an integer") from None
    if v < minimum:
        raise ConfigError(f"{name} must be >= {minimum}")
    return v


LDAP_VARS = ("ADSYNC_LDAP_URLS", "ADSYNC_BASE_DN", "ADSYNC_REALM", "ADSYNC_PRINCIPAL", "ADSYNC_PASSWORD_FILE")


def load(env: dict | None = None, *, need_push: bool = True, need_ldap: bool = True) -> Config:
    env = dict(os.environ if env is None else env)
    if not need_ldap:
        # --snapshot-file: only the push settings matter
        env = {**{n: "-" for n in LDAP_VARS}, "ADSYNC_LDAP_URLS": "ldap://unused.invalid", **{k: v for k, v in env.items() if v}}
    missing = [n for n in LDAP_VARS if not env.get(n)]
    if need_push and not env.get("ADSYNC_TOKEN_FILE"):
        missing.append("ADSYNC_TOKEN_FILE")
    if missing:
        raise ConfigError("missing: " + ", ".join(missing))

    urls = _split(env["ADSYNC_LDAP_URLS"])
    hosts = [_host_of(u) for u in urls]
    realm = env["ADSYNC_REALM"].strip().upper()
    principal = env["ADSYNC_PRINCIPAL"].strip()
    if "@" not in principal:
        principal = f"{principal}@{realm}"
    kdcs = tuple(_split(env.get("ADSYNC_KDCS"))) or tuple(dict.fromkeys(hosts))
    enctypes = tuple(_split(env.get("ADSYNC_ENCTYPES"))) or DEFAULT_ENCTYPES
    for e in enctypes:
        if not _ENCTYPE_RE.match(e):
            raise ConfigError(f"invalid enctype: {e}")
    kvno_raw = (env.get("ADSYNC_KVNO") or "auto").strip().lower()
    kvno = None if kvno_raw == "auto" else _int(env, "ADSYNC_KVNO", 1)
    for v in (realm, principal, *kdcs):
        if not re.match(r"^[A-Za-z0-9._@:\[\]-]+$", v):
            raise ConfigError(f"invalid characters in {v!r}")

    return Config(
        ldap_urls=tuple(urls),
        base_dn=env["ADSYNC_BASE_DN"].strip(),
        realm=realm,
        principal=principal,
        password_file=env["ADSYNC_PASSWORD_FILE"],
        kdcs=kdcs,
        enctypes=enctypes,
        kvno=kvno,
        interval_seconds=_int(env, "ADSYNC_INTERVAL_SECONDS", 300, 30),
        push_url=env.get("ADSYNC_PUSH_URL") or Config.push_url,
        token_file=env.get("ADSYNC_TOKEN_FILE") or None,
        page_size=_int(env, "ADSYNC_PAGE_SIZE", 500),
        timeout_seconds=_int(env, "ADSYNC_TIMEOUT_SECONDS", 30),
        min_ssf=_int(env, "ADSYNC_MIN_SSF", 128, 0),
        runtime_dir=env.get("ADSYNC_RUNTIME_DIR") or Config.runtime_dir,
    )
