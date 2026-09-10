/* Optional browser smoke: build frontend + backend first. API responses are
 * mocked here; real HTTP/Mongo coverage lives in backend/test/dish-metadata.e2e-spec.ts.
 * Set PLAYWRIGHT_CORE_PATH to an existing playwright-core installation if needed. */
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
    const file = pathname.startsWith('/assets/') ? path.join(dist, path.basename(pathname) === pathname.slice(8) ? pathname : 'index.html') : path.join(dist, 'index.html');
    try {
      const body = await readFile(file);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('user', JSON.stringify({ role: 'admin', fullName: 'Browser fixture' }));
      localStorage.setItem('accessToken', 'browser-fixture-only');
    });
    const category = { _id: '123456789012345678901234', name: 'Món chính', isActive: true };
    let dishes = [{ _id: '123456789012345678901235', name: 'Món cũ', description: 'Mô tả cũ', price: 45000, categoryId: category, isAvailable: true }];
    let failSave = false;
    let failOptions = false;
    let lastSaved;
    await page.route('**/*', async (route) => {
      const req = route.request();
      const pathname = new URL(req.url()).pathname;
      if (!['/categories', '/dishes'].some((prefix) => pathname.startsWith(prefix))) return route.continue();
      const fulfill = (body, status = 200) => route.fulfill({ status, json: body });
      if (pathname === '/categories') return fulfill([category]);
      if (pathname === '/dishes/metadata-options') return fulfill(failOptions ? { message: 'Fixture unavailable' } : DISH_METADATA_OPTIONS, failOptions ? 503 : 200);
      if (req.method() === 'GET') return fulfill(dishes);
      if (failSave) return fulfill({ message: ['Không thể lưu dữ liệu kiểm thử'] }, 400);
      const body = await new Request(req.url(), { method: req.method(), headers: req.headers(), body: req.postDataBuffer() }).formData();
      lastSaved = Object.fromEntries(body.entries());
      for (const key of ['ingredients', 'allergenTags', 'dietaryTags', 'availableModifiers']) lastSaved[key] = JSON.parse(lastSaved[key]);
      lastSaved.spiceLevel = lastSaved.spiceLevel === '' ? null : Number(lastSaved.spiceLevel);
      lastSaved.price = Number(lastSaved.price);
      lastSaved.isAvailable = lastSaved.isAvailable === 'true';
      const dish = { ...lastSaved, _id: req.method() === 'POST' ? '123456789012345678901236' : pathname.split('/').pop(), categoryId: category };
      dishes = [...dishes.filter((item) => item._id !== dish._id), dish];
      return fulfill(dish, req.method() === 'POST' ? 201 : 200);
    });
    const url = `http://127.0.0.1:${server.address().port}/admin/dishes`;
    await page.goto(url);
    await page.getByRole('button', { name: 'Thêm món ăn', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Tên món', { exact: false }).fill('Phở kiểm thử');
    await dialog.getByLabel('Giá bán', { exact: false }).fill('65000');
    await dialog.getByRole('textbox', { name: 'Mô tả tiếng Anh', exact: true }).fill('Test beef broth');
    await dialog.getByRole('button', { name: 'Thêm nguyên liệu' }).click();
    await dialog.getByLabel('Nguyên liệu 1', { exact: true }).fill('beef');
    await dialog.getByLabel('Đậu phộng', { exact: true }).check();
    await dialog.getByLabel('Không hành', { exact: true }).check();
    await dialog.getByLabel('Độ cay').selectOption('0');
    await dialog.getByLabel('Khẩu phần').fill('1 tô');
    await dialog.getByRole('button', { name: 'Thêm món ăn', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(lastSaved.ingredients, ['beef']);
    assert.deepEqual(lastSaved.allergenTags, ['peanut']);
    assert.deepEqual(lastSaved.availableModifiers, ['NO_ONION']);
    assert.equal(lastSaved.spiceLevel, 0);
    const card = page.locator('article').filter({ hasText: 'Phở kiểm thử' });
    await card.getByRole('button', { name: 'Sửa', exact: true }).click();
    assert.equal(await dialog.getByRole('textbox', { name: 'Mô tả tiếng Anh', exact: true }).inputValue(), 'Test beef broth');
    assert.equal(await dialog.getByLabel('Nguyên liệu 1', { exact: true }).inputValue(), 'beef');
    await dialog.getByRole('button', { name: 'Xóa nguyên liệu 1' }).click();
    await dialog.getByLabel('Đậu phộng', { exact: true }).uncheck();
    await dialog.getByLabel('Không hành', { exact: true }).uncheck();
    await dialog.getByLabel('Độ cay').selectOption('');
    failSave = true;
    await dialog.getByRole('button', { name: 'Lưu thay đổi' }).click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(await dialog.getByLabel('Tên món', { exact: false }).inputValue(), 'Phở kiểm thử');
    failSave = false;
    await dialog.getByRole('button', { name: 'Lưu thay đổi' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(lastSaved.ingredients, []);
    assert.deepEqual(lastSaved.allergenTags, []);
    assert.equal(lastSaved.spiceLevel, null);
    await page.locator('article').filter({ hasText: 'Món cũ' }).getByRole('button', { name: 'Sửa', exact: true }).click();
    assert.equal(await dialog.getByLabel('Độ cay').inputValue(), '');
    await mkdir(path.resolve(__dirname, '../test-results'), { recursive: true });
    for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }, { width: 812, height: 375 }]) {
      await page.setViewportSize(viewport);
      await page.screenshot({ path: path.resolve(__dirname, `../test-results/phase15-${viewport.width}.png`) });
      const overflow = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('body *')].filter((element) => element.getBoundingClientRect().right > innerWidth + 1).map((element) => ({ tag: element.tagName, classes: element.className, right: element.getBoundingClientRect().right })).slice(0, 8) }));
      assert.equal(overflow.scrollWidth <= overflow.width, true, JSON.stringify(overflow));
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    failOptions = true;
    await page.reload();
    await page.getByRole('button', { name: 'Thêm món ăn', exact: true }).click();
    await dialog.getByRole('button', { name: 'Tải lại lựa chọn' }).waitFor();
    failOptions = false;
    await dialog.getByRole('button', { name: 'Tải lại lựa chọn' }).click();
    await dialog.getByLabel('Độ cay').waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS: browser create/edit/clear/legacy/error/retry; multipart payload; desktop/mobile/landscape; reduced motion; no page errors. API mocked.');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
