import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { DownloadJob } from './types';

export interface LocalArchivePlugin {
  listJobs(): Promise<{ jobs: DownloadJob[] }>;
  createJobs(input: { urls: string[] }): Promise<{
    created: DownloadJob[];
    duplicates: DownloadJob[];
    rejected: Array<{ url: string; error: string }>;
  }>;
  cancelJob(input: { id: string }): Promise<DownloadJob>;
  retryJob(input: { id: string }): Promise<DownloadJob>;
  clearHistory(): Promise<{ removed: number }>;
  getHealth(): Promise<{ ok: boolean; local: boolean }>;
  getXSessionStatus(): Promise<{ configured: boolean }>;
  startXLogin(): Promise<{ configured: boolean; canceled: boolean }>;
  clearXSession(): Promise<{ configured: boolean }>;
  readClipboard(): Promise<{ text: string }>;
  openMedia(input: { id: string }): Promise<void>;
  selectDownloadFolder(): Promise<{ selected: boolean; uri?: string }>;
  getDownloadFolder(): Promise<{ selected: boolean }>;
  shareMedia(input: { id: string }): Promise<void>;
  addListener(eventName: 'jobsChanged', listenerFunc: (event: { jobs: DownloadJob[] }) => void): Promise<PluginListenerHandle>;
}

export const LocalArchive = registerPlugin<LocalArchivePlugin>('LocalArchive');
