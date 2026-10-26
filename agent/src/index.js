#!/usr/bin/env node
// Claude Remote agent entry point.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import qrcode from 'qrcode-terminal';
import { buildLink, localAddresses, selfHosted } from './links.js';
import { loadConfig, saveConfig, rotateToken, configPath } from './config.js';
import { AgentServer } from './server.js';
import { startTunnel } from './tunnel.js';
import { installHooks, uninstallHooks, hooksStatus, settingsPath } from './hooks.js';
import { PROJECTS_DIR } from './transcripts.js';
import { checkLogin } from './runner.js';

const HELP = `claude-remote-agent [options]

Runs on the PC where Claude Code is installed and lets the Claude Remote web UI
see your sessions, answer permission prompts and questions, and send messages.
Uses your existing Claude Code login: no API key needed.

Options:
  --port <n>            Local port (default 3721; saved)
  --host <addr>         Bind address (default 127.0.0.1; use 0.0.0.0 for LAN access; saved)
  --no-tunnel           Do not start the Cloudflare quick tunnel (LAN / local use)
  --public-url <url>    You expose the agent yourself (Tailscale Funnel, named Cloudflare tunnel,
                        reverse proxy...): also print a link with this stable URL (saved; "off" clears)
  --web <url>           Web UI base URL used in the connection link (saved)
  --hook-wait <sec>     How long a terminal session waits for a web answer (saved)
  --stop-hold <sec>     After a turn ends in a session driven from the web, keep it reachable
                        this long so a message from the phone is delivered at once (default 120;
                        0 disables; saved; re-run --install-hooks after changing it)
  --install-hooks       Add Claude Code hooks (~/.claude/settings.json) and exit
  --uninstall-hooks     Remove the hooks and exit
  --no-hooks            Start without asking about hooks
  --rotate-token        Generate a new access token (old links stop working)
  --link                Print the connection link(s) for the saved configuration and exit
                        (handy when the agent runs in the background, see install-autostart.bat)
  --show-config         Print config file location and exit
  -h, --help            Show this help
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--port': out.port = Number(next()); break;
      case '--host': out.host = String(next()); break;
      case '--no-tunnel': out.tunnel = false; break;
      case '--public-url': out.publicUrl = String(next()); break;
      case '--web': out.web = String(next()); break;
      case '--hook-wait': out.hookWait = Number(next()); break;
      case '--stop-hold': out.stopHold = Number(next()); break;
      case '--install-hooks': out.installHooks = true; break;
      case '--uninstall-hooks': out.uninstallHooks = true; break;
      case '--no-hooks': out.noHooks = true; break;
      case '--rotate-token': out.rotate = true; break;
      case '--show-config': out.showConfig = true; break;
      case '--link': out.link = true; break;
      case '-h': case '--help': out.help = true; break;
      default: out._.push(a);
    }
  }
  return out;
}

const ts = () => new Date().toLocaleTimeString();
const log = (m) => console.log(`[${ts()}] ${m}`);

function ask(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve('');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

function printLink(cfg, wsBase, label, opts) {
  const link = buildLink(cfg, wsBase, opts);
  console.log('');
  console.log(`══════════ ${label} ══════════`);
  console.log(`Open this link (it contains your secret token, keep it private):`);
  console.log('');
  console.log(`  ${link}`);
  console.log('');
  qrcode.generate(link, { small: true }, (code) => console.log(code));
  console.log(`Agent address: ${wsBase}`);
  console.log('');
}

function printLocalLinks(cfg) {
  const addrs = localAddresses().filter((a) => !a.virtual);
  if (!addrs.length) return;
  console.log('');
  console.log('══════════ SAME WI-FI / TAILSCALE (no DNS, no tunnel) ══════════');
  if (!selfHosted()) {
    console.log('(build the web UI once to use these: cd web && npm install && npm run build)');
  }
  for (const a of addrs) {
    const wsBase = `ws://${a.ip}:${cfg.port}`;
    const kind = a.tailscale ? 'Tailscale' : a.name;
    console.log(`  ${kind}: ${buildLink(cfg, wsBase, { self: true })}`);
  }
  console.log('  (Tailscale links work from anywhere while the Tailscale app is on in the phone)');
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const cfg = loadConfig();
  if (args.showConfig) {
    console.log(configPath());
    console.log(JSON.stringify({ ...cfg, token: '***', hookSecret: '***' }, null, 2));
    return;
  }
  if (args.rotate) {
    rotateToken(cfg);
    log('access token rotated. Previous links no longer work.');
  }
  if (args.link) {
    if (cfg.publicUrl) printLink(cfg, cfg.publicUrl, 'REMOTE ACCESS (your own stable URL)', { self: true });
    if (cfg.host === '0.0.0.0' || cfg.host === '::') printLocalLinks(cfg);
    if (!cfg.publicUrl) console.log('(the Cloudflare quick tunnel address changes at every start: see agent.log for the current one)');
    return;
  }
  if (args.web) {
    try {
      const u = new URL(args.web);
      if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
      cfg.webUrl = u.origin + u.pathname.replace(/\/$/, '');
      saveConfig(cfg);
    } catch {
      console.error('invalid --web URL');
      process.exit(1);
    }
  }
  if (Number.isFinite(args.hookWait) && args.hookWait >= 5) {
    cfg.hookWaitSeconds = Math.floor(args.hookWait);
    saveConfig(cfg);
  }
  if (Number.isFinite(args.stopHold) && args.stopHold >= 0) {
    cfg.stopHoldSeconds = Math.min(3600, Math.floor(args.stopHold));
    saveConfig(cfg);
    log(`stop hold set to ${cfg.stopHoldSeconds}s (run --install-hooks to update the hook timeout)`);
  }
  if (args.installHooks) {
    const st = installHooks(cfg);
    log(`hooks installed in ${settingsPath()} (${st.events.join(', ')})`);
    return;
  }
  if (args.uninstallHooks) {
    uninstallHooks();
    log(`hooks removed from ${settingsPath()}`);
    return;
  }
  // Port and host are persisted so the hook script finds the agent.
  if ((Number.isFinite(args.port) && args.port > 0 && args.port !== cfg.port) || (args.host && args.host !== cfg.host)) {
    if (Number.isFinite(args.port) && args.port > 0) cfg.port = args.port;
    if (args.host) cfg.host = args.host;
    saveConfig(cfg);
  }
  if (args.publicUrl !== undefined) {
    if (/^(off|none|)$/i.test(args.publicUrl)) {
      delete cfg.publicUrl;
    } else {
      const pub = args.publicUrl.replace(/^http/, 'ws').replace(/\/$/, '');
      if (!/^wss?:\/\/[^/\s]+$/.test(pub)) {
        console.error('--public-url must be an http(s):// or ws(s):// origin, e.g. https://pc.tailnet.ts.net:10000');
        process.exit(1);
      }
      cfg.publicUrl = pub;
    }
    saveConfig(cfg);
  }
  const useTunnel = args.tunnel === false ? false : cfg.tunnel !== false;

  console.log('');
  console.log('  Claude Remote agent');
  console.log(`  transcripts: ${PROJECTS_DIR}`);
  console.log(`  config:      ${configPath()}`);
  console.log('');

  // Hooks: ask once on first run (skipped when not interactive).
  const hs = hooksStatus();
  if (!hs.installed && !args.noHooks && !cfg.hooksPrompted) {
    console.log('Claude Code hooks let the web UI see sessions you run in a terminal or in the');
    console.log('desktop app, and approve their permission prompts and questions remotely.');
    console.log(`They are added to ${settingsPath()} (a backup is kept) and fail open.`);
    const a = await ask('Install hooks now? [Y/n] ');
    if (a === '' || /^y/i.test(a)) {
      try {
        installHooks(cfg);
        log('hooks installed');
      } catch (err) {
        log(`could not install hooks: ${err.message}`);
      }
    } else {
      log('skipped. You can run with --install-hooks later.');
    }
    cfg.hooksPrompted = true;
    saveConfig(cfg);
  } else if (hs.installed) {
    log(`hooks active (${hs.events.length} events)`);
  }

  const login = checkLogin();
  if (login.ok === false) {
    console.log('');
    console.log('  ⚠ Claude Code is not logged in on this PC, so messages sent from the web UI');
    console.log('    cannot start Claude. Run this once in a terminal (uses your Claude plan, no API key):');
    console.log('');
    console.log('        claude login');
    console.log('');
    console.log('    Viewing sessions and answering prompts of sessions you run yourself still works.');
    console.log('');
  } else if (login.ok) {
    log(`Claude Code login OK (${login.detail})`);
  }

  const server = new AgentServer(cfg, { log, loggedIn: login.ok });
  try {
    await server.start();
  } catch (err) {
    console.error(`cannot listen on ${cfg.host}:${cfg.port}: ${err.message}`);
    process.exit(1);
  }
  server.startHeartbeat();
  log(`listening on http://${cfg.host}:${cfg.port}  (sessions indexed: ${server.store.listSessions().length})`);
  // pid file: lets stop.bat / autostart.ps1 find the background instance.
  const pidFile = path.join(path.dirname(configPath()), 'agent.pid');
  try {
    fs.writeFileSync(pidFile, String(process.pid));
  } catch {
    /* not essential */
  }
  const removePid = () => {
    try {
      if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidFile);
    } catch {
      /* ignore */
    }
  };
  process.on('exit', removePid);

  const localBase = `ws://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`;
  if (cfg.publicUrl) {
    // The user fronts the agent with their own tunnel / reverse proxy (Tailscale Funnel, named
    // Cloudflare tunnel, ngrok, ...). Stable address, so this link never changes.
    printLink(cfg, cfg.publicUrl, 'REMOTE ACCESS (your own stable URL)', { self: true });
  }
  if (cfg.host === '0.0.0.0' || cfg.host === '::') printLocalLinks(cfg);
  if (!useTunnel) {
    if (!cfg.publicUrl) printLink(cfg, localBase, 'THIS PC ONLY');
  } else {
    log('starting Cloudflare quick tunnel...');
    startTunnel(cfg.port, {
      log,
      onUrl: (url) => {
        const wsBase = url.replace(/^http/, 'ws');
        log(`tunnel ready: ${url}`);
        printLink(cfg, wsBase, 'REMOTE ACCESS (Cloudflare quick tunnel, new address on every start)');
        console.log('(a fresh tunnel address can take up to a minute to resolve; just retry if the page cannot connect at first.');
        console.log(' Some home routers block *.trycloudflare.com: use mobile data, or the links above.)');
        server.setTunnel(wsBase);
      },
      onDown: () => server.setTunnel(null),
    });
    console.log(`(this PC only: ${buildLink(cfg, localBase)})`);
  }

  const shutdown = () => {
    log('shutting down');
    server.stop();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
