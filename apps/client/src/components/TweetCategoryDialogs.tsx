import { useEffect, useMemo, useState } from 'react';
import { Check, LoaderCircle, Plus, Tag, X } from 'lucide-react';
import { createTweetCategory as createCategoryApi, getTweetCategoryAssignments, updateTweetCategories } from '../api';
import type { TweetCategory } from '../nativeArchive';

export function TweetCategoryDialog({
  tweetIds,
  categories,
  onCreateCategory,
  onClose,
  onSaved,
}: {
  tweetIds: string[];
  categories: TweetCategory[];
  onCreateCategory: (category: TweetCategory) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ids = useMemo(() => [...new Set(tweetIds)], [tweetIds]);
  const [membership, setMembership] = useState<Record<string, string[]>>({});
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [newCategories, setNewCategories] = useState<TweetCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');
  const [retryAction, setRetryAction] = useState<'load' | 'create' | 'save'>('load');

  const visibleCategories = [...categories, ...newCategories.filter((fresh) => !categories.some((item) => item.id === fresh.id))];

  async function loadAssignments() {
    setLoading(true);
    setError('');
    try {
      const result = await getTweetCategoryAssignments(ids);
      setMembership(result.assignments);
      setOverrides({});
    } catch (loadError) {
      setRetryAction('load');
      setError(loadError instanceof Error ? loadError.message : '无法读取推文分类，请重试');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadAssignments(); }, [ids.join('|')]);

  function initialState(categoryId: string): 'all' | 'none' | 'mixed' {
    const count = ids.filter((tweetId) => membership[tweetId]?.includes(categoryId)).length;
    return count === 0 ? 'none' : count === ids.length ? 'all' : 'mixed';
  }

  async function addCategory() {
    setBusy(true);
    setError('');
    try {
      const category = await createCategoryApi(newName);
      setNewCategories((current) => [...current, category]);
      setOverrides((current) => ({ ...current, [category.id]: true }));
      setNewName('');
      onCreateCategory(category);
    } catch (createError) {
      setRetryAction('create');
      setError(createError instanceof Error ? createError.message : '无法创建分类，请重试');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const addIds = visibleCategories.filter((category) => overrides[category.id] === true).map((category) => category.id);
    const removeIds = visibleCategories.filter((category) => overrides[category.id] === false).map((category) => category.id);
    setBusy(true);
    setError('');
    try {
      if (addIds.length || removeIds.length) await updateTweetCategories(ids, addIds, removeIds);
      onSaved();
    } catch (saveError) {
      setRetryAction('save');
      setError(saveError instanceof Error ? saveError.message : '分类未保存，请重试');
    } finally {
      setBusy(false);
    }
  }

  return <div className="category-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="category-dialog" role="dialog" aria-modal="true" aria-labelledby="tweet-category-title">
      <header><span className="category-dialog-icon"><Tag size={19} /></span><div><h2 id="tweet-category-title">为 {ids.length} 条推文分类</h2><p>未更改的分类归属会保留</p></div>
        <button type="button" onClick={onClose} aria-label="关闭分类面板" disabled={busy}><X size={19} /></button></header>
      <div className="category-dialog-content">
        {loading ? <p className="archive-loading" role="status">正在读取当前归属…</p> : visibleCategories.length ? <div className="category-checkbox-list">
          {visibleCategories.map((category) => {
            const state = initialState(category.id);
            const checked = Object.prototype.hasOwnProperty.call(overrides, category.id) ? overrides[category.id] : state === 'all';
            const mixed = !Object.prototype.hasOwnProperty.call(overrides, category.id) && state === 'mixed';
            return <label className={`category-checkbox-row ${checked ? 'is-checked' : ''} ${mixed ? 'is-mixed' : ''}`} key={category.id}>
              <input type="checkbox" checked={checked} ref={(element) => { if (element) element.indeterminate = mixed; }} onChange={() => setOverrides((current) => ({ ...current, [category.id]: !checked }))} />
              <span className="category-checkbox-mark">{checked && <Check size={14} />}{mixed && <span />}</span>
              <span>{category.name}</span><small>{category.tweetCount}</small>
            </label>;
          })}
        </div> : <p className="category-dialog-empty">还没有分类，可以直接创建一个。</p>}
        <form className="category-create-inline" onSubmit={(event) => { event.preventDefault(); void addCategory(); }}>
          <input value={newName} onChange={(event) => setNewName([...event.target.value].slice(0, 30).join(''))} placeholder="新分类名（1–30 字）" aria-label="新分类名" />
          <button type="submit" className="category-quiet-button" disabled={busy || !newName.trim()}><Plus size={15} />创建</button>
        </form>
        {error && <div className="category-action-error" role="alert">{error}<button type="button" onClick={() => void (retryAction === 'load' ? loadAssignments() : retryAction === 'create' ? addCategory() : save())}>重试</button></div>}
      </div>
      <footer><button type="button" className="category-quiet-button" onClick={onClose} disabled={busy}>取消</button>
        <button type="button" className="category-primary-button" onClick={() => void save()} disabled={busy || loading}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存分类</button>
      </footer>
    </section>
  </div>;
}

export function CategoryNameDialog({ category, onClose, onSave }: { category?: TweetCategory; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(category?.name ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try { await onSave(name); } catch (saveError) { setError(saveError instanceof Error ? saveError.message : '无法保存分类，请重试'); }
    finally { setBusy(false); }
  }
  return <div className="category-dialog-backdrop">
    <form className="category-dialog category-name-dialog" role="dialog" aria-modal="true" aria-labelledby="category-name-title" onSubmit={(event) => void submit(event)}>
      <header><span className="category-dialog-icon"><Tag size={19} /></span><div><h2 id="category-name-title">{category ? '重命名分类' : '新建分类'}</h2><p>分类名需为 1–30 个字符</p></div><button type="button" onClick={onClose} aria-label="关闭分类对话框"><X size={19} /></button></header>
      <div className="category-dialog-content"><input className="category-name-input" autoFocus value={name} onChange={(event) => setName([...event.target.value].slice(0, 30).join(''))} aria-label="分类名" />{error && <p className="category-action-error" role="alert">{error}</p>}</div>
      <footer><button type="button" className="category-quiet-button" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="category-primary-button" disabled={busy || !name.trim()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存</button></footer>
    </form>
  </div>;
}

export function DeleteCategoryDialog({ category, onClose, onConfirm }: { category: TweetCategory; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function confirm() {
    setBusy(true); setError('');
    try { await onConfirm(); } catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : '无法删除分类，请重试'); }
    finally { setBusy(false); }
  }
  return <div className="category-dialog-backdrop">
    <section className="category-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-category-title" aria-describedby="delete-category-description">
      <header><span className="category-dialog-icon is-danger"><Tag size={19} /></span><div><h2 id="delete-category-title">删除“{category.name}”</h2><p id="delete-category-description">只会删除分类及其关联，不会删除推文或媒体文件。</p></div></header>
      <div className="category-dialog-content">{error && <p className="category-action-error" role="alert">{error}</p>}</div>
      <footer><button type="button" className="category-quiet-button" onClick={onClose} disabled={busy}>取消</button><button type="button" className="category-danger-button" onClick={() => void confirm()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : null}删除分类</button></footer>
    </section>
  </div>;
}
