/**
 * Configuration loaded from the environment, validated at startup.
 *
 * Fails fast on invalid values: a container that starts with a bad recording
 * length or an unwritable output path should crash immediately rather than
 * silently misbehave when an event finally arrives hours later.
 */

import { log } from './logger.js';
import { parseCidr, DEFAULT_TRUSTED_NETWORKS } from './net.js';

const parseInteger = (name, rawValue, fallback, { min, max }) => {
  if (rawValue === undefined || rawValue === '') {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got "${rawValue}"`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${value}`);
  }

  return value;
};

/** Parses a unix file mode written in octal, e.g. "644" or "0644". */
const parseOctal = (name, rawValue, fallback) => {
  if (rawValue === undefined || rawValue === '') {
    return fallback;
  }

  if (!/^0?[0-7]{3}$/.test(rawValue.trim())) {
    throw new Error(`${name} must be a 3-digit octal file mode (e.g. 644), got "${rawValue}"`);
  }

  return Number.parseInt(rawValue.trim(), 8);
};

const parseBoolean = (name, rawValue, fallback) => {
  if (rawValue === undefined || rawValue === '') {
    return fallback;
  }
  if (['true', '1', 'yes'].includes(rawValue.toLowerCase())) {
    return true;
  }
  if (['false', '0', 'no'].includes(rawValue.toLowerCase())) {
    return false;
  }
  throw new Error(`${name} must be a boolean (true/false), got "${rawValue}"`);
};

/**
 * Parses TRUSTED_NETWORKS into parsed CIDRs plus the literal list for logging.
 *
 * Defaults to no trusted networks: an address-based auth bypass should be opted
 * into deliberately, not inherited by anyone who upgrades. "default" selects the
 * usual private ranges. An unparseable entry throws rather than being skipped —
 * silently dropping a typo'd CIDR would quietly change who can see the footage.
 */
const parseTrustedNetworks = (rawValue) => {
  const raw = (rawValue ?? '').trim();
  if (raw === '') {
    return { trustedNetworks: [], trustedNetworkSource: 'none' };
  }

  const entries =
    raw.toLowerCase() === 'default'
      ? DEFAULT_TRUSTED_NETWORKS
      : raw
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);

  const trustedNetworks = entries.map((entry) => {
    const cidr = parseCidr(entry);
    if (!cidr) {
      throw new Error(
        `TRUSTED_NETWORKS contains "${entry}", which is not a valid IP or CIDR ` +
          `(e.g. "192.168.1.0/24"). Use "default" for the usual private ranges, ` +
          `or "" to always require the password.`,
      );
    }
    return cidr;
  });

  return { trustedNetworks, trustedNetworkSource: entries.join(', ') };
};

const parseList = (rawValue) =>
  (rawValue ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

export const loadConfig = (env = process.env) => {
  // The token file is the source of truth once running, because Ring rotates
  // refresh tokens roughly hourly. RING_REFRESH_TOKEN is only the seed value
  // used on very first startup.
  const seedRefreshToken = env.RING_REFRESH_TOKEN?.trim() ?? '';

  const config = {
    seedRefreshToken,
    tokenPath: env.TOKEN_PATH?.trim() || '/data/refresh-token',
    outputDir: env.OUTPUT_DIR?.trim() || '/recordings',

    // Which cameras to watch. Empty means every camera on the account.
    cameraNames: parseList(env.CAMERA_NAMES),
    locationIds: parseList(env.RING_LOCATION_IDS),

    // The *minimum* length of a recording. With EXTEND_ON_ACTIVITY the clip runs
    // longer whenever Ring keeps reporting activity, up to MAX_RECORD_SECONDS.
    recordSeconds: parseInteger('RECORD_SECONDS', env.RECORD_SECONDS, 30, {
      min: 5,
      max: 300,
    }),

    // Keep recording while the event is still going. Ring re-sends a notification
    // every few seconds for as long as it sees activity, so a repeat notification
    // for a camera that is already recording is the signal that whoever triggered
    // it is still there.
    extendOnActivity: parseBoolean('EXTEND_ON_ACTIVITY', env.EXTEND_ON_ACTIVITY, true),

    // How long to keep recording after the most recent sign of activity. Ring's
    // repeat notifications arrive every ~5-10s, so this needs to comfortably
    // exceed that gap or the recording stops between two of them.
    extendSeconds: parseInteger('EXTEND_SECONDS', env.EXTEND_SECONDS, 20, {
      min: 5,
      max: 120,
    }),

    // Hard ceiling on a single recording, however much activity continues. Ring
    // live sessions do not last forever, battery models drain fast while
    // streaming, and an unbounded clip could fill the disk from one event.
    maxRecordSeconds: parseInteger('MAX_RECORD_SECONDS', env.MAX_RECORD_SECONDS, 120, {
      min: 5,
      max: 900,
    }),

    // Ring keeps sending notifications for a single real-world event. Without a
    // cooldown one visitor produces a pile of overlapping recordings, and
    // concurrent live streams to the same camera fail.
    cooldownSeconds: parseInteger('COOLDOWN_SECONDS', env.COOLDOWN_SECONDS, 60, {
      min: 0,
      max: 3600,
    }),

    captureSnapshot: parseBoolean('CAPTURE_SNAPSHOT', env.CAPTURE_SNAPSHOT, true),

    // How far into the recording to grab the thumbnail frame. The opening moments
    // of a Ring stream are often a grey or half-decoded keyframe while the encoder
    // settles, so frame 0 makes a poor thumbnail; 2s is past that and still shows
    // whatever triggered the event. Capped below recordSeconds after parsing.
    thumbnailOffsetSeconds: parseInteger(
      'THUMBNAIL_OFFSET_SECONDS',
      env.THUMBNAIL_OFFSET_SECONDS,
      2,
      { min: 0, max: 60 },
    ),
    recordMotion: parseBoolean('RECORD_MOTION', env.RECORD_MOTION, true),
    recordDing: parseBoolean('RECORD_DING', env.RECORD_DING, true),

    retentionDays: parseInteger('RETENTION_DAYS', env.RETENTION_DAYS, 14, {
      min: 0,
      max: 3650,
    }),
    retentionMaxGb: parseInteger('RETENTION_MAX_GB', env.RETENTION_MAX_GB, 20, {
      min: 0,
      max: 100000,
    }),
    pruneIntervalMinutes: parseInteger(
      'PRUNE_INTERVAL_MINUTES',
      env.PRUNE_INTERVAL_MINUTES,
      60,
      { min: 1, max: 1440 },
    ),

    // Permissions applied to saved videos and snapshots. The default 0644 makes
    // recordings readable by any host user that can reach the mounted
    // directory, not just the owner — the usual want for footage you intend to
    // browse or serve from outside the container. Tighten to 0640 or 0600 if the
    // directory is shared with users who should not see the footage.
    fileMode: parseOctal('FILE_MODE', env.FILE_MODE, 0o644),

    // Purely informational: the host-side path of the recordings bind mount, so
    // startup logs can point at a location that is meaningful outside the
    // container. Has no effect on where files are written.
    hostOutputPath: env.HOST_OUTPUT_PATH?.trim() || '',

    // Read-only browser UI for the recordings. Off by default: it serves footage
    // of your front door, so enabling it should be a deliberate choice.
    webEnabled: parseBoolean('WEB_ENABLED', env.WEB_ENABLED, false),
    webPort: parseInteger('WEB_PORT', env.WEB_PORT, 8080, { min: 1, max: 65535 }),
    // Optional HTTP basic auth. Both must be set for it to take effect; without
    // them the UI is unauthenticated and startup logs a warning.
    webUsername: env.WEB_USERNAME?.trim() || '',
    webPassword: env.WEB_PASSWORD ?? '',
    // Clients in these CIDRs skip the password. Set to "" to require it from
    // everyone, or "default" for the usual private ranges. Only meaningful if
    // the server sees real client addresses — see GET /whoami.
    ...parseTrustedNetworks(env.TRUSTED_NETWORKS),

    debug: parseBoolean('DEBUG', env.DEBUG, false),
    // Use the system ffmpeg from the image rather than downloading a static
    // build at install time.
    ffmpegPath: env.FFMPEG_PATH?.trim() || 'ffmpeg',
  };

  if (!config.recordMotion && !config.recordDing) {
    throw new Error(
      'RECORD_MOTION and RECORD_DING are both false — nothing would ever be recorded',
    );
  }

  // A ceiling below the floor would mean the minimum length could never be
  // reached. Raise the ceiling rather than throw: the operator clearly wants at
  // least recordSeconds, and that is the value with the stronger claim.
  if (config.maxRecordSeconds < config.recordSeconds) {
    log.warn('MAX_RECORD_SECONDS is below RECORD_SECONDS, raising it to match', {
      maxRecordSeconds: config.maxRecordSeconds,
      recordSeconds: config.recordSeconds,
    });
    config.maxRecordSeconds = config.recordSeconds;
  }

  // An offset at or past the end of every recording would always miss and always
  // fall back to frame 0. Clamp rather than throw: the intent is clear, and a
  // thumbnail preference is not worth refusing to start over.
  if (config.thumbnailOffsetSeconds >= config.recordSeconds) {
    config.thumbnailOffsetSeconds = Math.max(0, Math.floor(config.recordSeconds / 2));
  }

  // A half-set credential pair is almost always a typo, and silently falling back
  // to no authentication would expose the footage without saying so.
  if (Boolean(config.webUsername) !== Boolean(config.webPassword)) {
    throw new Error(
      'WEB_USERNAME and WEB_PASSWORD must both be set, or both be empty for no authentication',
    );
  }

  return config;
};
