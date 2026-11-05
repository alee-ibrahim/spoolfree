"""Reads OUs and computers from AD over LDAP, bound with SASL GSSAPI and a sealed (encrypted) connection."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit

from .config import Config

WKO_COMPUTERS = "AA312825768811D1ADED00C04FD8D5CD"  # GUID_COMPUTRS_CONTAINER_W
OU_ATTRS = ["ou", "name", "objectGUID", "description"]
COMPUTER_ATTRS = ["cn", "name", "sAMAccountName", "objectGUID", "userAccountControl", "dNSHostName", "operatingSystem"]


class DirectoryError(Exception):
    pass


def guid_from_bytes(raw: bytes) -> str:
    """AD objectGUID: 16 bytes, first three fields little-endian (same as the app's guidFromBuffer)."""
    if len(raw) != 16:
        raise ValueError("objectGUID must be 16 bytes")
    return str(uuid.UUID(bytes_le=raw))


def _first(attrs: dict, name: str) -> bytes | None:
    for k, v in attrs.items():
        if k.lower() == name.lower() and v:
            return v[0]
    return None


def _text(attrs: dict, name: str) -> str | None:
    v = _first(attrs, name)
    return v.decode("utf-8", "replace") if v is not None else None


def entry_to_ou(dn: str, attrs: dict) -> dict:
    raw = _first(attrs, "objectGUID")
    out = {"dn": dn, "name": _text(attrs, "ou") or _text(attrs, "name") or dn.split(",", 1)[0].split("=", 1)[-1]}
    if raw is not None and len(raw) == 16:
        out["objectGuid"] = guid_from_bytes(raw)
    desc = _text(attrs, "description")
    if desc:
        out["description"] = desc
    return out


def entry_to_computer(dn: str, attrs: dict) -> dict | None:
    raw = _first(attrs, "objectGUID")
    uac = _text(attrs, "userAccountControl")
    if raw is None or len(raw) != 16 or uac is None:
        return None
    sam = _text(attrs, "sAMAccountName")
    name = _text(attrs, "cn") or _text(attrs, "name") or (sam[:-1] if sam and sam.endswith("$") else sam)
    return {
        "dn": dn,
        "objectGuid": guid_from_bytes(raw),
        "name": name,
        "dnsHostName": _text(attrs, "dNSHostName"),
        "operatingSystem": _text(attrs, "operatingSystem"),
        "userAccountControl": int(uac) & 0xFFFFFFFF,
    }


def default_computers_container(wko_values: list[bytes], base_dn: str) -> str:
    """wellKnownObjects of the domain head (honours `redircmp`), else CN=Computers."""
    for v in wko_values or []:
        s = v.decode("utf-8", "replace")
        if WKO_COMPUTERS in s.upper():
            return s[s.rfind(":") + 1 :]
    return f"CN=Computers,{base_dn}"


def build_snapshot(base_dn: str, default_container: str, ous: list[dict], computers: list[dict], source: str) -> dict:
    return {
        "version": 1,
        "source": source,
        "collectedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "baseDn": base_dn,
        "defaultComputersContainer": default_container,
        "ous": ous,
        "computers": computers,
    }


def counts(snapshot: dict) -> dict:
    comps = snapshot["computers"]
    return {
        "ous": len(snapshot["ous"]),
        "computers": len(comps),
        "enabled": sum(1 for c in comps if not c["userAccountControl"] & 0x2),
        "disabled": sum(1 for c in comps if c["userAccountControl"] & 0x2),
        "withDnsHostName": sum(1 for c in comps if c.get("dnsHostName")),
    }


def _ldap_msg(e: Exception) -> str:
    a = e.args[0] if e.args else None
    if isinstance(a, dict):
        parts = [str(a.get("desc", "")), str(a.get("info", ""))]
        return " ".join(" - ".join(p for p in parts if p).split())[:300]
    return " ".join(str(e).split())[:300]


class Connection:
    """A bound, sealed connection to the first domain controller in ADSYNC_LDAP_URLS that answers."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.conn = None
        self.url = None
        self.ssf = 0
        self.whoami = None

    def __enter__(self):
        import ldap
        import ldap.sasl

        errors = []
        for url in self.cfg.ldap_urls:
            c = None
            try:
                c = ldap.initialize(url)
                c.set_option(ldap.OPT_PROTOCOL_VERSION, 3)
                c.set_option(ldap.OPT_REFERRALS, 0)
                c.set_option(ldap.OPT_NETWORK_TIMEOUT, self.cfg.timeout_seconds)
                c.set_option(ldap.OPT_TIMEOUT, self.cfg.timeout_seconds)
                # The service principal is ldap/<host from the URL>: no reverse DNS, no canonicalization.
                c.set_option(ldap.OPT_X_SASL_NOCANON, 1)
                # Refuse a bind without a security layer: AD then signs and seals every message.
                c.set_option(ldap.OPT_X_SASL_SSF_MIN, self.cfg.min_ssf)
                c.sasl_interactive_bind_s("", ldap.sasl.gssapi())
                ssf = int(c.get_option(ldap.OPT_X_SASL_SSF) or 0)
                if ssf < self.cfg.min_ssf:
                    raise DirectoryError(f"security strength factor {ssf} < ADSYNC_MIN_SSF {self.cfg.min_ssf}")
                self.conn, self.url, self.ssf = c, url, ssf
                try:
                    self.whoami = c.whoami_s()
                except ldap.LDAPError:
                    self.whoami = None
                return self
            except (ldap.LDAPError, DirectoryError) as e:
                errors.append(f"{url}: {_ldap_msg(e)}")
                if c is not None:
                    try:
                        c.unbind_s()
                    except Exception:
                        pass
        raise DirectoryError("no domain controller could be bound: " + "; ".join(errors))

    def __exit__(self, *exc):
        if self.conn is not None:
            try:
                self.conn.unbind_s()
            except Exception:
                pass

    @property
    def host(self) -> str:
        return (urlsplit(self.url).hostname or "") if self.url else ""

    def paged_search(self, base: str, scope: int, filt: str, attrs: list[str]) -> list[tuple[str, dict]]:
        from ldap.controls import SimplePagedResultsControl

        ctrl = SimplePagedResultsControl(True, size=self.cfg.page_size, cookie=b"")
        out: list[tuple[str, dict]] = []
        while True:
            msgid = self.conn.search_ext(base, scope, filt, attrs, serverctrls=[ctrl])
            _, data, _, ctrls = self.conn.result3(msgid, timeout=self.cfg.timeout_seconds * 4)
            out.extend((dn, a) for dn, a in data if dn)  # skip search references (dn None)
            page = next((c for c in ctrls if c.controlType == SimplePagedResultsControl.controlType), None)
            if not page or not page.cookie:
                return out
            ctrl.cookie = page.cookie

    def read(self) -> dict:
        import ldap

        base = self.cfg.base_dn
        res = self.conn.search_s(base, ldap.SCOPE_BASE, "(objectClass=*)", ["wellKnownObjects"])
        wko = res[0][1].get("wellKnownObjects", []) if res else []
        default = default_computers_container(wko, base)
        ou_entries = self.paged_search(base, ldap.SCOPE_SUBTREE, "(objectClass=organizationalUnit)", OU_ATTRS)
        comp_entries = self.paged_search(base, ldap.SCOPE_SUBTREE, "(objectCategory=computer)", COMPUTER_ATTRS)
        ous = [entry_to_ou(dn, a) for dn, a in ou_entries]
        computers = [c for c in (entry_to_computer(dn, a) for dn, a in comp_entries) if c is not None]
        return build_snapshot(base, default, ous, computers, self.host)

    def own_kvno(self) -> int | None:
        """msDS-KeyVersionNumber of the service account (readable by the account itself)."""
        import ldap
        from ldap.filter import escape_filter_chars

        sam = escape_filter_chars(self.cfg.sam_account_name)
        res = self.conn.search_s(
            self.cfg.base_dn, ldap.SCOPE_SUBTREE, f"(&(objectCategory=person)(sAMAccountName={sam}))", ["msDS-KeyVersionNumber"]
        )
        for dn, a in res:
            if dn:
                v = _text(a, "msDS-KeyVersionNumber")
                return int(v) if v and v.isdigit() else None
        return None
