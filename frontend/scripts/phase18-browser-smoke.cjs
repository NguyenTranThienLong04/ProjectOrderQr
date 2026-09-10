/* Built UI + mocked HTTP. Real JWT/Mongo/audit/CRUD coverage is in
 * backend/test/dish-draft.e2e-spec.ts. No live model calls or business writes.
 * Reuse an installed playwright-core via PLAYWRIGHT_CORE_PATH. */
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { DISH_METADATA_OPTIONS } = require('../../backend/dist/src/modules/dish/dish-metadata.js');

async function main() {
  const dist = path.resolve(__dirname, '../dist');
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = pathname.startsWith('/assets/') ? path.join(dist, 'assets', path.basename(pathname)) : path.join(dist, 'index.html');
    try {
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const passed = [];
  const done = (name) => { passed.push(name); console.log(`PASS ${passed.length}: ${name}`); };
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('user', JSON.stringify({ role: 'admin', fullName: 'Phase 18 fixture' }));
      localStorage.setItem('accessToken', 'test-browser-token');
    });
    const category = { _id: '123456789012345678901234', name: 'Món Việt', isActive: true };
    const original = { _id: '123456789012345678901235', name: 'Bánh xèo', nameEn: 'Existing name', description: 'Mô tả cũ', descriptionEn: 'Existing description', price: 65000, categoryId: category, ingredients: ['rice-flour'], allergenTags: ['egg'], isAvailable: true };
    let dishes = [{ ...original }];
    const aiRequests = [];
    const saves = [];
    const generated = { nameEn: 'Bánh xèo', description: 'Bánh xèo truyền thống.', descriptionEn: 'Traditional bánh xèo.' };
    let release;
    let errorCode = null;
    await page.route('**/ai/admin/dish-draft', async (route) => {
      const input = route.request().postDataJSON();
      aiRequests.push(input);
      const code = errorCode;
      await new Promise((resolve) => { release = resolve; });
      if (code) return route.fulfill({ status: code === 'AI_TIMEOUT' ? 504 : code === 'AI_RATE_LIMIT' ? 429 : 503, json: { code, message: 'Controlled test error' } }).catch(() => {});
      return route.fulfill({ status: 200, json: { result: Object.fromEntries(input.generateFields.map((field) => [field, generated[field]])), warnings: [], modelVersion: 'mock:test:dish-draft-v1', fallbackUsed: false } }).catch(() => {});
    });
    await page.route('**/categories?**', (route) => route.fulfill({ json: [category] }));
    await page.route((url) => url.pathname === '/dishes' || url.pathname.startsWith('/dishes/'), async (route) => {
      const req = route.request();
      const pathname = new URL(req.url()).pathname;
      if (pathname === '/dishes/metadata-options') return route.fulfill({ json: DISH_METADATA_OPTIONS });
      if (req.method() === 'GET') return route.fulfill({ json: dishes });
      const form = await new Request(req.url(), { method: req.method(), headers: req.headers(), body: req.postDataBuffer() }).formData();
      const saved = Object.fromEntries(form.entries());
      for (const key of ['ingredients', 'allergenTags', 'dietaryTags', 'availableModifiers']) saved[key] = JSON.parse(saved[key]);
      saved.price = Number(saved.price); saved.isAvailable = saved.isAvailable === 'true';
      const dish = { ...saved, _id: req.method() === 'POST' ? '123456789012345678901236' : pathname.split('/').pop(), categoryId: category };
      saves.push({ method: req.method(), ...saved });
      dishes = [...dishes.filter((item) => item._id !== dish._id), dish];
      await route.fulfill({ status: req.method() === 'POST' ? 201 : 200, json: dish });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/admin/dishes`);
    const edit = async () => page.locator('article').filter({ hasText: 'Bánh xèo' }).first().getByRole('button', { name: 'Sửa', exact: true }).click();
    await edit();
    const dialog = page.getByRole('dialog');
    const panel = dialog.getByRole('region', { name: 'AI suggestion' });
    const field = (name) => dialog.getByRole('textbox', { name, exact: true });
    const start = async () => {
      release = null;
      const requestPromise = page.waitForRequest('**/ai/admin/dish-draft');
      await panel.getByRole('button', { name: /^(Generate with AI|Regenerate|Thử lại với AI)$/ }).click();
      await requestPromise;
      assert.ok(release);
    };
    const finish = async () => { release(); await panel.getByRole('button', { name: 'Use Draft', exact: true }).waitFor(); };

    await start();
    assert.equal(await panel.getByRole('button', { name: 'Đang tạo bản nháp…' }).isDisabled(), true);
    assert.equal(await field('Tên tiếng Anh').inputValue(), original.nameEn);
    assert.equal(await field('Mô tả').isEditable(), true);
    assert.deepEqual(Object.keys(aiRequests[0]).sort(), ['categoryId', 'description', 'descriptionEn', 'generateFields', 'name', 'nameEn']);
    assert.equal(aiRequests[0].description, original.description);
    assert.equal(saves.length, 0);
    done('Generate calls endpoint with current copy only; loading keeps manual form usable');
    await finish();
    assert.equal(await field('Tên tiếng Anh').inputValue(), original.nameEn);
    assert.equal(await field('Mô tả tiếng Anh').inputValue(), original.descriptionEn);
    await panel.getByRole('textbox', { name: 'Bản nháp — Tên tiếng Anh', exact: true }).fill('Edited draft');
    assert.equal(saves.length, 0);
    done('Preview is editable; existing values stay unchanged with no auto-save');
    await panel.getByRole('button', { name: 'Bỏ bản nháp', exact: true }).click();
    assert.equal(await field('Tên tiếng Anh').inputValue(), original.nameEn);
    assert.equal(await panel.getByRole('button', { name: 'Use Draft' }).count(), 0);
    done('Discard leaves all original fields untouched');
    await start(); await finish();
    await panel.getByRole('textbox', { name: 'Bản nháp — Tên tiếng Anh', exact: true }).fill('Reviewed bánh xèo');
    await panel.getByRole('button', { name: 'Use Draft' }).click();
    assert.equal(await field('Tên tiếng Anh').inputValue(), 'Reviewed bánh xèo');
    assert.equal(await field('Mô tả tiếng Anh').inputValue(), generated.descriptionEn);
    assert.equal(saves.length, 0);
    done('Use Draft applies edited content to form only');
    await dialog.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(saves.length, 1); assert.equal(saves[0].method, 'PUT');
    assert.equal(saves[0].nameEn, 'Reviewed bánh xèo');
    assert.deepEqual(saves[0].ingredients, original.ingredients);
    assert.deepEqual(saves[0].allergenTags, original.allergenTags);
    assert.equal(saves[0].price, original.price);
    done('Explicit Save reuses multipart Dish update and preserves factual metadata');

    await edit();
    await panel.getByRole('checkbox', { name: 'Tên tiếng Anh', exact: true }).uncheck();
    await panel.getByRole('checkbox', { name: 'Mô tả tiếng Việt', exact: true }).uncheck();
    await start(); await finish();
    assert.deepEqual(aiRequests.at(-1).generateFields, ['descriptionEn']);
    assert.equal(await panel.getByRole('textbox').count(), 1);
    await panel.getByRole('textbox', { name: 'Bản nháp — Mô tả tiếng Anh' }).fill('English only');
    await panel.getByRole('button', { name: 'Use Draft' }).click();
    assert.equal(await field('Tên tiếng Anh').inputValue(), 'Reviewed bánh xèo');
    assert.equal(await field('Mô tả').inputValue(), generated.description);
    assert.equal(await field('Mô tả tiếng Anh').inputValue(), 'English only');
    done('Single-field generation never replaces unrequested fields');

    await start();
    await field('Mô tả').fill('Nội dung vừa sửa');
    await finish();
    assert.equal(await panel.getByRole('button', { name: 'Use Draft' }).isDisabled(), true);
    await start(); await finish();
    assert.equal(aiRequests.at(-1).description, 'Nội dung vừa sửa');
    assert.equal(await panel.getByRole('button', { name: 'Use Draft' }).isEnabled(), true);
    done('Changed form blocks stale draft; regenerate uses the new content');
    await panel.getByRole('button', { name: 'Bỏ bản nháp', exact: true }).click();
    for (const code of ['AI_DISABLED', 'AI_NOT_CONFIGURED', 'AI_TIMEOUT', 'AI_PROVIDER_UNAVAILABLE', 'AI_RATE_LIMIT']) {
      errorCode = code;
      await start(); release();
      await panel.getByRole('alert').waitFor();
      await field('Mô tả').fill(`Manual after ${code}`);
      assert.equal(await field('Mô tả').inputValue(), `Manual after ${code}`);
      assert.equal(await dialog.getByRole('button', { name: 'Lưu thay đổi' }).isEnabled(), true);
    }
    errorCode = null;
    done('Five controlled provider errors allow retry and manual editing/saving');
    await dialog.getByRole('button', { name: 'Lưu thay đổi' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(saves.at(-1).description, 'Manual after AI_RATE_LIMIT');
    done('Manual CRUD save succeeds after AI failures');

    await edit(); await start();
    const lateRelease = release;
    await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
    await edit(); lateRelease();
    await field('Tên tiếng Anh').fill('Manual new session');
    assert.equal(await panel.getByRole('button', { name: 'Use Draft' }).count(), 0);
    assert.equal(await field('Tên tiếng Anh').inputValue(), 'Manual new session');
    done('Closing during generation aborts and prevents draft leaking into reopened form');
    await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();

    await page.getByRole('button', { name: 'Thêm món ăn', exact: true }).click();
    await field('Tên món *').fill('Cơm tấm');
    await dialog.getByRole('spinbutton', { name: 'Giá bán (VND) *', exact: true }).fill('55000');
    Object.assign(generated, { nameEn: 'Cơm tấm', description: 'Cơm tấm truyền thống.', descriptionEn: 'Traditional cơm tấm.' });
    await start(); await finish();
    assert.equal(aiRequests.at(-1).nameEn, '');
    await mkdir(path.resolve(__dirname, '../test-results'), { recursive: true });
    for (const viewport of [{ width: 1280, height: 1000 }, { width: 375, height: 812 }, { width: 812, height: 375 }]) {
      await page.setViewportSize(viewport);
      await panel.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const bounds = await panel.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1);
      await page.screenshot({ path: path.resolve(__dirname, `../test-results/phase18-${viewport.width}.png`) });
    }
    done('Preview remains within desktop/mobile/landscape viewport with reduced motion');
    await panel.getByRole('button', { name: 'Use Draft' }).click();
    await dialog.getByRole('button', { name: 'Thêm món ăn', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(saves.at(-1).method, 'POST');
    assert.equal(saves.at(-1).name, 'Cơm tấm');
    assert.equal(saves.at(-1).nameEn, generated.nameEn);
    assert.deepEqual(errors, []);
    done('Create flow supports missing English and explicit CRUD save; zero browser errors');
    console.log(`Phase 18 browser smoke: ${passed.length}/${passed.length} scenarios PASS (mock API, not live model).`);
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
