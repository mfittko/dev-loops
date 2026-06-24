# dev-loops containerized dev-loop runtime
# Single-stage deterministic build for local and CI use.

FROM node:24-bookworm-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf

# Pinned tool versions (bump together when updating)
ARG PI_VERSION=0.79.0
ARG PI_SUBAGENTS_VERSION=0.28.0
ARG PI_TELEGRAM_VERSION=0.3.5
ARG PI_INTERCOM_VERSION=0.6.0
ARG GH_CLI_VERSION=2.63.2
ARG GIT_VERSION=1:2.39.5-0+deb12u2

# Pinned gh CLI SHA256 checksums (verified at install time)
ARG GH_CLI_CHECKSUM_AMD64=94970e886e6fd1c2f8b1e31326fdc58ff5a434318de78d2b9b1c88dd1c6418db
ARG GH_CLI_CHECKSUM_ARM64=7f0db36da8c209befe550ab8005306bb08a3c7ecbb9a497201d008b5603bf710

# System dependencies: git (dev-loop worktree ops), curl + ca-certificates (gh CLI install)
# git version pinned via apt version constraint for deterministic rebuilds.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git=${GIT_VERSION} \
    && rm -rf /var/lib/apt/lists/*

# Install pi CLI and extensions globally (pinned versions)
RUN npm install -g --ignore-scripts \
    "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    "pi-subagents@${PI_SUBAGENTS_VERSION}" \
    "pi-telegram@${PI_TELEGRAM_VERSION}" \
    "pi-intercom@${PI_INTERCOM_VERSION}"

# Install GitHub CLI (pinned version, architecture-aware, checksum-verified)
# Only x86_64/amd64 and aarch64/arm64 are supported.
RUN ARCH=$(uname -m) \
    && case "${ARCH}" in \
         x86_64)  ARCH=amd64; EXPECTED_CHECKSUM=${GH_CLI_CHECKSUM_AMD64} ;; \
         aarch64) ARCH=arm64; EXPECTED_CHECKSUM=${GH_CLI_CHECKSUM_ARM64} ;; \
         *)       echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && DEB="gh_${GH_CLI_VERSION}_linux_${ARCH}.deb" \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/${DEB}" -o "/tmp/${DEB}" \
    && echo "${EXPECTED_CHECKSUM}  /tmp/${DEB}" | sha256sum -c - \
    && dpkg -i "/tmp/${DEB}" \
    && rm "/tmp/${DEB}"

# Set workspace directory
WORKDIR /workspace

# Copy workspace files
COPY . .

# Install workspace dependencies (postinstall creates dev-loops symlink)
RUN npm ci

# Append workspace node_modules/.bin last so global tools take precedence
ENV PATH="${PATH}:/workspace/node_modules/.bin"


# Run as non-root node user (base image provides this user)
USER node

# Dual-harness smoke (#775):
# - Pi: the default `dev-loops` CMD below (Pi CLI installed above).
# - Claude (Pi-free, read-only, offline — no interactive session, API key, or GitHub token):
#     npm run smoke:headless            # exercises the offline `dev-loops status` info path
#   Add `-- --loop-info --issue <n>` to also exercise `dev-loops loop info` (needs GitHub read access).
#   The headless Claude Agent SDK run is `node scripts/claude/headless-dev-loop.mjs --issue <n>`
#   (needs `claude` on PATH + an API key; use `--dry-run` to inspect the invocation).
CMD ["dev-loops"]
