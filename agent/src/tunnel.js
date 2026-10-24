// Cloudflare quick tunnel (no account needed) so the web UI can reach the
// agent from anywhere over TLS. The URL changes on every start.
import fs from 'node:fs';
import { Tunnel, bin, use } from 'cloudflared';

function resolveBinary(log) {
  if (fs.existsSync(bin)) return bin;
  // The npm postinstall download may have failed; fall back to PATH.
  log('cloudflared binary not found in package, trying PATH');
  use(process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  return null;
}

export function startTunnel(port, { log, onUrl, onDown }) {
  resolveBinary(log);
  let stopped = false;
  let tunnel = null;
  let attempt = 0;

  const launch = () => {
    if (stopped) return;
    attempt += 1;
    tunnel = Tunnel.quick(`http://127.0.0.1:${port}`, { 'no-autoupdate': true, 'edge-ip-version': 'auto' });
    tunnel.once('url', (url) => {
      attempt = 0;
      onUrl(url.replace(/\/$/, ''));
    });
    tunnel.on('error', (err) => log(`tunnel error: ${err?.message || err}`));
    tunnel.on('stderr', (data) => {
      const s = String(data);
      if (/ERR|error/i.test(s) && !/context canceled/i.test(s)) log(`tunnel: ${s.trim().slice(0, 300)}`);
    });
    tunnel.once('exit', (code) => {
      if (stopped) return;
      onDown?.();
      const delay = Math.min(30000, 2000 * attempt);
      log(`tunnel exited (code ${code}); restarting in ${Math.round(delay / 1000)}s`);
      setTimeout(launch, delay);
    });
  };
  launch();

  return {
    stop() {
      stopped = true;
      try {
        tunnel?.stop();
      } catch {
        /* ignore */
      }
    },
  };
}
