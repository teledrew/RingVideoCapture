/**
 * Ring doorbell event recorder.
 *
 * Subscribes to Ring push notifications for the configured cameras and records
 * video plus a snapshot to a local directory whenever motion is detected or the
 * doorbell is pressed.
 */

import { mkdir, access, stat, writeFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

import { RingApi } from 'ring-client-api';

import { loadConfig } from './config.js';
import { log } from './logger.js';
import { TokenStore } from './token-store.js';
import { EventRecorder } from './recorder.js';
import { startRetention } from './retention.js';
import { classifyNotification } from './notification.js';
import { startServer } from './server.js';

/**
 * Verifies the output directory exists and is genuinely writable, and reports
 * where the files will be visible from outside the container.
 *
 * An access() check alone is not enough: on a bind-mounted network share the
 * directory can look writable yet reject the first real write. Better to fail at
 * startup than to discover it when the first event arrives.
 */
const ensureOutputDir = async (config) => {
  const { outputDir, hostOutputPath, fileMode } = config;

  await mkdir(outputDir, { recursive: true });

  try {
    await access(outputDir, constants.W_OK);
  } catch {
    throw new Error(
      `Output directory ${outputDir} is not writable by uid ${process.getuid?.() ?? '?'}. ` +
        `Check the ownership of the mounted volume, or set PUID/PGID to match the ` +
        `host user that owns it.`,
    );
  }

  // Prove writability with an actual file, then clean up.
  const probePath = join(outputDir, '.write-probe');
  try {
    await writeFile(probePath, '');
    await unlink(probePath);
  } catch (error) {
    throw new Error(
      `Output directory ${outputDir} passed a permission check but rejected a test ` +
        `write (${error.message}). If this is a network share, confirm the mount is ` +
        `online and writable by uid ${process.getuid?.() ?? '?'}.`,
    );
  }

  const stats = await stat(outputDir);
  log.step('Recordings directory ready', {
    inContainer: outputDir,
    // Where the operator should look on the host, when they've told us.
    onHost: hostOutputPath || '(set HOST_OUTPUT_PATH to show this)',
    writableByUid: process.getuid?.() ?? 'n/a',
    dirOwnerUid: stats.uid,
    dirOwnerGid: stats.gid,
    newFileMode: `0${fileMode.toString(8)}`,
  });
};

const selectCameras = (allCameras, cameraNames) => {
  if (cameraNames.length === 0) {
    return allCameras;
  }

  const wanted = cameraNames.map((name) => name.toLowerCase());
  const selected = allCameras.filter((camera) => wanted.includes(camera.name.toLowerCase()));

  const missing = cameraNames.filter(
    (name) => !allCameras.some((camera) => camera.name.toLowerCase() === name.toLowerCase()),
  );
  if (missing.length > 0) {
    throw new Error(
      `CAMERA_NAMES refers to cameras that do not exist on this account: ${missing.join(', ')}. ` +
        `Available: ${allCameras.map((camera) => camera.name).join(', ') || '(none)'}`,
    );
  }

  return selected;
};

const main = async () => {
  const config = loadConfig();

  log.step('Starting ring-recorder', {
    outputDir: config.outputDir,
    recordSeconds: config.recordSeconds,
    ...(config.extendOnActivity
      ? {
          extendOnActivity: true,
          extendSeconds: config.extendSeconds,
          maxRecordSeconds: config.maxRecordSeconds,
        }
      : { extendOnActivity: false }),
    cooldownSeconds: config.cooldownSeconds,
    motion: config.recordMotion,
    ding: config.recordDing,
    snapshot: config.captureSnapshot,
  });

  await ensureOutputDir(config);

  const tokenStore = new TokenStore(config.tokenPath);
  // Checked up front: a token volume we cannot write to breaks push
  // notifications on the next restart, long after the cause would be visible.
  await tokenStore.verifyWritable();
  const refreshToken = tokenStore.read(config.seedRefreshToken);

  const ringApi = new RingApi({
    refreshToken,
    ffmpegPath: config.ffmpegPath,
    debug: config.debug,
    controlCenterDisplayName: 'ring-recorder',
    ...(config.locationIds.length > 0 ? { locationIds: config.locationIds } : {}),
  });

  // Must be registered before any request triggers a rotation. Ring rotates
  // refresh tokens roughly hourly and each one carries the FCM push
  // registration; losing one silently breaks all future event notifications.
  ringApi.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
    void tokenStore.write(newRefreshToken);
  });

  const allCameras = await ringApi.getCameras();
  if (allCameras.length === 0) {
    throw new Error('No cameras found on this Ring account');
  }

  log.substep('Discovered cameras', {
    cameras: allCameras.map((camera) => camera.name),
  });

  const cameras = selectCameras(allCameras, config.cameraNames);
  const recorder = new EventRecorder(config);
  const stopRetention = startRetention(config);
  const stopServer = config.webEnabled ? startServer(config) : null;

  for (const camera of cameras) {
    log.step('Monitoring camera', {
      camera: camera.name,
      id: camera.id,
      isDoorbell: camera.isDoorbot,
      battery: camera.batteryLevel ?? 'wired',
    });

    camera.onNewNotification.subscribe((notification) => {
      const event = classifyNotification(notification);
      if (!event) {
        return;
      }
      // A notification arriving while this camera is already recording is Ring
      // telling us the event is still going, so it extends the clip instead of
      // being discarded as a duplicate. This is the only end-of-event signal
      // available: Ring sends nothing to say the visitor has left.
      //
      // Checked before the RECORD_MOTION/RECORD_DING filters on purpose. Those
      // control what may *start* a recording; once one is running, any activity is
      // evidence someone is still there and worth keeping the camera rolling for.
      if (config.extendOnActivity && recorder.noteActivity(camera)) {
        log.substep('Still active, extending recording', {
          camera: camera.name,
          kind: event.kind,
          subtype: event.subtype,
        });
        return;
      }

      if (event.kind === 'motion' && !config.recordMotion) {
        return;
      }
      if (event.kind === 'ding' && !config.recordDing) {
        return;
      }

      log.step('Event received', {
        camera: camera.name,
        kind: event.kind,
        subtype: event.subtype,
      });

      // Not awaited: the notification handler must return promptly so further
      // events are still observed while this recording runs.
      void recorder.capture(camera, event);
    });
  }

  log.step('Listening for events. Press Ctrl+C to stop.');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    log.step('Shutting down', { signal });
    stopRetention();
    await stopServer?.();

    // Before waiting: a recording still being extended by ongoing activity would
    // otherwise outlast the wait below and be killed mid-write.
    recorder.stopExtending();

    // Long enough for a recording at the floor length to finish and be renamed
    // into place. The default 15s predates extendable recordings, when a clip was
    // always nearly done by the time a signal arrived.
    const idle = await recorder.waitForIdle((config.recordSeconds + 20) * 1000);
    if (!idle) {
      log.warn('Timed out waiting for in-flight recordings to finish');
    }

    ringApi.disconnect();
    // Ensure a token rotation received moments ago reaches disk.
    await tokenStore.flush();

    log.step('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

main().catch((error) => {
  log.error('Fatal error', { error: error.message });
  if (process.env.DEBUG === 'true') {
    console.error(error);
  }
  process.exit(1);
});
