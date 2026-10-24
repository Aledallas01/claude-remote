#!/usr/bin/env node
// Claude Code hook script. Forwards the hook event to the local Claude Remote
// agent over loopback HTTP and prints the agent's decision (if any) to stdout.
// Fails open: any problem -> exit 0 with no output, Claude Code continues normally.
import fs from 'node:fs';
import http from 'node:http';
import { configPath } from '../src/config.js';

const event = process.argv[2] || '';

if (process.env.CLAUDE_REMOTE_SDK) process.exit(0); // sessions driven by the agent itself use canUseTool

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return; // agent never configured
  }
  const raw = await readStdin();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  const blocking = event === 'PermissionRequest' || (event === 'PreToolUse' && payload.tool_name === 'AskUserQuestion');
  const timeoutMs = blocking ? (Number(cfg.hookWaitSeconds || 180) + 10) * 1000 : 3000;
  const body = JSON.stringify({ event, payload });

  await new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(cfg.port || 3721),
        path: '/hook',
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-claude-remote-secret': String(cfg.hookSecret || ''),
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          if (res.statusCode === 200 && out && out !== '{}') process.stdout.write(out);
          resolve();
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.on('error', () => resolve());
    req.end(body);
  });
}

main().finally(() => process.exit(0));
