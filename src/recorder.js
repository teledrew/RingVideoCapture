/**
 * Captures video and a snapshot for a single camera event.
 *
 * Recordings are written to a `.part` file and renamed on success, so consumers
 * watching the output directory never pick up a half-written MP4, and a crashed
 * recording is distinguishable from a complete one.
 */

import { execFile } from 'node:child_process';
import { chmod, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { firstValueFrom } from 'rxjs';

import { log } from './logger.js';

// execFile, not exec: it takes an argument array and never invokes a shell, so a
// camera name that made it into a path cannot be interpreted as a command.
const run = promisify(execFile);

/** Filesystem-safe slug for use in filenames. */
const slugify = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'camera';

/** Local-time compact timestamp: 20260805-142530 */
const fileTimestamp = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
};

export class EventRecorder {
  #config;
  // camera id -> timestamp (ms) when that camera is eligible to record again.
  #cooldownUntil = new Map();
  // camera id -> in-flight recording state, holding the timestamp of the most
  // recent sign of activity. A camera supports only one live stream at a time,
  // so overlapping captures would fail.
  #inFlight = new Map();

  constructor(config) {
    this.#config = config;
  }

  /** True if this camera is within its cooldown window or already recording. */
  isSuppressed(camera, now = Date.now()) {
    if (this.#inFlight.has(camera.id)) {
      return { suppressed: true, reason: 'recording already in progress' };
    }

    const until = this.#cooldownUntil.get(camera.id) ?? 0;
    if (now < until) {
      const remaining = Math.ceil((until - now) / 1000);
      return { suppressed: true, reason: `cooldown active, ${remaining}s remaining` };
    }

    return { suppressed: false };
  }

  /**
   * Records a fresh sign of activity on a camera that is already recording.
   *
   * Ring keeps re-sending notifications for as long as it sees something, so a
   * repeat notification during a recording is the only evidence available that
   * whoever triggered it is still there. There is no "motion ended" event to wait
   * for — see the note on the extension logic below.
   *
   * @returns true if an in-flight recording was extended.
   */
  noteActivity(camera, now = Date.now()) {
    const state = this.#inFlight.get(camera.id);
    if (!state) {
      return false;
    }

    state.lastActivityAt = now;
    state.activityCount += 1;
    return true;
  }

  /**
   * Records video for an event, then optionally a snapshot.
   *
   * Resolves once capture finishes. Never rejects: a failed recording is logged
   * and swallowed so one bad event cannot take down the monitor.
   */
  async capture(camera, event) {
    const suppression = this.isSuppressed(camera);
    if (suppression.suppressed) {
      log.substep('Skipping event', {
        camera: camera.name,
        kind: event.kind,
        reason: suppression.reason,
      });
      return;
    }

    const state = { lastActivityAt: Date.now(), activityCount: 0 };
    this.#inFlight.set(camera.id, state);
    // Provisional cooldown, covering the shortest possible recording. Extended as
    // the recording runs and set properly once its real length is known: the clip
    // can now outlast this window, and a cooldown that expired mid-recording would
    // let the next notification start a second stream to the same camera.
    this.#cooldownUntil.set(
      camera.id,
      Date.now() + (this.#config.recordSeconds + this.#config.cooldownSeconds) * 1000,
    );

    const baseName = `${fileTimestamp(event.at)}_${slugify(camera.name)}_${event.kind}`;
    const videoPath = join(this.#config.outputDir, `${baseName}.mp4`);
    const partialPath = `${videoPath}.part`;
    // Set only once the recording is safely renamed into place, so the thumbnail
    // step below knows whether there is a video to take a frame from.
    let savedVideoPath = null;

    try {
      log.step('Recording', {
        camera: camera.name,
        kind: event.kind,
        subtype: event.subtype,
        seconds: this.#config.recordSeconds,
        file: `${baseName}.mp4`,
      });

      const startedAt = Date.now();

      // Not camera.recordToFile(): that infers the output container from the
      // file extension, and ours is `.part`, which ffmpeg does not recognise —
      // it refuses to open the output and exits without creating the file, so
      // the rename below fails with a misleading ENOENT. Drive streamVideo()
      // directly instead so `-f mp4` can state the format explicitly.
      // Fragmented MP4, not `+faststart`. A plain MP4 only becomes playable once
      // ffmpeg writes the moov atom, which it does on the way out — so anything
      // that stops it short leaves ftyp/mdat with no moov, and every player
      // rejects that. `+frag_keyframe+empty_moov` writes a minimal moov up front
      // and self-contained fragments as it goes, so whatever reached disk stays
      // playable however the stream ends: a dropped call, a killed container, a
      // NAS running out of space.
      // `-t` is the hard ceiling, not the target length. ffmpeg is told to run for
      // up to maxRecordSeconds and the call is stopped early once activity has
      // died down, because ffmpeg's own duration limit cannot be changed once the
      // process has started.
      const liveCall = await camera.streamVideo({
        output: [
          '-t',
          String(this.#config.extendOnActivity ? this.#config.maxRecordSeconds : this.#config.recordSeconds),
          '-f',
          'mp4',
          '-movflags',
          '+frag_keyframe+empty_moov+default_base_moof',
          partialPath,
        ],
      });

      if (this.#config.extendOnActivity) {
        await this.#superviseRecording(camera, liveCall, state, startedAt);
      }

      await firstValueFrom(liveCall.onCallEnded);

      // onCallEnded fires when the *Ring call* drops, which is when camera-utils
      // signals ffmpeg — not when ffmpeg has flushed its trailer and exited. The
      // library exposes no hook for that (it claims exitCallback for its own
      // bookkeeping), so wait for the file to stop growing before touching it.
      await this.#waitForOutput(partialPath);

      // ffmpeg creates the file itself, subject to the process umask, so set the
      // mode explicitly to keep recordings readable from the host.
      await this.#applyFileMode(partialPath);
      await rename(partialPath, videoPath);
      savedVideoPath = videoPath;

      log.step('Recording complete', {
        camera: camera.name,
        file: `${baseName}.mp4`,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        // How many repeat notifications arrived while recording, i.e. how much of
        // the clip length was earned by continued activity rather than the floor.
        ...(this.#config.extendOnActivity ? { extendedBy: state.activityCount } : {}),
      });
    } catch (error) {
      log.error('Recording failed', {
        camera: camera.name,
        kind: event.kind,
        error: error.message,
      });
      // Keep a partial recording rather than destroy it: fragmented MP4 stays
      // playable when truncated, so some footage of the event beats none. Only
      // an empty file is worth removing.
      const orphanSize = await stat(partialPath)
        .then((s) => s.size)
        .catch(() => 0);
      if (orphanSize > 0) {
        log.warn('Keeping partial recording', {
          file: `${baseName}.mp4.part`,
          bytes: orphanSize,
        });
      } else {
        await unlink(partialPath).catch(() => {});
      }
    } finally {
      // Thumbnail last, and on both paths. A Doorbell Gen 2 cannot capture a
      // snapshot while streaming — attempting it first (or concurrently) blocks
      // for the full 15-second refresh timeout and delays the recording, which
      // is the artefact that actually matters. Once the video exists a frame from
      // it is the better thumbnail anyway; the camera snapshot is now only the
      // fallback for when there is no video.
      if (this.#config.captureSnapshot) {
        await this.#captureSnapshot(
          camera,
          join(this.#config.outputDir, `${baseName}.jpg`),
          savedVideoPath,
        );
      }

      // Start the real cooldown from the end of the recording. Doing it here rather
      // than up front matters now that clips have no fixed length: the window has
      // to begin once the camera is actually free.
      this.#cooldownUntil.set(camera.id, Date.now() + this.#config.cooldownSeconds * 1000);
      this.#inFlight.delete(camera.id);
    }
  }

  /**
   * Runs the recording for as long as the event lasts, then stops the call.
   *
   * Ring provides no "motion ended" or "visitor left" signal. What it does provide
   * is a repeat push notification every few seconds for as long as it still sees
   * activity, so continued notifications stand in for continued presence, and their
   * absence for the event being over. `noteActivity()` timestamps each one.
   *
   * The recording therefore runs until recordSeconds has elapsed AND nothing has
   * been reported for extendSeconds, with maxRecordSeconds as a hard stop. Stopping
   * the call is what ends the recording: ffmpeg's `-t` was set to the ceiling up
   * front and cannot be shortened afterwards.
   *
   * Returns once the call has been asked to stop, or immediately if it ends on its
   * own first — a dropped stream, or ffmpeg hitting the ceiling.
   */
  async #superviseRecording(camera, liveCall, state, startedAt) {
    const { recordSeconds, extendSeconds, maxRecordSeconds } = this.#config;
    let callEnded = false;
    const subscription = liveCall.onCallEnded.subscribe(() => {
      callEnded = true;
    });

    try {
      while (!callEnded) {
        const now = Date.now();
        const elapsed = (now - startedAt) / 1000;
        const quietFor = (now - state.lastActivityAt) / 1000;

        if (elapsed >= maxRecordSeconds) {
          log.substep('Reached maximum recording length, stopping', {
            camera: camera.name,
            seconds: Math.round(elapsed),
            stillActive: quietFor < extendSeconds,
          });
          liveCall.stop();
          return;
        }

        // Shutting down: stop at the floor rather than following the visitor, so
        // the process can exit with a complete clip instead of being killed
        // part-way through writing one.
        if (this.#extendingStopped && elapsed >= recordSeconds) {
          log.substep('Shutting down, stopping recording at minimum length', {
            camera: camera.name,
            seconds: Math.round(elapsed),
          });
          liveCall.stop();
          return;
        }

        if (elapsed >= recordSeconds && quietFor >= extendSeconds) {
          log.substep('Activity ended, stopping recording', {
            camera: camera.name,
            seconds: Math.round(elapsed),
            quietForSeconds: Math.round(quietFor),
            extraNotifications: state.activityCount,
          });
          liveCall.stop();
          return;
        }

        // No cooldown bookkeeping here: isSuppressed() checks #inFlight before it
        // looks at the cooldown, and #inFlight covers the whole of capture(), so
        // the cooldown cannot be consulted while this loop is running. The window
        // that matters is set once the recording ends, in capture()'s finally.
        await sleep(1000);
      }
    } finally {
      subscription.unsubscribe();
    }
  }

  /**
   * Waits for ffmpeg to finish writing the output file.
   *
   * Two things have to happen after the Ring call ends: the file has to appear
   * at all, and ffmpeg has to finish flushing into it. Polling for a stable size
   * covers both without a fixed sleep that would be either too short on a busy
   * NAS or wasted time on an idle one.
   *
   * Throws if the file never appears, which is a real failure worth reporting —
   * previously it surfaced as a confusing ENOENT from chmod/rename instead.
   */
  async #waitForOutput(path, { timeoutMs = 15000, stableMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastSize = -1;
    let stableSince = null;

    while (Date.now() < deadline) {
      let size = null;
      try {
        ({ size } = await stat(path));
      } catch {
        // Not created yet: ffmpeg opens the output only once the first frames
        // arrive. Keep waiting until the deadline.
      }

      if (size !== null) {
        if (size === lastSize && size > 0) {
          stableSince ??= Date.now();
          if (Date.now() - stableSince >= stableMs) {
            return;
          }
        } else {
          stableSince = null;
          lastSize = size;
        }
      }

      await sleep(100);
    }

    if (lastSize <= 0) {
      throw new Error(
        `ffmpeg produced no output at ${path} within ${timeoutMs}ms — the live ` +
          `stream may have failed to negotiate, or ffmpeg rejected its arguments`,
      );
    }
    log.warn('Output still growing at timeout, using it anyway', { path, bytes: lastSize });
  }

  /**
   * Applies the configured mode so recordings are readable from the host.
   * Non-fatal: on filesystems that don't support chmod (e.g. some CIFS mounts)
   * the recording is still valid.
   */
  async #applyFileMode(path) {
    try {
      await chmod(path, this.#config.fileMode);
    } catch (error) {
      log.warn('Could not set file permissions', { path, error: error.message });
    }
  }

  /**
   * Extracts a still from the recording itself, for use as the thumbnail.
   *
   * Preferred over camera.getSnapshot() because it is a frame of *the event*.
   * getSnapshot() runs after the stream has ended, so it shows whatever the camera
   * sees once everything is over — usually an empty doorstep, which is exactly the
   * moment nobody wants a picture of.
   *
   * Not frame 0: the first moments of a Ring stream are typically a grey or
   * half-decoded keyframe while the encoder settles. Seeking a little way in gives
   * a clean frame that still shows what triggered the event. Falls back to the
   * first available frame on a clip too short to seek into.
   */
  async #extractThumbnail(videoPath, snapshotPath) {
    const offsets = [this.#config.thumbnailOffsetSeconds, 0];

    for (const offset of offsets) {
      try {
        // -ss before -i seeks by container index rather than decoding forward to
        // the timestamp, which keeps this fast on a NAS.
        await run(
          this.#config.ffmpegPath,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-ss',
            String(offset),
            '-i',
            videoPath,
            '-frames:v',
            '1',
            '-q:v',
            '3',
            snapshotPath,
          ],
          // A still frame is near-instant; anything slower means ffmpeg is stuck
          // on a corrupt file and should be abandoned rather than left running.
          { timeout: 20000 },
        );

        const { size } = await stat(snapshotPath);
        if (size === 0) {
          // ffmpeg can exit 0 having created an empty file when the seek lands
          // past the end of a short clip. Treat that as a failure so the next
          // offset is tried.
          throw new Error('ffmpeg wrote an empty file');
        }

        await this.#applyFileMode(snapshotPath);
        log.substep('Saved thumbnail from recording', {
          file: snapshotPath.slice(snapshotPath.lastIndexOf('/') + 1),
          atSeconds: offset,
          bytes: size,
        });
        return true;
      } catch (error) {
        // Not a warning on the first pass: falling back to offset 0 is expected on
        // a clip shorter than the offset, and a noisy log for a handled case
        // trains you to ignore it. ffmpeg's stderr runs to a dozen lines, so keep
        // only the last, which is the one that says what actually went wrong.
        const reason = (error.stderr || error.message)
          .trim()
          .split('\n')
          .filter(Boolean)
          .at(-1);
        log.substep('Could not extract frame', { atSeconds: offset, reason });
        // Do not leave a zero-byte JPEG behind for the next attempt or the web UI
        // to find.
        await unlink(snapshotPath).catch(() => {});
      }
    }

    return false;
  }

  /**
   * Saves the event thumbnail.
   *
   * Prefers a frame from the recording, falling back to the camera's own snapshot
   * when there is no video to take one from (a failed stream) or extraction fails.
   * The fallback is worth keeping: on a failed recording it is the only trace that
   * something happened.
   */
  async #captureSnapshot(camera, snapshotPath, videoPath = null) {
    if (videoPath && (await this.#extractThumbnail(videoPath, snapshotPath))) {
      return;
    }

    try {
      const image = await camera.getSnapshot();
      await writeFile(snapshotPath, image, { mode: this.#config.fileMode });
      await this.#applyFileMode(snapshotPath);
      log.substep('Saved snapshot from camera', { camera: camera.name, bytes: image.length });
    } catch (error) {
      // Snapshots may be blocked by modes/schedules, and battery cameras cannot
      // produce one while a stream is still winding down. Never fatal — this
      // runs after the recording, so the video is already safely on disk.
      log.warn('Snapshot failed', {
        camera: camera.name,
        error: error.message,
      });
    }
  }

  /**
   * Stops extending in-flight recordings, so they wind down at their next check.
   *
   * Called on shutdown: without it a recording being held open by a visitor who is
   * still there would keep extending while the process is trying to exit, until the
   * shutdown timeout gave up and the container was killed mid-write.
   */
  stopExtending() {
    this.#extendingStopped = true;
  }

  #extendingStopped = false;

  /** Resolves once any in-flight recordings have finished, up to a timeout. */
  async waitForIdle(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (this.#inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return this.#inFlight.size === 0;
  }
}
