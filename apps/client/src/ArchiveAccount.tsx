import { useEffect, useState, type FormEvent } from 'react';
import App from './App';
import { ArchiveHttpError, remoteRequest } from './archive-transport';
import { resetOffline } from './offline-db';
import { isNativeAndroid, remoteOrigin, usesLocalArchive } from './platform';
import { useArchiveSync } from './useArchiveSync';
import { LocalArchive } from './nativeArchive';

type Device = { id: string; name: string; expiresAt: number };
type Account = { device: Device; devices: Device[] };
const sessionKey = 'archive-device:' + remoteOrigin;

function httpsOrigin(value: string) {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('请输入 HTTPS 服务地址，例如 https://archive.example.com');
  }
  return url.origin;
}

export function ArchiveAccount() {
  const [signedIn, setSignedIn] = useState(() => Boolean(localStorage.getItem(sessionKey)));
  const [show, setShow] = useState(false);
  const [account, setAccount] = useState<Account>();
  const [origin, setOrigin] = useState(remoteOrigin);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState(isNativeAndroid ? '安卓手机' : 'iPhone PWA');
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState(false);
  const sync = useArchiveSync(!usesLocalArchive && signedIn);

  function signedOut() {
    localStorage.removeItem(sessionKey);
    setSignedIn(false);
    setAccount(undefined);
    setError('请登录归档账号');
  }
  function recorded(device: Device) {
    localStorage.setItem(sessionKey, device.id);
    setSignedIn(true);
  }

  useEffect(() => {
    if (usesLocalArchive) return;
    let disposed = false;
    const refresh = () => {
      if (!navigator.onLine) return;
      void remoteRequest<Account>('/api/account').then((result) => {
        if (disposed) return;
        recorded(result.device);
        setAccount(result);
      }).catch((cause) => {
        if (disposed || !(cause instanceof ArchiveHttpError)) return;
        if (cause.status === 401) signedOut();
        else setError(cause.message);
      });
    };
    const expired = () => { if (!disposed) signedOut(); };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('archive-session-expired', expired);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', visible);
    refresh();
    return () => {
      disposed = true;
      window.removeEventListener('archive-session-expired', expired);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  async function login(event: FormEvent) {
    event.preventDefault();
    setWaiting(true);
    setError('');
    try {
      const server = isNativeAndroid ? httpsOrigin(origin) : '';
      const result = await remoteRequest<{ device: Device }>('/api/account/login', {
        method: 'POST', body: JSON.stringify({ username: username.trim(), password, deviceName, bearer: isNativeAndroid }),
      }, server);
      setPassword('');
      if (isNativeAndroid && server !== remoteOrigin) {
        localStorage.setItem('archive-remote-origin', server);
        localStorage.setItem('archive-device:' + server, result.device.id);
        window.location.reload();
        return;
      }
      recorded(result.device);
      setAccount(await remoteRequest<Account>('/api/account'));
      if (!isNativeAndroid) void navigator.storage?.persist?.().catch(() => undefined);
      setShow(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWaiting(false);
    }
  }

  async function revoke(id: string) {
    setError('');
    setWaiting(true);
    try {
      await remoteRequest('/api/account/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
      if (id === account?.device.id) {
        signedOut();
        if (!isNativeAndroid) {
          await resetOffline();
          window.location.reload();
        }
      } else setAccount(await remoteRequest<Account>('/api/account'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setWaiting(false); }
  }

  const canBrowse = signedIn || usesLocalArchive;
  const panel = show || !canBrowse;
  const report = sync.report;
  return <>
    {canBrowse && <App onArchiveAccount={() => {
      setShow(true);
      if (signedIn && !usesLocalArchive) void remoteRequest<Account>('/api/account').then(setAccount).catch((cause) => setError(cause.message));
    }} syncMessage={sync.message} />}
    {panel && <div className={canBrowse ? 'confirmation-backdrop' : 'archive-login-page'}>
      <section className="confirmation-dialog archive-account" role={canBrowse ? 'dialog' : undefined} aria-labelledby="archive-account-title" aria-modal={canBrowse || undefined}>
        <h2 id="archive-account-title">归档账号</h2>
        {!signedIn || usesLocalArchive ? <form onSubmit={(event) => void login(event)}>
          {isNativeAndroid && <label>服务器 HTTPS 地址<input required type="url" value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://archive.example.com" /></label>}
          <label>账号<input required autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>密码<input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <label>设备名称<input required maxLength={80} value={deviceName} onChange={(event) => setDeviceName(event.target.value)} /></label>
          <div className="confirmation-actions"><button type="submit" className="confirmation-primary" disabled={waiting}>{waiting ? '登录中…' : '登录'}</button></div>
        </form> : <>
          <h3>登录设备</h3>
          {account?.devices.map((device) => <div className="archive-device-row" key={device.id}>
            <span>{device.name}{device.id === account.device.id ? '（本机）' : ''}</span>
            <button type="button" disabled={waiting} onClick={() => void revoke(device.id)}>{device.id === account.device.id ? '退出登录' : '撤销登录'}</button>
          </div>)}
          {isNativeAndroid && <section>
            <h3>安卓旧下载导入</h3>
            {report ? <details><summary>已合并 {report.merged.length} 条 · 缺失 {report.missing.length} 项 · 需重新授权 {report.permissions.length} 项</summary>
              <ul>
                {report.merged.map((id) => <li key={'merged:' + id}>已合并 · {id}</li>)}
                {report.missing.map((item, i) => <li key={'missing:' + i}>缺失 · {item.tweetId} · {item.filename}</li>)}
                {report.permissions.map((item, i) => <li key={'permission:' + i}>需重新授权 · {item.tweetId} · {item.filename}</li>)}
              </ul>
            </details> : <p>{sync.message || '正在检查本机已有的下载'}</p>}
            {!!report?.permissions.length && <button type="button" onClick={() => {
              void LocalArchive.authorizeImportFolder().then(({ granted }) => {
                if (granted) sync.retry();
              }).catch((cause) => setError(cause.message));
            }}>重新授权原下载目录</button>}
            <button type="button" onClick={sync.retry}>重新检查导入与同步</button>
          </section>}
        </>}
        {error && <p role="alert">{error}</p>}
        <div className="confirmation-actions">
          {canBrowse && <button type="button" onClick={() => { setError(''); setShow(false); }}>关闭</button>}
          {isNativeAndroid && remoteOrigin && !signedIn && <button type="button" onClick={() => {
            localStorage.removeItem('archive-remote-origin');
            window.location.reload();
          }}>返回本机归档</button>}
        </div>
      </section>
    </div>}
  </>;
}
