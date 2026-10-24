# GuardDog in a sandbox: static rules (semgrep, yara) over a directory oupdate has already unpacked.
# Run with no network, a read-only root and no capabilities (see README section "GuardDog layer").
FROM python@sha256:cce12316475d7d56d605f76e1d811d0dc4e7227f2d4afd29951521264f504ff8
ARG GUARDDOG=3.2.0
COPY requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r /tmp/requirements.lock && rm /tmp/requirements.lock
RUN useradd -u 10001 -m scan
USER 10001
ENTRYPOINT ["guarddog"]
