import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './http-api.js';
import { XSessionStorageError, XSessionStore } from './x-session-store.js';

const archiveUsername = 'test';
const archivePassword = 'archive-fixture-password';
const key = 'a'.repeat(64);
const otherKey = 'b'.repeat(64);
const session = { authToken: 'auth-token-private-123', csrfToken: 'csrf-token-private-456' };
const dataDirs: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

async function newDataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'x-session-'));
  dataDirs.push(directory);
  return directory;
}

async function listen(running: Awaited<ReturnType<typeof createApp>>) {
  const server = running.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  servers.push({ close: () => new Promise((resolve) => server.close(() => resolve())) });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/account/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: archiveUsername, password: archivePassword, deviceName: 'Test' }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  return (route: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('Cookie', cookie);
    return fetch(base + route, { ...init, headers });
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(dataDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('X session encryption', () => {
  it('stores ciphertext and restores the session after creating a new store', async () => {
    const directory = await newDataDir();
    const first = new XSessionStore(directory, key);
    await first.save(session);
    const raw = await fs.readFile(path.join(directory, 'x-session.json'), 'utf8');

    expect(raw).not.toContain(session.authToken);
    expect(raw).not.toContain(session.csrfToken);
    expect(await new XSessionStore(directory, key).get()).toEqual(session);
    await expect(new XSessionStore(directory, otherKey).get()).rejects.toBeInstanceOf(XSessionStorageError);
  });

  it('rejects damaged session files and removes them without needing the key', async () => {
    const directory = await newDataDir();
    const store = new XSessionStore(directory, key);
    await store.save(session);
    await fs.writeFile(path.join(directory, 'x-session.json'), '{ damaged');
    await expect(store.get()).rejects.toBeInstanceOf(XSessionStorageError);
    await new XSessionStore(directory, '').clear();
    expect(await fs.stat(path.join(directory, 'x-session.json')).catch(() => undefined)).toBeUndefined();
  });

  it('keeps session endpoints secret-free and allows archive jobs without an X session key', async () => {
    const directory = await newDataDir();
    const running = await createApp({ dataDir: directory, archiveUsername, archivePassword, insecureLoopback: true, clientDist: path.join(directory, 'missing'), xSessionEncryptionKey: '' });
    const request = await listen(running);

    const status = await request(`/api/x-session`);
    expect(await status.json()).toMatchObject({ available: false, configured: false, stored: false });
    expect((await request(`/api/jobs`)).status).toBe(200);
    const rejectedSave = await request(`/api/x-session`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auth_token: session.authToken, ct0: session.csrfToken }),
    });
    expect(rejectedSave.status).toBe(503);
    expect(await rejectedSave.text()).not.toContain(session.authToken);

    // Clearing an old file remains possible even if the encryption key was lost.
    await new XSessionStore(directory, key).save(session);
    const removed = await request(`/api/x-session`, { method: 'DELETE' });
    expect(await removed.json()).toMatchObject({ configured: false, stored: false });
    expect(await fs.stat(path.join(directory, 'x-session.json')).catch(() => undefined)).toBeUndefined();
  });

  it('never returns the submitted values from PUT, GET, or job endpoints', async () => {
    const directory = await newDataDir();
    const running = await createApp({ dataDir: directory, archiveUsername, archivePassword, insecureLoopback: true, clientDist: path.join(directory, 'missing'), xSessionEncryptionKey: key });
    const request = await listen(running);
    const saved = await request(`/api/x-session`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auth_token: session.authToken, ct0: session.csrfToken }),
    });
    const savedBody = await saved.text();
    expect(saved.status).toBe(200);
    expect(savedBody).not.toContain(session.authToken);
    expect(savedBody).not.toContain(session.csrfToken);

    const status = await (await request(`/api/x-session`)).text();
    const jobs = await (await request(`/api/jobs`)).text();
    expect(status).toContain('"configured":true');
    expect(status).not.toContain(session.authToken);
    expect(status).not.toContain(session.csrfToken);
    expect(jobs).not.toContain(session.authToken);
    expect(jobs).not.toContain(session.csrfToken);
    expect(await running.sessions.get()).toEqual(session);
  });
});
