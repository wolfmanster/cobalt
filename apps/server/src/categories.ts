import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class ArchiveError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ArchiveError';
    this.status = status;
  }
}

export interface StoredCategory {
  id: string;
  name: string;
  normalizedName: string;
  createdAt: string;
}

export interface StoredAssignment {
  tweetId: string;
  categoryId: string;
}

export interface CategorySnapshot {
  version: 1;
  categories: StoredCategory[];
  assignments: StoredAssignment[];
}

export function normalizeCategoryName(rawName: unknown): { name: string; normalizedName: string } {
  if (typeof rawName !== 'string') throw new ArchiveError('分类名需为 1–30 个字符');
  const name = rawName.trim();
  const characters = [...name].length;
  if (characters < 1 || characters > 30) throw new ArchiveError('分类名需为 1–30 个字符');
  // Locale.ROOT case folding matches String#toLowerCase, not a locale-specific mapping.
  return { name, normalizedName: name.toLowerCase() };
}

function emptySnapshot(): CategorySnapshot {
  return { version: 1, categories: [], assignments: [] };
}

function corrupt(filePath: string, detail: string): Error {
  return new Error(`分类文件损坏（${detail}）：${filePath}`);
}

function parseSnapshot(raw: string, filePath: string): CategorySnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corrupt(filePath, '无法解析 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw corrupt(filePath, '根节点必须是对象');
  const record = parsed as Partial<CategorySnapshot>;
  if (record.version !== 1 || !Array.isArray(record.categories) || !Array.isArray(record.assignments)) {
    throw corrupt(filePath, '版本或结构无效');
  }
  return {
    version: 1,
    categories: record.categories.map((item, index) => {
      if (!item || typeof item !== 'object') throw corrupt(filePath, `分类 #${index} 无效`);
      const category = item as Partial<StoredCategory>;
      if ([category.id, category.name, category.normalizedName, category.createdAt].some((value) => typeof value !== 'string')) {
        throw corrupt(filePath, `分类 #${index} 字段无效`);
      }
      return { id: category.id!, name: category.name!, normalizedName: category.normalizedName!, createdAt: category.createdAt! };
    }),
    assignments: record.assignments.map((item, index) => {
      if (!item || typeof item !== 'object') throw corrupt(filePath, `分配 #${index} 无效`);
      const assignment = item as Partial<StoredAssignment>;
      if (typeof assignment.tweetId !== 'string' || typeof assignment.categoryId !== 'string') {
        throw corrupt(filePath, `分配 #${index} 字段无效`);
      }
      return { tweetId: assignment.tweetId, categoryId: assignment.categoryId };
    }),
  };
}

export class CategoryStore {
  private snapshot: CategorySnapshot = emptySnapshot();
  private chain: Promise<void> = Promise.resolve();
  readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = path.join(dataDir, 'categories.json');
  }

  async init(): Promise<void> {
    try {
      this.snapshot = parseSnapshot(await fs.readFile(this.filePath, 'utf8'), this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  getSnapshot(): CategorySnapshot {
    return structuredClone(this.snapshot);
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  private enqueue<T>(mutator: (draft: CategorySnapshot) => T): Promise<T> {
    const task = this.chain.then(async () => {
      const draft = structuredClone(this.snapshot);
      const result = mutator(draft);
      await fs.mkdir(this.dataDir, { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
      await fs.rename(temporary, this.filePath);
      this.snapshot = draft;
      return result;
    });
    this.chain = task.then(() => undefined, () => undefined);
    return task;
  }

  create(rawName: unknown): Promise<StoredCategory> {
    const { name, normalizedName } = normalizeCategoryName(rawName);
    return this.enqueue((draft) => {
      if (draft.categories.some((category) => category.normalizedName === normalizedName)) throw new ArchiveError('分类名已存在');
      const category: StoredCategory = { id: randomUUID(), name, normalizedName, createdAt: new Date().toISOString() };
      draft.categories.push(category);
      return { ...category };
    });
  }

  mergeImported(tweetId: string | undefined, names: string[]): Promise<void> {
    if (!names.length) return Promise.resolve();
    const normalized = names.map(normalizeCategoryName);
    return this.enqueue((draft) => {
      const assigned = new Set(draft.assignments.filter((item) => item.tweetId === tweetId).map((item) => item.categoryId));
      for (const name of normalized) {
        let category = draft.categories.find((item) => item.normalizedName === name.normalizedName);
        if (!category) {
          category = { ...name, id: randomUUID(), createdAt: new Date().toISOString() };
          draft.categories.push(category);
        }
        if (tweetId && !assigned.has(category.id)) {
          draft.assignments.push({ tweetId, categoryId: category.id });
          assigned.add(category.id);
        }
      }
    });
  }

  rename(id: string, rawName: unknown): Promise<StoredCategory> {
    const { name, normalizedName } = normalizeCategoryName(rawName);
    return this.enqueue((draft) => {
      const category = draft.categories.find((item) => item.id === id);
      if (!category) throw new ArchiveError('分类不存在', 404);
      if (draft.categories.some((item) => item.id !== id && item.normalizedName === normalizedName)) throw new ArchiveError('分类名已存在');
      category.name = name;
      category.normalizedName = normalizedName;
      return { ...category };
    });
  }

  delete(id: string): Promise<{ deleted: true }> {
    return this.enqueue((draft) => {
      const index = draft.categories.findIndex((item) => item.id === id);
      if (index < 0) throw new ArchiveError('分类不存在', 404);
      draft.categories.splice(index, 1);
      draft.assignments = draft.assignments.filter((assignment) => assignment.categoryId !== id);
      return { deleted: true as const };
    });
  }

  assignmentsFor(tweetIds: string[]): Record<string, string[]> {
    const ids = [...new Set(tweetIds.map((id) => id.trim()).filter(Boolean))];
    const known = new Set(this.snapshot.categories.map((category) => category.id));
    const byTweet = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const assignment of this.snapshot.assignments) {
      const list = byTweet.get(assignment.tweetId);
      if (!list || !known.has(assignment.categoryId)) continue;
      list.push(assignment.categoryId);
    }
    return Object.fromEntries(byTweet);
  }

  updateAssignments(tweetIds: string[], addCategoryIds: string[] = [], removeCategoryIds: string[] = []): Promise<{ updated: number }> {
    const ids = [...new Set(tweetIds.map((id) => id.trim()).filter(Boolean))];
    const addIds = [...new Set(addCategoryIds.map((id) => id.trim()).filter(Boolean))];
    const removeIds = [...new Set(removeCategoryIds.map((id) => id.trim()).filter(Boolean))];
    if (!ids.length) return Promise.reject(new ArchiveError('请选择至少一条推文'));
    return this.enqueue((draft) => {
      const existing = new Set(draft.categories.map((category) => category.id));
      if ([...addIds, ...removeIds].some((id) => !existing.has(id))) throw new ArchiveError('分类已不存在，请刷新后重试');
      const pairs = new Set(draft.assignments.map((assignment) => `${assignment.tweetId}\0${assignment.categoryId}`));
      for (const tweetId of ids) {
        for (const categoryId of addIds) pairs.add(`${tweetId}\0${categoryId}`);
        for (const categoryId of removeIds) pairs.delete(`${tweetId}\0${categoryId}`);
      }
      draft.assignments = [...pairs].map((pair) => {
        const splitAt = pair.indexOf('\0');
        return { tweetId: pair.slice(0, splitAt), categoryId: pair.slice(splitAt + 1) };
      });
      return { updated: ids.length };
    });
  }

  removeOrphanAssignments(completedTweetIds: Iterable<string>): Promise<void> {
    const live = new Set(completedTweetIds);
    return this.enqueue((draft) => {
      draft.assignments = draft.assignments.filter((assignment) => live.has(assignment.tweetId));
    });
  }
}
