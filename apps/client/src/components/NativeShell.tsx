import { ArrowDownToLine, Check, FolderCheck, FolderOpen, History, Home, Link2, LoaderCircle, Search, ShieldCheck } from 'lucide-react';

export type NativeTab = 'queue' | 'search' | 'history';
const PAGE_COPY: Record<NativeTab, { title: string; subtitle: string }> = {
  queue: { title: '媒体归档', subtitle: '收藏值得留下的瞬间' },
  search: { title: '搜索', subtitle: '从作者或内容找回收藏' },
  history: { title: '历史记录', subtitle: '已保存的内容，都在这里' },
};

export function NativeHeader({ tab, folderReady, folderLabel, choosingFolder, sessionConfigured, sessionBusy, serviceHealthy, onFolder, onAccount }: {
  tab: NativeTab; folderReady: boolean; folderLabel: string; choosingFolder: boolean;
  sessionConfigured: boolean; sessionBusy: boolean; serviceHealthy: boolean | null;
  onFolder: () => void; onAccount: () => void;
}) {
  const copy = PAGE_COPY[tab];
  const serviceLabel = serviceHealthy === null ? '正在检查本地服务' : serviceHealthy ? '本地服务可用' : '本地服务不可用';
  return <header className={`native-header ${tab === 'history' ? 'is-minimal' : ''}`}>
    <div className="native-header-copy">{tab !== 'history' && <h1>{copy.title}</h1>}<p>{copy.subtitle}</p></div>
    <div className="native-header-actions">
      <span className={`native-service-dot ${serviceHealthy === false ? 'is-offline' : serviceHealthy === null ? 'is-checking' : ''}`} role="status" aria-label={serviceLabel} title={serviceLabel} />
      {tab === 'queue' && <>
      <button type="button" className="native-icon-button" onClick={onFolder} disabled={choosingFolder} title={`下载位置：${folderLabel}`} aria-label="更改下载位置">
        {choosingFolder ? <LoaderCircle className="spin" size={20} /> : folderReady ? <FolderCheck size={20} /> : <FolderOpen size={20} />}
      </button>
      <button type="button" className={`native-icon-button native-account-button ${sessionConfigured ? 'is-ready' : ''}`} onClick={onAccount} disabled={sessionBusy} title={sessionConfigured ? '管理 X 登录' : '登录 X'} aria-label={sessionConfigured ? '管理 X 登录' : '登录 X'}>
        {sessionBusy ? <LoaderCircle className="spin" size={20} /> : <ShieldCheck size={20} />}
        {sessionConfigured && <span className="native-account-dot" />}
      </button>
      </>}
    </div>
    {serviceHealthy === false && <div className="native-service-warning" role="status">本地服务暂不可用，请稍后重试</div>}
  </header>;
}

export function NativeNavigation({ tab, onNavigate, onCompose }: {
  tab: NativeTab; onNavigate: (tab: NativeTab) => void; onCompose: () => void;
}) {
  return <nav className="native-navigation" aria-label="主导航">
    <button type="button" className={tab === 'queue' ? 'selected' : ''} onClick={() => onNavigate('queue')} aria-current={tab === 'queue' ? 'page' : undefined}><Home size={22} /><span>首页</span></button>
    <button type="button" className="native-compose-action" onClick={onCompose} aria-label="新建下载链接"><Link2 size={22} /><span>新建</span></button>
    <button type="button" className={tab === 'search' ? 'selected' : ''} onClick={() => onNavigate('search')} aria-current={tab === 'search' ? 'page' : undefined}><Search size={22} /><span>搜索</span></button>
    <button type="button" className={tab === 'history' ? 'selected' : ''} onClick={() => onNavigate('history')} aria-current={tab === 'history' ? 'page' : undefined}><History size={22} /><span>历史</span></button>
  </nav>;
}

export function NativeDownloadStats({ activeCount, completedToday }: { activeCount: number; completedToday: number }) {
  return <section className="native-download-stats" aria-label="下载统计">
    <div><span className="native-stat-icon"><ArrowDownToLine size={19} /></span><span>进行中<strong>{activeCount}</strong></span></div>
    <div><span className="native-stat-icon is-complete"><Check size={19} /></span><span>今日完成<strong>{completedToday}</strong></span></div>
  </section>;
}
