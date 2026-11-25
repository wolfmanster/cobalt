import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface XSession {
  authToken: string;
  csrfToken: string;
}

interface EncryptedSessionFile {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class XSessionConfigurationError extends Error {}
export class XSessionStorageError extends Error {}

const AAD = Buffer.from('cobalt-x-session-v1', 'utf8');

export class XSessionStore {
  private readonly filePath: string;
  private readonly encryptionKey: Buffer | undefined;
  private readonly configurationError: string | undefined;

  constructor(dataDir: string, encryptionKey = process.env.X_SESSION_ENCRYPTION_KEY) {
    this.filePath = path.join(dataDir, 'x-session.json');
    try {
      this.encryptionKey = parseKey(encryptionKey);
    } catch (error) {
      this.encryptionKey = undefined;
      this.configurationError = error instanceof Error ? error.message : 'X_SESSION_ENCRYPTION_KEY 配置无效';
    }
  }

  get available(): boolean {
    return this.encryptionKey !== undefined;
  }

  get configurationMessage(): string | undefined {
    if (this.encryptionKey) return undefined;
    return this.configurationError ?? '服务器未配置 X_SESSION_ENCRYPTION_KEY，无法使用 PWA 登录';
  }

  async get(): Promise<XSession | undefined> {
    if (!this.encryptionKey) throw new XSessionConfigurationError(this.configurationError ?? '服务器未配置 X_SESSION_ENCRYPTION_KEY，无法使用 PWA 登录');
    let serialized: string;
    try {
      serialized = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw new XSessionStorageError('无法读取加密的 X 会话文件');
    }

    try {
      const envelope = JSON.parse(serialized) as Partial<EncryptedSessionFile>;
      if (envelope.version !== 1 || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') {
        throw new Error('invalid envelope');
      }
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      const value = JSON.parse(plaintext) as Partial<XSession>;
      if (!isValidSessionValue(value.authToken) || !isValidSessionValue(value.csrfToken)) throw new Error('invalid session');
      return { authToken: value.authToken, csrfToken: value.csrfToken };
    } catch {
      throw new XSessionStorageError('无法解密已保存的 X 会话；请确认加密密钥，或移除会话后重新登录');
    }
  }

  async isConfigured(): Promise<boolean> {
    return (await this.get()) !== undefined;
  }

  async hasStoredSession(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw new XSessionStorageError('无法读取加密的 X 会话文件');
    }
  }

  async save(session: XSession): Promise<void> {
    if (!this.encryptionKey) throw new XSessionConfigurationError(this.configurationError ?? '服务器未配置 X_SESSION_ENCRYPTION_KEY，无法使用 PWA 登录');
    if (!isValidSessionValue(session.authToken)) throw new TypeError('auth_token 格式无效');
    if (!isValidSessionValue(session.csrfToken)) throw new TypeError('ct0 格式无效');

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(session), 'utf8'),
      cipher.final(),
    ]);
    const envelope: EncryptedSessionFile = {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temporaryPath, this.filePath);
    } catch {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new XSessionStorageError('无法保存加密的 X 会话');
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.filePath, { force: true });
    } catch {
      throw new XSessionStorageError('无法移除已保存的 X 会话');
    }
  }
}

function parseKey(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  if (!/^[\da-fA-F]{64}$/.test(value)) throw new XSessionConfigurationError('X_SESSION_ENCRYPTION_KEY 必须是 64 位十六进制字符（32 字节）');
  return Buffer.from(value, 'hex');
}

function isValidSessionValue(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 8
    && value.length <= 512
    && !/[;\s\r\n]/u.test(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
