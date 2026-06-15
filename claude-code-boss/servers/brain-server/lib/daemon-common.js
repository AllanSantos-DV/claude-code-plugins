/**
 * lib/daemon-common.js — shared helpers for the HTTP daemon + its supervisor.
 */
import crypto from 'node:crypto';
import path from 'node:path';

/**
 * Deterministic per-data-dir port in the private range (49152-65535) so two
 * different installs on the same machine don't collide. Override with
 * BRAIN_HTTP_PORT.
 */
export function resolvePort(dataDir) {
  const env = process.env.BRAIN_HTTP_PORT && Number(process.env.BRAIN_HTTP_PORT);
  if (env && env > 0) return env;
  const h = crypto.createHash('sha256').update(String(dataDir || 'default')).digest();
  return 49152 + (h.readUInt16BE(0) % (65535 - 49152));
}

/**
 * Lock/health file path. Lives in DATA_DIR (persistent across versions), NEVER in
 * the rotating/cleaned plugin cache — so any version's launcher can find it.
 */
export function lockFile(dataDir) {
  return path.join(dataDir, 'brain-http.lock.json');
}

export const HEALTH_PATH = '/health';
export const MCP_PATH = '/mcp';
