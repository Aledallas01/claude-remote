// Configuration for the Claude Remote agent.
// Stored outside the repo (per-user), never committed:
//   Windows: %APPDATA%\claude-remote\config.json
//   macOS/Linux: ~/.config/claude-remote/config.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_WEB_URL = 'https://claude-remote-three.vercel.app';
export const DEFAULT_PORT = 3721;

export function configDir() {
  if (process.env.CLAUDE_REMOTE_CONFIG_DIR) return process.env.CLAUDE_REMOTE_CONFIG_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'claude-remote');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claude-remote');
}

export function configPath() {
  return path.join(configDir(), 'config.json');
}

// Letters and digits only: survives copy/paste through messaging apps and phone keyboards,
// which like to turn '-' into dashes. 32 bytes -> 52 chars of base32 (~256 bits).
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function randomToken(bytes = 32) {
  const buf = crypto.randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

const DEFAULTS = {
  port: DEFAULT_PORT,
  host: '127.0.0.1',
  webUrl: DEFAULT_WEB_URL,
  tunnel: true,
  hookWaitSeconds: 180,
  // After a turn ends in a session that the web UI is using, the Stop hook keeps the session
  // reachable for this long so a message from the phone reaches Claude immediately.
  stopHoldSeconds: 120,
  hooksPrompted: false,
  agentName: os.hostname(),
};

export function loadConfig() {
  const file = configPath();
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    cfg = {};
  }
  let dirty = false;
  if (!cfg.token || typeof cfg.token !== 'string' || cfg.token.length < 32) {
    cfg.token = randomToken(32);
    dirty = true;
  }
  if (!cfg.hookSecret || typeof cfg.hookSecret !== 'string') {
    cfg.hookSecret = randomToken(24);
    dirty = true;
  }
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (cfg[k] === undefined) {
      cfg[k] = v;
      dirty = true;
    }
  }
  if (dirty) saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows: ignore */
  }
}

export function rotateToken(cfg) {
  cfg.token = randomToken(32);
  saveConfig(cfg);
  return cfg;
}
