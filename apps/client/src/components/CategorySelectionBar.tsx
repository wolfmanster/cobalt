import { Check, FolderPlus, ListChecks, X } from 'lucide-react';

export function CategorySelectionBar({
  currentTweetIds,
  selectionMode,
  selectedCount,
  onStart,
  onStop,
  onSelectPage,
  onAssign,
}: {
  currentTweetIds: string[];
  selectionMode: boolean;
  selectedCount: number;
  onStart: () => void;
  onStop: () => void;
  onSelectPage: (tweetIds: string[]) => void;
  onAssign: () => void;
}) {
  if (!selectionMode) return <div className="category-selection-entry">
    <button type="button" className="category-quiet-button" onClick={onStart}><ListChecks size={15} />选择推文</button>
  </div>;

  return <div className="category-selection-bar" role="group" aria-label="批量分类操作">
    <span>{selectedCount ? `已选 ${selectedCount} 条` : '选择已完成推文'}</span>
    <button type="button" className="category-quiet-button" onClick={() => onSelectPage(currentTweetIds)} disabled={!currentTweetIds.length}>
      <Check size={15} />选中本页 ({currentTweetIds.length})
    </button>
    <button type="button" className="category-primary-button" onClick={onAssign} disabled={!selectedCount}>
      <FolderPlus size={15} />批量分类
    </button>
    <button type="button" className="category-quiet-button" onClick={onStop} aria-label="退出选择模式"><X size={15} />完成</button>
  </div>;
}
