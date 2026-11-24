import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createJobRefresh } from './jobRefresh';
import { HistoryBrowser } from './HistoryBrowser';
import { CategoryBrowser } from './CategoryBrowser';
import { DownloadFolderDialog, ClearHistoryDialog } from './components/ArchiveDialogs';
import { CategorySelectionBar } from './components/CategorySelectionBar';
import { CategoryNameDialog, DeleteCategoryDialog, TweetCategoryDialog } from './components/TweetCategoryDialogs';
import { LinkComposer } from './components/LinkComposer';
import { SessionPanel } from './components/SessionPanel';
import { NativeHeader, NativeNavigation, NativeDownloadStats } from './components/NativeShell';
import { JobCard } from './components/JobCard';
import { HistoryMediaViewer } from './components/HistoryMediaViewer';
import { useMediaViewer } from './hooks/useMediaViewer';
import { extractUrls } from './lib/format';
import {
  CircleAlert,
  History,
  Link2,
  LoaderCircle,
  Pause,
  Trash2,
  X,
} from 'lucide-react';
import { cancelJob, clearHistory, clearXSession, consumeSharedContent, createJobs, createTweetCategory, deleteTweetCategory, getDownloadFolder, getHealth, getXSessionStatus, listJobs, listTweetCategories, openMedia, readClipboardText, renameTweetCategory, retryJob, selectDownloadFolder, setDownloadPath, startXLogin, subscribeCategoryChanges, subscribeJobs, subscribeServerEvents, subscribeSharedContent, xLoginSupported } from './api';
import { downloadFolderSupported, isNativeAndroid, mobileShell, usesLocalArchive } from './platform';
import { subscribeServiceWorkerUpdate } from './pwa-update';
import type { DownloadJob } from './types';
import type { TweetCategory } from './nativeArchive';

const HISTORY_PAGE_SIZE = 25;

export default function App() {
  const mediaViewer = useMediaViewer();
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [completedToday, setCompletedToday] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [input, setInput] = useState('');
  const [tab, setTab] = useState<'queue' | 'history' | 'search'>('queue');
  const [historyView, setHistoryView] = useState<'all' | 'authors' | 'categories'>('all');
  const [categories, setCategories] = useState<TweetCategory[]>([]);
  const [allDownloadedCount, setAllDownloadedCount] = useState(0);
  const [uncategorizedCount, setUncategorizedCount] = useState(0);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedTweetIds, setSelectedTweetIds] = useState<Set<string>>(() => new Set());
  const [categoryTargets, setCategoryTargets] = useState<string[] | null>(null);
  const [categoryNameDialogOpen, setCategoryNameDialogOpen] = useState(false);
  const [categoryToRename, setCategoryToRename] = useState<TweetCategory | null>(null);
  const [categoryToDelete, setCategoryToDelete] = useState<TweetCategory | null>(null);
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
  const [offline, setOffline] = useState(!isNativeAndroid && typeof navigator !== 'undefined' && navigator.onLine === false);
  const [applyUpdate, setApplyUpdate] = useState<(() => void) | null>(null);
  const urls = useMemo(() => extractUrls(input), [input]);

  const registerArchiveBackHandler = useCallback((handler: (() => boolean) | null) => {
    archiveBackHandler.current = handler;
  }, []);

  const loadJobs = useMemo(() => createJobRefresh(listJobs, HISTORY_PAGE_SIZE, (result, page) => {
    if (previousHistoryTotal.current !== null && previousHistoryTotal.current !== result.historyTotal) {
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
  const refreshCategories = useCallback(async () => {
    const result = await listTweetCategories();
    setCategories(result.categories);
    setAllDownloadedCount(result.allTotal);
    setUncategorizedCount(result.uncategorizedTotal);
  }, []);

  const submitUrls = useCallback(async (requestedUrls: string[]) => {
    if (!requestedUrls.length) return;
    if (requestedUrls.length > 200) {
      setNotice('每批最多 200 条');
      return;
    }
    setSubmitting(true);
    try {
      if (downloadFolderSupported && !(await getDownloadFolder()).selected) {
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
    if (downloadFolderSupported) {
      void getDownloadFolder().then((result) => {
        setFolderReady(result.selected);
        if (result.label) {
          setFolderLabel(result.label);
          if (result.mode === 'downloads') setDownloadSubfolder(result.label.replace(/^Download\/?/, ''));
        }
      }).catch(() => undefined);
    }
    if (xLoginSupported) {
      void getXSessionStatus().then((result) => setSessionConfigured(result.configured)).catch(() => undefined);
    }
    if (usesLocalArchive) {
      const events = subscribeJobs(() => { void refreshJobs().catch((error) => setNotice(error.message)); });
      const shared = subscribeSharedContent((text) => {
        void receiveSharedContent(text);
      });
      void consumeSharedContent().then((result) => {
        if (result.text) void receiveSharedContent(result.text);
      });
      return () => { void events.close(); void shared.close(); };
    }
    void refreshCategories().catch((error) => setNotice(error instanceof Error ? error.message : '无法读取分类'));
    const events = subscribeServerEvents(() => {
      void refreshJobs().catch((error) => setNotice(error.message));
      void refreshCategories().catch((error) => setNotice(error instanceof Error ? error.message : '无法刷新分类'));
      setArchiveRevision((current) => current + 1);
    });
    return () => { void events.close(); };
  }, [receiveSharedContent, refreshCategories, refreshJobs]);

  useEffect(() => {
    if (!usesLocalArchive) return;
    void refreshCategories().catch((error) => setNotice(error instanceof Error ? error.message : '无法读取分类'));
    const events = subscribeCategoryChanges(() => {
      setArchiveRevision((current) => current + 1);
      void refreshCategories().catch((error) => setNotice(error instanceof Error ? error.message : '无法刷新分类'));
      void refreshJobs().catch((error) => setNotice(error.message));
    });
    return () => { void events.close(); };
  }, [refreshCategories, refreshJobs]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 4200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!mobileShell) return;
    if (previousTab.current !== tab) window.scrollTo({ top: 0, behavior: 'auto' });
    previousTab.current = tab;
  }, [tab]);

  useEffect(() => {
    if (!isNativeAndroid) return;
    const browserWindow = window as Window & { __cobaltGoBack?: () => boolean };
    const handleBack = () => {
      if (categoryTargets !== null) {
        setCategoryTargets(null);
        return true;
      }
      if (categoryNameDialogOpen || categoryToDelete !== null) {
        setCategoryNameDialogOpen(false);
        setCategoryToRename(null);
        setCategoryToDelete(null);
        return true;
      }
      if (selectionMode) {
        setSelectionMode(false);
        setSelectedTweetIds(new Set());
        return true;
      }
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
  }, [categoryTargets, categoryNameDialogOpen, categoryToDelete, selectionMode, clearConfirmationOpen, folderDialogOpen, showSessionPanel, tab, mediaViewer.closeIfOpen]);

  const authorDetailSources = useRef(new Map<string, boolean>());
  const [authorDetailOpen, setAuthorDetailOpen] = useState(false);
  const noteAuthorDetail = useCallback((source: string, open: boolean) => {
    authorDetailSources.current.set(source, open);
    const anyOpen = [...authorDetailSources.current.values()].some(Boolean);
    setAuthorDetailOpen((current) => current === anyOpen ? current : anyOpen);
  }, []);
  const noteSearchAuthorDetail = useCallback((open: boolean) => noteAuthorDetail('search', open), [noteAuthorDetail]);
  const noteAuthorsAuthorDetail = useCallback((open: boolean) => noteAuthorDetail('authors', open), [noteAuthorDetail]);
  const closeBrowserLayer = useCallback(() => {
    if (categoryTargets !== null) {
      setCategoryTargets(null);
      return true;
    }
    if (categoryNameDialogOpen || categoryToDelete !== null) {
      setCategoryNameDialogOpen(false);
      setCategoryToRename(null);
      setCategoryToDelete(null);
      return true;
    }
    if (selectionMode) {
      setSelectionMode(false);
      setSelectedTweetIds(new Set());
      return true;
    }
    if (clearConfirmationOpen) {
      setClearConfirmationOpen(false);
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
  }, [categoryTargets, categoryNameDialogOpen, categoryToDelete, selectionMode, clearConfirmationOpen, tab, mediaViewer.closeIfOpen]);
  const browserLayers = useCallback(() => {
    const layers: string[] = [];
    if (tab !== 'queue') layers.push(`tab:${tab}`);
    if (authorDetailOpen) layers.push('author');
    if (mediaViewer.preview) layers.push('preview');
    if (clearConfirmationOpen) layers.push('clear');
    if (selectionMode) layers.push('select');
    if (categoryNameDialogOpen || categoryToDelete) layers.push('name');
    if (categoryTargets) layers.push('assign');
    return layers;
  }, [tab, authorDetailOpen, mediaViewer.preview, clearConfirmationOpen, selectionMode, categoryNameDialogOpen, categoryToDelete, categoryTargets]);
  const layerStack = useRef<string[]>([]);
  const popGuard = useRef(false);
  useEffect(() => {
    if (isNativeAndroid) return;
    const onPop = () => {
      if (popGuard.current) {
        popGuard.current = false;
        return;
      }
      popGuard.current = true;
      if (!closeBrowserLayer()) popGuard.current = false;
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [closeBrowserLayer]);
  useEffect(() => {
    if (isNativeAndroid) return;
    const next = browserLayers();
    const previous = layerStack.current;
    if (popGuard.current) {
      popGuard.current = false;
      layerStack.current = next;
      return;
    }
    if (next.length === previous.length && next.every((item, index) => item === previous[index])) return;
    const grew = next.length > previous.length && previous.every((item, index) => next[index] === item);
    if (grew) {
      for (let index = previous.length; index < next.length; index += 1) history.pushState({ veoLayer: next[index] }, '');
      layerStack.current = next;
      return;
    }
    const shrank = previous.length > next.length && next.every((item, index) => item === previous[index]);
    if (shrank) {
      popGuard.current = true;
      layerStack.current = next;
      history.go(next.length - previous.length);
      return;
    }
    if (previous.length === next.length && next.length > 0) history.replaceState({ veoLayer: next[next.length - 1] }, '');
    layerStack.current = next;
  }, [browserLayers]);

  useEffect(() => {
    let disposed = false;
    const refreshHealth = async () => {
      try {
        const health = await getHealth();
        if (!disposed) setServiceHealthy(usesLocalArchive ? Boolean(health.ok && health.local) : Boolean(health.ok && health.cobalt));
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

  useEffect(() => {
    if (isNativeAndroid || !('scrollRestoration' in history)) return;
    const previous = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    return () => { history.scrollRestoration = previous; };
  }, []);

  useEffect(() => {
    if (isNativeAndroid) return;
    const show = () => setOffline(true);
    const hide = () => setOffline(false);
    window.addEventListener('offline', show);
    window.addEventListener('online', hide);
    return () => {
      window.removeEventListener('offline', show);
      window.removeEventListener('online', hide);
    };
  }, []);

  useEffect(() => subscribeServiceWorkerUpdate((apply) => setApplyUpdate(() => apply)), []);

  useEffect(() => {
    if (isNativeAndroid || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const shell = document.querySelector<HTMLElement>('.app-shell');
    const apply = () => {
      const overlap = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      shell?.style.setProperty('--keyboard-overlap', `${overlap}px`);
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement) active.scrollIntoView({ block: 'nearest' });
    };
    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
    return () => {
      viewport.removeEventListener('resize', apply);
      viewport.removeEventListener('scroll', apply);
      shell?.style.removeProperty('--keyboard-overlap');
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
      setArchiveRevision((current) => current + 1);
      await refreshCategories();
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
      await openMedia({ id });
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

  function openComposer() {
    setTab('queue');
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('.native-ingest-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      textareaRef.current?.focus({ preventScroll: true });
    });
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

  function clearSelection() {
    setSelectionMode(false);
    setSelectedTweetIds(new Set());
  }

  function toggleSelectedTweet(tweetId: string) {
    setSelectedTweetIds((current) => {
      const next = new Set(current);
      if (next.has(tweetId)) next.delete(tweetId);
      else next.add(tweetId);
      return next;
    });
  }

  function selectCurrentPage(tweetIds: string[]) {
    setSelectedTweetIds((current) => new Set([...current, ...tweetIds]));
  }

  function openCategoryPanel(tweetIds: string[]) {
    const uniqueIds = [...new Set(tweetIds)];
    if (uniqueIds.length) setCategoryTargets(uniqueIds);
  }

  async function saveCategoryName(name: string) {
    if (categoryToRename) await renameTweetCategory(categoryToRename.id, name);
    else await createTweetCategory(name);
    setCategoryNameDialogOpen(false);
    setCategoryToRename(null);
    setArchiveRevision((current) => current + 1);
    void refreshCategories().catch((error) => setNotice(error instanceof Error ? error.message : '无法刷新分类'));
  }

  async function confirmDeleteCategory() {
    if (!categoryToDelete) return;
    await deleteTweetCategory(categoryToDelete.id);
    setCategoryToDelete(null);
    clearSelection();
    setArchiveRevision((current) => current + 1);
    await refreshCategories();
  }

  function finishCategoryAssignment() {
    setCategoryTargets(null);
    clearSelection();
    setArchiveRevision((current) => current + 1);
    void Promise.all([refreshJobs(), refreshCategories()]).catch((error) => setNotice(error instanceof Error ? error.message : '分类已保存，但列表刷新失败'));
  }

  function onCategoryCreated(category: TweetCategory) {
    setCategories((current) => current.some((item) => item.id === category.id) ? current : [...current, category]);
    setArchiveRevision((current) => current + 1);
  }

  function renderHistoryJob(job: DownloadJob) {
    return <JobCard key={job.id} job={job} onAction={action} onOpenMedia={(id) => void openJobMedia(id)} onPreviewMedia={mediaViewer.open} onNotice={setNotice} presentation="history"
      onClassify={(tweetId) => openCategoryPanel([tweetId])} selectionMode={selectionMode}
      selected={selectedTweetIds.has(job.tweetId)} onToggleSelection={toggleSelectedTweet} />;
  }

  function jumpToTab(nextTab: 'queue' | 'history' | 'search') {
    clearSelection();
    setTab(nextTab);
    window.scrollTo({ top: 0, behavior: 'smooth' });
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

  function showHistoryPage(page: number) {
    const lastPage = Math.max(0, Math.ceil(historyTotal / HISTORY_PAGE_SIZE) - 1);
    const nextPage = Math.min(Math.max(page, 0), lastPage);
    historyPageRef.current = nextPage;
    void refreshJobs().catch((error) => setNotice(error.message));
  }

  const ingestPanel = <LinkComposer mobile={mobileShell} androidSession={xLoginSupported} input={input} linkCount={urls.length}
    submitting={submitting} sessionConfigured={sessionConfigured} textareaRef={textareaRef}
    onInput={setInput} onImport={importFile} onSubmit={() => void submit()} onPaste={openComposer} />;

  const sessionPanel = showSessionPanel && <SessionPanel native={xLoginSupported} configured={sessionConfigured}
    busy={sessionBusy} onConnect={() => void connectX()} onDisconnect={() => void disconnectX()}
    onClose={() => setShowSessionPanel(false)} />;

  return (
    <div className={`app-shell is-mobile-shell${isNativeAndroid ? ' is-native' : ''}`}>
      <NativeHeader tab={tab} folderReady={folderReady} folderLabel={folderLabel}
        choosingFolder={choosingFolder} sessionConfigured={sessionConfigured} sessionBusy={sessionBusy}
        serviceHealthy={serviceHealthy} showAndroidChrome={isNativeAndroid} onFolder={() => setFolderDialogOpen(true)}
        onAccount={() => setShowSessionPanel((visible) => !visible)} />
      {!isNativeAndroid && offline && <div className="offline-hint" role="status">当前离线，归档仍在服务器</div>}
      {applyUpdate && <div className="update-hint" role="status">有新版本，刷新后更新<button type="button" onClick={() => applyUpdate()}>刷新</button></div>}

      <main id="top" className="native-main">
          <>
            {isNativeAndroid && sessionPanel}
            <div className="native-pages">
              <section className={`native-page ${tab === 'queue' ? 'is-current' : ''}`} aria-label="首页">
                {ingestPanel}
                <NativeDownloadStats activeCount={activeJobs.length} completedToday={completedToday} />
                <section className="workspace">
                  <div className="workspace-head"><div className="workspace-title"><h2>进行中的任务</h2><p>下载状态会自动更新</p></div></div>
                  {activeJobs.length ? (
                    <div className="job-list">{activeJobs.map((job) => <JobCard key={job.id} job={job} onAction={action} onOpenMedia={(id) => void openJobMedia(id)} onPreviewMedia={mediaViewer.open} onNotice={setNotice} />)}</div>
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
                  onAuthorDetailChange={noteSearchAuthorDetail}
                  selectionMode={selectionMode} selectedTweetIds={selectedTweetIds}
                  onStartSelection={() => setSelectionMode(true)} onStopSelection={clearSelection}
                  onSelectPage={selectCurrentPage} onAssign={() => openCategoryPanel([...selectedTweetIds])}
                  onScopeChange={clearSelection}
                  renderJob={renderHistoryJob}
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
                    <button type="button" role="tab" aria-selected={historyView === 'all'} className={historyView === 'all' ? 'selected' : ''} onClick={() => { clearSelection(); setHistoryView('all'); }}>全部推文</button>
                    <button type="button" role="tab" aria-selected={historyView === 'authors'} className={historyView === 'authors' ? 'selected' : ''} onClick={() => { clearSelection(); setHistoryView('authors'); }}>作者</button>
                    <button type="button" role="tab" aria-selected={historyView === 'categories'} className={historyView === 'categories' ? 'selected' : ''} onClick={() => { clearSelection(); setHistoryView('categories'); }}>分类</button>
                  </div>
                  {historyView === 'authors' ? <HistoryBrowser
                    mode="authors"
                    revision={archiveRevision}
                    onDetailBackChange={registerArchiveBackHandler}
                    onAuthorDetailChange={noteAuthorsAuthorDetail}
                    selectionMode={selectionMode} selectedTweetIds={selectedTweetIds}
                    onStartSelection={() => setSelectionMode(true)} onStopSelection={clearSelection}
                    onSelectPage={selectCurrentPage} onAssign={() => openCategoryPanel([...selectedTweetIds])}
                    onScopeChange={clearSelection}
                    renderJob={renderHistoryJob}
                    onError={setNotice}
                  /> : historyView === 'categories' ? <CategoryBrowser
                    categories={categories} allTotal={allDownloadedCount} uncategorizedTotal={uncategorizedCount}
                    revision={archiveRevision} renderJob={renderHistoryJob} onError={setNotice}
                    selectionMode={selectionMode} selectedTweetIds={selectedTweetIds}
                    onStartSelection={() => setSelectionMode(true)} onStopSelection={clearSelection}
                    onSelectPage={selectCurrentPage} onAssign={() => openCategoryPanel([...selectedTweetIds])}
                    onScopeChange={clearSelection} onCreate={() => { setCategoryToRename(null); setCategoryNameDialogOpen(true); }}
                    onRename={(category) => { setCategoryToRename(category); setCategoryNameDialogOpen(true); }}
                    onDelete={setCategoryToDelete}
                  /> : historyJobs.length ? (
                    <>
                      <CategorySelectionBar currentTweetIds={[...new Set(historyJobs.filter((job) => job.status === 'completed').map((job) => job.tweetId))]}
                        selectionMode={selectionMode} selectedCount={selectedTweetIds.size} onStart={() => setSelectionMode(true)} onStop={clearSelection}
                        onSelectPage={selectCurrentPage} onAssign={() => openCategoryPanel([...selectedTweetIds])} />
                      <div className="job-list history-post-list">{historyJobs.map(renderHistoryJob)}</div>
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
      </main>

      <HistoryMediaViewer viewer={mediaViewer} />

      <footer className="page-footer"><span>{isNativeAndroid ? '媒体由本地服务解析与保存' : '媒体由服务器归档'}</span><span>{isNativeAndroid && sessionConfigured ? 'X 会话经 Android Keystore 加密' : '公开帖子无需登录'}</span></footer>
      <NativeNavigation tab={tab} onNavigate={jumpToTab} onCompose={openComposer} />
      {isNativeAndroid && folderDialogOpen && <DownloadFolderDialog subfolder={downloadSubfolder} currentLocation={folderLabel} busy={choosingFolder}
        onSubfolder={setDownloadSubfolder} onSave={() => void saveDownloadSubfolder()}
        onChoose={() => void chooseDownloadFolder()} onClose={() => setFolderDialogOpen(false)} />}
      {clearConfirmationOpen && <ClearHistoryDialog busy={clearing} removesServerArchive={!isNativeAndroid} onConfirm={() => void clear()}
        onClose={() => setClearConfirmationOpen(false)} />}
      {categoryTargets !== null && <TweetCategoryDialog tweetIds={categoryTargets} categories={categories}
        onCreateCategory={onCategoryCreated} onClose={() => setCategoryTargets(null)} onSaved={finishCategoryAssignment} />}
      {categoryNameDialogOpen && <CategoryNameDialog category={categoryToRename ?? undefined}
        onClose={() => { setCategoryNameDialogOpen(false); setCategoryToRename(null); }} onSave={saveCategoryName} />}
      {categoryToDelete && <DeleteCategoryDialog category={categoryToDelete} onClose={() => setCategoryToDelete(null)} onConfirm={confirmDeleteCategory} />}
      {notice && <div className="toast" role="status"><CircleAlert size={17} />{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><X size={15} /></button></div>}
    </div>
  );
}
