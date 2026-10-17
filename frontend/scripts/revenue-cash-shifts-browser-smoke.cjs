/* Production bundle, local fixtures; no real users, payments or cash shifts. */
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const { createServer } = require('node:http');
const { readFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const dist = path.resolve(__dirname, '../dist');
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = pathname.startsWith('/assets/') ? path.join(dist, 'assets', path.basename(pathname)) : path.join(dist, 'index.html');
    try { res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(file)); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const staffId = '507f1f77bcf86cd799439011';
  const row = { id: 'receipt', invoiceCode: 'INV-20261017-K7P4X2M9', sessionId: 'session', orderIds: ['order'], paidAt: '2026-10-17T08:00:00Z', amount: 5000000, paymentMethod: 'CASH', tableName: 'A01', staffName: 'Phục vụ', settledBy: staffId, cashShiftId: 'shift' };
  let active = null, history = [], mode = 'normal', lastQuery, lastClose, failClose = false;
  const makeShift = openingCash => ({ id: 'shift', staffId, staffName: 'Phục vụ', openedAt: '2026-10-17T01:00:00Z', closedAt: null, openingCash, cashSales: 5000000, expectedCash: openingCash + 5000000, actualCash: null, variance: null, status: 'OPEN', version: 1, transactionCount: 1, closedBy: null, closedByName: null });
  const pageData = shift => ({ ...shift, transactions: [row], page: 1, pageSize: 50 });
  let browser;
  const errors = [];
  let passed = 0;
  const done = label => console.log(`PASS ${++passed}: ${label}`);
  try {
    browser = await chromium.launch({ headless: true });
    async function contextFor(role) {
      const context = await browser.newContext({ viewport: { width: 1366, height: 1000 }, reducedMotion: 'reduce' });
      await context.addInitScript(({ role, staffId }) => {
        localStorage.setItem('accessToken', 'fixture');
        localStorage.setItem('user', JSON.stringify({ id: staffId, role, fullName: 'Phục vụ', email: 'fixture@example.invalid' }));
      }, { role, staffId });
      await context.route('**/*', async route => {
        if (!['xhr', 'fetch'].includes(route.request().resourceType())) return route.continue();
        const url = new URL(route.request().url()), method = route.request().method();
        const json = body => route.fulfill({ json: body });
        if (url.pathname === '/admin/revenue/staff') return json([{ _id: staffId, fullName: 'Phục vụ' }]);
        if (url.pathname === '/admin/revenue') {
          lastQuery = Object.fromEntries(url.searchParams);
          if (mode === 'error') return route.fulfill({ status: 503, json: { message: 'Chưa thể tải báo cáo' } });
          const empty = mode === 'empty';
          return json({ totalRevenue: empty ? 0 : 5250000, cashRevenue: empty ? 0 : 5000000, vnpayRevenue: empty ? 0 : 250000, cashInOpenShifts: 0, cashInClosedShifts: 0, unassignedHistoricalCash: empty ? 0 : 5000000, transactionCount: empty ? 0 : 2, timezone: 'Asia/Ho_Chi_Minh', page: 1, pageSize: 50, transactions: empty ? [] : [{ ...row, cashShiftId: null }, { ...row, id: 'vnp', invoiceCode: 'INV-20261017-X7P4X2M9', paymentMethod: 'VNPAY', amount: 250000, staffName: null }], byDay: empty ? [] : [{ date: '2026-10-17', totalRevenue: 5250000, cashRevenue: 5000000, vnpayRevenue: 250000 }], cashByStaff: empty ? [] : [{ staffId, staffName: 'Phục vụ', revenue: 5000000, transactionCount: 1 }] });
        }
        if (url.pathname === '/cash-shifts/current') return json(active);
        if (['/cash-shifts/mine', '/admin/cash-shifts'].includes(url.pathname)) return json({ shifts: history, total: history.length, page: 1, pageSize: 50 });
        if (url.pathname === '/cash-shifts' && method === 'POST') {
          const body = route.request().postDataJSON(); assert.deepEqual(Object.keys(body), ['openingCash']);
          active = makeShift(body.openingCash); history = [active]; return json(pageData(active));
        }
        if (url.pathname === '/cash-shifts/shift/close') {
          lastClose = route.request().postDataJSON();
          assert.deepEqual(Object.keys(lastClose).sort(), ['actualCash', 'version']);
          if (failClose) { failClose = false; active = { ...active, version: 2 }; history = [active]; return route.fulfill({ status: 409, json: { message: 'Ca vừa có thay đổi; tải lại số tiền trước khi đóng' } }); }
          const closed = { ...active, status: 'CLOSED', actualCash: lastClose.actualCash, variance: lastClose.actualCash - active.expectedCash, closedAt: '2026-10-17T15:00:00Z', closedBy: staffId, closedByName: 'Phục vụ' };
          active = null; history = [closed]; return json(pageData(closed));
        }
        if (url.pathname === '/cash-shifts/shift') return json(pageData(history[0]));
        throw new Error(`Unexpected request: ${method} ${url.pathname}`);
      });
      const page = await context.newPage(); page.on('pageerror', err => errors.push(err.message));
      return { context, page };
    }
    const { page: admin, context: adminContext } = await contextFor('admin');
    await admin.goto(`${origin}/admin/revenue`);
    await admin.getByRole('heading', { name: 'Hóa đơn', exact: true }).waitFor();
    assert.equal(await admin.locator('dl').first().locator(':scope > div').count(), 4);
    const historical = admin.getByRole('region', { name: 'CASH theo ca' });
    await historical.getByText('Unassigned / Historical CASH', { exact: true }).waitFor();
    assert.match(await historical.innerText(), /5\.000\.000/);
    assert.match(await historical.innerText(), /không tính vào chênh lệch/);
    await admin.getByRole('link', { name: row.invoiceCode, exact: true }).waitFor();
    await Promise.all([admin.waitForResponse(response => response.url().includes('/admin/revenue?')), admin.getByRole('button', { name: '7 ngày', exact: true }).click()]);
    assert.equal((Date.parse(lastQuery.to) - Date.parse(lastQuery.from)) / 86400000, 6);
    await admin.getByRole('button', { name: 'Khoảng ngày', exact: true }).click();
    await admin.getByLabel('Từ ngày', { exact: true }).fill('2026-10-01');
    await admin.getByLabel('Đến hết ngày', { exact: true }).fill('2026-10-17');
    await Promise.all([admin.waitForResponse(response => response.url().includes('/admin/revenue?')), admin.getByRole('button', { name: 'Áp dụng' }).click()]);
    assert.equal(lastQuery.from, '2026-10-01'); assert.equal(lastQuery.to, '2026-10-17');
    await Promise.all([admin.waitForResponse(response => new URL(response.url()).searchParams.get('staffId') === staffId), admin.getByRole('combobox', { name: /^Nhân viên thu CASH/ }).selectOption(staffId)]);
    done('Revenue totals, invoice link, Vietnam date presets and staff filter');
    const artifacts = path.resolve(__dirname, '../../.tmp/revenue-verification'); await mkdir(artifacts, { recursive: true });
    await admin.screenshot({ path: path.join(artifacts, 'revenue-desktop.png'), fullPage: true });
    for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
      await admin.setViewportSize(viewport);
      await admin.screenshot({ path: path.join(artifacts, `revenue-${viewport.width}.png`), fullPage: true });
      assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, JSON.stringify(await admin.evaluate(() => [...document.querySelectorAll('main > *, main section, main .grid')].filter(element => element.getBoundingClientRect().right > innerWidth + 1).map(element => ({ width: element.getBoundingClientRect().width, cls: element.className })))));
    }
    await admin.setViewportSize({ width: 375, height: 812 });
    await admin.screenshot({ path: path.join(artifacts, 'revenue-mobile.png'), fullPage: true });
    done('Revenue at 375px and landscape without page overflow');
    mode = 'error'; await admin.getByRole('button', { name: 'Tải lại', exact: true }).click();
    await admin.getByText('Chưa thể tải báo cáo', { exact: true }).waitFor();
    assert.equal(await admin.locator('dl > div').count(), 0);
    mode = 'empty'; await admin.getByRole('button', { name: 'Tải lại', exact: true }).click();
    await admin.getByText('Chưa có hóa đơn phù hợp.').waitFor();
    mode = 'normal'; done('Error clears stale totals; empty report remains explicit');
    const { page: waiter, context: waiterContext } = await contextFor('waiter');
    await waiter.goto(`${origin}/waiter/cash-shifts`);
    await waiter.getByLabel('Tiền đầu ca (VND)').fill('50000');
    await waiter.getByRole('button', { name: 'Mở ca tiền mặt', exact: true }).click();
    await waiter.getByRole('button', { name: 'Xem và đóng ca' }).click();
    const dialog = waiter.getByRole('dialog');
    await dialog.getByLabel('Tiền thực tế nộp (VND)').fill('4850000');
    assert.equal(await dialog.locator('input').count(), 1);
    failClose = true; await dialog.getByRole('button', { name: 'Xác nhận đóng ca' }).click();
    await dialog.getByText('Ca vừa có thay đổi; tải lại số tiền trước khi đóng').waitFor();
    await dialog.getByLabel('Tiền thực tế nộp (VND)').waitFor();
    assert.equal(await dialog.getByLabel('Tiền thực tế nộp (VND)').inputValue(), '4850000');
    await dialog.getByRole('button', { name: 'Xác nhận đóng ca' }).click();
    await dialog.getByText('Có chênh lệch đối soát.', { exact: false }).waitFor();
    assert.equal(lastClose.version, 2); assert.equal(lastClose.actualCash, 4850000);
    assert.match(await dialog.innerText(), /-200\.000/);
    assert.equal(await dialog.locator('input').count(), 0);
    await waiter.setViewportSize({ width: 375, height: 812 });
    assert.equal(await waiter.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await waiter.screenshot({ path: path.join(artifacts, 'close-shift-mobile.png'), fullPage: true });
    done('Waiter opens own shift, reloads stale close preview, submits actual only, sees persisted variance');
    await admin.setViewportSize({ width: 1366, height: 1000 });
    await admin.goto(`${origin}/admin/cash-shifts`);
    await admin.getByText('Có chênh lệch', { exact: true }).waitFor();
    await admin.getByRole('button', { name: /^Chi tiết ca/ }).click();
    await admin.getByRole('dialog').getByRole('link', { name: row.invoiceCode }).waitFor();
    assert.equal(await admin.getByRole('dialog').locator('input').count(), 0);
    await admin.screenshot({ path: path.join(artifacts, 'reconciliation-desktop.png'), fullPage: true });
    done('Admin discrepancy highlight, immutable closed shift detail and CASH receipts');
    assert.deepEqual(errors, []);
    await adminContext.close(); await waiterContext.close();
    console.log(`Completed ${passed} focused browser checks`);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
