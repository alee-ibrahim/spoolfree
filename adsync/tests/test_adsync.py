"""Unit tests (stdlib only, no python-ldap or krb5 needed): python -m unittest discover -s adsync/tests -t adsync"""

import os
import struct
import tempfile
import unittest
import uuid
from unittest import mock

from spoolfree_adsync import cli
from spoolfree_adsync.config import ConfigError, load
from spoolfree_adsync.directory import (
    build_snapshot,
    counts,
    default_computers_container,
    entry_to_computer,
    entry_to_ou,
    guid_from_bytes,
)
from spoolfree_adsync.krb import Kerberos, KerberosError, render_krb5_conf
from spoolfree_adsync.push import PushError, post_json

BASE = "DC=example,DC=org"


def env(**over):
    e = {
        "ADSYNC_LDAP_URLS": "ldap://dc1.example.org, ldap://dc2.example.org:389",
        "ADSYNC_BASE_DN": BASE,
        "ADSYNC_REALM": "example.org",
        "ADSYNC_PRINCIPAL": "svc-spoolfree",
        "ADSYNC_PASSWORD_FILE": "/run/secrets/pw",
        "ADSYNC_TOKEN_FILE": "/run/secrets/token",
    }
    e.update(over)
    return e


class ConfigTests(unittest.TestCase):
    def test_defaults(self):
        c = load(env())
        self.assertEqual(c.ldap_urls, ("ldap://dc1.example.org", "ldap://dc2.example.org:389"))
        self.assertEqual(c.realm, "EXAMPLE.ORG")
        self.assertEqual(c.principal, "svc-spoolfree@EXAMPLE.ORG")
        self.assertEqual(c.kdcs, ("dc1.example.org", "dc2.example.org"))
        self.assertIsNone(c.kvno)
        self.assertEqual(c.interval_seconds, 300)
        self.assertEqual(c.sam_account_name, "svc-spoolfree")

    def test_ip_and_short_names_refused(self):
        with self.assertRaisesRegex(ConfigError, "FQDN"):
            load(env(ADSYNC_LDAP_URLS="ldap://192.0.2.10"))
        with self.assertRaisesRegex(ConfigError, "fully qualified"):
            load(env(ADSYNC_LDAP_URLS="ldap://dc1"))

    def test_missing_and_dry_run(self):
        with self.assertRaisesRegex(ConfigError, "ADSYNC_TOKEN_FILE"):
            load(env(ADSYNC_TOKEN_FILE=""))
        self.assertIsNone(load(env(ADSYNC_TOKEN_FILE=""), need_push=False).token_file)

    def test_kvno_and_interval(self):
        self.assertEqual(load(env(ADSYNC_KVNO="3")).kvno, 3)
        with self.assertRaises(ConfigError):
            load(env(ADSYNC_INTERVAL_SECONDS="5"))


class KrbConfTests(unittest.TestCase):
    def test_render(self):
        conf = render_krb5_conf(load(env()))
        self.assertIn("rdns = false", conf)
        self.assertIn("dns_canonicalize_hostname = false", conf)
        self.assertIn("permitted_enctypes = aes256-cts-hmac-sha1-96 aes128-cts-hmac-sha1-96", conf)
        self.assertIn("    kdc = dc2.example.org", conf)
        self.assertIn("  dc1.example.org = EXAMPLE.ORG", conf)


class FakeRun:
    """Records subprocess calls and fakes ktutil/klist/kinit."""

    def __init__(self, keytab_entries=2, kinit_rc=0):
        self.calls = []
        self.keytab_entries = keytab_entries
        self.kinit_rc = kinit_rc

    def __call__(self, args, input=None, **kw):
        self.calls.append((args, input))
        r = mock.Mock(returncode=0, stdout="", stderr="")
        if args[0] == "ktutil":
            path = [l for l in input.splitlines() if l.startswith("wkt ")][0][4:]
            with open(path, "wb") as f:
                f.write(b"\x05\x02keytab")
        elif args[0] == "klist":
            r.stdout = "\n".join(f"   2 01/01/26 svc-spoolfree@EXAMPLE.ORG" for _ in range(self.keytab_entries))
        elif args[0] == "kinit":
            r.returncode = self.kinit_rc
            r.stderr = "kinit: Preauthentication failed" if self.kinit_rc else ""
        return r


class KerberosTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pw = os.path.join(self.tmp.name, "pw")
        with open(self.pw, "w") as f:
            f.write("S3cret pass;word\n")
        self.cfg = load(env(ADSYNC_PASSWORD_FILE=self.pw, ADSYNC_RUNTIME_DIR=os.path.join(self.tmp.name, "rt")))
        self._env = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)
        self.tmp.cleanup()

    def test_password_only_on_stdin(self):
        run = FakeRun()
        k = Kerberos(self.cfg, run=run)
        k.prepare()
        k.login()
        for args, stdin in run.calls:
            self.assertNotIn("S3cret", " ".join(args))
        ktutil_input = [i for a, i in run.calls if a[0] == "ktutil"][0]
        self.assertIn("addent -password -p svc-spoolfree@EXAMPLE.ORG -k 1 -e aes256-cts-hmac-sha1-96 -f", ktutil_input)
        self.assertEqual(ktutil_input.count("S3cret pass;word"), 2)
        self.assertTrue(os.path.exists(k.keytab))
        self.assertEqual(os.environ["KRB5CCNAME"], f"FILE:{k.ccache}")

    def test_keytab_rebuilt_only_when_password_or_kvno_changes(self):
        run = FakeRun()
        k = Kerberos(self.cfg, run=run)
        k.prepare()
        self.assertTrue(k.ensure_keytab())
        self.assertFalse(k.ensure_keytab())
        with open(self.pw, "w") as f:
            f.write("rotated")
        self.assertTrue(k.ensure_keytab())
        self.assertTrue(k.set_kvno(2))
        self.assertIn("-k 2 ", [i for a, i in run.calls if a[0] == "ktutil"][-1])
        self.assertFalse(k.set_kvno(2))

    def test_errors_never_contain_the_password(self):
        run = FakeRun(keytab_entries=0)
        orig = run.__call__

        def leaky(args, input=None, **kw):
            r = orig(args, input, **kw)
            if args[0] == "ktutil":
                r.stderr = 'ktutil: Unknown request "S3cret pass;word".'
            return r

        k = Kerberos(self.cfg, run=leaky)
        k.prepare()
        with self.assertRaises(KerberosError) as ctx:
            k.ensure_keytab()
        self.assertNotIn("S3cret", str(ctx.exception))
        self.assertIn("[redacted]", str(ctx.exception))

    def test_kinit_failure_retries_with_a_fresh_keytab(self):
        run = FakeRun(kinit_rc=1)
        k = Kerberos(self.cfg, run=run)
        k.prepare()
        with self.assertRaisesRegex(KerberosError, "Preauthentication failed"):
            k.login()
        self.assertEqual([a[0] for a, _ in run.calls].count("ktutil"), 2)


class MappingTests(unittest.TestCase):
    def test_guid_byte_order_matches_the_app(self):
        # Same vector as tests/ldap.test.ts in the app
        raw = bytes.fromhex("5bad8f0fcbd99f46a16570867728950e")
        self.assertEqual(guid_from_bytes(raw), "0f8fad5b-d9cb-469f-a165-70867728950e")

    def test_entries(self):
        g = uuid.uuid4()
        c = entry_to_computer(
            f"CN=PC1,OU=Lab,{BASE}",
            {"cn": [b"PC1"], "objectGUID": [g.bytes_le], "userAccountControl": [b"4098"], "dNSHostName": [b"pc1.example.org"]},
        )
        self.assertEqual(c["objectGuid"], str(g))
        self.assertEqual(c["userAccountControl"], 4098)
        self.assertIsNone(c["operatingSystem"])
        self.assertIsNone(entry_to_computer("CN=X", {"cn": [b"X"], "userAccountControl": [b"4096"]}))
        o = entry_to_ou(f"OU=Lab,{BASE}", {"ou": [b"Lab"], "objectGUID": [g.bytes_le]})
        self.assertEqual(o, {"dn": f"OU=Lab,{BASE}", "name": "Lab", "objectGuid": str(g)})

    def test_default_container_and_counts(self):
        wko = [b"B:32:AA312825768811D1ADED00C04FD8D5CD:OU=New PCs,DC=example,DC=org"]
        self.assertEqual(default_computers_container(wko, BASE), "OU=New PCs,DC=example,DC=org")
        self.assertEqual(default_computers_container([], BASE), f"CN=Computers,{BASE}")
        s = build_snapshot(BASE, f"CN=Computers,{BASE}", [{"dn": "OU=A"}], [
            {"userAccountControl": 4096, "dnsHostName": "a"},
            {"userAccountControl": 4098, "dnsHostName": None},
        ], "dc1.example.org")
        self.assertEqual(s["version"], 1)
        self.assertEqual(counts(s), {"ous": 1, "computers": 2, "enabled": 1, "disabled": 1, "withDnsHostName": 1})


class PushTests(unittest.TestCase):
    def test_4xx_is_final_and_connection_errors_retry(self):
        import urllib.error

        sleeps = []
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("refused")) as m:
            with self.assertRaisesRegex(PushError, "after 3 attempts"):
                post_json("http://127.0.0.1:1/x", "t" * 40, {}, attempts=3, sleep=sleeps.append)
            self.assertEqual(m.call_count, 3)
        err = urllib.error.HTTPError("http://x", 401, "unauthorized", {}, None)
        err.read = lambda n=-1: b'{"error":"unauthorized"}'
        with mock.patch("urllib.request.urlopen", side_effect=err) as m:
            with self.assertRaisesRegex(PushError, "HTTP 401"):
                post_json("http://127.0.0.1:1/x", "t" * 40, {}, attempts=3, sleep=sleeps.append)
            self.assertEqual(m.call_count, 1)


class CliTests(unittest.TestCase):
    def test_bad_config_exits_2(self):
        with mock.patch.dict(os.environ, {"ADSYNC_LDAP_URLS": ""}, clear=True):
            self.assertEqual(cli.main(["--once"]), 2)


if __name__ == "__main__":
    unittest.main()
