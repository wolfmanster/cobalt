import { useState, type FormEvent } from 'react';
import { LoaderCircle, ShieldCheck, X } from 'lucide-react';

export function SessionPanel({ native, browserSession, available, configured, stored, error, busy, onConnect, onSave, onDisconnect, onClose }: {
  native: boolean; browserSession: boolean; available: boolean; configured: boolean; stored: boolean; error?: string; busy: boolean;
  onConnect: () => void; onSave: (authToken: string, csrfToken: string) => Promise<boolean>; onDisconnect: () => void; onClose: () => void;
}) {
  const [authToken, setAuthToken] = useState('');
  const [csrfToken, setCsrfToken] = useState('');
  const [submitError, setSubmitError] = useState('');
  function close() {
    setAuthToken('');
    setCsrfToken('');
    setSubmitError('');
    onClose();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitError('');
    if (await onSave(authToken, csrfToken)) {
      setAuthToken('');
      setCsrfToken('');
    }
  }
  return <section className="auth-session-panel" aria-label="X 登录设置">
    <span className="auth-session-icon"><ShieldCheck size={21} /></span>
    <div className="auth-session-copy">
      <strong>{configured ? 'X 账号已连接' : '连接你的 X 账号'}</strong>
      <small>{native
        ? '公开帖子无需登录。连接账号后，可保存该账号有权查看的帖子；登录信息会在本机加密保存。'
        : '只填写 auth_token 与 ct0，不要填写 X 密码。会话由私有服务加密保存；公开帖子仍可在未连接时下载。'}</small>
    </div>
    {browserSession && <form className="pwa-session-form" onSubmit={(event) => void submit(event)}>
      {configured
        ? <div className="pwa-session-configured" role="status">已配置 X 会话。此页面不显示或读取已保存的 Cookie。</div>
        : !available && stored
          ? <div className="pwa-session-configured" role="status">服务器无法读取旧会话。可恢复原加密密钥，或移除后重新配置登录。</div>
          : available && <>
        <label>auth_token<input type="password" name="auth_token" autoComplete="off" spellCheck={false} value={authToken} maxLength={512} disabled={!available || busy} onChange={(event) => setAuthToken(event.target.value)} /></label>
        <label>ct0<input type="password" name="ct0" autoComplete="off" spellCheck={false} value={csrfToken} maxLength={512} disabled={!available || busy} onChange={(event) => setCsrfToken(event.target.value)} /></label>
      </>}
      {(error || submitError) && <p className="pwa-session-error" role="alert">{submitError || error}</p>}
      <div className="auth-session-actions">
        {configured || (stored && !available)
          ? <button className="danger-outline-button" type="button" onClick={onDisconnect} disabled={busy}>移除登录</button>
          : available && <button className="auth-login-button" type="submit" disabled={busy || !authToken || !csrfToken}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{busy ? '正在保存…' : '保存会话'}
          </button>}
        {!configured && stored && available && <button className="danger-outline-button" type="button" onClick={onDisconnect} disabled={busy}>移除旧会话</button>}
        <button className="auth-close-button" type="button" onClick={close} aria-label="关闭 X 登录设置"><X size={18} /></button>
      </div>
    </form>}
    {native && <div className="auth-session-actions">
      {configured ? <button className="danger-outline-button" type="button" onClick={onDisconnect} disabled={busy}>移除登录</button>
        : <button className="auth-login-button" type="button" onClick={onConnect} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}打开 X 登录</button>}
      <button className="auth-close-button" type="button" onClick={close} aria-label="关闭 X 登录设置"><X size={18} /></button>
    </div>}
  </section>;
}
