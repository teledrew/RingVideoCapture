/**
 * Tests for the logic that can be exercised without a live Ring account:
 * config validation, notification classification, retention pruning and token
 * persistence.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, stat, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReplaySubject } from 'rxjs';

import { loadConfig } from '../src/config.js';
import { TokenStore } from '../src/token-store.js';
import { prune } from '../src/retention.js';
import { classifyNotification } from '../src/notification.js';
import { FILENAME_PATTERN, eventTime, relativeTime } from '../src/server.js';
import { EventRecorder } from '../src/recorder.js';

const scratchDir = () => mkdtemp(join(tmpdir(), 'ring-recorder-test-'));

describe('loadConfig', () => {
  it('applies defaults when the environment is empty', () => {
    const config = loadConfig({});
    assert.equal(config.recordSeconds, 30);
    assert.equal(config.cooldownSeconds, 60);
    assert.equal(config.retentionDays, 14);
    assert.equal(config.captureSnapshot, true);
    assert.deepEqual(config.cameraNames, []);
  });

  it('parses camera names into a trimmed list', () => {
    const config = loadConfig({ CAMERA_NAMES: 'Front Door, Back Gate ,' });
    assert.deepEqual(config.cameraNames, ['Front Door', 'Back Gate']);
  });

  it('rejects a non-integer duration', () => {
    assert.throws(() => loadConfig({ RECORD_SECONDS: '12.5' }), /must be an integer/);
  });

  it('rejects a duration outside the allowed range', () => {
    assert.throws(() => loadConfig({ RECORD_SECONDS: '9000' }), /must be between 5 and 300/);
  });

  it('rejects an unparseable boolean', () => {
    assert.throws(() => loadConfig({ CAPTURE_SNAPSHOT: 'maybe' }), /must be a boolean/);
  });

  it('rejects a configuration that could never record anything', () => {
    assert.throws(
      () => loadConfig({ RECORD_MOTION: 'false', RECORD_DING: 'false' }),
      /nothing would ever be recorded/,
    );
  });

  it('accepts 0 to disable retention limits', () => {
    const config = loadConfig({ RETENTION_DAYS: '0', RETENTION_MAX_GB: '0' });
    assert.equal(config.retentionDays, 0);
    assert.equal(config.retentionMaxGb, 0);
  });

  it('defaults new files to 0644 so the host can read them', () => {
    assert.equal(loadConfig({}).fileMode, 0o644);
  });

  it('parses an octal file mode with or without a leading zero', () => {
    assert.equal(loadConfig({ FILE_MODE: '600' }).fileMode, 0o600);
    assert.equal(loadConfig({ FILE_MODE: '0640' }).fileMode, 0o640);
  });

  it('rejects a file mode that is not valid octal', () => {
    assert.throws(() => loadConfig({ FILE_MODE: '999' }), /3-digit octal/);
    assert.throws(() => loadConfig({ FILE_MODE: 'rw-' }), /3-digit octal/);
  });

  it('exposes the host output path for logging when provided', () => {
    assert.equal(loadConfig({ HOST_OUTPUT_PATH: '/volume1/ring/recordings' }).hostOutputPath,
      '/volume1/ring/recordings');
    assert.equal(loadConfig({}).hostOutputPath, '');
  });
});

describe('classifyNotification', () => {
  const notification = ({ category, subtype }) => ({
    android_config: { category },
    data: {
      event: {
        ding: { id: 'ding-1', created_at: '2026-08-05T14:25:30.000Z', subtype },
      },
    },
  });

  it('classifies a doorbell press', () => {
    const event = classifyNotification(
      notification({ category: 'com.ring.pn.live-event.ding', subtype: 'ding' }),
    );
    assert.equal(event.kind, 'ding');
    assert.equal(event.dingId, 'ding-1');
  });

  it('classifies motion', () => {
    const event = classifyNotification(
      notification({ category: 'com.ring.pn.live-event.motion', subtype: 'motion' }),
    );
    assert.equal(event.kind, 'motion');
  });

  it('uses the ding created_at as the event time', () => {
    const event = classifyNotification(
      notification({ category: 'com.ring.pn.live-event.motion', subtype: 'motion' }),
    );
    assert.equal(event.at.toISOString(), '2026-08-05T14:25:30.000Z');
  });

  it('falls back to subtype when the category is unrecognised', () => {
    const event = classifyNotification(
      notification({ category: 'com.ring.pn.something-new', subtype: 'human' }),
    );
    assert.equal(event.kind, 'motion');
  });

  it('ignores non-camera notifications', () => {
    assert.equal(
      classifyNotification({
        android_config: { category: 'com.ring.push.HANDLE_NEW_USER_SOUND_SIREN' },
        data: {},
      }),
      null,
    );
  });

  it('ignores malformed notifications without throwing', () => {
    assert.equal(classifyNotification({}), null);
    assert.equal(classifyNotification(null), null);
  });
});

describe('TokenStore', () => {
  it('falls back to the seed token on first run', async () => {
    const directory = await scratchDir();
    const store = new TokenStore(join(directory, 'refresh-token'));
    assert.equal(store.read('seed-token'), 'seed-token');
  });

  it('throws a helpful error when no token is available at all', async () => {
    const directory = await scratchDir();
    const store = new TokenStore(join(directory, 'refresh-token'));
    assert.throws(() => store.read(''), /No refresh token available/);
  });

  it('prefers the persisted token over the seed token', async () => {
    const directory = await scratchDir();
    const path = join(directory, 'refresh-token');
    const store = new TokenStore(path);

    await store.write('rotated-token');
    await store.flush();

    assert.equal(new TokenStore(path).read('seed-token'), 'rotated-token');
  });

  it('writes the token file with owner-only permissions', async () => {
    const directory = await scratchDir();
    const path = join(directory, 'refresh-token');
    const store = new TokenStore(path);

    await store.write('secret-token');
    await store.flush();

    const stats = await stat(path);
    assert.equal(stats.mode & 0o777, 0o600);
  });

  it('leaves no temp file behind after a write', async () => {
    const directory = await scratchDir();
    const store = new TokenStore(join(directory, 'refresh-token'));

    await store.write('token');
    await store.flush();

    const entries = await readdir(directory);
    assert.deepEqual(entries, ['refresh-token']);
  });

  it('serialises rapid rotations so the last one wins', async () => {
    const directory = await scratchDir();
    const path = join(directory, 'refresh-token');
    const store = new TokenStore(path);

    store.write('first');
    store.write('second');
    await store.write('third');
    await store.flush();

    assert.equal((await readFile(path, 'utf8')).trim(), 'third');
  });

  it('ignores an empty persisted file and uses the seed token', async () => {
    const directory = await scratchDir();
    const path = join(directory, 'refresh-token');
    await writeFile(path, '   \n');

    assert.equal(new TokenStore(path).read('seed-token'), 'seed-token');
  });

  it('verifyWritable passes for a writable directory and leaves no probe file', async () => {
    const directory = await scratchDir();
    const store = new TokenStore(join(directory, 'refresh-token'));

    await store.verifyWritable();

    assert.deepEqual(await readdir(directory), []);
  });

  it('verifyWritable fails loudly for an unwritable directory', async () => {
    const directory = await scratchDir();
    const locked = join(directory, 'locked');
    await mkdir(locked, { mode: 0o500 });

    const store = new TokenStore(join(locked, 'refresh-token'));
    await assert.rejects(
      () => store.verifyWritable(),
      /not writable.*permanently break push notifications/s,
    );
  });
});

describe('prune', () => {
  const ageInDays = (days) => Date.now() - days * 24 * 60 * 60 * 1000;

  /** Creates a file of a given size with a specific mtime. */
  const makeRecording = async (directory, name, bytes, ageDays) => {
    const path = join(directory, name);
    await writeFile(path, Buffer.alloc(bytes));
    const when = new Date(ageInDays(ageDays));
    await utimes(path, when, when);
    return path;
  };

  it('deletes recordings older than the age limit', async () => {
    const outputDir = await scratchDir();
    await makeRecording(outputDir, 'old.mp4', 100, 30);
    await makeRecording(outputDir, 'fresh.mp4', 100, 1);

    await prune({ outputDir, retentionDays: 14, retentionMaxGb: 0 });

    assert.deepEqual((await readdir(outputDir)).sort(), ['fresh.mp4']);
  });

  it('keeps everything when both limits are disabled', async () => {
    const outputDir = await scratchDir();
    await makeRecording(outputDir, 'ancient.mp4', 100, 4000);

    await prune({ outputDir, retentionDays: 0, retentionMaxGb: 0 });

    assert.deepEqual(await readdir(outputDir), ['ancient.mp4']);
  });

  it('deletes oldest-first when over the size limit', async () => {
    const outputDir = await scratchDir();
    await makeRecording(outputDir, 'a-oldest.mp4', 1000, 3);
    await makeRecording(outputDir, 'b-middle.mp4', 1000, 2);
    await makeRecording(outputDir, 'c-newest.mp4', 1000, 1);

    // Cap at 2500 bytes: the two newest (2000 bytes) fit, the oldest must go.
    await prune({ outputDir, retentionDays: 0, retentionMaxBytes: 2500 });

    assert.deepEqual((await readdir(outputDir)).sort(), ['b-middle.mp4', 'c-newest.mp4']);
  });

  it('does not double-count files already doomed by age', async () => {
    const outputDir = await scratchDir();
    // The old file alone frees enough space, so the newest must survive.
    await makeRecording(outputDir, 'old.mp4', 2000, 30);
    await makeRecording(outputDir, 'fresh.mp4', 1000, 1);

    await prune({ outputDir, retentionDays: 14, retentionMaxBytes: 1500 });

    assert.deepEqual(await readdir(outputDir), ['fresh.mp4']);
  });

  it('keeps everything when already under the size limit', async () => {
    const outputDir = await scratchDir();
    await makeRecording(outputDir, 'a.mp4', 100, 2);
    await makeRecording(outputDir, 'b.mp4', 100, 1);

    await prune({ outputDir, retentionDays: 0, retentionMaxBytes: 10_000 });

    assert.deepEqual((await readdir(outputDir)).sort(), ['a.mp4', 'b.mp4']);
  });

  it('ignores files it does not manage', async () => {
    const outputDir = await scratchDir();
    await makeRecording(outputDir, 'notes.txt', 100, 900);
    await makeRecording(outputDir, 'old.mp4', 100, 900);

    await prune({ outputDir, retentionDays: 1, retentionMaxGb: 0 });

    assert.deepEqual(await readdir(outputDir), ['notes.txt']);
  });

  it('cleans up abandoned .part files by age', async () => {
    const outputDir = await scratchDir();
    await makeRecording(outputDir, 'crashed.mp4.part', 100, 30);

    await prune({ outputDir, retentionDays: 14, retentionMaxGb: 0 });

    assert.deepEqual(await readdir(outputDir), []);
  });

  it('does not throw when the output directory is missing', async () => {
    await prune({
      outputDir: join(tmpdir(), 'ring-recorder-does-not-exist'),
      retentionDays: 1,
      retentionMaxGb: 1,
    });
  });
});

describe('web server filename guard', () => {
  // The traversal guard is the pattern itself: every request path is reduced to a
  // basename and then matched against it, so anything it rejects can never reach
  // the filesystem. Asserted directly rather than only over HTTP, where a proxy
  // might normalise a path before the server sees it.
  it('rejects anything that is not a finished recording', () => {
    for (const bad of [
      '../../etc/passwd',
      'refresh-token',
      'refresh-token\u0000.mp4',
      '20260810-142548_front-door_motion.mp4.part',
      '20260810-142548_front-door_motion.exe',
      'not-a-timestamp_front-door_motion.mp4',
      '20260810-142548_front-door_other.mp4',
      '',
    ]) {
      assert.equal(FILENAME_PATTERN.test(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it('accepts the exact names the recorder produces', () => {
    for (const good of [
      '20260810-142548_front-door_motion.mp4',
      '20260810-142548_front-door_ding.jpg',
      '20260810-000000_back-gate-2_motion.mp4',
    ]) {
      assert.equal(FILENAME_PATTERN.test(good), true, `should accept ${good}`);
    }
  });
});

describe('TV view timestamps', () => {
  // The TV view leads with "how long ago", so these boundaries are the feature.
  // Flooring rather than rounding is what stops 119 seconds rendering as the
  // impossible "60 min ago" once it crosses into minutes.
  it('describes elapsed time in units worth reading across a room', () => {
    const at = eventTime('20260810-120000');
    const after = (seconds) => relativeTime(at, at.getTime() + seconds * 1000);

    assert.equal(after(0), 'just now');
    assert.equal(after(89), 'just now');
    assert.equal(after(90), '1 min ago');
    assert.equal(after(119), '1 min ago');
    assert.equal(after(120), '2 min ago');
    assert.equal(after(59 * 60 + 59), '59 min ago');
    assert.equal(after(60 * 60), '1 hour ago');
    assert.equal(after(2 * 60 * 60), '2 hours ago');
    assert.equal(after(23 * 60 * 60), '23 hours ago');
    assert.equal(after(24 * 60 * 60), 'yesterday');
    assert.equal(after(47 * 60 * 60), 'yesterday');
    assert.equal(after(48 * 60 * 60), '2 days ago');
  });

  // A viewer whose clock is ahead of the container would otherwise get "-3 min
  // ago", which reads as a bug to anyone looking at the screen.
  it('does not render a negative age when the clock is ahead', () => {
    const at = eventTime('20260810-120000');
    assert.equal(relativeTime(at, at.getTime() - 60 * 1000), 'just now');
  });

  it('reads the filename stamp as local time', () => {
    const at = eventTime('20260810-142548');
    assert.equal(at.getFullYear(), 2026);
    assert.equal(at.getMonth(), 7); // zero-based: August
    assert.equal(at.getDate(), 10);
    assert.equal(at.getHours(), 14);
    assert.equal(at.getMinutes(), 25);
    assert.equal(at.getSeconds(), 48);
  });
});

describe('activity-based recording extension', () => {
  /**
   * A camera stand-in whose stream ends only when stopped or when ffmpeg's own
   * `-t` ceiling elapses. ReplaySubject, not Subject, to match the real
   * StreamingSession.onCallEnded — with a plain Subject the recorder's
   * firstValueFrom() misses an emission that has already happened and rejects
   * with "no elements in sequence".
   */
  const fakeCamera = (id = 1, { ignoreDurationLimit = false } = {}) => {
    const ended = new ReplaySubject(1);
    const calls = [];
    let endedBy = null;
    return {
      calls,
      stoppedBy: () => endedBy,
      camera: {
        id,
        name: 'Front Door',
        async streamVideo({ output }) {
          const path = output.at(-1);
          const durationLimit = Number(output[output.indexOf('-t') + 1]);
          calls.push({ durationLimit });
          await writeFile(path, 'video');
          // Stands in for ffmpeg exiting when its own `-t` elapses.
          const ffmpegExit = ignoreDurationLimit
            ? null
            : setTimeout(() => {
                endedBy ??= 'ffmpeg-t';
                ended.next(endedBy);
                ended.complete();
              }, durationLimit * 1000);
          return {
            onCallEnded: ended,
            stop() {
              if (ffmpegExit) {
                clearTimeout(ffmpegExit);
              }
              endedBy ??= 'stopped';
              ended.next(endedBy);
              ended.complete();
            },
          };
        },
        async getSnapshot() {
          return Buffer.from('jpeg');
        },
      },
    };
  };

  const baseEnv = (overrides) => ({
    RING_REFRESH_TOKEN: 'seed',
    CAPTURE_SNAPSHOT: 'false',
    RECORD_SECONDS: '5',
    EXTEND_SECONDS: '5',
    ...overrides,
  });

  it('extends the recording while activity keeps being reported', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'ring-extend-'));
    const config = loadConfig(baseEnv({ OUTPUT_DIR: outputDir, MAX_RECORD_SECONDS: '60' }));
    const recorder = new EventRecorder(config);
    const { camera } = fakeCamera();

    // Two reports after the 5s floor, so the clip cannot stop before ~11s: the
    // last is at 8s and the quiet period is 5s.
    for (const seconds of [3, 6, 8]) {
      setTimeout(() => recorder.noteActivity(camera), seconds * 1000);
    }

    const startedAt = Date.now();
    await recorder.capture(camera, { kind: 'motion', subtype: 'motion', at: new Date() });
    const elapsed = (Date.now() - startedAt) / 1000;

    assert.ok(elapsed > 11, `expected the clip to outlast the 5s floor, got ${elapsed}s`);
    assert.ok(elapsed < 20, `expected it to stop once quiet, got ${elapsed}s`);
  });

  it('stops at the floor when nothing further is reported', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'ring-extend-'));
    const config = loadConfig(baseEnv({ OUTPUT_DIR: outputDir, MAX_RECORD_SECONDS: '60' }));
    const recorder = new EventRecorder(config);
    const { camera } = fakeCamera();

    const startedAt = Date.now();
    await recorder.capture(camera, { kind: 'ding', subtype: 'ding', at: new Date() });
    const elapsed = (Date.now() - startedAt) / 1000;

    // Never approaches the 60s ceiling: a single event must not hold the camera.
    assert.ok(elapsed < 9, `expected a floor-length clip, got ${elapsed}s`);
  });

  // Bounded explicitly: nothing else can end this call, so a recorder that fails
  // to enforce its own ceiling would hang here rather than fail, and a hung suite
  // is far harder to diagnose than a failing assertion.
  it('stops at the ceiling however long activity continues', { timeout: 30000 }, async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'ring-extend-'));
    const config = loadConfig(baseEnv({ OUTPUT_DIR: outputDir, MAX_RECORD_SECONDS: '8' }));
    const recorder = new EventRecorder(config);
    // ignoreDurationLimit: the fake never ends the call on its own, so only the
    // recorder's own ceiling check can stop this. Otherwise ffmpeg's `-t` — set to
    // the same ceiling — ends it regardless and the test passes even if the
    // recorder's enforcement is deleted entirely.
    const { camera, stoppedBy } = fakeCamera(1, { ignoreDurationLimit: true });

    const ticker = setInterval(() => recorder.noteActivity(camera), 1000);
    const startedAt = Date.now();
    try {
      await recorder.capture(camera, { kind: 'motion', subtype: 'motion', at: new Date() });
    } finally {
      clearInterval(ticker);
    }
    const elapsed = (Date.now() - startedAt) / 1000;

    assert.equal(stoppedBy(), 'stopped', 'the recorder did not stop the call itself');
    assert.ok(elapsed < 13, `expected the ceiling to cut it off, got ${elapsed}s`);
  });

  it('passes the ceiling to ffmpeg as its duration limit, not the floor', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'ring-extend-'));
    const config = loadConfig(baseEnv({ OUTPUT_DIR: outputDir, MAX_RECORD_SECONDS: '90' }));
    const recorder = new EventRecorder(config);
    const { camera, calls } = fakeCamera();

    await recorder.capture(camera, { kind: 'ding', subtype: 'ding', at: new Date() });

    // ffmpeg's -t cannot be changed once started, so it has to be the ceiling and
    // the recorder has to end the call itself. If this ever reads 5, extension is
    // silently capped at the floor.
    assert.equal(calls[0].durationLimit, 90);
  });

  it('records a fixed length when extension is disabled', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'ring-extend-'));
    const config = loadConfig(
      baseEnv({ OUTPUT_DIR: outputDir, EXTEND_ON_ACTIVITY: 'false', MAX_RECORD_SECONDS: '90' }),
    );
    const recorder = new EventRecorder(config);
    const { camera, calls } = fakeCamera();

    assert.equal(calls.length, 0);
    const startedAt = Date.now();
    await recorder.capture(camera, { kind: 'ding', subtype: 'ding', at: new Date() });

    assert.equal(calls[0].durationLimit, 5);
    assert.ok((Date.now() - startedAt) / 1000 < 9);
  });

  it('reports no extension for a camera that is not recording', () => {
    const recorder = new EventRecorder(loadConfig({ RING_REFRESH_TOKEN: 'seed' }));
    // The main loop uses this to decide between extending and starting a capture;
    // a false positive here would drop the event entirely.
    assert.equal(recorder.noteActivity({ id: 7, name: 'Front Door' }), false);
  });

  it('keeps the camera suppressed for the whole of an extended recording', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'ring-extend-'));
    const config = loadConfig(
      baseEnv({ OUTPUT_DIR: outputDir, MAX_RECORD_SECONDS: '60', COOLDOWN_SECONDS: '1' }),
    );
    const recorder = new EventRecorder(config);
    const { camera } = fakeCamera();

    for (const seconds of [3, 6, 8]) {
      setTimeout(() => recorder.noteActivity(camera), seconds * 1000);
    }
    // Sampled into a variable rather than asserted inside the timer: an assertion
    // that throws in a fire-and-forget callback surfaces as an unhandled error
    // rather than a failing test, which can be reported against whichever test
    // happens to be running.
    let midRecording = null;
    setTimeout(() => {
      // Past RECORD_SECONDS + COOLDOWN_SECONDS (6s), where a cooldown pinned to
      // the floor length would have lapsed and admitted a second stream to a
      // camera that only supports one.
      midRecording = recorder.isSuppressed(camera);
    }, 7000);

    await recorder.capture(camera, { kind: 'motion', subtype: 'motion', at: new Date() });

    assert.equal(midRecording?.suppressed, true, 'camera became eligible mid-recording');
  });

  it('winds down to the floor length on shutdown', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'ring-extend-'));
    const config = loadConfig(baseEnv({ OUTPUT_DIR: outputDir, MAX_RECORD_SECONDS: '120' }));
    const recorder = new EventRecorder(config);
    const { camera } = fakeCamera();

    // Activity that never stops: without stopExtending() this runs to the 120s
    // ceiling and the container is killed mid-write long before that.
    const ticker = setInterval(() => recorder.noteActivity(camera), 1000);
    setTimeout(() => recorder.stopExtending(), 6000);

    const startedAt = Date.now();
    try {
      await recorder.capture(camera, { kind: 'motion', subtype: 'motion', at: new Date() });
    } finally {
      clearInterval(ticker);
    }
    const elapsed = (Date.now() - startedAt) / 1000;

    assert.ok(elapsed < 12, `expected a prompt wind-down, got ${elapsed}s`);
  });

  it('raises a ceiling set below the floor rather than refusing to start', () => {
    const config = loadConfig({
      RING_REFRESH_TOKEN: 'seed',
      RECORD_SECONDS: '60',
      MAX_RECORD_SECONDS: '30',
    });
    assert.equal(config.maxRecordSeconds, 60);
  });
});
