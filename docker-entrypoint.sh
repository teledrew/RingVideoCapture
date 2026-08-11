#!/bin/sh
# Aligns the container's runtime user with the host user that owns the mounted
# recordings directory, then drops privileges.
#
# Without this, recordings are written as the image's build-time uid (1000) and
# are awkward or impossible to read, move or delete from the host when the host
# user has a different uid — which is common on NAS devices and multi-user Linux
# hosts. Docker Desktop on macOS/Windows masks the problem by remapping
# ownership at the virtiofs/gRPC-FUSE layer, so this only bites on Linux.
#
# Set PUID/PGID to the owner of the host directory: `id -u` and `id -g`.
set -eu

readonly target_uid="${PUID:-1000}"
readonly target_gid="${PGID:-1000}"
readonly output_dir="${OUTPUT_DIR:-/recordings}"
readonly token_dir="$(dirname "${TOKEN_PATH:-/data/refresh-token}")"

# Only root can change ownership or switch user. If the container was started
# with --user, respect that and run as-is.
if [ "$(id -u)" -ne 0 ]; then
  echo "==> Running as uid $(id -u) (set via --user); skipping PUID/PGID setup"
  exec "$@"
fi

echo "==> Preparing runtime user (PUID=${target_uid} PGID=${target_gid})"

# Repoint the existing `node` account rather than creating a new user, so the
# home directory and shell stay valid.
current_gid="$(getent group node | cut -d: -f3)"
if [ "${current_gid}" != "${target_gid}" ]; then
  # Free the target gid if another group already holds it.
  existing_group="$(getent group "${target_gid}" | cut -d: -f1 || true)"
  if [ -n "${existing_group}" ] && [ "${existing_group}" != "node" ]; then
    groupmod -g 59999 "${existing_group}"
  fi
  groupmod -o -g "${target_gid}" node
fi

current_uid="$(id -u node)"
if [ "${current_uid}" != "${target_uid}" ]; then
  existing_user="$(getent passwd "${target_uid}" | cut -d: -f1 || true)"
  if [ -n "${existing_user}" ] && [ "${existing_user}" != "node" ]; then
    usermod -u 59999 "${existing_user}"
  fi
  usermod -o -u "${target_uid}" node
fi

mkdir -p "${output_dir}" "${token_dir}" 2>/dev/null || true

# Best-effort: /app may be mounted read-only, which is a legitimate hardening
# choice. The app only needs to read it.
chown -R node:node /app 2>/dev/null || \
  echo "--> Could not chown /app (read-only mount?); continuing"

# Ownership fixes are best-effort. A read-only or permission-restricted mount
# makes chown fail, but the app's own startup checks produce a far clearer
# diagnostic than a bare `chown: Read-only file system`, so let it get that far
# rather than dying here.
chown -R node:node "${token_dir}" 2>/dev/null || \
  echo "--> Could not chown ${token_dir}; continuing so startup checks can report why"

# For the recordings directory, only fix the directory itself, not its contents.
# A recursive chown over a large archive of footage would add minutes to every
# start. Existing files keep whatever ownership they have, which is correct —
# they are already readable by the host user that created them.
chown node:node "${output_dir}" 2>/dev/null || \
  echo "--> Could not chown ${output_dir}; relying on existing permissions"

echo "==> Dropping privileges to uid ${target_uid}"
exec gosu node "$@"
