/**
 * Prunes old recordings so an unattended container cannot fill the host disk.
 *
 * Two independent limits, both applied on every pass:
 *   - age:  delete anything older than RETENTION_DAYS
 *   - size: delete oldest-first until the directory is under RETENTION_MAX_GB
 *
 * Either limit can be disabled by setting it to 0.
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { log } from './logger.js';

const BYTES_PER_GB = 1024 ** 3;
const MANAGED_EXTENSIONS = ['.mp4', '.jpg', '.part'];

const isManaged = (name) =>
  MANAGED_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));

/** Lists managed files with their size and mtime, oldest first. */
const listRecordings = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile() || !isManaged(entry.name)) {
      continue;
    }

    const path = join(directory, entry.name);
    try {
      const stats = await stat(path);
      files.push({ path, name: entry.name, bytes: stats.size, modifiedMs: stats.mtimeMs });
    } catch (error) {
      // File may have been removed between readdir and stat; harmless.
      if (error.code !== 'ENOENT') {
        log.warn('Could not stat recording during prune', {
          file: entry.name,
          error: error.message,
        });
      }
    }
  }

  return files.sort((a, b) => a.modifiedMs - b.modifiedMs);
};

/**
 * Runs one prune pass. Never throws — retention problems must not kill the
 * monitor, which is the primary function of the app.
 */
export const prune = async ({
  outputDir,
  retentionDays,
  retentionMaxGb,
  // Byte-level override for the size cap. Only used by tests, which cannot
  // express a meaningful limit in whole gigabytes.
  retentionMaxBytes = retentionMaxGb * BYTES_PER_GB,
}) => {
  if (retentionDays === 0 && retentionMaxBytes === 0) {
    return;
  }

  try {
    const files = await listRecordings(outputDir);
    if (files.length === 0) {
      return;
    }

    const doomed = new Map();

    if (retentionDays > 0) {
      const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      for (const file of files) {
        if (file.modifiedMs < cutoffMs) {
          doomed.set(file.path, { ...file, reason: 'age' });
        }
      }
    }

    if (retentionMaxBytes > 0) {
      const limitBytes = retentionMaxBytes;
      let totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);

      // Age-based deletions already free space; account for them first so we
      // do not delete more than necessary.
      for (const file of doomed.values()) {
        totalBytes -= file.bytes;
      }

      // files is oldest-first, so this drops the least recent footage.
      for (const file of files) {
        if (totalBytes <= limitBytes) {
          break;
        }
        if (doomed.has(file.path)) {
          continue;
        }
        doomed.set(file.path, { ...file, reason: 'size' });
        totalBytes -= file.bytes;
      }
    }

    if (doomed.size === 0) {
      return;
    }

    let deletedCount = 0;
    let deletedBytes = 0;
    for (const file of doomed.values()) {
      try {
        await unlink(file.path);
        deletedCount += 1;
        deletedBytes += file.bytes;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          log.warn('Could not delete recording during prune', {
            file: file.name,
            error: error.message,
          });
        }
      }
    }

    if (deletedCount > 0) {
      log.step('Pruned recordings', {
        files: deletedCount,
        freedMb: Math.round(deletedBytes / (1024 * 1024)),
        retentionDays: retentionDays || 'disabled',
        retentionMaxGb: retentionMaxGb || 'disabled',
      });
    }
  } catch (error) {
    log.error('Prune pass failed', { error: error.message });
  }
};

/**
 * Starts periodic pruning and returns a stop function.
 * Runs one pass immediately so a restart reclaims space without waiting.
 */
export const startRetention = (config) => {
  void prune(config);

  const timer = setInterval(() => void prune(config), config.pruneIntervalMinutes * 60 * 1000);
  // Do not hold the event loop open purely for pruning.
  timer.unref();

  return () => clearInterval(timer);
};
