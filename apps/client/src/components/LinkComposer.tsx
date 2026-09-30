import { useRef, useState, type RefObject } from 'react';
import { ArrowDownToLine, ClipboardPaste, FileText, Link2, LoaderCircle, ShieldCheck, Upload } from 'lucide-react';

export function LinkComposer({ native, input, linkCount, submitting, sessionConfigured, textareaRef, onInput, onImport, onSubmit, onPaste }: {
  native: boolean; input: string; linkCount: number; submitting: boolean; sessionConfigured: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>; onInput: (text: string) => void;
  onImport: (file?: File) => Promise<void>; onSubmit: () => void; onPaste: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = <input ref={fileRef} type="file" accept=".txt,.csv,text/plain,text/csv" hidden onChange={(event) => {
    void onImport(event.target.files?.[0]);
    event.target.value = '';
  }} />;
  return <section className={`ingest-panel ${native ? 'native-ingest-panel' : ''}`} aria-label="添加下载链接">
    <div className="panel-heading">
      <div><span><Link2 size={native ? 21 : 26} /></span><div><h2>{native ? '保存一条新链接' : '添加链接'}</h2><small>{native ? '粘贴 X 帖子链接，余下的交给我们' : '支持单条或批量导入 X 帖子链接'}</small></div></div>
      {!native && <div className="privacy-chip"><ShieldCheck size={13} />默认仅公开内容</div>}
    </div>
    <div className={`composer ${dragging ? 'is-dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => {
      event.preventDefault(); setDragging(false); void onImport(event.dataTransfer.files[0]);
    }}>
      <textarea ref={textareaRef} value={input} onChange={(event) => onInput(event.target.value)}
        rows={native ? Math.max(3, Math.min(7, input.split('\n').length + 1)) : undefined}
        placeholder={native ? 'https://x.com/…/status/…\n支持多条链接，每行一条' : '粘贴 X 帖子链接'} aria-label="X 帖子链接" />
      {native ? <div className="native-composer-tools">
        <button type="button" onClick={onPaste}><ClipboardPaste size={16} />粘贴链接</button>
        <button type="button" onClick={() => fileRef.current?.click()}><Upload size={16} />导入文件</button>
        {fileInput}
      </div> : <div className={`drop-zone ${dragging ? 'dragging' : ''}`} onClick={() => fileRef.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileRef.current?.click(); }
      }}><Upload size={16} /><span>导入 TXT / CSV</span>{fileInput}</div>}
    </div>
    <div className="submit-row">
      <div className={`input-count ${linkCount ? 'has-links' : ''}`}><FileText size={15} /><strong>{linkCount}</strong> 条链接已识别</div>
      <button type="button" className="primary-button" onClick={onSubmit} disabled={!linkCount || submitting}>
        {submitting ? <LoaderCircle className="spin" size={18} /> : <ArrowDownToLine size={18} />}{submitting ? '正在添加…' : '开始下载'}
      </button>
    </div>
    {native && <p className="native-composer-note"><ShieldCheck size={13} />{sessionConfigured ? '已启用账号访问 · 媒体保存在本机' : '公开帖子无需登录 · 媒体保存在本机'}</p>}
  </section>;
}
