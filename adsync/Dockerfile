# syntax=docker/dockerfile:1.7
# spoolfree-adsync: optional sidecar that reads AD over Kerberos (SASL GSSAPI, sealed) and pushes
# snapshots to Spoolfree (DIRECTORY_MODE=snapshot). Build: docker build -t spoolfree-adsync adsync/
FROM debian:trixie-slim

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-ldap krb5-user libsasl2-modules-gssapi-mit ca-certificates tini \
 && apt-get upgrade -y \
 && rm -rf /var/lib/apt/lists/* /etc/krb5.conf \
 && groupadd -g 1000 adsync && useradd -u 1000 -g 1000 -M -d /nonexistent -s /usr/sbin/nologin adsync

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ADSYNC_RUNTIME_DIR=/tmp/adsync
WORKDIR /app
COPY spoolfree_adsync ./spoolfree_adsync
USER 1000:1000
# Mount a writable (ideally memory-backed) /tmp: krb5.conf, keytab and ticket cache go to /tmp/adsync.
ENTRYPOINT ["/usr/bin/tini", "--", "python3", "-m", "spoolfree_adsync"]
