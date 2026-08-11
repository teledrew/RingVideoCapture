# ring-recorder

Watches Ring cameras and doorbells for **motion** and **doorbell presses**, and saves
each event as an MP4 plus a JPEG thumbnail in a directory you own. Runs as a
long-lived Docker service. Optional read-only web UI for browsing what it caught.

No cloud, no third-party service, no Ring Protect subscription. Files land on your
disk, named after the event, and stay there until the retention rules remove them.

Built on [`ring-client-api`](https://www.npmjs.com/package/ring-client-api).

```
20260805-142530_front-door_ding.mp4
20260805-142530_front-door_ding.jpg
20260805-143012_front-door_motion.mp4
20260805-143012_front-door_motion.jpg
```

Timestamps come from Ring's own event time, so the filename matches when the thing
actually happened rather than when the container got round to it.

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Web interface](#web-interface)
- [File ownership and permissions](#file-ownership-and-permissions)
- [Synology NAS](#synology-nas-container-manager)
- [Refresh token handling](#refresh-token-handling)
- [Retention](#retention)
- [Recording length](#recording-length)
- [How the recording works](#how-the-recording-works)
- [Security](#security)
- [Development](#development)
- [Layout](#layout)
- [Known limitations](#known-limitations)
- [Licence](#licence)

## What it does

On each motion or ding event, in this order:

1. Opens a live WebRTC stream and records to MP4 — at least `RECORD_SECONDS`
   (default 30), longer while the event is still going. See
   [recording length](#recording-length).
2. Extracts a JPEG thumbnail from the finished recording.
3. Applies a per-camera cooldown, so one visitor doesn't produce a pile of clips.
4. Prunes old recordings in the background so the disk can't fill up.

Video comes first deliberately — several Ring models can't take a snapshot while
streaming, and asking for one first blocks for the full 15-second refresh timeout,
delaying the artefact that actually matters.

The thumbnail is a frame lifted out of the clip (at `THUMBNAIL_OFFSET_SECONDS`,
default 2s), not a fresh camera snapshot. A snapshot taken after the stream ends
shows whatever the camera sees once everything is over — usually an empty doorstep,
which is the one moment nobody wants a picture of. A frame of the recording shows the
event. If there's no video to take a frame from, because the stream failed, it falls
back to `camera.getSnapshot()` so a failed event still leaves some trace.

Recordings are written to `.mp4.part` and renamed on completion, so anything watching
the directory never sees a half-written file.

## Requirements

- Docker with Compose v2 (`docker compose`, not `docker-compose`)
- A Ring account, and the ability to complete its 2FA prompt once
- Outbound UDP for WebRTC
- ~100MB disk per hour of recorded footage, at 1080p

Node isn't needed on the host — only inside the image. For local development, Node
20, 22 or 24.

## Quick start

### 1. Generate a refresh token

On any machine with Node. It prompts for your Ring email, password and 2FA code, and
prints a token:

```bash
npx -p ring-client-api ring-auth-cli
```

That token grants **full access to your Ring account**. Treat it like the password.

### 2. Configure

```bash
cp .env.example .env
# paste the token into RING_REFRESH_TOKEN
```

`RING_REFRESH_TOKEN` is the only required setting. Leave `CAMERA_NAMES` empty to
watch every camera on the account.

On Linux or a NAS, also set `PUID`/`PGID` to the host user who should own the files —
see [file ownership](#file-ownership-and-permissions).

### 3. Run

```bash
docker compose up -d
docker compose logs -f
```

Startup lists the cameras it found, which is the quickest way to get `CAMERA_NAMES`
right:

```
==> Starting ring-recorder {"outputDir":"/recordings","recordSeconds":30,...}
--> Using refresh token from persisted store {"path":"/data/refresh-token"}
--> Discovered cameras {"cameras":["Front Door","Back Garden"]}
==> Monitoring camera {"camera":"Front Door","id":123456,"isDoorbell":true,"battery":87}
==> Listening for events. Press Ctrl+C to stop.
```

Press the doorbell to confirm the whole path works:

```
==> Recording {"camera":"Front Door","kind":"ding","seconds":30,"file":"..._ding.mp4"}
--> Still active, extending recording {"camera":"Front Door","kind":"motion"}
--> Activity ended, stopping recording {"camera":"Front Door","seconds":47,"quietForSeconds":20}
==> Recording complete {"camera":"Front Door","file":"..._ding.mp4","elapsedSeconds":48,"extendedBy":2}
--> Saved thumbnail from recording {"file":"..._ding.jpg","atSeconds":2,"bytes":43632}
```

The clip ran to 47s rather than 30 because Ring kept reporting activity — see
[recording length](#recording-length).

## Configuration

Everything is an environment variable. `.env.example` is a copyable template with
the same notes inline.

| Variable | Default | Description |
| --- | --- | --- |
| `RING_REFRESH_TOKEN` | — | Seed token. Only used on first run; see [token handling](#refresh-token-handling). |
| `CAMERA_NAMES` | *(all)* | Comma-separated camera names, exactly as in the Ring app. |
| `RING_LOCATION_IDS` | *(all)* | Restrict to specific Ring location IDs. |
| `RECORD_SECONDS` | `30` | *Minimum* video length per event (5–300). |
| `EXTEND_ON_ACTIVITY` | `true` | Keep recording while Ring still reports activity. See [recording length](#recording-length). |
| `EXTEND_SECONDS` | `20` | Stop this long after the last sign of activity (5–120). |
| `MAX_RECORD_SECONDS` | `120` | Hard ceiling on one recording (5–900). Raised to `RECORD_SECONDS` if set below it. |
| `COOLDOWN_SECONDS` | `60` | Quiet period after a recording before the same camera can retrigger. |
| `CAPTURE_SNAPSHOT` | `true` | Also save a JPEG thumbnail per event. |
| `THUMBNAIL_OFFSET_SECONDS` | `2` | How far into the clip the thumbnail frame is taken from (0–60). Clamped below `RECORD_SECONDS`. |
| `RECORD_MOTION` | `true` | Record motion events. |
| `RECORD_DING` | `true` | Record doorbell presses. |
| `RETENTION_DAYS` | `14` | Delete clips older than this. `0` disables. |
| `RETENTION_MAX_GB` | `20` | Delete oldest-first above this total. `0` disables. |
| `PRUNE_INTERVAL_MINUTES` | `60` | How often the prune pass runs. |
| `OUTPUT_DIR` | `/recordings` | Where clips are written inside the container. |
| `PUID` / `PGID` | `1000` | Host uid/gid that should own saved files. See [ownership](#file-ownership-and-permissions). |
| `FILE_MODE` | `644` | Octal permissions for saved files. `600` restricts to the owner. |
| `HOST_OUTPUT_PATH` | *(unset)* | Cosmetic: host path echoed in startup logs. |
| `TOKEN_PATH` | `/data/refresh-token` | Where the rotated token is persisted. |
| `WEB_ENABLED` | `false` | Serve the [web interface](#web-interface). |
| `WEB_PORT` | `8080` | Port the web interface listens on inside the container. |
| `WEB_HOST_PORT` | `8080` | Host port it's published on (compose only). |
| `WEB_USERNAME` / `WEB_PASSWORD` | *(unset)* | HTTP basic auth. Both, or neither. |
| `TRUSTED_NETWORKS` | *(none)* | CIDRs that skip the password, or `default` for private ranges. [Read the caveat](#authentication). |
| `FFMPEG_PATH` | `ffmpeg` | Uses the image's ffmpeg; nothing is downloaded at install time. |
| `NETWORK_MODE` | `bridge` | Set to `host` on Linux if WebRTC fails to negotiate. |
| `TZ` | `Europe/London` | Timezone for log and filename timestamps. |
| `DEBUG` | `false` | Verbose API and ffmpeg logging. |
| `NODE_VERSION` | `22` | Node version inside the image (build arg). |

Invalid values fail at startup, not at the first event — so a typo shows up
immediately in `docker compose logs` rather than silently costing you a recording at
3am.

## Web interface

Optional, off by default: a small read-only page for browsing and playing what's been
recorded. No build step, no CDN, no client-side framework — plain HTML served from
Node's own `http` module, so it adds nothing to the dependency tree.

Set these in `.env`, and uncomment the `ports:` block in `compose.yaml`:

```bash
WEB_ENABLED=true
WEB_USERNAME=you
WEB_PASSWORD=something-long
WEB_HOST_PORT=8080     # change if 8080 is taken on the host
```

Then open `http://<host>:8080`. It lists events newest-first with the extracted frame
as a thumbnail, plays video inline with working seek (HTTP range requests, which Safari
requires), and offers a download link. It refreshes itself when a new recording
lands — via server-sent events — without interrupting a clip you're already
watching.

Endpoints: `/` listing, `/watch/<name>` player, `/media/<name>` file, `/events` SSE
stream, `/healthz` for container health checks, and `/whoami` for diagnosing the auth
rules below.

There's also `/tv`, a large-type view of the most recent event with its elapsed time,
for an always-on display where the question is whether anything has happened rather
than what's in the archive. Linked from the header of the main page.

Only filenames matching the recorder's own pattern are ever served. Nothing else in
the directory is reachable, including the refresh token if you happened to mount it
there.

### Authentication

`WEB_USERNAME` and `WEB_PASSWORD` enable HTTP basic auth, compared with a
constant-time check. Both must be set or both empty; a half-set pair fails at
startup rather than quietly serving the footage unprotected. With both empty there's
no authentication at all, and startup logs say so.

**Set them.** This serves video of your front door, and "it's only on my LAN"
includes the guest Wi-Fi and every IoT device on it.

`TRUSTED_NETWORKS` lets clients in given CIDRs skip the password
(`192.168.1.0/24`, or `default` for the usual private ranges). One caveat decides
whether it's usable at all: **on a Docker bridge network the container never sees
real client addresses.** Every request appears to come from the bridge gateway, so a
rule matching that gateway exempts *everything* — including anything arriving
through a port forward. Check what the container actually sees:

```bash
$ curl -s http://<host>:8080/whoami
remoteAddress: ::ffff:172.24.0.1
trusted: false
authConfigured: true
```

If that isn't the real client IP, leave `TRUSTED_NETWORKS` empty and use a password.
It works as intended under `network_mode: host`. `172.16.0.0/12` is deliberately
excluded from `default` for the same reason — that's where Docker's own bridges
live, and including it would silently disable authentication for every request.

`X-Forwarded-For` and friends are ignored entirely. They're client-supplied, so
honouring them would let anyone claim a trusted address.

**Don't port-forward this to the internet.** For remote access, use a VPN
(Tailscale, WireGuard) or a reverse proxy that terminates TLS and does its own
authentication.

## File ownership and permissions

Recordings are written to `/recordings` in the container, bind-mounted to
`RECORDINGS_PATH` on the host, so they appear in that host directory as they're
created with no copy step.

The part that needs attention is **ownership**. The container writes as `PUID:PGID`
(default `1000:1000`). On Linux and NAS devices, if that doesn't match the host user
owning the directory, files land unreadable or undeletable from outside the
container:

```bash
id -u   # -> PUID
id -g   # -> PGID
```

`FILE_MODE` (default `644`) then decides whether *other* host users can read the
footage. ffmpeg creates the video file itself subject to its umask, so the mode is
applied explicitly afterwards rather than left to chance.

Docker Desktop on macOS/Windows remaps ownership at the filesystem layer, so the
defaults just work there and `PUID`/`PGID` are effectively ignored. This only matters
on real Linux hosts and NAS devices.

Startup states what it resolved, which is the fastest way to confirm the mount:

```
==> Recordings directory ready {"inContainer":"/recordings",
    "onHost":"/volume1/ring/recordings","writableByUid":1026,
    "dirOwnerUid":1026,"dirOwnerGid":100,"newFileMode":"0644"}
```

Set `HOST_OUTPUT_PATH` to have the host-side path echoed there; it's purely
cosmetic, since the container can't otherwise know what the host calls the
directory.

Both the recordings and token directories are probed with a real test write at
startup, so a wrongly-owned or read-only mount fails immediately with an
explanation instead of at the first event hours later.

To run unprivileged end to end, pass `--user 1026:100` (or compose's `user:`) — the
entrypoint detects it and skips the uid remapping entirely.

## Synology NAS (Container Manager)

You do **not** need to build or upload a Docker image. Container Manager builds it
for you, natively for your NAS's own CPU, so the x86-64-vs-ARM question never
arises.

First, the NAS-side prep:

1. **Create shared folders** in File Station, e.g. `/volume1/ring/recordings` and
   `/volume1/ring/config`.
2. **Find your uid/gid** over SSH. DSM accounts usually start at uid 1026, and
   `users` is gid 100:
   ```bash
   id your-dsm-user
   ```
3. **Edit the `EDIT`-marked values** in your chosen compose file below: token,
   `PUID`/`PGID`, `HOST_OUTPUT_PATH`, camera names, and the two volume paths.
4. **Container Manager → Project → Create**, then upload the file.

Container Manager does **not** read `.env` files for uploaded projects, which is why
both Synology compose files carry literal values you edit in place rather than
`${VAR}` placeholders.

### Option A — single file, builds from GitHub (simplest)

Upload `compose.synology-git.yaml` and nothing else. Docker clones the source itself
as the build context:

```yaml
build:
  context: "https://github.com/teledrew/RingVideoCapture.git#main"
```

Requires the repo to stay **public** — Docker's clone is unauthenticated. Pin to a
tag rather than a branch for a reproducible deploy: `...git#v1.0.0`.

### Option B — upload the source folder

Use `compose.synology.yaml` (which has `context: .`) and upload the source alongside
it. Container Manager builds from the local folder, so the repo can stay private.
The build needs `Dockerfile`, `docker-entrypoint.sh`, `package.json`,
`package-lock.json` and `src/` — about 120KB.

### Synology notes

- **Getting `PUID`/`PGID` right is what makes the videos browsable in File Station
  and over SMB.** With wrong values they're owned by an unrelated uid and DSM shows
  them as inaccessible. This is the single most likely thing to get wrong on a NAS.
- **Use host port 8123 (or anything free) for the web UI.** DSM claims 8080 and
  several nearby ports for itself.
- **`/data` is a bind mount, not a named volume**, so the refresh token sits in a
  shared folder you can see and back up rather than inside Synology's Docker
  storage. It must survive container recreation — Container Manager recreates
  containers whenever you edit a project.
- **`network_mode: host` is omitted.** Container Manager's UI doesn't support it, and
  it isn't needed: the WebRTC streams are outbound-only, so bridge networking works.
- **`mem_limit: 1g`** guards against a runaway ffmpeg destabilising DSM, which is
  itself memory-hungry. One stream needs far less.
- **Container Manager's "restart" does not apply compose changes.** Editing
  environment variables requires recreating the container, and its "Build" can
  silently reuse a cached image. If a change doesn't seem to take effect, that's
  usually why — over SSH, `docker compose up -d --force-recreate`.
- **No compiler needed on the NAS.** None of the dependencies have install scripts,
  so there's no `node-gyp` step — the usual reason NAS-side builds fail.
- **Expect roughly 2–5 minutes** for a cold build. Avoid `--no-cache` on rebuilds:
  it discards the ~250MB ffmpeg apt layer and makes every build slow for no benefit.
- **Timezone:** `TZ` only affects this app's logs and filenames. It doesn't inherit
  DSM's setting.

## Refresh token handling

**This is the part that breaks naive Ring integrations, so it's worth understanding.**

Ring rotates refresh tokens roughly hourly, and each rotated token carries forward
the push-notification (FCM) registration established on first connect. This app
subscribes to `onRefreshTokenUpdated` and persists every rotation to `TOKEN_PATH` on
the `/data` volume, writing via a temp file and atomic rename so a crash mid-write
can't corrupt it.

Consequences worth knowing:

- **The `/data` volume must persist across restarts and container recreation.** If
  it's lost, the container re-seeds from `RING_REFRESH_TOKEN` and Ring rejects the
  stale FCM data — authentication may still succeed while **push notifications
  silently stop working forever**. Recovery means deleting the client from Ring
  Control Center and re-authenticating.
- After the first successful run, `RING_REFRESH_TOKEN` is ignored. Clear it from
  `.env` if you like.
- The token file is written `0600` and never logged.

## Retention

Two independent limits, both applied on every pass, either disabled with `0`:

- **Age** — anything older than `RETENTION_DAYS`.
- **Size** — oldest-first until the directory is under `RETENTION_MAX_GB`.

Only `.mp4`, `.jpg` and `.part` files are touched; anything else you keep in the
directory is left alone. Abandoned `.part` files from crashed recordings get cleaned
up by the age rule.

## Recording length

`RECORD_SECONDS` is a floor, not a fixed length. A visitor who stands at the door
for two minutes shouldn't produce a 30-second clip that stops before the interesting
part.

Ring provides no "motion ended" or "visitor left" event — nothing arrives to say the
event is over. What it does provide is a *repeat* notification every few seconds for
as long as it still sees activity. That's the only signal available, so the recorder
treats continued notifications as continued presence:

- Records for at least `RECORD_SECONDS`.
- Every notification for a camera that's already recording pushes the end back to
  `EXTEND_SECONDS` from now, instead of being discarded as a duplicate.
- Stops once nothing has been reported for `EXTEND_SECONDS`, or at
  `MAX_RECORD_SECONDS`, whichever comes first.

So a doorbell press with nobody lingering gives ~30s; someone at the door for two
minutes gives a clip that follows them until they leave, up to the ceiling.

The `extendedBy` count in the "Recording complete" log line is how many repeat
notifications arrived — i.e. how much of the length was earned by real activity.

**Why there's a ceiling.** Ring live sessions don't last indefinitely, streaming
drains battery models quickly, and one busy afternoon shouldn't fill the disk from a
single event. Set `MAX_RECORD_SECONDS` to the longest clip you'd actually want.

**Caveats worth knowing.** This is inference from notification traffic, not a real
end-of-event signal:

- Ring's repeat interval isn't documented or guaranteed. `EXTEND_SECONDS` needs to
  comfortably exceed the gap between notifications or a recording can stop while
  someone is still there. The 20s default is deliberately generous; lower it only if
  you've watched your own logs.
- Ring may throttle notifications for repeated motion on the same camera, in which
  case the clip ends early regardless.
- Extension makes clips longer and less predictable in size. Retention is by age and
  total bytes, so it still can't overrun the disk, but expect to hold fewer events in
  the same space.
- Set `EXTEND_ON_ACTIVITY=false` for the old fixed-length behaviour.

If you need genuinely complete event coverage, Ring's own cloud recordings (with a
Ring Protect subscription) are authoritative — they start before the trigger via the
on-camera pre-roll buffer and end when Ring decides the event ended. This records
from the live stream instead, which is why it can only start when the notification
arrives.

## How the recording works

Two details are less obvious than they look, and both were bugs before they were
features.

**Fragmented MP4, not `+faststart`.** A plain MP4 only becomes playable once ffmpeg
writes the `moov` atom, which it does on the way out. Anything that stops it short —
a dropped Ring call, a killed container, a full disk — leaves `ftyp`/`mdat` with no
`moov`, and every player rejects that file outright. So recordings use
`-movflags +frag_keyframe+empty_moov+default_base_moof`: a minimal `moov` up front
plus self-contained fragments as it goes. Whatever reached the disk stays playable,
however the stream ended. A truncated clip is worth far more than a corrupt one.

**Waiting for ffmpeg, not for Ring.** `onCallEnded` fires when the *Ring call*
drops, which is when the library signals ffmpeg — not when ffmpeg has flushed its
trailer and exited. Renaming at that moment produces a file that's still being
written. `ring-client-api` exposes no hook for the process exit, so the recorder
polls until the file size stops growing before it touches anything.

Failures are non-destructive: a partial `.part` file with bytes in it is kept and
logged rather than deleted, because fragmented MP4 means it's probably watchable.

## Security

- **A Ring refresh token grants full access to the account** — cameras, live view,
  address, the lot. It's not an API key you can scope down.
- `.gitignore` covers `.env`, `*refresh-token*`, `compose.override.*`, and all media
  files. Check `git status` before your first commit anyway.
- **Don't commit a real token.** If you do, revoke it immediately in Ring Control
  Center; rewriting history isn't enough once it's been pushed.
- The web UI is read-only, serves only files matching the recorder's naming pattern,
  and ignores forwarded-address headers. It has no TLS and no rate limiting — put it
  behind a VPN or authenticating proxy for anything beyond a trusted LAN.
- Container runs as a non-root user; the entrypoint uses `gosu` to drop privileges
  after aligning uid/gid.

Found a security problem? Open an issue for anything low-risk, or contact the
maintainer privately for anything that would expose someone's footage.

## Development

```bash
npm install
npm test        # 48 unit tests, no Ring account needed
```

Tests cover config validation, notification classification, token persistence
(including permissions and concurrent rotations), retention pruning, CIDR matching,
and the web UI's filename guard against path traversal. Nothing touches the network.

Plain JavaScript, ES modules, no build step, no transpiler. Two runtime
dependencies (`ring-client-api` and `rxjs`); the HTTP server, file watching, CIDR
parsing and range handling are all Node stdlib. Tests use the built-in
`node:test` runner.

`ring-client-api` supports Node `^20 || ^22 || ^24`, so run tests on a supported
Node locally, or in the container:

```bash
docker run --rm -v "$PWD/test:/app/test:ro" ring-recorder node --test test/*.test.js
```

Build against a different Node runtime:

```bash
docker build --build-arg NODE_VERSION=24 -t ring-recorder .
```

Contributions welcome. Please keep the no-dependency stance for the web UI, and add
a test for anything touching authentication or path handling.

## Layout

```
src/
  index.js              wiring, camera selection, startup checks, shutdown
  config.js             environment parsing and validation
  notification.js       push notification -> recordable event
  recorder.js           video + thumbnail capture, cooldown, overlap suppression
  retention.js          age- and size-based pruning
  token-store.js        atomic, 0600 refresh token persistence
  server.js             optional read-only web UI, no dependencies
  net.js                CIDR matching for the web UI's trusted-network check
  logger.js             structured stdout/stderr logging
test/unit.test.js       48 tests, no network access
docker-entrypoint.sh    PUID/PGID alignment, then drops privileges via gosu
compose.yaml               standard Docker / Docker Desktop
compose.synology.yaml      Synology, building from an uploaded source folder
compose.synology-git.yaml  Synology, single file, builds from GitHub
```

## Known limitations

- **No pre-roll.** Recording starts when the notification arrives, so the moment
  just before the event isn't captured. Ring's own cloud recordings do include
  pre-roll — `camera.getRecordingUrl(dingId)` could fetch those instead, but that
  needs a Ring Protect subscription and adds 30–60s of delay.
- **Event length is inferred, not signalled.** Ring never says an event has ended,
  so recordings extend on repeat notifications and stop when those dry up. See
  [recording length](#recording-length) for what that can and can't guarantee.
- **Battery cameras drain noticeably** with frequent recording, and more so now that
  clips extend while someone is at the door. Consider raising `COOLDOWN_SECONDS`,
  lowering `MAX_RECORD_SECONDS`, or `RECORD_MOTION=false` to capture only doorbell
  presses.
- **One stream per camera.** Ring permits a single live stream per camera, so
  overlapping events on the same camera are skipped and logged rather than queued.
  Different cameras record concurrently.
- **Thumbnails can be missing** if both the frame extraction and the fallback camera
  snapshot fail — a corrupt clip on a camera that also refuses snapshots. Logged as a
  warning; the video is already safely on disk by then, and the web UI handles an
  event with no thumbnail.
- **WebRTC needs outbound UDP.** The default bridge network works on Docker Desktop.
  On Linux, if streams fail to negotiate, set `NETWORK_MODE=host`.
- **Unofficial API.** `ring-client-api` reverse-engineers Ring's app protocol. Ring
  can change it without notice, and this is not affiliated with or endorsed by Ring
  or Amazon.
- **`npm audit` reports a high-severity SSRF advisory in `ip`**, pulled in
  transitively via `werift` (the WebRTC stack) by `ring-client-api`. No fix exists
  that doesn't downgrade `ring-client-api` to 9.x, a major regression. It isn't
  reachable from this app's inputs — nothing here makes requests to user-supplied
  addresses — so it's accepted rather than patched.

## Licence

MIT. See [LICENSE](LICENSE).
