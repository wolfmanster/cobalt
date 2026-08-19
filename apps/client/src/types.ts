export type JobStatus = 'queued' | 'resolving' | 'downloading' | 'completed' | 'failed' | 'canceled';

export interface PostMetadata {
  authorName: string;
  username: string;
  userId: string;
  avatarUrl: string;
  text: string;
  language: string;
  publishedAt: string;
}

export interface MediaItem {
  id: string;
  kind: 'video' | 'image' | 'gif';
  filename: string;
  contentType?: string;
  size?: number;
  downloadedBytes: number;
  totalBytes?: number;
  previewUrl: string;
  downloadUrl: string;
}

export interface DownloadJob {
  id: string;
  tweetId: string;
  sourceUrl: string;
  canonicalUrl: string;
  status: JobStatus;
  progress: number;
  metadata?: PostMetadata;
  media: MediaItem[];
  error?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
