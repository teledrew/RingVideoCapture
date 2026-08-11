/**
 * Persistence for the Ring refresh token.
 *
 * Ring rotates refresh tokens roughly hourly, and each rotation carries forward
 * the FCM push-registration data established on first connect. If a rotated
 * token is not persisted, the container will re-seed from the original token on
 * its next restart and push notifications (i.e. every motion and ding event)
 * will stop working permanently — recovering requires removing the device from
 * Ring Control Center and re-authenticating.
 *
 * See https://github.com/dgreif/ring/wiki/Refresh-Tokens#refresh-token-expiration
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chmod, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { log } from './logger.js';

const TOKEN_FILE_MODE = 0o600;

export class TokenStore {
  #path;
  // Serialises writes so two rapid rotations cannot interleave and leave a
  // truncated or stale token on disk.
  #pending = Promise.resolve();

  constructor(path) {
    this.#path = path;
  }

  /**
   * Returns the persisted token, falling back to the seed token from the
   * environment on first run.
   */
  read(seedToken) {
    const directory = dirname(this.#path);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }

    if (existsSync(this.#path)) {
      const stored = readFileSync(this.#path, 'utf8').trim();
      if (stored) {
        log.substep('Using refresh token from persisted store', { path: this.#path });
        return stored;
      }
      log.warn('Token file exists but is empty, falling back to RING_REFRESH_TOKEN', {
        path: this.#path,
      });
    }

    if (!seedToken) {
      throw new Error(
        `No refresh token available. Set RING_REFRESH_TOKEN for the first run ` +
          `(generate one with "npx -p ring-client-api ring-auth-cli"), or mount an ` +
          `existing token at ${this.#path}`,
      );
    }

    log.substep('No persisted token yet, seeding from RING_REFRESH_TOKEN');
    return seedToken;
  }

  /**
   * Verifies the token directory is writable before we depend on it.
   *
   * Without this check, a read-only or wrongly-owned token volume is only
   * discovered when Ring first rotates the token — up to an hour in, as a log
   * line that scrolls past. The app keeps working on its valid in-memory token,
   * then loses push notifications permanently at the next restart. Failing at
   * startup instead makes the misconfiguration impossible to miss.
   */
  async verifyWritable() {
    const probePath = `${this.#path}.probe`;
    try {
      await writeFile(probePath, '', { mode: TOKEN_FILE_MODE });
      await unlink(probePath);
    } catch (error) {
      throw new Error(
        `Token directory ${dirname(this.#path)} is not writable (${error.message}). ` +
          `Rotated refresh tokens could not be saved, which would permanently break ` +
          `push notifications after the next restart. Fix the volume ownership, or ` +
          `set PUID/PGID to match the host user that owns it.`,
      );
    }
  }

  /**
   * Writes a rotated token durably. Writes to a temp file then renames, so a
   * crash mid-write cannot leave a corrupt token that locks us out of the
   * account.
   */
  write(token) {
    this.#pending = this.#pending.then(async () => {
      const temporaryPath = `${this.#path}.tmp`;
      try {
        await writeFile(temporaryPath, `${token}\n`, { mode: TOKEN_FILE_MODE });
        await chmod(temporaryPath, TOKEN_FILE_MODE);
        await rename(temporaryPath, this.#path);
        log.substep('Persisted rotated refresh token', { path: this.#path });
      } catch (error) {
        // Deliberately loud: a silent failure here means push notifications
        // break on the next restart, long after the cause.
        log.error('FAILED to persist rotated refresh token — push notifications will break on restart', {
          path: this.#path,
          error: error.message,
        });
      }
    });

    return this.#pending;
  }

  /** Resolves once all queued writes have completed. */
  flush() {
    return this.#pending;
  }
}
