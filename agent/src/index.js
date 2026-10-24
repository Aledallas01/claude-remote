#!/usr/bin/env node
// Claude Remote agent entry point.
import readline from 'node:readline';
import qrcode from 'qrcode-terminal';
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
  --web <url>           Web UI base URL used in the connection link (saved)
  --hook-wait <sec>     How long a terminal session waits for a web answer (saved)
  --install-hooks       Add Claude Code hooks (~/.claude/settings.json) and exit
  --uninstall-hooks     Remove the hooks and exit
  --no-hooks            Start without asking about hooks
  --rotate-token        Generate a new access token (old links stop working)
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
      case '--web': out.web = String(next()); break;
      case '--hook-wait': out.hookWait = Number(next()); break;
      case '--install-hooks': out.installHooks = true; break;
      case '--uninstall-hooks': out.uninstallHooks = true; break;
      case '--no-hooks': out.noHooks = true; break;
      case '--rotate-token': out.rotate = true; break;
      case '--show-config': out.showConfig = true; break;
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

function buildLink(cfg, wsBase) {
  const params = new URLSearchParams({ a: wsBase, t: cfg.token, n: cfg.agentName });
  return `${cfg.webUrl.replace(/\/$/, '')}/#${params.toString()}`;
}

function printLink(cfg, wsBase, label) {
  const link = buildLink(cfg, wsBase);
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

  const localBase = `ws://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`;
  if (!useTunnel) {
    printLink(cfg, localBase, 'LOCAL ACCESS');
  } else {
    log('starting Cloudflare quick tunnel...');
    startTunnel(cfg.port, {
      log,
      onUrl: (url) => {
        const wsBase = url.replace(/^http/, 'ws');
        log(`tunnel ready: ${url}`);
        printLink(cfg, wsBase, 'REMOTE ACCESS');
        server.broadcast({ type: 'tunnel', url: wsBase });
      },
      onDown: () => server.broadcast({ type: 'tunnel', url: null }),
    });
    console.log(`(same PC / LAN without tunnel: ${buildLink(cfg, localBase)})`);
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
