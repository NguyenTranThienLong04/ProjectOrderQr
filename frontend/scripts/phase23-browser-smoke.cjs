/* Real production React assets; synthetic HTTP/business Socket fixtures only. */
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
  const io = new Server(server, { transports: ['polling'], cors: { origin: '*' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const tableId = '123456789012345678901234', sessionId = '123456789012345678901235';
  const dishes = ['Phở bò', 'Gỏi cuốn tôm', 'Trà đào'].map((name, index) => ({ _id: `12345678901234567890123${index + 6}`, categoryId: 'soups', name, nameEn: ['Beef pho', 'Shrimp rolls', 'Peach tea'][index], price: 50000, isAvailable: true }));
  let cart = { sessionId, tableId, version: 1, cart: [{ cartItemId: 'row-a', dishId: dishes[0]._id, dishName: dishes[0].name, unitPrice: 50000, quantity: 1, note: '' }] };
  const requests = [], adds = [], orderRequests = [], errors = [], held = [];
  let mode = 'hold';
  const emit = () => io.emit('cart:synced', cart);
  io.on('connection', socket => {
    socket.on('cart:join', () => socket.emit('cart:synced', cart));
    socket.on('cart:add', payload => {
      adds.push(payload); const dish = dishes.find(d => d._id === payload.dishId);
      cart = { ...cart, version: cart.version + 1, cart: [...cart.cart, { cartItemId: `row-${adds.length}`, dishId: dish._id, dishName: dish.name, unitPrice: dish.price, quantity: 1, note: payload.note }] }; emit();
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
      return route.fulfill({ json: { table: { id: tableId, tableCode: 'P23' }, categories: [{ _id: 'soups', id: 'soups', name: 'Món ăn', dishes: dishes.map(d => ({ ...d, name: en ? d.nameEn : d.name })) }] } });
    });
    await context.route('**/sessions/active?**', route => route.fulfill({ json: cart }));
    await context.route('**/vnpay/session-summary?**', route => route.fulfill({ json: { sessionId, tableId, tableIds: [tableId], orders: [], payableOrders: [], canPay: false } }));
    await context.route(url => url.pathname === '/orders', route => {
      orderRequests.push(route.request().postDataJSON()); cart = { ...cart, version: cart.version + 1, cart: [] }; emit();
      return route.fulfill({ json: { orderId: 'test-order', sessionId, tableId, status: 'pending', totalAmount: 100000 } });
    });
    await context.route('**/ai/menu/search', route => route.fulfill({ json: { result: { dishes: [dishes[2]], appliedFilters: { excludedAllergens: ['peanut'], requiredDietaryTags: ['vegan'], maxPrice: 100000, keywords: ['tea'] } }, warnings: [], fallbackUsed: false, modelVersion: 'mock' } }));
    await context.route('**/menu/recommendations', async route => {
      const input = route.request().postDataJSON(); requests.push(input); const requestMode = mode;
      const currentIds = cart.cart.map(i => i.dishId);
      const result = { result: { recommendations: dishes.filter(d => !currentIds.includes(d._id)).map(dish => ({ dish: { ...dish, name: input.lang === 'en' ? dish.nameEn : dish.name }, reason: currentIds.length ? 'frequently_bought_together' : 'popular', evidence: { pairCount: 40, confidence: 0.57 } })), cartDishIds: currentIds, sampleSize: 640 }, warnings: input.constraints.excludedAllergens?.length ? ['Không thể xác minh đầy đủ điều kiện dị ứng.'] : [] };
      if (requestMode === 'hold') await new Promise(resolve => held.push(resolve));
      if (requestMode === 'empty') result.result.recommendations = [];
      await route.fulfill(requestMode === 'error' ? { status: 503, json: {} } : requestMode === 'malformed' ? { body: '<html>upstream unavailable</html>' } : { json: result }).catch(() => {});
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const section = page.getByRole('region', { name: 'Gợi ý ăn kèm', exact: true });
    const waitRequests = async count => { for (let i = 0; i < 150 && requests.length < count; i++) await page.waitForTimeout(20); assert.equal(requests.length, count); };
    const waitHeld = async () => { for (let i = 0; i < 150 && !held.length; i++) await page.waitForTimeout(20); assert.ok(held.length); };
    await page.goto(`${origin}/menu?tableId=${tableId}`); await waitHeld();
    assert.ok(await section.getByText('Đang tải gợi ý…', { exact: true }).isVisible());
    await page.getByRole('button', { name: /^Mở giỏ hàng/ }).click(); await page.getByRole('button', { name: 'Đóng giỏ hàng', exact: true }).click();
    assert.equal(adds.length, 0); done('Loading stays local; cart opens; suggestions never auto-add');
    held.shift()(); mode = 'normal'; await section.getByRole('button', { name: 'Chọn Gỏi cuốn tôm', exact: true }).waitFor();
    assert.equal(await section.getByText('Thường được gọi cùng món đã chọn', { exact: true }).count(), 2);
    assert.equal(await section.getByRole('button', { name: 'Chọn Phở bò', exact: true }).count(), 0);
    done('DB-shaped dishes, prices, pair labels and duplicate exclusion render');
    const initialCount = requests.length; for (let i = 0; i < 25; i++) emit(); await page.waitForTimeout(800); assert.equal(requests.length, initialCount);
    cart = { ...cart, version: cart.version + 1, cart: [{ ...cart.cart[0], quantity: 7, note: 'không hành' }, { ...cart.cart[0], cartItemId: 'variant', note: 'ít cay' }] }; emit();
    await page.waitForTimeout(700); assert.equal(requests.length, initialCount);
    done('Socket echoes, quantity and note variants do not trigger requests');
    await section.getByRole('button', { name: 'Chọn Gỏi cuốn tôm', exact: true }).click();
    await page.locator('#dish-note').fill('  không hành  '); await page.getByRole('button', { name: 'Thêm vào giỏ', exact: true }).click();
    await waitRequests(initialCount + 1); assert.equal(adds.length, 1); assert.equal(adds[0].dishId, dishes[1]._id); assert.equal(adds[0].note.trim(), 'không hành');
    await section.getByRole('button', { name: 'Chọn Trà đào', exact: true }).waitFor();
    assert.equal(await section.getByRole('button', { name: 'Chọn Gỏi cuốn tôm', exact: true }).count(), 0);
    done('Choose opens existing note dialog; explicit add uses original cart Socket flow');
    const beforeBurst = requests.length;
    for (let i = 0; i < 20; i++) { cart = { ...cart, version: cart.version + 1, cart: i % 2 ? [] : [{ cartItemId: 'a', dishId: dishes[0]._id, dishName: dishes[0].name, unitPrice: 50000, quantity: 1 }] }; emit(); }
    await waitRequests(beforeBurst + 1); await section.getByText('Phổ biến', { exact: true }).first().waitFor();
    await page.waitForTimeout(800); assert.equal(requests.length, beforeBurst + 1);
    done('Rapid shared-cart mutations coalesce to one request; empty cart labels popularity');
    mode = 'hold'; cart = { ...cart, cart: [{ cartItemId: 'b', dishId: dishes[1]._id, dishName: dishes[1].name, unitPrice: 50000, quantity: 1 }] }; emit(); await waitHeld();
    const stale = held.shift(); mode = 'normal'; cart = { ...cart, cart: [] }; emit(); await section.getByText('Phổ biến', { exact: true }).first().waitFor(); stale(); await page.waitForTimeout(200);
    assert.equal(await section.getByText('Thường được gọi cùng món đã chọn', { exact: true }).count(), 0);
    done('Late response cannot replace the newer cart context');
    mode = 'error'; cart = { ...cart, cart: [{ cartItemId: 'a', dishId: dishes[0]._id, dishName: dishes[0].name, unitPrice: 50000, quantity: 1 }] }; emit();
    await section.getByRole('button', { name: 'Thử lại gợi ý', exact: true }).waitFor(); const errorsCount = requests.length; await page.waitForTimeout(800); assert.equal(requests.length, errorsCount);
    await page.getByRole('button', { name: /^Mở giỏ hàng/ }).click(); await page.getByRole('button', { name: 'Gửi đơn đến bếp', exact: true }).click();
    await page.getByRole('button', { name: 'Đóng giỏ hàng', exact: true }).waitFor({ state: 'hidden' }); assert.equal(orderRequests.length, 1);
    await section.getByRole('button', { name: 'Thử lại gợi ý', exact: true }).waitFor();
    done('503 has no automatic retry loop and does not block submitting an order');
    mode = 'empty'; await section.getByRole('button', { name: 'Thử lại gợi ý', exact: true }).click(); await section.getByText('Chưa có gợi ý phù hợp.', { exact: true }).waitFor();
    done('Explicit retry and honest empty state work');
    mode = 'malformed'; cart = { ...cart, cart: [{ cartItemId: 'a', dishId: dishes[0]._id, dishName: dishes[0].name, unitPrice: 50000, quantity: 1 }] }; emit();
    await section.getByRole('button', { name: 'Thử lại gợi ý', exact: true }).waitFor();
    mode = 'normal'; await section.getByRole('button', { name: 'Thử lại gợi ý', exact: true }).click(); await section.getByRole('button', { name: 'Chọn Trà đào', exact: true }).waitFor();
    done('Malformed upstream data remains a recoverable local error');
    const beforeSearch = requests.length; const search = page.locator('#menu-search'); await search.fill('không đậu phộng');
    assert.equal(await section.count(), 0); await page.waitForTimeout(450); assert.equal(requests.length, beforeSearch);
    await page.getByRole('button', { name: 'Tìm bằng AI', exact: true }).click();
    await section.getByText('Không thể xác minh đầy đủ điều kiện dị ứng.', { exact: true }).waitFor();
    assert.deepEqual(requests.at(-1).constraints, { excludedAllergens: ['peanut'], requiredDietaryTags: ['vegan'], maxPrice: 100000 });
    assert.equal(requests.at(-1).dishIds, undefined); assert.equal(requests.at(-1).price, undefined);
    done('Unresolved search hides suggestions; supported semantic hard constraints are forwarded without client facts');
    await search.fill(''); mode = 'hold'; await waitHeld(); const languageStale = held.shift();
    mode = 'normal'; await page.getByLabel('Ngôn ngữ menu', { exact: true }).selectOption('en'); languageStale();
    const enSection = page.getByRole('region', { name: 'Suggestions for your basket', exact: true });
    await enSection.getByRole('button', { name: 'Choose Peach tea', exact: true }).waitFor(); assert.equal(requests.at(-1).lang, 'en');
    done('Language changes cancel stale suggestions and use localized facts');
    await mkdir(path.resolve(__dirname, '../test-results'), { recursive: true });
    for (const [width, height] of [[1280, 1000], [375, 812], [812, 375]]) {
      await page.setViewportSize({ width, height }); await enSection.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const button = enSection.getByRole('button', { name: 'Choose Peach tea', exact: true }); await search.focus(); await button.focus();
      assert.ok(await button.evaluate(el => { const rect = el.getBoundingClientRect(); return rect.height >= 44 && el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); }));
      await page.screenshot({ path: path.resolve(__dirname, `../test-results/phase23-${width}.png`), fullPage: true });
    }
    done('Desktop/mobile/landscape fit; keyboard focus and 44px controls; reduced motion');
    mode = 'hold'; cart = { ...cart, cart: [] }; emit(); await waitHeld(); const unmount = held.shift();
    await page.goto(`${origin}/login`); unmount(); await page.waitForTimeout(200); assert.deepEqual(errors, []);
    done('Unmount cancels pending work and no browser JavaScript errors');
    console.log(`Phase 23 browser: ${passed.length}/${passed.length} scenarios PASS (mock HTTP/business Socket)`);
  } finally { await browser?.close(); await new Promise(resolve => io.close(resolve)); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
