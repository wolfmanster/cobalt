// A deterministic Capacitor bridge used only by browser regression tests.
// It never touches the device database, network sessions, or download folders.
export function installNativeFixture(options = {}) {
  const image = (width, height, color) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/><circle cx="${width * .72}" cy="${height * .26}" r="${width * .12}" fill="#fff" opacity=".65"/><path d="M0 ${height * .7} L${width * .35} ${height * .38} L${width} ${height * .86} V${height} H0Z" fill="#1c3945" opacity=".5"/></svg>`)}`;
  const sourceMedia = [
    { width: 600, height: 900, color: '#79a99d' },
    { width: 1200, height: 800, color: '#88b5d1' },
    { width: 800, height: 800, color: '#cfb5a2' },
    { width: 1600, height: 900, color: '#8096c0' },
  ].map(({ width, height, color }, i) => ({
    id: `media-${i}`, kind: 'image', filename: `landscape-${i + 1}.jpg`, downloadedBytes: 1024,
    size: 1024, previewUrl: image(width, height, color), downloadUrl: '',
  }));
  const media = Array.from({ length: options.mediaCount ?? sourceMedia.length }, (_, i) => ({ ...sourceMedia[i % sourceMedia.length], id: `media-${i}`, filename: `landscape-${i + 1}.jpg` }));
  const makeJob = (i, status = 'completed') => ({
    id: `job-${i}`, tweetId: String(1800000000000000000n + BigInt(i)), sourceUrl: `https://x.com/archive/status/${i}`,
    canonicalUrl: `https://x.com/archive/status/${i}`, status, progress: status === 'downloading' ? 42 : status === 'completed' ? 100 : 0,
    attempts: 1, createdAt: '2026-09-30T01:00:00Z', updatedAt: '2026-09-30T01:00:00Z',
    metadata: { authorName: '山间来信', username: 'mountain_notes', userId: 'author-1',
      avatarUrl: image(80, 80, '#84afa1'), text: '把路上遇见的风景留下来。\n山间的光、湖面的风，还有安静的午后。',
      language: 'zh', publishedAt: '2026-09-29T08:30:00Z' },
    media: status === 'completed' ? media.map((item) => ({ ...item, id: `${i}-${item.id}` })) : [],
  });
  const authors = [{ authorKey: 'author-1', authorName: '山间来信', username: 'mountain_notes',
    avatarUrl: image(80, 80, '#84afa1'), tweetCount: 27, latestDownloadedAt: '2026-09-30T01:00:00Z' }];
  let jobs = options.empty ? [] : [makeJob(100, 'downloading'), makeJob(101, 'queued'), ...Array.from({ length: 27 }, (_, i) => makeJob(i))];
  let configured = options.configured ?? true;
  const listeners = new Map();
  let callbackId = 0;
  const calls = [];
  const emit = (eventName, data) => { for (const listener of listeners.values()) if (listener.eventName === eventName) listener.callback(data); };
  const terminal = () => jobs.filter((job) => ['completed', 'failed', 'canceled'].includes(job.status));
  const matching = (query) => !query || `${authors[0].authorName} ${authors[0].username} ${jobs[0]?.metadata?.text}`.toLowerCase().includes(query.replace(/^@/, '').toLowerCase());
  const implementations = {
    listJobs: ({ historyOffset = 0, historyLimit = 25 } = {}) => ({
      jobs: [...jobs.filter((job) => ['queued', 'resolving', 'downloading'].includes(job.status)), ...terminal().slice(historyOffset, historyOffset + historyLimit)],
      historyTotal: terminal().length, completedToday: terminal().filter((job) => job.status === 'completed').length,
    }),
    listDownloadedPosts: ({ query = '', offset = 0, limit = 25 } = {}) => ({ jobs: matching(query) ? terminal().slice(offset, offset + limit) : [], total: matching(query) ? terminal().length : 0 }),
    listAuthors: ({ query = '' } = {}) => ({ authors: !options.empty && matching(query) ? authors : [], total: !options.empty && matching(query) ? 1 : 0 }),
    getDownloadFolder: () => ({ selected: true, mode: 'downloads', label: 'Download/X Media Archive' }),
    getXSessionStatus: () => ({ configured }), getHealth: () => ({ ok: !options.offline, local: true }),
    consumeSharedContent: () => ({ text: options.shared ?? '' }), readClipboard: () => ({ text: 'https://x.com/archive/status/1234567890' }),
    startXLogin: () => { configured = true; return { configured: true, canceled: false }; },
    clearXSession: () => { configured = false; return { configured: false }; },
    setDownloadPath: ({ path }) => ({ selected: true, mode: 'downloads', label: `Download/${path}` }),
    selectDownloadFolder: () => ({ selected: true, mode: 'folder', label: 'Archive' }),
    createJobs: ({ urls }) => { const created = urls.map((_, i) => makeJob(200 + i, 'queued')); jobs.push(...created); queueMicrotask(() => emit('jobsChanged')); return { created, duplicates: [], rejected: [] }; },
    cancelJob: ({ id }) => { const job = jobs.find((item) => item.id === id); job.status = 'canceled'; queueMicrotask(() => emit('jobsChanged')); return job; },
    retryJob: ({ id }) => { const job = jobs.find((item) => item.id === id); job.status = 'queued'; queueMicrotask(() => emit('jobsChanged')); return job; },
    clearHistory: () => { const removed = terminal().length; jobs = jobs.filter((job) => !terminal().includes(job)); queueMicrotask(() => emit('jobsChanged')); return { removed }; },
    openMedia: () => ({}),
    removeListener: ({ callbackId }) => { listeners.delete(callbackId); return {}; },
  };
  window.CapacitorCustomPlatform = { name: 'android' };
  window.Capacitor = {
    PluginHeaders: [{ name: 'LocalArchive', methods: [
      ...Object.keys(implementations).map((name) => ({ name, rtype: 'promise' })), { name: 'addListener', rtype: 'callback' },
    ] }],
    convertFileSrc: (path) => path,
    nativePromise: async (_plugin, method, args) => {
      calls.push({ method, args });
      if (!implementations[method]) throw new Error(`Unexpected fixture method: ${method}`);
      return implementations[method](args);
    },
    nativeCallback: async (_plugin, method, args, callback) => {
      if (method !== 'addListener') throw new Error(`Unexpected callback: ${method}`);
      const id = String(++callbackId); listeners.set(id, { eventName: args.eventName, callback }); return id;
    },
  };
  window.__nativeFixture = { calls, emit };
}
