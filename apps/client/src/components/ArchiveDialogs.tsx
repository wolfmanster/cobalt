import { useEffect, useRef, type ReactNode } from 'react';

function DialogFrame({ children, labelledBy, describedBy, alert = false, onClose }: {
  children: ReactNode; labelledBy: string; describedBy?: string; alert?: boolean; onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus({ preventScroll: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);
  return <div className="confirmation-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className={`confirmation-dialog ${alert ? '' : 'folder-dialog'}`} role={alert ? 'alertdialog' : 'dialog'} tabIndex={-1} aria-modal="true" aria-labelledby={labelledBy} aria-describedby={describedBy}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') return;
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
        if (!controls?.length) return;
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus(); }
      }}>{children}</section>
  </div>;
}

export function DownloadFolderDialog({ subfolder, currentLocation, busy, onSubfolder, onSave, onChoose, onClose }: {
  subfolder: string; currentLocation: string; busy: boolean; onSubfolder: (path: string) => void; onSave: () => void; onChoose: () => void; onClose: () => void;
}) {
  return <DialogFrame labelledBy="download-folder-title" onClose={onClose}>
    <h2 id="download-folder-title">下载位置</h2>
    <p>当前位置：{currentLocation}</p>
    <p>输入 Download 下的文件夹名称，也可以选择其他位置。支持多级路径，留空则保存到 Download。</p>
    <label className="folder-path-label" htmlFor="download-subfolder">Download /</label>
    <input id="download-subfolder" className="folder-path-input" value={subfolder} onChange={(event) => onSubfolder(event.target.value)} placeholder="X Media Archive" />
    <button className="folder-picker-button" type="button" onClick={onChoose} disabled={busy}>选择其他文件夹…</button>
    <div className="confirmation-actions">
      <button type="button" onClick={onClose} disabled={busy}>取消</button>
      <button className="confirmation-primary" type="button" onClick={onSave} disabled={busy}>{busy ? '正在保存…' : '保存位置'}</button>
    </div>
  </DialogFrame>;
}

export function ClearHistoryDialog({ busy, onConfirm, onClose }: { busy: boolean; onConfirm: () => void; onClose: () => void }) {
  return <DialogFrame alert labelledBy="clear-history-title" describedBy="clear-history-description" onClose={onClose}>
    <h2 id="clear-history-title">清除下载历史？</h2>
    <p id="clear-history-description">此操作会移除完成、失败和取消任务的历史记录，但不会删除已保存的媒体文件。</p>
    <div className="confirmation-actions">
      <button type="button" onClick={onClose} disabled={busy}>取消</button>
      <button type="button" className="confirmation-danger" onClick={onConfirm} disabled={busy}>{busy ? '正在清除' : '清除历史'}</button>
    </div>
  </DialogFrame>;
}
