/**
 * Minimal structured logger.
 *
 * Never log the refresh token or any part of it — it grants full access to the
 * Ring account. Log *that* a token was rotated, never its value.
 */

const timestamp = () => new Date().toISOString();

const write = (stream, level, message, fields) => {
  const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
  stream.write(`${timestamp()} [${level}] ${message}${suffix}\n`);
};

export const log = {
  /** Main operational steps. */
  step: (message, fields) => write(process.stdout, 'INFO', `==> ${message}`, fields),
  /** Sub-steps within an operation. */
  substep: (message, fields) => write(process.stdout, 'INFO', `--> ${message}`, fields),
  info: (message, fields) => write(process.stdout, 'INFO', message, fields),
  warn: (message, fields) => write(process.stderr, 'WARN', message, fields),
  error: (message, fields) => write(process.stderr, 'ERROR', message, fields),
};
