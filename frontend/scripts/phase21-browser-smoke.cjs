/* Actual production UI; explicitly mocked HTTP/Socket, synthetic analytics. */
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
  const requests = [], errors = [], passed = [];
  const done = label => { passed.push(label); console.log(`PASS ${passed.length}: ${label}`); };
  let browser, mode = 'success', release, entered;
  const period = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z', timezone: 'UTC' };
  const warning = 'Mẫu dữ liệu nhỏ; chưa đủ cơ sở để kết luận xu hướng.';
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => { localStorage.setItem('user', JSON.stringify({ role: 'admin', fullName: 'Synthetic Phase 21' })); localStorage.setItem('accessToken', 'test-only'); });
    await context.route(/\/socket.io\//, async route => { try { const url = new URL(route.request().url()); await route.fulfill({ response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }) }); } catch {} });
    let analyticsGets = 0; const analyticsUrls = [];
    await context.route('**/admin/analytics/**', route => {
      if (route.request().method() !== 'GET') return route.fallback();
      analyticsGets++;
      analyticsUrls.push(new URL(route.request().url()));
      const pathname = new URL(route.request().url()).pathname;
      return route.fulfill({ json: pathname.endsWith('/overview') ? { totalOrders: 20, ordersToday: 2, occupiedTables: 1, avgOrderValue: 100000 }
        : pathname.endsWith('/top-rated-dishes') ? [{ dishName: 'Phở synthetic', averageRating: 4.5, reviewCount: 2 }]
        : pathname.endsWith('/top-dishes') ? [{ dishName: 'Phở synthetic', totalQuantity: 3, revenue: 300000 }]
        : [{ date: '2026-08-01', revenue: 12500000, orders: 2 }] });
    });
    await context.route('**/ai/admin/analytics/query', async route => {
      requests.push(route.request().postDataJSON()); const currentMode = mode;
      await new Promise(resolve => { release = resolve; entered?.(); });
      const result = { result: { answer: 'Doanh thu đã thanh toán: 12.500.000 VND.' }, facts: [{ id: 'f1', metric: 'revenue', label: 'Doanh thu đã thanh toán', value: 12500000, unit: 'VND', period }], warnings: [warning], modelVersion: 'mock:admin-analytics-v1', fallbackUsed: false };
      if (currentMode === 'unsupported') { result.result.answer = 'Hệ thống chưa có dữ liệu cost/margin/waste.'; result.facts = []; result.warnings = ['Chưa có dữ liệu chi phí.']; }
      await route.fulfill(currentMode === 'error' ? { status: 503, json: { code: 'AI_DISABLED' } } : { json: result }).catch(() => {});
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/admin`);
    await page.getByRole('heading', { name: 'Xu hướng doanh thu' }).waitFor();
    const input = page.getByLabel('Câu hỏi phân tích');
    await input.fill('Doanh thu tháng này?'); assert.equal(requests.length, 0);
    done('dashboard charts available; typing sends no AI request');
    const send = async () => { const started = new Promise(resolve => { entered = resolve; }); await input.press('Enter'); await started; };
    await send(); await page.getByRole('button', { name: 'Đang phân tích…' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Đang phân tích…' }).isDisabled(), true);
    await page.getByRole('heading', { name: 'Xu hướng doanh thu' }).waitFor();
    assert.equal(requests[0].query, 'Doanh thu tháng này?'); done('submit and loading retain existing dashboard');
    release(); await page.getByRole('heading', { name: 'Câu trả lời', exact: true }).waitFor();
    assert.match(await page.locator('section[aria-labelledby="copilot-title"]').innerText(), /12\.500\.000 VND/); done('answer rendered');
    await page.getByRole('heading', { name: 'Dữ liệu sử dụng' }).waitFor(); await page.getByText('Kỳ: 2026-08-01 – 2026-08-31 (UTC)', { exact: true }).waitFor(); done('facts and UTC range rendered');
    await page.getByText(warning, { exact: true }).waitFor(); done('warnings rendered separately');
    mode = 'error'; await input.fill('doanh thu hôm nay'); await send(); release(); await page.getByRole('alert').filter({ hasText: 'Chưa thể trả lời bằng AI' }).waitFor();
    await page.getByRole('heading', { name: 'Xu hướng doanh thu' }).waitFor();
    const getsBefore = analyticsGets; await page.getByRole('button', { name: 'Áp dụng', exact: true }).click();
    await page.waitForTimeout(150); assert.ok(analyticsGets > getsBefore); done('AI error leaves charts and analytics refresh usable');
    mode = 'success'; const retryStarted = new Promise(resolve => { entered = resolve; }); await page.getByRole('button', { name: 'Thử lại', exact: true }).click(); await retryStarted; release();
    await page.getByRole('heading', { name: 'Câu trả lời', exact: true }).waitFor(); done('retry succeeds without losing question');
    mode = 'unsupported'; await input.fill('lợi nhuận tháng này'); await send(); release(); await page.getByText('Không có dữ liệu hỗ trợ câu hỏi này.', { exact: true }).waitFor(); done('unsupported response with explicit warning and empty facts');
    mode = 'success'; await input.fill('doanh thu'); await send(); await input.fill('câu hỏi đã đổi'); release(); await page.waitForTimeout(150);
    assert.equal(await page.getByRole('heading', { name: 'Câu trả lời', exact: true }).count(), 0); done('editing cancels stale response');
    await page.getByLabel('Từ ngày', { exact: true }).fill('2026-08-01'); await page.getByLabel('Đến ngày', { exact: true }).fill('2026-08-31');
    await page.getByRole('button', { name: 'Áp dụng', exact: true }).click();
    await page.waitForTimeout(150);
    assert.ok(analyticsUrls.some(url => url.pathname.endsWith('/revenue') && url.searchParams.get('to') === '2026-08-31T23:59:59.999Z'));
    await input.fill('doanh thu'); await send(); assert.equal(requests.at(-1).fromDate, '2026-08-01'); assert.equal(requests.at(-1).toDate, '2026-08-31');
    await page.getByLabel('Đến ngày', { exact: true }).fill('2026-08-15'); release(); await page.waitForTimeout(150);
    assert.equal(await page.getByRole('heading', { name: 'Câu trả lời', exact: true }).count(), 0); done('dashboard dates sent; date edits cancel stale response');
    await send(); release(); await page.getByRole('heading', { name: 'Câu trả lời', exact: true }).waitFor();
    await mkdir(path.resolve(__dirname, '../test-results'), { recursive: true });
    for (const viewport of [{ width: 1280, height: 1000 }, { width: 375, height: 812 }, { width: 812, height: 375 }]) {
      await page.setViewportSize(viewport); await input.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.ok((await page.getByRole('button', { name: 'Hỏi phân tích', exact: true }).boundingBox()).height >= 44);
      await page.screenshot({ path: path.resolve(__dirname, `../test-results/phase21-${viewport.width}.png`), fullPage: true });
    }
    done('responsive desktop/mobile/landscape, reduced motion, no page overflow');
    assert.deepEqual(errors, []); done('zero browser JavaScript errors');
    console.log(`Phase 21: ${passed.length}/${passed.length} scenarios PASS (mock HTTP/Socket; synthetic data).`);
  } finally { await browser?.close(); await new Promise(resolve => io.close(resolve)); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
