# Claude Remote

See your **Claude Code** sessions, answer its questions, approve or deny tool calls and send new
messages, from any browser or phone, while Claude keeps running on your own PC.

- **No API key.** It uses the Claude Code login you already have (your Claude plan).
- **Zero accounts.** No sign-up, no server that stores your data. The web app is a static page; it
  talks directly to the agent running on your PC through an encrypted tunnel.
- **Public and self-hostable.** Everyone connects *their own* PC. You can use the hosted web UI or
  serve it yourself from the agent (`http://127.0.0.1:3721`).

```
 phone / laptop browser  ──wss──▶  Cloudflare quick tunnel  ──▶  agent on your PC  ──▶  Claude Code
 (static web UI, Vercel)                                        (Node.js)             (your login)
```

## What you can do from the web UI

| | |
|---|---|
| **Browse every session** | All transcripts under `~/.claude/projects`, grouped by project, searchable, with live updates while Claude works. |
| **Approve / deny tool calls** | Permission prompts (Bash, Edit, Write, MCP tools…) appear as cards: *Allow*, *Allow always*, *Deny with a reason*. |
| **Answer questions** | `AskUserQuestion` prompts are rendered with their options, multi-select and a free-text "Other". |
| **Send messages** | Continue any session or start a new one in a project folder, with *Ask me* / *Auto-accept edits* / *Plan* permission modes. Stop a running turn at any time. |
| **Sessions you run elsewhere** | With the optional hooks, sessions started in a terminal or in the Claude desktop app show up live and their prompts can be answered from the web too. |

## Quick start (Windows)

1. Install [Node.js 18+](https://nodejs.org) and make sure Claude Code is logged in
   (run `claude` once in a terminal and complete `/login`, or `claude login`).
2. Clone and start the agent:

   ```bat
   git clone https://github.com/Aledallas01/claude-remote
   cd claude-remote\agent
   start.bat
   ```

   `start.bat` installs the dependencies the first time, then runs the agent. On macOS/Linux use
   `npm install && npm start` instead.
3. On first run the agent asks whether to install the Claude Code hooks (recommended, see below).
4. The console prints a **link and a QR code**. Open the link on your phone or in any browser, or scan
   the QR. That is it: the page connects to your PC.

The link looks like `https://claude-remote.vercel.app/#a=wss://…trycloudflare.com&t=<token>`.
Everything after `#` never leaves your browser (URL fragments are not sent to web servers), and the
page stores it in `localStorage` only if you tick *Remember on this device*.

### Agent options

```
node src/index.js [options]
  --port <n>          local port (default 3721)
  --no-tunnel         LAN / same-PC use only, no Cloudflare tunnel
  --host 0.0.0.0      also listen on your LAN interfaces (use with --no-tunnel)
  --web <url>         web UI base URL used in the printed link (default: the hosted one)
  --hook-wait <sec>   how long a terminal session waits for a web answer (default 180)
  --install-hooks     add the hooks to ~/.claude/settings.json and exit
  --uninstall-hooks   remove them and exit
  --rotate-token      new access token (old links stop working)
  --show-config       print the config file location
```

Config lives in `%APPDATA%\claude-remote\config.json` (Windows) or `~/.config/claude-remote/config.json`.

## How it works

The repository has two parts.

### `agent/` – runs on your PC (Node.js)

- **Transcripts.** Reads and watches `~/.claude/projects/**/*.jsonl`, the files Claude Code itself
  writes, so every session is visible, including old ones, with no extra logging.
- **Agent SDK.** Messages you send from the web go through the
  [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), which drives the Claude Code
  already installed on the PC (or the copy bundled with the SDK). It therefore uses your existing
  Claude login, and the session is a normal Claude Code session: same `CLAUDE.md`, MCP servers,
  settings and permissions. Its permission prompts and questions come back to the web through the SDK's
  `canUseTool` callback.
- **Hooks (optional).** `--install-hooks` adds entries to `~/.claude/settings.json` that run
  `agent/hook/claude-remote-hook.js` on `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`,
  `Notification`, `PermissionRequest` and `PreToolUse` (matcher `AskUserQuestion`). The hook forwards
  the event to the agent over `127.0.0.1` and, for permission prompts and questions, waits for your
  answer from the web. It **fails open**: if the agent is not running or nobody is connected to the
  web UI, the hook returns immediately and Claude Code shows its usual prompt. A web user can also hand a
  prompt back with *Answer in terminal*. A backup of `settings.json` is written before every change.
- **Tunnel.** A [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
  (`cloudflared`, no account) exposes the agent over TLS at a random `*.trycloudflare.com` address that
  changes on every start. Use `--no-tunnel` to stay on your LAN.

### `web/` – the web UI (React + Vite, deployed on Vercel)

A static single-page app. It has no backend and no analytics: the only network connection it opens is
the WebSocket to your agent. It can also be served by the agent itself (build it with `npm run build`
in `web/`; the agent serves `web/dist` when present).

## Security model

- **Access token.** The agent generates a random 256-bit token on first start. Every WebSocket
  connection must present it as its first message within a few seconds or it is closed; failed attempts
  are rate-limited per IP. Rotate it with `--rotate-token`.
- **Transport.** The tunnel is TLS end to end between the browser and Cloudflare, and Cloudflare to
  your PC over cloudflared's outbound connection. The agent itself listens on `127.0.0.1` only unless you pass
  `--host`.
- **No third party stores anything.** The web page is static; the token travels in the URL fragment,
  which browsers never send to the server. Nothing about your sessions reaches Vercel or Cloudflare's
  storage; Cloudflare only relays the encrypted connection.
- **Hooks are loopback-only** and authenticated with a separate secret from the config file.
- **What the token grants.** Anyone with the link can read your sessions and make Claude Code act on
  your PC, within the permission mode you choose from the web. Treat it like a password: do not share
  screenshots of the QR code, and prefer *Ask me* mode when working remotely.
- **Hook timeouts.** While a web client is connected, a permission prompt of a terminal session waits up to
  `--hook-wait` seconds (default 180) for a web answer before falling back to the terminal. Without
  any connected web client it does not wait at all.

Found a vulnerability? Please open a private security advisory on GitHub rather than a public issue.

## Development

```bash
cd agent && npm install && node src/index.js --no-tunnel      # agent on http://127.0.0.1:3721
cd web && npm install && npm run dev                           # UI on http://localhost:5173
```

Deploy the UI with the Vercel CLI from `web/` (`vercel --prod`) or import the repository in Vercel
with `web` as the root directory. Then point your agent at your deployment with `--web https://your-app.vercel.app`.

## Limitations

- Sending a message to a session that is currently open in a terminal is not possible (the terminal
  owns that conversation); you can still read it and answer its prompts via hooks. Start a new session
  from the web, or continue a session that is idle.
- Images and files cannot be attached from the web yet.
- Quick tunnel URLs are temporary: when you restart the agent you get a new link (the token stays the same).

## Italiano: avvio rapido

1. Installa [Node.js 18+](https://nodejs.org) e assicurati che Claude Code abbia fatto il login
   (`claude login` in un terminale, una sola volta).
2. `git clone https://github.com/Aledallas01/claude-remote`, entra in `claude-remote\agent` e fai
   doppio clic su `start.bat` (su macOS/Linux: `npm install && npm start`).
3. Alla prima esecuzione rispondi `Y` per installare gli hook di Claude Code: così anche le sessioni
   che avvii dal terminale o dall'app desktop compaiono sul sito e puoi approvare i loro permessi.
4. Apri il link (o il QR) stampato nella console da telefono o browser: vedi le chat, rispondi alle
   domande, accetti o rifiuti gli strumenti e mandi messaggi. Nessuna API key: usa il tuo abbonamento Claude.

Il link contiene il token segreto: non condividerlo. Il sito è una pagina statica, i dati passano solo
tra il tuo browser e il tuo PC.

## License

MIT
