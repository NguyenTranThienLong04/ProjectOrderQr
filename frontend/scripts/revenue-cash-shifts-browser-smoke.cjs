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
  let active = null, history = [], mode = 'normal', lastQuery, lastSubmit, lastVerify, failSubmit = false;
  const makeShift = openingCash => ({ id: 'shift', staffId, staffName: 'Phục vụ', openedAt: '2026-10-17T01:00:00Z', closedAt: null, openingCash, cashSales: 5000000, expectedCash: openingCash + 5000000, actualCash: null, variance: null, declaredCash: null, declaredVariance: null, submittedAt: null, verifiedCash: null, verifiedVariance: null, verifiedAt: null, status: 'OPEN', version: 1, transactionCount: 1, closedBy: null, closedByName: null });
  const view = (shift, role) => {
    if (!shift) return null;
    const result = { ...shift, canSubmit: role === 'waiter' && shift.status === 'OPEN', canVerify: role === 'admin' && shift.status === 'PENDING_REVIEW' };
    if (role === 'waiter' && shift.status === 'OPEN') for (const key of ['cashSales', 'expectedCash', 'variance', 'declaredVariance', 'verifiedVariance']) delete result[key];
    return result;
  };
  const pageData = (shift, role) => ({ ...view(shift, role), transactions: role === 'waiter' && shift.status === 'OPEN' ? [] : [row], page: 1, pageSize: 50 });
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
        if (url.pathname === '/cash-shifts/current') return json(role === 'waiter' ? view(active, role) : null);
        if (['/cash-shifts/mine', '/admin/cash-shifts'].includes(url.pathname)) return json({ shifts: history.map(shift => view(shift, role)), total: history.length, page: 1, pageSize: 50 });
        if (url.pathname === '/cash-shifts' && method === 'POST') {
          const body = route.request().postDataJSON(); assert.deepEqual(Object.keys(body), ['openingCash']);
          active = makeShift(body.openingCash); history = [active]; return json(pageData(active, role));
        }
        if (url.pathname === '/cash-shifts/shift/submit') {
          lastSubmit = route.request().postDataJSON();
          assert.deepEqual(Object.keys(lastSubmit).sort(), ['declaredCash', 'version']);
          if (failSubmit) { failSubmit = false; active = { ...active, version: 2 }; history = [active]; return route.fulfill({ status: 409, json: { message: 'Ca vừa có thay đổi; tải lại và kiểm đếm trước khi gửi đối soát' } }); }
          active = { ...active, status: 'PENDING_REVIEW', version: 3, declaredCash: lastSubmit.declaredCash, declaredVariance: lastSubmit.declaredCash - active.expectedCash, submittedAt: '2026-10-17T14:00:00Z', declaredBy: staffId };
          history = [active]; return json(pageData(active, role));
        }
        if (url.pathname === '/admin/cash-shifts/shift/verify') {
          lastVerify = route.request().postDataJSON();
          assert.deepEqual(Object.keys(lastVerify).sort(), ['verifiedCash', 'version']);
          assert.equal(role, 'admin');
          const closed = { ...active, status: 'CLOSED', version: 4, verifiedCash: lastVerify.verifiedCash, verifiedVariance: lastVerify.verifiedCash - active.expectedCash, verifiedAt: '2026-10-17T15:00:00Z', closedAt: '2026-10-17T15:00:00Z', verifiedBy: 'admin', closedBy: 'admin', closedByName: 'Admin' };
          active = null; history = [closed]; return json(pageData(closed, role));
        }
        if (url.pathname === '/cash-shifts/shift') return json(pageData(history[0], role));
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
    await waiter.getByRole('button', { name: 'Kê khai và gửi đối soát' }).waitFor();
    assert.doesNotMatch(await waiter.locator('main').innerText(), /5\.050\.000|5\.000\.000|CASH đã thu/);
    await waiter.getByRole('button', { name: 'Kê khai và gửi đối soát' }).click();
    const dialog = waiter.getByRole('dialog');
    await dialog.getByLabel('Tiền kê khai (VND)').fill('4850000');
    assert.doesNotMatch(await dialog.innerText(), /5\.050\.000|5\.000\.000|Tiền mặt dự kiến|CASH đã thu|Hóa đơn CASH/);
    assert.equal(await dialog.locator('input').count(), 1);
    failSubmit = true; await dialog.getByRole('button', { name: 'Gửi đối soát', exact: true }).click();
    await dialog.getByText('Ca vừa có thay đổi; tải lại và kiểm đếm trước khi gửi đối soát').waitFor();
    await dialog.getByLabel('Tiền kê khai (VND)').waitFor();
    assert.equal(await dialog.getByLabel('Tiền kê khai (VND)').inputValue(), '4850000');
    await dialog.getByRole('button', { name: 'Gửi đối soát', exact: true }).click();
    await dialog.getByText('Có chênh lệch đối soát.', { exact: false }).waitFor();
    assert.equal(lastSubmit.version, 2); assert.equal(lastSubmit.declaredCash, 4850000);
    assert.match(await dialog.innerText(), /-200\.000/);
    assert.equal(await dialog.locator('input').count(), 0);
    await waiter.setViewportSize({ width: 375, height: 812 });
    assert.equal(await waiter.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await waiter.screenshot({ path: path.join(artifacts, 'close-shift-mobile.png'), fullPage: true });
    await dialog.getByRole('button', { name: 'Đóng cửa sổ' }).click();
    await waiter.getByRole('button', { name: 'Xem ca chờ xác minh' }).waitFor();
    assert.equal(await waiter.getByLabel('Tiền đầu ca (VND)').count(), 0);
    done('Waiter blind count, stale submission recovery, pending read-only declaration and no new shift');
    await admin.setViewportSize({ width: 1366, height: 1000 });
    await admin.goto(`${origin}/admin/cash-shifts`);
    await admin.getByText('Có chênh lệch', { exact: true }).waitFor();
    await admin.getByRole('button', { name: /^Xác minh ca/ }).click();
    await admin.getByRole('dialog').getByRole('link', { name: row.invoiceCode }).waitFor();
    const verifyDialog = admin.getByRole('dialog');
    const verified = verifyDialog.getByLabel('Tiền xác minh (VND)');
    assert.equal(await verified.inputValue(), '');
    assert.match(await verifyDialog.innerText(), /5\.050\.000/);
    assert.match(await verifyDialog.innerText(), /4\.850\.000/);
    await verified.fill('4950000');
    await verifyDialog.getByRole('button', { name: 'Xác nhận xác minh' }).click();
    await verifyDialog.getByText('Tiền kê khai khác tiền Admin xác minh.').waitFor();
    assert.deepEqual(lastVerify, { verifiedCash: 4950000, version: 3 });
    assert.match(await verifyDialog.innerText(), /-100\.000/);
    assert.equal(await admin.getByRole('dialog').locator('input').count(), 0);
    await admin.screenshot({ path: path.join(artifacts, 'reconciliation-desktop.png'), fullPage: true });
    done('Admin verifies a separate count, sees both discrepancies and immutable CLOSED receipts');
    await waiter.getByRole('button', { name: 'Tải lại', exact: true }).click();
    await waiter.getByLabel('Tiền đầu ca (VND)').waitFor();
    done('Waiter can open a new shift only after Admin verification');
    assert.deepEqual(errors, []);
    await adminContext.close(); await waiterContext.close();
    console.log(`Completed ${passed} focused browser checks`);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
