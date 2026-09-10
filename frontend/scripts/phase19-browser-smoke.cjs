/* Built React UI, mocked HTTP/business Socket handlers. Real server/DB evidence:
 * backend/test/order-note.e2e-spec.ts. No live model/provider calls. */
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
  const tableId = '123456789012345678901234', sessionId = '123456789012345678901235', dishId = '123456789012345678901236';
  const note = 'Không hành, ít cay, dị ứng đậu phộng';
  const analysis = { summary: 'Không hành; Ít cay', modifierTags: ['NO_ONION', 'LESS_SPICY'], allergyMentioned: true, warnings: ['Khách có đề cập dị ứng. Nhân viên cần xác minh trực tiếp.', 'Dữ liệu món hiện ghi nhận allergen đậu phộng. Cần xác minh với nhân viên.'], modelVersion: 'mock:test:order-note-v1', fallbackUsed: false, confirmedByCustomer: true };
  let previewAnalysis = analysis;
  const dish = { _id: dishId, name: 'Món thử Phase 19', price: 50000, isAvailable: true };
  const cart = { sessionId, tableId, version: 0, cart: [] };
  const events = [], aiRequests = [], orderRequests = [], kitchen = [];
  let released, routeEntered, errorCode = null;
  const emitCart = () => { cart.version++; io.emit('cart:synced', cart); };
  io.on('connection', socket => {
    socket.on('cart:join', () => socket.emit('cart:synced', cart));
    socket.on('cart:add', payload => {
      events.push(payload);
      let row = cart.cart.find(item => item.note === payload.note);
      if (!row) { row = { cartItemId: `row-${cart.cart.length}`, dishId, dishName: dish.name, note: payload.note, unitPrice: dish.price, quantity: 0 }; cart.cart.push(row); }
      row.quantity += payload.quantity;
      if (payload.analysisToken && payload.confirmedByCustomer) row.aiNoteAnalysis = analysis;
      emitCart();
    });
    socket.on('cart:update-quantity', payload => { cart.cart.find(item => item.cartItemId === payload.cartItemId).quantity = payload.quantity; emitCart(); });
    socket.on('cart:remove', payload => { cart.cart = cart.cart.filter(item => item.cartItemId !== payload.cartItemId); emitCart(); });
  });
  let browser; const passed = []; const done = name => { passed.push(name); console.log(`PASS ${passed.length}: ${name}`); };
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    await context.route(/\/socket.io\//, async route => { try { const url = new URL(route.request().url()); const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}` }); await route.fulfill({ response }); } catch {} });
    await context.route(url => url.pathname === '/ai/order-notes/analyze', async route => {
      aiRequests.push(route.request().postDataJSON()); const code = errorCode;
      await new Promise(resolve => { released = resolve; routeEntered?.(); });
      await route.fulfill(code ? { status: code === 'AI_TIMEOUT' ? 504 : 503, json: { code, message: 'Controlled test error' } } : { json: { result: { summary: previewAnalysis.summary, modifierTags: previewAnalysis.modifierTags, allergyMentioned: previewAnalysis.allergyMentioned }, warnings: previewAnalysis.warnings, modelVersion: previewAnalysis.modelVersion, fallbackUsed: false, analysisToken: 'server-signed-test-token' } }).catch(() => {});
    });
    await context.route(url => url.pathname === '/menu', route => route.request().resourceType() === 'document' ? route.continue() : route.fulfill({ json: { table: { id: tableId, tableCode: 'P19' }, categories: [{ _id: 'category', id: 'category', name: 'Món Việt', dishes: [dish] }] } }));
    await context.route('**/sessions/active?**', route => route.fulfill({ json: cart }));
    await context.route('**/vnpay/session-summary?**', route => route.fulfill({ json: { sessionId, tableId, tableIds: [tableId], tableCode: 'P19', sessionOrderCount: 0, orderCount: 0, itemCount: 0, subtotalAmount: 0, discountAmount: 0, payableTotal: 0, canPay: false, fullyPaid: false, eligibilityMessage: 'Chưa có món', orders: [], payableOrders: [] } }));
    await context.route(url => url.pathname === '/orders', async route => {
      orderRequests.push(route.request().postDataJSON());
      kitchen.push({ orderId: 'order', tableId, tableCode: 'P19', tableDisplayName: 'P19', createdAt: new Date().toISOString(), items: cart.cart.map((item, i) => ({ ...item, itemId: `item-${i}`, status: 'Pending' })) });
      cart.cart = []; emitCart();
      await route.fulfill({ status: 201, json: { orderId: 'order', sessionId, tableId, status: 'Pending', totalAmount: 50000 } });
    });
    await context.route(url => url.pathname === '/orders/kitchen', route => route.fulfill({ json: kitchen }));
    await context.route(/\/orders\/order\/items\/.*\/status$/, async route => {
      const itemId = new URL(route.request().url()).pathname.split('/')[4]; const { status } = route.request().postDataJSON();
      kitchen[0].items.find(item => item.itemId === itemId).status = status;
      await route.fulfill({ json: {} });
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/menu?tableId=${tableId}`);
    const open = async (text = note) => { await page.getByRole('button', { name: `Xem chi tiết ${dish.name}` }).click(); await page.locator('#dish-note').fill(text); };
    const panel = () => page.getByRole('region', { name: 'Phân tích ghi chú bằng AI' });
    const start = async () => { released = null; const routed = new Promise(resolve => { routeEntered = resolve; }); const pending = page.waitForRequest('**/ai/order-notes/analyze'); await panel().getByRole('button', { name: 'Analyze with AI', exact: true }).click(); await pending; await routed; assert.ok(released); };
    const finish = async () => { released(); await panel().getByRole('button', { name: 'Use analysis' }).waitFor(); };
    const add = async () => { const count = events.length; await page.getByRole('button', { name: 'Thêm vào giỏ', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('[role="dialog"]')); const startAt = Date.now(); while (events.length === count && Date.now() - startAt < 6000) await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(events.length, count + 1); };
    await open(); await start();
    assert.equal(await panel().getByRole('button', { name: 'Đang phân tích…' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Thêm vào giỏ', exact: true }).isEnabled(), true);
    assert.deepEqual(aiRequests[0], { sessionId, tableId, dishId, note });
    done('Analyze loading/input ownership; add remains enabled');
    await finish(); assert.equal(await page.locator('#dish-note').inputValue(), note); assert.equal(events.length, 0);
    assert.ok(await panel().getByText(note, { exact: true }).isVisible());
    done('Preview original/summary/allergy warnings without cart mutation');
    await panel().getByRole('button', { name: 'Ignore', exact: true }).click(); await add();
    assert.equal(events[0].note, note); assert.equal(events[0].analysisToken, undefined);
    done('Ignore adds original note with no analysis');
    await open(); await start(); await finish(); await panel().getByRole('button', { name: 'Use analysis' }).click();
    assert.equal(events.length, 1); await add();
    assert.equal(events[1].analysisToken, 'server-signed-test-token'); assert.equal(events[1].confirmedByCustomer, true); assert.equal(events[1].note, note);
    done('Use analysis requires explicit add, sends receipt and unchanged note');
    await open(); await start(); await finish(); await panel().getByRole('button', { name: 'Use analysis' }).click(); await page.locator('#dish-note').fill('ít cay'); await add();
    assert.equal(events.at(-1).analysisToken, undefined);
    done('Changing note invalidates accepted preview');
    await open('không tiêu'); await start(); const lateRelease = released; await page.locator('#dish-note').fill('thêm nước chấm'); lateRelease();
    assert.equal(await panel().getByRole('button', { name: 'Use analysis' }).count(), 0); await add(); assert.equal(events.at(-1).note, 'thêm nước chấm');
    done('Late result after note edit cannot restore stale metadata');
    await open(); await start(); const closedRelease = released; await page.getByRole('dialog').getByRole('button', { name: 'Đóng hộp thoại', exact: true }).click(); closedRelease();
    await open('ghi chú mới'); assert.equal(await panel().getByRole('button', { name: 'Use analysis' }).count(), 0); await add();
    done('Close/reopen aborts previous analysis');
    for (const code of ['AI_DISABLED','AI_NOT_CONFIGURED','AI_TIMEOUT','AI_PROVIDER_UNAVAILABLE','AI_INVALID_OUTPUT']) {
      errorCode = code; await open(`ghi chú ${code}`); await start(); released(); await panel().getByRole('alert').waitFor();
      assert.equal(await page.locator('#dish-note').inputValue(), `ghi chú ${code}`); await add(); assert.equal(events.at(-1).analysisToken, undefined);
    }
    errorCode = null; done('Five AI failure modes retain note and allow add');
    for (const supported of [false, true]) {
      const warning = 'Món chưa có modifier tương ứng cho yêu cầu “Không cay” (NO_SPICE); dữ liệu hiện chưa hỗ trợ tùy chỉnh này. Nhân viên cần xác minh khả năng đáp ứng.';
      previewAnalysis = { ...analysis, summary: 'Không cay; dành cho trẻ em', modifierTags: supported ? ['NO_SPICE'] : [], allergyMentioned: false, warnings: supported ? [] : [warning] };
      await open('không cay cho trẻ em ăn'); await start(); await finish();
      assert.ok(await panel().getByText(previewAnalysis.summary, { exact: true }).isVisible());
      assert.equal(await panel().locator('li').count(), supported ? 0 : 1);
      if (!supported) assert.ok(await panel().getByText(warning, { exact: true }).isVisible());
      assert.equal(await panel().getByText(/Có đề cập dị ứng/).count(), 0);
      assert.equal(await panel().getByText('Nhân viên vui lòng xem ghi chú gốc.', { exact: true }).count(), 0);
      await page.getByRole('dialog').getByRole('button', { name: 'Đóng hộp thoại', exact: true }).click();
      done(`Child/no-spice semantics render with ${supported ? 'supported modifier, no warnings' : 'empty tags, specific warning'}`);
    }
    previewAnalysis = analysis;
    await open('đặt khi đang phân tích'); await start(); const pendingRelease = released; await add(); pendingRelease(); assert.equal(events.at(-1).analysisToken, undefined);
    done('Adding while AI is pending works with original note');
    await page.getByRole('button', { name: /^Mở giỏ hàng/ }).click();
    assert.equal(cart.cart.filter(item => item.note === note).length, 1); assert.equal(cart.cart.find(item => item.note === note).quantity, 2);
    assert.ok(await page.getByRole('dialog').getByText(note, { exact: true }).isVisible()); assert.ok(await page.getByRole('region', { name: 'AI hỗ trợ ghi chú' }).isVisible());
    await page.getByRole('button', { name: 'Gửi đơn đến bếp', exact: true }).click(); await page.getByText('Đơn đã được gửi đến bếp.', { exact: false }).waitFor();
    assert.equal(orderRequests.length, 1); assert.equal(orderRequests[0].tableId, tableId);
    done('Shared cart keeps same-note identity, different notes, original + accepted metadata, submits order');
    await open(); await start(); await finish();
    await mkdir(path.resolve(__dirname, '../test-results'), { recursive: true });
    for (const [width, height] of [[1280,1000],[375,812],[812,375]]) {
      await page.setViewportSize({ width, height }); await panel().scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.ok(await panel().getByText(note, { exact: true }).isVisible());
      await page.screenshot({ path: path.resolve(__dirname, `../test-results/phase19-${width}.png`) });
      const approve = panel().getByRole('button', { name: 'Use analysis', exact: true });
      await approve.click({ trial: true });
      await approve.focus();
      assert.ok(await approve.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }));
    }
    done('Desktop/mobile/landscape preview and reduced motion without horizontal overflow');
    await page.evaluate(() => { localStorage.setItem('accessToken', 'test-only'); localStorage.setItem('user', JSON.stringify({ role: 'kitchen', fullName: 'Phase 19 fixture' })); });
    await page.setViewportSize({ width: 1280, height: 1000 }); await page.goto(`${origin}/kitchen`);
    const ticket = page.locator('article').filter({ hasText: note }).first(); await ticket.waitFor();
    assert.ok(await ticket.getByText(`Ghi chú khách: ${note}`, { exact: true }).isVisible());
    assert.ok(await ticket.getByRole('region', { name: 'AI hỗ trợ ghi chú' }).isVisible());
    await ticket.getByRole('button', { name: /Bắt đầu/ }).click();
    assert.equal(kitchen[0].items[0].status, 'Preparing');
    assert.ok(await ticket.getByRole('region', { name: 'AI hỗ trợ ghi chú' }).isVisible());
    await page.screenshot({ path: path.resolve(__dirname, '../test-results/phase19-kitchen.png'), fullPage: true });
    done('Kitchen renders original and accepted analysis through state transition');
    assert.deepEqual(errors, []); done('Zero browser JavaScript errors');
    console.log(`Phase 19 browser: ${passed.length}/${passed.length} scenarios PASS (mock HTTP/business Socket handlers)`);
  } finally { await browser?.close(); await new Promise(resolve => io.close(resolve)); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
