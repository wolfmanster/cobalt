import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { DownloadJob } from './types';

export interface DownloadedAuthor {
  authorKey: string;
  authorName: string;
  username: string;
  avatarUrl: string;
  tweetCount: number;
  latestDownloadedAt: string;
}

export interface TweetCategory {
  id: string;
  name: string;
  createdAt: string;
  tweetCount: number;
}

export interface DownloadFolder {
  selected: boolean;
  mode?: 'downloads' | 'folder';
  label?: string;
}

export interface LocalArchivePlugin {
  listJobs(input?: { historyOffset?: number; historyLimit?: number }): Promise<{ jobs: DownloadJob[]; historyTotal: number; completedToday: number }>;
  listDownloadedPosts(input: { authorKey?: string; categoryId?: string; query: string; offset: number; limit: number }): Promise<{ jobs: DownloadJob[]; total: number }>;
  listAuthors(input: { query: string; offset: number; limit: number }): Promise<{ authors: DownloadedAuthor[]; total: number }>;
  listTweetCategories(): Promise<{ categories: TweetCategory[]; allTotal: number; uncategorizedTotal: number }>;
  createTweetCategory(input: { name: string }): Promise<TweetCategory>;
  renameTweetCategory(input: { id: string; name: string }): Promise<TweetCategory>;
  deleteTweetCategory(input: { id: string }): Promise<{ deleted: boolean }>;
  getTweetCategoryAssignments(input: { tweetIds: string[] }): Promise<{ assignments: Record<string, string[]> }>;
  updateTweetCategories(input: { tweetIds: string[]; addCategoryIds: string[]; removeCategoryIds: string[] }): Promise<{ updated: number }>;
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
  consumeSharedContent(): Promise<{ text: string }>;
  readClipboard(): Promise<{ text: string }>;
  openMedia(input: { id: string }): Promise<void>;
  selectDownloadFolder(): Promise<DownloadFolder>;
  setDownloadPath(input: { path: string }): Promise<DownloadFolder>;
  getDownloadFolder(): Promise<DownloadFolder>;
  addListener(eventName: 'jobsChanged', listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'categoriesChanged', listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'sharedContent', listenerFunc: (event: { text: string }) => void): Promise<PluginListenerHandle>;
}

export const LocalArchive = registerPlugin<LocalArchivePlugin>('LocalArchive');
