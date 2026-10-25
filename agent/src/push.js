// Web Push: lets the phone get a notification for a permission prompt or a question even
// when the web app is in the background or closed. The browser's push service (Apple,
// Google, Mozilla) only ever sees an encrypted payload; the VAPID key pair identifies this
// agent and is generated once, locally. Subscriptions live next to the config file.
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { configDir, saveConfig } from './config.js';

const MAX_SUBSCRIPTIONS = 20;

export class PushStore {
  constructor(cfg, { log } = {}) {
    this.cfg = cfg;
    this.log = log || (() => {});
    this.file = path.join(configDir(), 'push-subscriptions.json');
    if (!cfg.vapidPublicKey || !cfg.vapidPrivateKey) {
      const keys = webpush.generateVAPIDKeys();
      cfg.vapidPublicKey = keys.publicKey;
      cfg.vapidPrivateKey = keys.privateKey;
      saveConfig(cfg);
    }
    webpush.setVapidDetails('mailto:claude-remote@localhost', cfg.vapidPublicKey, cfg.vapidPrivateKey);
    this.subs = this.load();
  }

  get publicKey() {
    return this.cfg.vapidPublicKey;
  }

  get count() {
    return this.subs.length;
  }

  load() {
    try {
      const list = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(list) ? list.filter((s) => s && typeof s.endpoint === 'string') : [];
    } catch {
      return [];
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.subs, null, 2), { mode: 0o600 });
    } catch (err) {
      this.log(`push: cannot save subscriptions: ${err.message}`);
    }
  }

  // sub: { endpoint, expirationTime, keys: { p256dh, auth } } as produced by PushManager.subscribe().
  add(sub, meta = {}) {
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
      throw new Error('invalid push subscription');
    }
    const entry = { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, ua: String(meta.ua || '').slice(0, 200), createdAt: new Date().toISOString() };
    this.subs = this.subs.filter((s) => s.endpoint !== entry.endpoint);
    this.subs.push(entry);
    if (this.subs.length > MAX_SUBSCRIPTIONS) this.subs = this.subs.slice(-MAX_SUBSCRIPTIONS);
    this.save();
    return this.subs.length;
  }

  remove(endpoint) {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length !== before) this.save();
    return this.subs.length;
  }

  has(endpoint) {
    return this.subs.some((s) => s.endpoint === endpoint);
  }

  // Sends the payload to every subscription; dead ones (410/404) are dropped.
  async notify(payload) {
    if (!this.subs.length) return;
    const body = JSON.stringify(payload);
    const results = await Promise.allSettled(
      this.subs.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 300, urgency: 'high', topic: String(payload.requestId || '').slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '') || undefined })),
    );
    let dirty = false;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') return;
      const code = r.reason?.statusCode;
      if (code === 404 || code === 410) {
        this.log(`push: subscription expired, removing (${this.subs[i]?.endpoint.slice(0, 40)}…)`);
        this.subs[i] = null;
        dirty = true;
      } else {
        this.log(`push: send failed (${code || r.reason?.message || 'unknown'})`);
      }
    });
    if (dirty) {
      this.subs = this.subs.filter(Boolean);
      this.save();
    }
  }
}
