import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeNativeTests, nativeBack, nativePage } from './native-ui-helpers.mjs';

after(closeNativeTests);

test('category counts and visible results refresh when a download completes', async (t) => {
  const page = await nativePage(t);
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.getByRole('tab', { name: '分类', exact: true }).click();
  await page.getByRole('tab', { name: '全部已下载 27' }).waitFor();
  await page.evaluate(() => window.__nativeFixture.completeJob('job-100'));
  await page.getByRole('tab', { name: '全部已下载 28' }).waitFor();
  await page.getByRole('tab', { name: '未分类 28' }).waitFor();
  await page.getByText('找到 28 条已下载推文').waitFor();
});

test('all-history batch selection applies only to the current page', async (t) => {
  const page = await nativePage(t);
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.getByRole('button', { name: '选择推文', exact: true }).click();
  await page.getByRole('button', { name: '选中本页 (25)', exact: true }).click();
  await page.getByRole('button', { name: '批量分类', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '为 25 条推文分类' });
  await dialog.getByRole('textbox', { name: '新分类名' }).fill('历史选中');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await dialog.getByRole('button', { name: '保存分类', exact: true }).click();
  await page.getByRole('tab', { name: '分类', exact: true }).click();
  await page.getByRole('tab', { name: /历史选中/ }).click();
  await page.getByText('找到 25 条已下载推文').waitFor();
  await page.getByRole('tab', { name: '未分类 2' }).waitFor();
});

test('categories support cross-page selection, scoped search, rename, delete, and reload persistence', async (t) => {
  const page = await nativePage(t);
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.getByRole('tab', { name: '分类', exact: true }).click();
  await page.getByRole('heading', { name: '推文分类' }).waitFor();
  await page.getByRole('button', { name: '新建分类', exact: true }).click();
  const nameDialog = page.getByRole('dialog', { name: '新建分类' });
  await nameDialog.getByRole('textbox', { name: '分类名' }).fill('旅行');
  await nameDialog.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('tab', { name: /旅行/ }).waitFor();

  await page.getByRole('button', { name: '选择推文', exact: true }).click();
  await page.getByRole('button', { name: '选中本页 (25)', exact: true }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByRole('button', { name: '选中本页 (2)', exact: true }).click();
  await page.getByRole('button', { name: '批量分类', exact: true }).click();
  const assignDialog = page.getByRole('dialog', { name: '为 27 条推文分类' });
  await assignDialog.getByRole('checkbox', { name: /旅行/ }).check();
  await assignDialog.getByRole('button', { name: '保存分类', exact: true }).click();
  await assignDialog.waitFor({ state: 'hidden' });

  await page.getByRole('tab', { name: /旅行/ }).click();
  await page.getByText('找到 27 条已下载推文').waitFor();
  await page.getByRole('searchbox', { name: '在当前分类中搜索' }).fill('山间');
  await page.getByText('找到 27 条已下载推文').waitFor();
  await page.getByRole('searchbox', { name: '在当前分类中搜索' }).fill('不存在的词');
  await page.getByText('找到 0 条已下载推文').waitFor();
  await page.getByRole('searchbox', { name: '在当前分类中搜索' }).fill('');

  await page.reload();
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.getByRole('tab', { name: '分类', exact: true }).click();
  await page.getByRole('tab', { name: /旅行/ }).waitFor();
  await page.getByRole('button', { name: '重命名分类 旅行' }).click();
  const rename = page.getByRole('dialog', { name: '重命名分类' });
  await rename.getByRole('textbox', { name: '分类名' }).fill('旅行记录');
  await rename.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('tab', { name: /旅行记录/ }).waitFor();
  await page.getByRole('button', { name: '删除分类 旅行记录' }).click();
  const deletion = page.getByRole('alertdialog', { name: '删除“旅行记录”' });
  await deletion.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('tab', { name: /旅行记录/ }).waitFor();
  await page.getByRole('button', { name: '删除分类 旅行记录' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除分类', exact: true }).click();
  await page.getByRole('tab', { name: '未分类 27' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: /旅行记录/ }).count(), 0);
});

test('assignment errors remain retryable and Android back closes the panel before selection mode', async (t) => {
  const page = await nativePage(t, { fixture: { categories: [{ id: 'category-stay', name: '稍后整理', createdAt: '2026-01-01', tweetCount: 0 }], failCategoryWrites: 1 } });
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.getByRole('tab', { name: '分类', exact: true }).click();
  await page.getByRole('button', { name: '选择推文', exact: true }).click();
  const firstCard = page.locator('.category-browser .job-card').first();
  await firstCard.getByRole('button', { name: '选择', exact: true }).click();
  await firstCard.getByRole('button', { name: '分类', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '为 1 条推文分类' });
  await dialog.getByRole('checkbox', { name: /稍后整理/ }).check();
  await dialog.getByRole('button', { name: '保存分类', exact: true }).click();
  await page.getByRole('alert').getByText('模拟写入失败').waitFor();
  await assert.equal(await dialog.isVisible(), true);
  assert.equal(await firstCard.getByRole('button', { name: '已选择', exact: true }).count(), 1);
  await page.getByRole('alert').getByRole('button', { name: '重试', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => Object.values(window.__nativeFixture.getState().assignments).some((ids) => ids.includes('category-stay'))), true);
  await page.getByRole('button', { name: '选择推文', exact: true }).click();
  await page.locator('.category-browser .job-card').first().getByRole('button', { name: '选择', exact: true }).click();
  await page.locator('.category-browser .job-card').first().getByRole('button', { name: '分类', exact: true }).click();
  const secondDialog = page.getByRole('dialog', { name: '为 1 条推文分类' });
  await nativeBack(page);
  await secondDialog.waitFor({ state: 'hidden' });
  await nativeBack(page);
  await page.getByRole('button', { name: '选择推文', exact: true }).waitFor();
  await assert.equal(await page.getByRole('button', { name: '已选择', exact: true }).count(), 0);
  await nativeBack(page);
  await page.getByRole('button', { name: '首页', exact: true }).waitFor();
});
