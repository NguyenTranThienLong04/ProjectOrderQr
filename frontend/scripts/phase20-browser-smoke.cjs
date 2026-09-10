/* Built UI with explicitly mocked HTTP and business Socket handlers. */
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const { Server } = require('../../backend/node_modules/socket.io');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, mkdir } = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const dist = path.resolve(__dirname, '../dist');
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = pathname.startsWith('/assets/') ? path.join(dist, 'assets', path.basename(pathname)) : path.join(dist, 'index.html');
    try { res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(file)); }
    catch { res.writeHead(404); res.end(); }
  });
  const io = new Server(server, { transports: ['polling'], cors: { origin: '*' }, pingInterval: 3000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const tableId = '123456789012345678901234', sessionId = '123456789012345678901235';
  const beef = { _id: '123456789012345678901236', categoryId: 'soups', name: 'Phở bò', nameEn: 'Beef pho', description: 'Món nước', price: 70000, isAvailable: true };
  const veggie = { _id: '123456789012345678901237', categoryId: 'rice', name: 'Cơm chay', nameEn: 'Vegetarian rice', price: 50000, isAvailable: true };
  const cart = { sessionId, tableId, version: 0, cart: [] };
  const events = [], requests = [], errors = [];
  let responseMode = 'semantic', release, entered;
  const warning = 'Không thể xác minh đầy đủ điều kiện dị ứng từ dữ liệu hiện có.';
  io.on('connection', socket => {
    socket.on('cart:join', () => socket.emit('cart:synced', cart));
    socket.on('cart:add', payload => {
      events.push(payload); cart.cart.push({ cartItemId: `row-${events.length}`, dishId: payload.dishId, dishName: beef.name, unitPrice: beef.price, quantity: 1, note: payload.note });
      cart.version++; io.emit('cart:synced', cart);
    });
  });
  let browser; const passed = []; const done = name => { passed.push(name); console.log(`PASS ${passed.length}: ${name}`); };
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
    await context.route(/\/socket.io\//, async route => { try { const url = new URL(route.request().url()); await route.fulfill({ response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }) }); } catch {} });
    await context.route(url => url.pathname === '/menu', route => {
      if (route.request().resourceType() === 'document') return route.continue();
      const en = new URL(route.request().url()).searchParams.get('lang') === 'en';
      return route.fulfill({ json: { table: { id: tableId, tableCode: 'P20' }, categories: [
        { _id: 'soups', id: 'soups', name: en ? 'Soups' : 'Món nước', dishes: [{ ...beef, name: en ? beef.nameEn : beef.name }] },
        { _id: 'rice', id: 'rice', name: en ? 'Rice' : 'Cơm', dishes: [{ ...veggie, name: en ? veggie.nameEn : veggie.name }] },
      ] } });
    });
    await context.route('**/sessions/active?**', route => route.fulfill({ json: cart }));
    await context.route('**/vnpay/session-summary?**', route => route.fulfill({ json: { sessionId, tableId, tableIds: [tableId], tableCode: 'P20', orders: [], payableOrders: [], canPay: false } }));
    await context.route(url => url.pathname === '/ai/menu/search', async route => {
      const input = route.request().postDataJSON(); requests.push(input); const mode = responseMode;
      await new Promise(resolve => { release = resolve; entered?.(); });
      let payload = { result: { dishes: [{ ...beef, name: input.lang === 'en' ? beef.nameEn : beef.name }], appliedFilters: { maxPrice: 100000, maxSpiceLevel: 0, requiredIngredients: ['beef'], excludedAllergens: ['peanut'] } }, warnings: [warning], modelVersion: 'mock:menu-search-v1', fallbackUsed: false };
      if (mode === 'fallback') payload = { ...payload, result: { dishes: [], appliedFilters: {} }, warnings: ['AI chưa khả dụng; điều kiện chưa được xác minh.'], fallbackUsed: true };
      if (mode === 'unsupported') payload = { ...payload, result: { dishes: [], appliedFilters: {} }, warnings: ['Dữ liệu menu hiện không đủ để xác minh điều kiện sức khỏe.'], fallbackUsed: true };
      if (mode === 'empty') payload = { ...payload, result: { dishes: [], appliedFilters: { maxPrice: 1000 } }, warnings: [] };
      await route.fulfill(mode === 'error' ? { status: 429, json: { code: 'AI_RATE_LIMIT' } } : { json: payload }).catch(() => {});
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/menu?tableId=${tableId}`);
    const input = page.locator('#menu-search'); await input.waitFor();
    const start = async (query, enter = false) => {
      await input.fill(query); const arrived = new Promise(resolve => { entered = resolve; });
      if (enter) await input.press('Enter'); else await page.getByRole('button', { name: /^(Tìm bằng AI|Search with AI)$/ }).click();
      await arrived;
    };
    const finish = async () => { release(); await page.getByRole('button', { name: /^(Tìm bằng AI|Search with AI)$/ }).waitFor(); };
    const clear = async () => { await page.getByRole('button', { name: /^(Xóa tìm kiếm|Clear search)$/ }).click(); };
    await input.fill('Phở'); assert.equal(await page.locator('article').count(), 1); assert.equal(requests.length, 0);
    await input.fill(''); await page.getByRole('button', { name: 'Cơm', exact: true }).click(); assert.equal(await page.locator('article').count(), 1);
    done('Existing instant name search and category filter work without AI calls');
    const query = 'Món dưới 100k, không cay, không đậu phộng và có thịt bò';
    await start(query, true);
    assert.ok(await page.getByText('Đang tìm món theo yêu cầu… Giỏ hàng vẫn sử dụng được.', { exact: true }).isVisible());
    await page.getByRole('button', { name: /^Mở giỏ hàng/ }).click(); await page.getByRole('button', { name: 'Đóng giỏ hàng', exact: true }).click();
    assert.deepEqual(requests[0], { tableId, query, lang: 'vi' }); assert.equal(events.length, 0);
    done('Natural query Enter submit is bounded, resets category, shows loading, keeps cart usable');
    await finish(); await page.getByText('Đang áp dụng', { exact: true }).waitFor();
    assert.equal(await page.locator('article').count(), 1); assert.ok(await page.getByRole('button', { name: 'Xem chi tiết Phở bò' }).isVisible());
    assert.ok(await page.getByText('Không cay', { exact: true }).isVisible()); assert.ok(await page.getByText(/≤ 100\.000/).isVisible()); assert.ok(await page.getByText(warning, { exact: true }).isVisible());
    done('Semantic dishes, short applied filters and allergy warning render');
    await page.getByRole('button', { name: 'Xem chi tiết Phở bò' }).click(); await page.locator('#dish-note').fill('không hành');
    await page.getByRole('button', { name: 'Thêm vào giỏ', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await page.getByRole('button', { name: /^Mở giỏ hàng, 1 món/ }).waitFor();
    assert.equal(events[0].dishId, beef._id); assert.equal(events[0].note, 'không hành'); assert.equal(events[0].analysisToken, undefined);
    done('Adding a semantic result retains existing dish/note cart flow');
    await input.fill('Cơm'); assert.equal(await page.getByText('Đang áp dụng', { exact: true }).count(), 0); assert.equal(await page.locator('article').count(), 1);
    done('Editing query clears stale filters and restores instant search');
    await start(query); const stale = release; await input.fill('Cơm'); stale();
    assert.equal(await page.getByText('Đang áp dụng', { exact: true }).count(), 0); assert.ok(await page.getByRole('button', { name: 'Xem chi tiết Cơm chay' }).isVisible());
    done('Late response after editing cannot replace current results');
    responseMode = 'fallback'; await start('Phở'); await finish(); await page.getByText('Đang dùng tìm kiếm thường', { exact: true }).waitFor();
    assert.ok(await page.getByRole('button', { name: 'Xem chi tiết Phở bò' }).isVisible());
    responseMode = 'error'; await start('Cơm'); await finish();
    assert.ok(await page.getByRole('button', { name: 'Xem chi tiết Cơm chay' }).isVisible()); assert.ok(await page.getByText(/AI chưa khả dụng\. Đang tìm theo tên/).isVisible());
    done('Backend fallback and HTTP 429 retain honest normal search');
    responseMode = 'unsupported'; await start('món tốt cho tim'); await finish(); await page.getByText('Dữ liệu menu hiện không đủ để xác minh điều kiện sức khỏe.', { exact: true }).waitFor();
    assert.equal(await page.getByText('Đang áp dụng', { exact: true }).count(), 0);
    done('Unsupported factual criteria show a warning without invented filters');
    responseMode = 'empty'; await start('món dưới 1k'); await finish();
    assert.ok(await page.getByText('Không tìm thấy món phù hợp', { exact: true }).isVisible()); await clear(); assert.equal(await page.locator('article').count(), 2);
    done('Empty semantic results have a working clear-search recovery');
    responseMode = 'semantic'; await start(query); const languageStale = release;
    await page.getByLabel('Ngôn ngữ menu', { exact: true }).selectOption('en'); languageStale();
    await page.getByRole('button', { name: 'Xem chi tiết Beef pho' }).waitFor();
    assert.equal(await input.inputValue(), ''); assert.equal(await page.getByText('Đang áp dụng', { exact: true }).count(), 0);
    await start('beef under 100k'); await finish(); await page.getByText('Applied filters', { exact: true }).waitFor();
    assert.equal(requests.at(-1).lang, 'en'); assert.ok(await page.getByRole('button', { name: 'Xem chi tiết Beef pho' }).isVisible());
    await page.getByLabel('Ngôn ngữ menu', { exact: true }).selectOption('vi'); await page.getByRole('button', { name: 'Xem chi tiết Phở bò' }).waitFor();
    done('VI/EN localization, semantic EN and language-change cancellation work');
    await start(query); await finish(); await mkdir(path.resolve(__dirname, '../test-results'), { recursive: true });
    for (const [width, height] of [[1280,1000],[375,812],[812,375]]) {
      await page.setViewportSize({ width, height }); await input.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const button = page.getByRole('button', { name: 'Tìm bằng AI', exact: true }); await button.click({ trial: true }); await button.focus();
      assert.ok(await button.evaluate(el => { const rect = el.getBoundingClientRect(); return rect.height >= 44 && el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); }));
      await page.screenshot({ path: path.resolve(__dirname, `../test-results/phase20-${width}.png`), fullPage: true });
    }
    done('Desktop/mobile/landscape, reduced motion, keyboard focus and 44px controls');
    assert.deepEqual(errors, []); done('Zero browser JavaScript errors');
    console.log(`Phase 20 browser: ${passed.length}/${passed.length} scenarios PASS (mock HTTP/business Socket handlers)`);
  } finally { await browser?.close(); await new Promise(resolve => io.close(resolve)); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
