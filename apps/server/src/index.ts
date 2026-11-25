import 'dotenv/config';
import fsp from 'node:fs/promises';
import { createApp } from './http-api.js';

const { app, store, categories, dataDir } = await createApp();
const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? '127.0.0.1';
const server = app.listen(port, host, () => {
  console.log(`X Media Archive: http://${host}:${port}`);
  console.log(`Cobalt: ${process.env.COBALT_URL ?? 'http://127.0.0.1:9000'}`);
  if (!isLoopback(host)) {
    console.warn(`HOST=${host}。请通过可信的同机 HTTPS 反向代理访问归档服务。`);
  }
});

function isLoopback(value: string): boolean {
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]';
}

async function shutdown() {
  server.close();
  await store.flush();
  await categories.flush();
  await fsp.mkdir(dataDir, { recursive: true });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
