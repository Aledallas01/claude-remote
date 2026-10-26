// Connection links: the web UI base + the agent's WebSocket address + the token, in the URL
// fragment (never sent to any server). Shared by the console output, --link and the tray app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The agent serves the web UI itself when ../web/dist exists (start.bat builds it). Links that
// point at a LAN / Tailscale / self-exposed address use that copy, so the phone needs to reach
// one host only, and plain-http LAN pages can open plain ws:// sockets (browsers block ws:// from
// an https page). The Cloudflare tunnel link keeps using the hosted web UI.
const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist', 'index.html');
export const selfHosted = () => fs.existsSync(WEB_DIST);

export function buildLink(cfg, wsBase, { self = false } = {}) {
  const params = new URLSearchParams({ a: wsBase, t: cfg.token, n: cfg.agentName });
  const webBase = self && selfHosted() ? wsBase.replace(/^ws/, 'http') : cfg.webUrl.replace(/\/$/, '');
  return `${webBase}/#${params.toString()}`;
}

// Non-loopback IPv4 addresses of this PC: LAN first, then Tailscale (100.64.0.0/10), then the rest.
export function localAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const ip = a.address;
      if (/^169\.254\./.test(ip)) continue; // link-local: never reachable from a phone
      const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) || /tailscale/i.test(name);
      // Virtual adapters are not reachable from a phone; VirtualBox host-only defaults to 192.168.56.x.
      const virtual = /vethernet|virtualbox|vmware|hyper-v|docker|wsl|loopback/i.test(name) || /^192\.168\.56\./.test(ip);
      out.push({ name, ip, tailscale, virtual });
    }
  }
  const rank = (a) => (a.tailscale ? 1 : a.virtual ? 2 : 0);
  return out.sort((x, y) => rank(x) - rank(y));
}

// Every link worth showing, in order of preference: [{ kind, label, wsBase, url }].
export function allLinks(cfg, { tunnelWs = null } = {}) {
  const out = [];
  if (cfg.publicUrl) out.push({ kind: 'public', label: 'Stable (Tailscale Funnel / your URL)', wsBase: cfg.publicUrl, url: buildLink(cfg, cfg.publicUrl, { self: true }) });
  if (tunnelWs) out.push({ kind: 'tunnel', label: 'Cloudflare tunnel (changes at every start)', wsBase: tunnelWs, url: buildLink(cfg, tunnelWs) });
  if (cfg.host === '0.0.0.0' || cfg.host === '::') {
    for (const a of localAddresses().filter((x) => !x.virtual)) {
      const wsBase = `ws://${a.ip}:${cfg.port}`;
      out.push({ kind: a.tailscale ? 'tailscale' : 'lan', label: a.tailscale ? 'Tailscale (phone with Tailscale on)' : `Same Wi-Fi (${a.name})`, wsBase, url: buildLink(cfg, wsBase, { self: true }) });
    }
  }
  return out;
}
