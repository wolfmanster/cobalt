export function extractUrls(text: string) {
  return [...new Set((text.match(/https:\/\/[^\s,;"'<>]+/gi) ?? []).map((url) => url.replace(/[)\].，。！？]+$/u, '')))];
}

export function formatBytes(bytes?: number) {
  if (bytes === undefined) return '大小未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function formatDate(value?: string) {
  if (!value) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
