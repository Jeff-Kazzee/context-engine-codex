# The official Ubuntu digest and incident-specific CA package are reviewed together.
FROM docker.io/library/ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
      ca-certificates=20260816ubuntu0.24.04.1 curl xz-utils python3 bash git passwd util-linux \
 && test "$(dpkg-query --show --showformat='${Version}' ca-certificates)" = 20260816ubuntu0.24.04.1 \
 && rm -rf /var/lib/apt/lists/*
ARG CE_UID
ARG CE_GID
RUN case "$CE_UID" in ''|0|*[!0-9]*) exit 1;; esac \
 && case "$CE_GID" in ''|0|*[!0-9]*) exit 1;; esac \
 && (getent group "$CE_GID" >/dev/null || groupadd --gid "$CE_GID" ce-ci) \
 && useradd --no-create-home --uid "$CE_UID" --gid "$CE_GID" --shell /bin/bash ce-ci
COPY .github/actions/security-ci/bootstrap.sh /opt/ce/bootstrap.sh
COPY .github/actions/security-ci/artifacts.json /opt/ce/artifacts.json
RUN bash /opt/ce/bootstrap.sh
COPY .github/actions/security-ci/entrypoint.sh .github/actions/security-ci/run.sh setup/check-node.mjs setup/node-runtime.mjs /opt/ce/
COPY setup/ci/ /opt/ce/ci/
ENV PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_USE_SYSTEM_CA=1
ENTRYPOINT ["/bin/bash", "/opt/ce/entrypoint.sh"]
