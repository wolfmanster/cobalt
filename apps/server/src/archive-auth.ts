import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Express, Request } from 'express';
import { z } from 'zod';

const derive = promisify(scrypt);
const cookie = '__Host-cobalt-archive';
const lifetime = 30 * 24 * 60 * 60;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

type Device = { id: string; name: string; expiresAt: number };
type Devices = Record<string, Device>;

export async function archiveAuth(app: Express, dataDir: string, username: string, password: string, insecureLoopback: boolean) {
  const file = path.join(dataDir, 'archive-sessions.json');
  let saved: { salt?: string; account: string; devices: Devices } | undefined;
  try {
    saved = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const salt = saved?.salt ? Buffer.from(saved.salt, 'hex') : randomBytes(16);
  const expected = password ? await derive(password, salt, 32) as Buffer : undefined;
  const account = digest(username + '\0' + (expected?.toString('hex') ?? ''));
  let devices: Devices = saved?.account === account ? saved.devices : {};

  let pending = Promise.resolve();
  function change(edit: (draft: Devices) => void) {
    const task = pending.then(async () => {
      const draft = Object.fromEntries(Object.entries(devices).filter(([, device]) => device.expiresAt > Date.now()));
      edit(draft);
      const temporary = file + '.tmp';
      await fs.writeFile(temporary, JSON.stringify({ salt: salt.toString('hex'), account, devices: draft }), { mode: 0o600 });
      await fs.rename(temporary, file);
      devices = draft;
    });
    pending = task.catch(() => undefined);
    return task;
  }

  const cookieName = insecureLoopback ? 'cobalt-archive-local' : cookie;
  function tokenKey(req: Request) {
    const token = req.get('authorization')?.match(/^Bearer ([\da-f]{64})$/i)?.[1]
      ?? req.get('cookie')?.split(';').map((part) => part.trim())
        .find((part) => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    return token && /^[\da-f]{64}$/.test(token) ? digest(token) : '';
  }
  function current(req: Request) {
    const device = devices[tokenKey(req)];
    return device && device.expiresAt > Date.now() ? device : undefined;
  }

  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.path === '/health') return next();
    if (!expected) return res.status(503).json({ error: '服务端尚未配置归档账号' });
    const loopback = insecureLoopback && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
    if (!req.secure && !loopback) return res.status(403).json({ error: '归档服务需要 HTTPS' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.get('origin');
      if (origin && origin !== req.protocol + '://' + req.get('host')) {
        return res.status(403).json({ error: '请通过归档服务的同源地址访问' });
      }
    }
    if (req.method === 'POST' && req.path === '/account/login') return next();
    if (!current(req)) return res.status(401).json({ error: '请登录归档账号' });
    next();
  });

  let attempts = 0;
  let retryAt = 0;
  app.post('/api/account/login', async (req, res, next) => {
    const input = z.object({
      username: z.string().max(128),
      password: z.string().max(1024),
      deviceName: z.string().trim().min(1).max(80),
      bearer: z.boolean().optional(),
    }).safeParse(req.body);
    if (!input.success || !expected) return res.status(400).json({ error: '请填写归档账号和密码' });
    if (Date.now() > retryAt) { attempts = 0; retryAt = Date.now() + 60_000; }
    if (++attempts > 15) return res.status(429).json({ error: '登录尝试过多，请稍后重试' });
    try {
      const actual = await derive(input.data.password, salt, 32) as Buffer;
      if (!timingSafeEqual(expected, actual) || input.data.username !== username) {
        return res.status(401).json({ error: '归档账号或密码错误' });
      }
      attempts = 0;
      const token = randomBytes(32).toString('hex');
      const device = { id: randomUUID(), name: input.data.deviceName, expiresAt: Date.now() + lifetime * 1000 };
      await change((draft) => {
        delete draft[tokenKey(req)];
        draft[digest(token)] = device;
      });
      if (!input.data.bearer) {
        res.cookie(cookieName, token, { secure: !insecureLoopback, httpOnly: true, sameSite: 'strict', path: '/', maxAge: lifetime * 1000 });
      }
      return res.json({ device, ...(input.data.bearer ? { token } : {}) });
    } catch (error) { return next(error); }
  });
  app.get('/api/account', (req, res) => res.json({
    device: current(req), devices: Object.values(devices).filter((device) => device.expiresAt > Date.now()),
  }));
  app.delete('/api/account/sessions/:id', async (req, res, next) => {
    try {
      await change((draft) => {
        const key = Object.keys(draft).find((item) => draft[item]?.id === req.params.id);
        if (key) delete draft[key];
      });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  return { current };
}
