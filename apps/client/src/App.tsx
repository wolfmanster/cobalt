import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createJobRefresh } from './jobRefresh';
import { HistoryBrowser } from './HistoryBrowser';
import { DownloadFolderDialog, ClearHistoryDialog } from './components/ArchiveDialogs';
import { LinkComposer } from './components/LinkComposer';
import { SessionPanel } from './components/SessionPanel';
import { NativeHeader, NativeNavigation, NativeDownloadStats } from './components/NativeShell';
import { JobCard } from './components/JobCard';
import { HistoryMediaViewer } from './components/HistoryMediaViewer';
import { useMediaViewer } from './hooks/useMediaViewer';
import { extractUrls } from './lib/format';
import {
  Archive,
  ArrowDownToLine,
  Check,
  CircleAlert,
  FolderCheck,
  FolderOpen,
  Home,
  History,
  Link2,
  LoaderCircle,
  Pause,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { cancelJob, clearHistory, clearXSession, consumeSharedContent, createJobs, getDownloadFolder, getHealth, getXSessionStatus, listJobs, openMedia, readClipboardText, retryJob, selectDownloadFolder, setDownloadPath, startXLogin, subscribeJobs, subscribeSharedContent, xLoginSupported } from './api';
import type { DownloadJob } from './types';

const HISTORY_PAGE_SIZE = 25;

export default function App() {
  const mediaViewer = useMediaViewer();
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [completedToday, setCompletedToday] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [input, setInput] = useState('');
  const [tab, setTab] = useState<'queue' | 'history' | 'search'>('queue');
  const [historyView, setHistoryView] = useState<'all' | 'authors'>('all');
  const [archiveRevision, setArchiveRevision] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false);
  const [folderReady, setFolderReady] = useState(false);
  const [folderLabel, setFolderLabel] = useState('Download/X Media Archive');
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [downloadSubfolder, setDownloadSubfolder] = useState('X Media Archive');
  const [serviceHealthy, setServiceHealthy] = useState<boolean | null>(null);
  const [sessionConfigured, setSessionConfigured] = useState(false);
  const [showSessionPanel, setShowSessionPanel] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const archiveBackHandler = useRef<(() => boolean) | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const handledSharedLinks = useRef(new Set<string>());
  const historyPageRef = useRef(0);
  const previousHistoryTotal = useRef<number | null>(null);
  const previousTab = useRef(tab);
  const [searchQuery, setSearchQuery] = useState('');
  const urls = useMemo(() => extractUrls(input), [input]);

  const registerArchiveBackHandler = useCallback((handler: (() => boolean) | null) => {
    archiveBackHandler.current = handler;
  }, []);

  const loadJobs = useMemo(() => createJobRefresh(listJobs, HISTORY_PAGE_SIZE, (result, page) => {
    if (xLoginSupported && previousHistoryTotal.current !== null && previousHistoryTotal.current !== result.historyTotal) {
      setArchiveRevision((current) => current + 1);
    }
    previousHistoryTotal.current = result.historyTotal;
    setJobs(result.jobs);
    setHistoryTotal(result.historyTotal);
    setCompletedToday(result.completedToday);
    historyPageRef.current = page;
    setHistoryPage(page);
  }), []);
  const refreshJobs = useCallback(() => loadJobs(historyPageRef.current), [loadJobs]);

  const submitUrls = useCallback(async (requestedUrls: string[]) => {
    if (!requestedUrls.length) return;
    setSubmitting(true);
    try {
      if (!(await getDownloadFolder()).selected) {
        setFolderDialogOpen(true);
        setNotice('请先重新设置下载位置');
        return;
      }
      const result = await createJobs(requestedUrls);
      setInput('');
      setTab('queue');
      const parts = [`新增 ${result.created.length} 条`];
      if (result.duplicates.length) parts.push(`去重 ${result.duplicates.length} 条`);
      if (result.rejected.length) parts.push(`拒绝 ${result.rejected.length} 条无效链接`);
      setNotice(parts.join('，'));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '提交失败');
    } finally {
      setSubmitting(false);
    }
  }, []);

  const receiveSharedContent = useCallback(async (text: string) => {
    const sharedUrls = extractUrls(text);
    const key = sharedUrls.join('\n');
    if (!key || handledSharedLinks.current.has(key)) return;
    handledSharedLinks.current.add(key);
    setInput(sharedUrls.join('\n'));
    setNotice(`已接收 ${sharedUrls.length} 条 X 链接，准备下载`);
    await submitUrls(sharedUrls);
  }, [submitUrls]);

  useEffect(() => {
    void refreshJobs().catch((error) => setNotice(error.message));
    void getDownloadFolder().then((result) => {
      setFolderReady(result.selected);
      if (result.label) {
        setFolderLabel(result.label);
        if (result.mode === 'downloads') setDownloadSubfolder(result.label.replace(/^Download\/?/, ''));
      }
    }).catch(() => undefined);
    if (xLoginSupported) {
      void getXSessionStatus().then((result) => setSessionConfigured(result.configured)).catch(() => undefined);
    }
    const events = subscribeJobs(() => { void refreshJobs().catch((error) => setNotice(error.message)); });
    const shared = subscribeSharedContent((text) => {
      void receiveSharedContent(text);
    });
    void consumeSharedContent().then((result) => {
      if (result.text) void receiveSharedContent(result.text);
    });
    return () => { void events.close(); void shared.close(); };
  }, [receiveSharedContent, refreshJobs]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 4200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!xLoginSupported) return;
    if (previousTab.current !== tab) window.scrollTo({ top: 0, behavior: 'auto' });
    previousTab.current = tab;
  }, [tab]);

  useEffect(() => {
    if (!xLoginSupported) return;
    const browserWindow = window as Window & { __cobaltGoBack?: () => boolean };
    const handleBack = () => {
      if (clearConfirmationOpen) {
        setClearConfirmationOpen(false);
        return true;
      }
      if (folderDialogOpen) {
        setFolderDialogOpen(false);
        return true;
      }
      if (showSessionPanel) {
        setShowSessionPanel(false);
        return true;
      }
      if (mediaViewer.closeIfOpen()) return true;
      if (archiveBackHandler.current?.()) return true;
      if (tab !== 'queue') {
        setTab('queue');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return true;
      }
      return false;
    };
    browserWindow.__cobaltGoBack = handleBack;
    return () => {
      if (browserWindow.__cobaltGoBack === handleBack) delete browserWindow.__cobaltGoBack;
    };
  }, [clearConfirmationOpen, folderDialogOpen, showSessionPanel, tab, mediaViewer.closeIfOpen]);

  useEffect(() => {
    let disposed = false;
    const refreshHealth = async () => {
      try {
        const health = await getHealth();
        if (!disposed) setServiceHealthy(health.ok && health.local);
      } catch {
        if (!disposed) setServiceHealthy(false);
      }
    };
    void refreshHealth();
    const interval = window.setInterval(() => void refreshHealth(), 30_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  const importFile = useCallback(async (file?: File) => {
    if (!file) return;
    if (!/\.(txt|csv)$/i.test(file.name)) {
      setNotice('请选择 TXT 或 CSV 文件');
      return;
    }
    const text = await file.text();
    const imported = extractUrls(text);
    setInput((current) => [...new Set([...extractUrls(current), ...imported])].join('\n'));
    setNotice(`已从 ${file.name} 读取 ${imported.length} 条链接`);
  }, []);

  async function submit() {
    if (!urls.length) return setNotice('请先粘贴至少一条 X 帖子链接');
    await submitUrls(urls);
  }

  async function action(kind: 'cancel' | 'retry', id: string) {
    try {
      await (kind === 'cancel' ? cancelJob(id) : retryJob(id));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作失败');
    }
  }

  async function clear() {
    setClearConfirmationOpen(false);
    setClearing(true);
    try {
      const { removed } = await clearHistory();
      historyPageRef.current = 0;
      setHistoryPage(0);
      await refreshJobs();
      setNotice(`已清除 ${removed} 条历史记录`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法清除历史记录');
    } finally {
      setClearing(false);
    }
  }

  function requestClearHistory() {
    setClearConfirmationOpen(true);
  }

  async function openJobMedia(id: string) {
    try {
      await openMedia(id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法打开媒体文件');
    }
  }

  async function chooseDownloadFolder() {
    setChoosingFolder(true);
    try {
      const result = await selectDownloadFolder();
      if (result.selected) {
        setFolderReady(true);
        if (result.label) setFolderLabel(result.label);
        setFolderDialogOpen(false);
        setNotice(`下载位置已设置为 ${result.label ?? '所选文件夹'}`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法选择下载文件夹');
    } finally {
      setChoosingFolder(false);
    }
  }

  const activeJobs = jobs.filter((job) => ['queued', 'resolving', 'downloading'].includes(job.status));
  const historyJobs = jobs.filter((job) => ['completed', 'failed', 'canceled'].includes(job.status));
  const visibleJobs = tab === 'queue' ? activeJobs : historyJobs;

  function openComposer() {
    if (xLoginSupported) {
      setTab('queue');
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('.native-ingest-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        textareaRef.current?.focus({ preventScroll: true });
      });
    } else {
      const panel = document.querySelector<HTMLElement>('.ingest-panel');
      panel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      textareaRef.current?.blur();
    }
    void readClipboardText().then((clipboardText) => {
      const value = clipboardText.trim();
      if (value) setInput((current) => current.trim() ? `${current.trim()}\n${value}` : value);
    }).catch(() => undefined);
  }

  async function connectX() {
    if (!xLoginSupported) {
      setNotice('请在 Android 应用中使用内置 X 登录；auth_token 与 ct0 会通过 Keystore 加密保存');
      return;
    }
    setSessionBusy(true);
    try {
      const result = await startXLogin();
      setSessionConfigured(result.configured);
      if (!result.canceled && result.configured) {
        setShowSessionPanel(false);
        setNotice('X 登录已加密保存；现在可下载当前账号有权查看的受保护帖子');
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法打开 X 登录');
    } finally {
      setSessionBusy(false);
    }
  }

  async function disconnectX() {
    setSessionBusy(true);
    try {
      const result = await clearXSession();
      setSessionConfigured(result.configured);
      setShowSessionPanel(false);
      setNotice('已移除本机保存的 X 登录；之后仅下载公开帖子');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法移除 X 登录');
    } finally {
      setSessionBusy(false);
    }
  }

  function jumpToTab(nextTab: 'queue' | 'history' | 'search') {
    setTab(nextTab);
    if (xLoginSupported) window.scrollTo({ top: 0, behavior: 'smooth' });
    else document.querySelector('.workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function saveDownloadSubfolder() {
    setChoosingFolder(true);
    try {
      const result = await setDownloadPath(downloadSubfolder);
      setFolderReady(result.selected);
      setFolderLabel(result.label ?? 'Download');
      setFolderDialogOpen(false);
      setNotice(`下载位置已设置为 ${result.label ?? 'Download'}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法设置下载位置');
    } finally {
      setChoosingFolder(false);
    }
  }

  function jumpHome() {
    setTab('queue');
    if (xLoginSupported) window.scrollTo({ top: 0, behavior: 'smooth' });
    else document.querySelector('#top')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showHistoryPage(page: number) {
    const lastPage = Math.max(0, Math.ceil(historyTotal / HISTORY_PAGE_SIZE) - 1);
    const nextPage = Math.min(Math.max(page, 0), lastPage);
    historyPageRef.current = nextPage;
    void refreshJobs().catch((error) => setNotice(error.message));
  }

  const ingestPanel = <LinkComposer native={xLoginSupported} input={input} linkCount={urls.length}
    submitting={submitting} sessionConfigured={sessionConfigured} textareaRef={textareaRef}
    onInput={setInput} onImport={importFile} onSubmit={() => void submit()} onPaste={openComposer} />;

  const sessionPanel = showSessionPanel && <SessionPanel native={xLoginSupported} configured={sessionConfigured}
    busy={sessionBusy} onConnect={() => void connectX()} onDisconnect={() => void disconnectX()}
    onClose={() => setShowSessionPanel(false)} />;

  const quickStats = (
    <section className="quick-stats" aria-label="下载统计">
      <div className="active-stat"><span className="stat-icon"><ArrowDownToLine size={29} /></span><div><span>正在下载</span><strong>{String(activeJobs.length).padStart(2, '0')}</strong></div></div>
      <div className="complete-stat"><span className="stat-icon"><Check size={31} /></span><div><span>今日完成</span><strong>{String(completedToday).padStart(2, '0')}</strong></div></div>
    </section>
  );

  return (
    <div className={`app-shell ${xLoginSupported ? 'is-native' : ''}`}>
      {xLoginSupported ? <NativeHeader tab={tab} folderReady={folderReady} folderLabel={folderLabel}
        choosingFolder={choosingFolder} sessionConfigured={sessionConfigured} sessionBusy={sessionBusy}
        serviceHealthy={serviceHealthy} onFolder={() => setFolderDialogOpen(true)}
        onAccount={() => setShowSessionPanel((visible) => !visible)} /> : (
      <header className={`topbar ${tab !== 'queue' ? 'is-compact' : ''}`}>
        <div className="topbar-actions">
          {tab === 'queue' && <>
            <button
              className={`folder-button ${folderReady ? 'is-ready' : ''}`}
              type="button"
              title={`下载位置：${folderLabel}，点击更改`}
              onClick={() => xLoginSupported ? setFolderDialogOpen(true) : void chooseDownloadFolder()}
              disabled={choosingFolder}
            >
              {choosingFolder ? <LoaderCircle className="spin" size={17} /> : folderReady ? <FolderCheck size={17} /> : <FolderOpen size={17} />}
              <span>{xLoginSupported ? '下载位置' : folderReady ? '文件夹已设置' : '选择下载文件夹'}</span>
            </button>
            <button
              className={`session-button ${sessionConfigured ? 'is-ready' : ''}`}
              type="button"
              title={sessionConfigured ? '管理已保存的 X 登录' : '登录 X 并加密保存 auth_token、ct0'}
              aria-label={sessionConfigured ? '管理已保存的 X 登录' : '登录 X 并加密保存 auth_token、ct0'}
              onClick={() => setShowSessionPanel((visible) => !visible)}
              disabled={sessionBusy}
            >
              {sessionBusy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}
              <span>{sessionConfigured ? 'X 已登录' : '登录 X'}</span>
            </button>
          </>}
          <div className={`service-state ${serviceHealthy === false ? 'is-offline' : ''}`}><span /> {serviceHealthy === null ? '正在检查本地服务' : serviceHealthy ? '本地服务可用' : '本地服务不可用'}</div>
        </div>
      </header>
      )}

      <main id="top" className={xLoginSupported ? 'native-main' : ''}>
        {xLoginSupported ? (
          <>
            {sessionPanel}
            <div className="native-pages">
              <section className={`native-page ${tab === 'queue' ? 'is-current' : ''}`} aria-label="首页">
                {ingestPanel}
                <NativeDownloadStats activeCount={activeJobs.length} completedToday={completedToday} />
                <section className="workspace">
                  <div className="workspace-head"><div className="workspace-title"><h2>进行中的任务</h2><p>下载状态会自动更新</p></div></div>
                  {activeJobs.length ? (
                    <div className="job-list">{activeJobs.map((job) => <JobCard key={job.id} job={job} onAction={action} onOpenMedia={(id) => void openJobMedia(id)} onPreviewMedia={mediaViewer.open} />)}</div>
                  ) : (
                    <div className="empty-state">
                      <span><Pause size={25} /></span>
                      <h3>准备好开始下载</h3>
                      <p>添加链接后，下载进度会实时出现在这里。</p>
                      <button onClick={openComposer}><Link2 size={15} />添加第一个链接</button>
                    </div>
                  )}
                </section>
              </section>

              <section className={`native-page native-search-page ${tab === 'search' ? 'is-current' : ''}`} aria-label="搜索">
                <HistoryBrowser
                  mode="search"
                  active={tab === 'search'}
                  revision={archiveRevision}
                  searchQuery={searchQuery}
                  onSearchQueryChange={setSearchQuery}
                  onDetailBackChange={registerArchiveBackHandler}
                  renderJob={(job) => <JobCard job={job} onAction={action} onOpenMedia={(id) => void openJobMedia(id)} onPreviewMedia={mediaViewer.open} presentation="history" />}
                  onError={setNotice}
                />
              </section>

              <section className={`native-page ${tab === 'history' ? 'is-current' : ''}`} aria-label="历史">
                <section className="workspace native-history-workspace">
                  <div className="workspace-head">
                    <div className="workspace-title"><h2>本地归档</h2><p>按帖子或作者浏览</p></div>
                    {historyTotal > 0 && <button className="clear-button" type="button" onClick={requestClearHistory} disabled={clearing}>{clearing ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{clearing ? '正在清除' : '清除'}</button>}
                  </div>
                  <div className="archive-view-tabs" role="tablist" aria-label="历史浏览方式">
                    <button type="button" role="tab" aria-selected={historyView === 'all'} className={historyView === 'all' ? 'selected' : ''} onClick={() => setHistoryView('all')}>全部推文</button>
                    <button type="button" role="tab" aria-selected={historyView === 'authors'} className={historyView === 'authors' ? 'selected' : ''} onClick={() => setHistoryView('authors')}>作者</button>
                  </div>
                  {historyView === 'authors' ? <HistoryBrowser
                    mode="authors"
                    revision={archiveRevision}
                    onDetailBackChange={registerArchiveBackHandler}
                    renderJob={(job) => <JobCard job={job} onAction={action} onOpenMedia={(id) => void openJobMedia(id)} onPreviewMedia={mediaViewer.open} presentation="history" />}
                    onError={setNotice}
                  /> : historyJobs.length ? (
                    <>
                      <div className="job-list history-post-list">{historyJobs.map((job) => <JobCard key={job.id} job={job} onAction={action} onOpenMedia={(id) => void openJobMedia(id)} onPreviewMedia={mediaViewer.open} presentation="history" />)}</div>
                      {historyTotal > HISTORY_PAGE_SIZE && <nav className="history-pagination" aria-label="下载历史分页">
                        <button onClick={() => showHistoryPage(historyPage - 1)} disabled={historyPage === 0}>上一页</button>
                        <span>第 {historyPage + 1} / {Math.ceil(historyTotal / HISTORY_PAGE_SIZE)} 页</span>
                        <button onClick={() => showHistoryPage(historyPage + 1)} disabled={(historyPage + 1) * HISTORY_PAGE_SIZE >= historyTotal}>下一页</button>
                      </nav>}
                    </>
                  ) : <div className="empty-state"><span><History size={25} /></span><h3>这里还很安静</h3><p>完成、失败或取消的任务都会保留在这里。</p></div>}
                </section>
              </section>
            </div>
          </>
        ) : (
          <>
            {ingestPanel}
            {sessionPanel}
            {quickStats}
            <section className="workspace">
              <div className="workspace-head">
                <div className="workspace-title"><span>下载管理</span><h2>{tab === 'queue' ? '正在下载' : tab === 'search' ? '搜索' : '历史记录'}</h2></div>
                {tab === 'history' && historyTotal > 0 && <button className="clear-button" type="button" onClick={requestClearHistory} disabled={clearing}>{clearing ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{clearing ? '正在清除' : '清除'}</button>}
              </div>
              {tab !== 'search' && <div className="tabs" role="tablist" aria-label="下载任务筛选">
                <button role="tab" aria-selected={tab === 'queue'} className={tab === 'queue' ? 'selected' : ''} onClick={() => setTab('queue')}><Archive size={17} />进行中 <span>{activeJobs.length}</span></button>
                <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'selected' : ''} onClick={() => setTab('history')}><History size={17} />历史 <span>{historyTotal}</span></button>
              </div>}
              {visibleJobs.length ? (
                <>
                  <div className={`job-list ${tab === 'history' ? 'history-post-list' : ''}`}>{visibleJobs.map((job) => <JobCard key={job.id} job={job} onAction={action} onOpenMedia={(id) => void openJobMedia(id)} onPreviewMedia={mediaViewer.open} presentation={tab === 'history' ? 'history' : 'queue'} />)}</div>
                  {tab === 'history' && historyTotal > HISTORY_PAGE_SIZE && <nav className="history-pagination" aria-label="下载历史分页">
                    <button onClick={() => showHistoryPage(historyPage - 1)} disabled={historyPage === 0}>上一页</button>
                    <span>第 {historyPage + 1} / {Math.ceil(historyTotal / HISTORY_PAGE_SIZE)} 页</span>
                    <button onClick={() => showHistoryPage(historyPage + 1)} disabled={(historyPage + 1) * HISTORY_PAGE_SIZE >= historyTotal}>下一页</button>
                  </nav>}
                </>
              ) : <div className="empty-state">
                <span>{tab === 'queue' ? <Pause size={25} /> : <History size={25} />}</span>
                <h3>{tab === 'queue' ? '准备好开始下载' : '这里还很安静'}</h3>
                <p>{tab === 'queue' ? '添加链接后，下载进度会实时出现在这里。' : '完成、失败或取消的任务都会保留在这里。'}</p>
                {tab === 'queue' && <button onClick={openComposer}><Link2 size={15} />添加第一个链接</button>}
              </div>}
            </section>
            <section className="privacy-note">
              <span><ShieldCheck size={19} /></span>
              <div><strong>{sessionConfigured ? '已启用受保护帖子下载' : '隐私优先'}</strong><small>{sessionConfigured ? '只使用 Keystore 加密的 X 会话，并仅发送给 X' : '无需登录时，不保存或发送任何 X Cookie'}</small></div>
              <Check size={17} />
            </section>
          </>
        )}
      </main>

      {xLoginSupported && <HistoryMediaViewer viewer={mediaViewer} />}

      <footer className="page-footer"><span>媒体由本地服务解析与保存</span><span>{xLoginSupported && sessionConfigured ? 'X 会话经 Android Keystore 加密' : '公开帖子无需登录'}</span></footer>
      {xLoginSupported ? <NativeNavigation tab={tab} onNavigate={jumpToTab} onCompose={openComposer} /> : (
      <nav className={`mobile-nav ${xLoginSupported ? 'has-search' : ''}`} aria-label="主导航">
        <button className={tab === 'queue' ? 'selected' : ''} onClick={jumpHome} aria-current={tab === 'queue' ? 'page' : undefined}>
          <Home size={21} /><span>首页</span>
        </button>
        <button className="mobile-add" onClick={openComposer} aria-label={xLoginSupported ? '新建下载链接' : '添加下载链接'}>
          <span><Link2 size={21} /></span><small>新建</small>
        </button>
        {xLoginSupported && <button className={tab === 'search' ? 'selected' : ''} onClick={() => jumpToTab('search')} aria-current={tab === 'search' ? 'page' : undefined}>
          <Search size={20} /><span>搜索</span>
        </button>}
        <button className={tab === 'history' ? 'selected' : ''} onClick={() => jumpToTab('history')} aria-current={tab === 'history' ? 'page' : undefined}>
          <History size={20} /><span>历史</span>{historyTotal > 0 && <b>{historyTotal}</b>}
        </button>
      </nav>
      )}
      {folderDialogOpen && <DownloadFolderDialog subfolder={downloadSubfolder} currentLocation={folderLabel} busy={choosingFolder}
        onSubfolder={setDownloadSubfolder} onSave={() => void saveDownloadSubfolder()}
        onChoose={() => void chooseDownloadFolder()} onClose={() => setFolderDialogOpen(false)} />}
      {clearConfirmationOpen && <ClearHistoryDialog busy={clearing} onConfirm={() => void clear()}
        onClose={() => setClearConfirmationOpen(false)} />}
      {notice && <div className="toast" role="status"><CircleAlert size={17} />{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><X size={15} /></button></div>}
    </div>
  );
}
