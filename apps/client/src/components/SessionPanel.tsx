import { LoaderCircle, ShieldCheck, X } from 'lucide-react';

export function SessionPanel({ native, configured, busy, onConnect, onDisconnect, onClose }: {
  native: boolean; configured: boolean; busy: boolean; onConnect: () => void; onDisconnect: () => void; onClose: () => void;
}) {
  return <section className="auth-session-panel" aria-label="X 登录设置">
    <span className="auth-session-icon"><ShieldCheck size={21} /></span>
    <div className="auth-session-copy">
      <strong>{configured ? 'X 账号已连接' : '连接你的 X 账号'}</strong>
      <small>{native ? '公开帖子无需登录。连接账号后，可保存该账号有权查看的帖子；登录信息会在本机加密保存。' : '请在 Android 应用中登录 X，登录信息会在本机加密保存。'}</small>
    </div>
    <div className="auth-session-actions">
      {configured ? <button className="danger-outline-button" type="button" onClick={onDisconnect} disabled={busy}>移除登录</button>
        : <button className="auth-login-button" type="button" onClick={onConnect} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}打开 X 登录</button>}
      <button className="auth-close-button" type="button" onClick={onClose} aria-label="关闭 X 登录设置"><X size={18} /></button>
    </div>
  </section>;
}
