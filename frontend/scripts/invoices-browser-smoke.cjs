/* Production React bundle + controlled HTTP/Socket fixtures; no live payment. */
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
  io.on('connection', socket => socket.on('join', payload => socket.emit('joined', payload)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const code = 'INV-20260910-K7P4X2M9', sessionId = '507f1f77bcf86cd799439011', tableId = '507f1f77bcf86cd799439012', txnRef = `${sessionId}123456789`;
  const invoice = {
    invoiceCode: code, paymentStatus: 'succeeded', paidAt: '2026-09-10T08:00:00Z', table: { displayName: 'A01 + A02' }, vnpTransactionNo: '123456789',
    orders: [
      { sequence: 1, items: [{ name: 'Cơm chiên hải sản', quantity: 2, unitPrice: 50000, note: 'Không hành' }], subtotalAmount: 100000, discountAmount: 0, totalAmount: 100000 },
      { sequence: 2, items: [{ name: 'Lẩu hải sản', quantity: 1, unitPrice: 250000 }], subtotalAmount: 250000, discountAmount: 50000, totalAmount: 200000 },
    ], subtotalAmount: 350000, discountAmount: 50000, totalAmount: 300000,
  };
  let browser, mode = 'success', pdfError = false, paymentStatus = 'pending', lookups = 0, paymentChecks = 0;
  const errors = [], passed = [];
  const done = label => { passed.push(label); console.log(`PASS ${passed.length}: ${label}`); };
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
      localStorage.setItem('accessToken', 'fixture');
      localStorage.setItem('user', JSON.stringify({ id: 'internal-user-id', role: 'admin', fullName: 'Quản trị viên', email: 'test@example.invalid' }));
    });
    await context.route(/\/socket.io\//, async route => { try { const url = new URL(route.request().url()); await route.fulfill({ response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }) }); } catch {} });
    await context.route(url => url.pathname === '/admin/invoices', route => route.request().resourceType() === 'document' ? route.continue() : route.fulfill({ json: [] }));
    await context.route(url => /^\/admin\/invoices\//.test(url.pathname), async route => {
      if (route.request().resourceType() === 'document') return route.continue();
      if (route.request().url().endsWith('/pdf')) return route.fulfill({ status: pdfError ? 503 : 200, contentType: 'application/pdf', headers: { 'Access-Control-Expose-Headers': 'Content-Disposition', 'Content-Disposition': `attachment; filename="SmartOrder-${code}.pdf"` }, body: '%PDF-1.4\nfixture' });
      lookups++;
      assert.equal(route.request().headers().authorization, 'Bearer fixture');
      if (mode === 'loading') await new Promise(resolve => setTimeout(resolve, 600));
      const status = mode === '404' ? 404 : mode === '400' ? 400 : mode === 'error' ? 503 : 200;
      return route.fulfill({ status, json: status === 200 ? { ...invoice, paymentStatus: mode === 'pending' ? 'pending' : 'succeeded', ...(mode === 'pending' ? { paidAt: null } : {}) } : { message: 'fixture error' } });
    });
    await context.route(url => url.pathname === '/vnpay/payment-status', route => { paymentChecks++; return route.fulfill({ json: { status: paymentStatus, invoiceCode: code, txnRef, sessionId } }); });
    await context.route(url => url.pathname === '/vnpay/session-invoice', route => {
      const params = new URL(route.request().url()).searchParams;
      assert.equal(params.get('txnRef'), txnRef); assert.equal(params.get('sessionId'), sessionId); assert.equal(params.get('tableId'), tableId);
      return route.fulfill({ contentType: 'application/pdf', headers: { 'Access-Control-Expose-Headers': 'Content-Disposition', 'Content-Disposition': `attachment; filename="SmartOrder-${code}.pdf"` }, body: '%PDF-1.4\nfixture' });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/admin/invoices`);
    await page.getByRole('heading', { name: 'Tra cứu hóa đơn' }).waitFor();
    const input = page.getByLabel('Mã hóa đơn', { exact: true });
    const search = async (value = code) => { await input.fill(value); await page.getByRole('button', { name: 'Tra cứu', exact: true }).click(); };
    await search('bad'); await page.getByRole('alert').waitFor(); assert.equal(lookups, 0); assert.equal(await input.getAttribute('aria-invalid'), 'true'); done('Invalid input stays local, accessible and focused');
    mode = 'loading'; await search(` ${code.toLowerCase()} `); await page.getByText('Đang tìm hóa đơn…').waitFor(); assert.equal(await input.isDisabled(), true);
    await page.getByRole('heading', { name: code }).waitFor(); assert.equal(await input.inputValue(), code); done('Loading and normalized success lookup with JWT');
    const result = page.getByRole('region', { name: 'Kết quả tra cứu' });
    const visible = await result.innerText();
    for (const value of ['Đã thanh toán', 'A01 + A02', '123456789', 'Lượt gọi món #1', 'Lượt gọi món #2', 'Cơm chiên hải sản × 2', 'Lẩu hải sản × 1', 'Không hành', '50.000', '350.000', '300.000']) assert.ok(visible.includes(value), value);
    assert.doesNotMatch(visible, /[a-f\d]{24}|sessionId|orderId|dishId|txnRef|internal-user-id/i); done('Multiple rounds, quantities, unit prices, notes and discount render without DB IDs');
    await page.locator('summary').click(); assert.equal(await page.getByText('Lượt gọi món #1', { exact: true }).isVisible(), false); await page.locator('summary').click(); done('View details expands and collapses');
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Tải lại PDF', exact: true }).click(); assert.equal((await download).suggestedFilename(), `SmartOrder-${code}.pdf`); done('Admin PDF download uses public filename');
    pdfError = true; await page.getByRole('button', { name: 'Tải lại PDF', exact: true }).click(); await page.getByText('Chưa thể tải PDF. Vui lòng thử lại.').waitFor(); pdfError = false; done('PDF error is recoverable and keeps invoice details');
    for (const [state, message] of [['404', 'Không tìm thấy hóa đơn.'], ['400', 'Mã hóa đơn không hợp lệ.'], ['error', 'Chưa thể tra cứu hóa đơn.']]) {
      mode = state; await search(); await page.getByRole('alert').filter({ hasText: message }).waitFor(); assert.equal(await result.count(), 0); done(`${state} clears previous invoice and announces error`);
    }
    mode = 'pending'; await search(); await page.getByText('Chưa ghi nhận thanh toán').waitFor(); assert.equal(await page.getByRole('button', { name: 'Tải lại PDF', exact: true }).count(), 0); done('Pending intent is explicit and cannot download receipt');
    mode = 'success'; await search(); await page.getByRole('heading', { name: code }).waitFor();
    for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
      await page.setViewportSize(viewport); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('main *')].filter(el => el.getBoundingClientRect().right > window.innerWidth + 1).map(el => ({ tag: el.tagName, text: el.textContent.slice(0, 60), width: el.getBoundingClientRect().width, x: el.getBoundingClientRect().x, cls: el.className }))), []);
    }
    await page.setViewportSize({ width: 375, height: 812 });
    const artifacts = path.resolve(__dirname, '../../.tmp/invoice-verification'); await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'admin-mobile.png'), fullPage: true }); done('375px and landscape fit without horizontal overflow, reduced motion');
    await page.setViewportSize({ width: 1280, height: 1000 }); await page.screenshot({ path: path.join(artifacts, 'admin-desktop.png'), fullPage: true });
    const paymentUrl = `${origin}/payment-result?result=pending&txnRef=${txnRef}&sessionId=${sessionId}&tableId=${tableId}`;
    await page.goto(paymentUrl); await page.getByRole('heading', { name: 'Đang xác nhận thanh toán' }).waitFor();
    await page.waitForFunction(() => document.body.innerText.includes('Đang xác nhận thanh toán'));
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await page.getByRole('button', { name: 'Tải hóa đơn tổng hợp' }).count(), 0);
    paymentStatus = 'succeeded';
    io.emit('session:payment-updated', { txnRef, sessionId, status: 'succeeded' });
    await page.getByRole('heading', { name: 'Thanh toán thành công' }).waitFor();
    const customerDownload = page.waitForEvent('download'); await page.getByRole('button', { name: 'Tải hóa đơn tổng hợp' }).click(); assert.equal((await customerDownload).suggestedFilename(), `SmartOrder-${code}.pdf`);
    assert.doesNotMatch(await page.locator('main').innerText(), /[a-f\d]{24}|txnRef|sessionId/i); done('Payment result waits for confirmed event, preserves ownership query and downloads public filename');
    paymentStatus = 'succeeded'; await page.goto(paymentUrl); await page.getByRole('heading', { name: 'Thanh toán thành công' }).waitFor(); await page.getByText(`Mã hóa đơn: ${code}`, { exact: true }).waitFor(); done('Reloaded paid result displays persisted public invoice code');
    assert.ok(paymentChecks >= 2); assert.deepEqual(errors, []); done('No browser runtime errors; payment status verified again on reload');
    await context.close();

    // CASH uses the existing invoice lookup/download after table release, even
    // when a socket refresh removes the action before the POST resolves.
    for (const role of ['admin', 'waiter']) {
      for (const width of [1280, 375]) {
        let settled = false, settlements = 0, pdfReads = 0, releaseReceipt;
        const staff = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        await staff.addInitScript((role) => {
          localStorage.setItem('accessToken', 'fixture');
          localStorage.setItem('user', JSON.stringify({ id: 'fixture-user', role, fullName: 'Nguyễn An' }));
        }, role);
        await staff.route(/\/socket.io\//, async route => { try { const url = new URL(route.request().url()); await route.fulfill({ response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }) }); } catch {} });
        await staff.route(url => url.pathname === '/auth/me', route => route.fulfill({ json: { user: { id: 'fixture-user', role, fullName: 'Nguyễn An' } } }));
        await staff.route(url => url.pathname === '/tables', route => route.fulfill({ json: [{
          _id: tableId, tableCode: 'A01', capacity: 4, qrCodeUrl: '',
          status: settled ? 'available' : 'waiting_payment', currentSessionId: settled ? null : sessionId,
        }] }));
        await staff.route(url => url.pathname === '/orders/waiter', route => route.fulfill({ json: [] }));
        await staff.route(url => url.pathname === '/orders/waiter/payment-summaries', route => route.fulfill({ json: settled ? [] : [{ tableId, canClear: false, isPaid: false }] }));
        await staff.route(url => url.pathname === '/sessions/table-operation-options', route => route.fulfill({ json: { moveSources: [], moveDestinations: [], mergeCandidates: [], unmergeGroups: [] } }));
        await staff.route(url => url.pathname === `/payments/tables/${tableId}/cash-settlement`, async route => {
          if (route.request().method() === 'GET') return route.fulfill({ json: {
            tableId, tableCode: 'A01', tableIds: [tableId], sessionId, sessionVersion: 1, confirmationKey: 'a'.repeat(64), orderCount: 2, payableTotal: 300000,
          } });
          assert.deepEqual(route.request().postDataJSON(), { sessionId, sessionVersion: 1, confirmationKey: 'a'.repeat(64) });
          settlements++; settled = true;
          const responseGate = new Promise(resolve => { releaseReceipt = resolve; });
          io.emit('tables:updated', {});
          await responseGate;
          return route.fulfill({ status: 201, json: { invoiceCode: code, amount: 300000, paymentMethod: 'CASH', sessionId, tableIds: [tableId] } });
        });
        const cashInvoice = { ...invoice, paymentMethod: 'CASH', settledByName: 'Nguyễn An', vnpTransactionNo: undefined,
          orders: invoice.orders.map(order => ({ ...order, promotionCode: order.discountAmount ? 'SAVE50' : undefined,
            items: [...order.items, { name: 'Món hết', quantity: 1, unitPrice: 90000, status: 'Rejected', rejectionReason: 'Hết nguyên liệu', chargedAmount: 0 }],
          })),
        };
        await staff.route(url => /^\/admin\/invoices(?:\/|$)/.test(url.pathname), route => {
          if (route.request().resourceType() === 'document') return route.continue();
          assert.equal(route.request().headers().authorization, 'Bearer fixture');
          assert.equal(settled, true);
          if (route.request().url().endsWith('/pdf')) {
            pdfReads++;
            return route.fulfill({ contentType: 'application/pdf', headers: { 'Access-Control-Expose-Headers': 'Content-Disposition', 'Content-Disposition': `attachment; filename="SmartOrder-${code}.pdf"` }, body: '%PDF-1.4\nfixture' });
          }
          return route.fulfill({ json: new URL(route.request().url()).pathname === '/admin/invoices'
            ? [{ invoiceCode: code, amount: invoice.totalAmount, paidAt: invoice.paidAt, table: invoice.table }]
            : cashInvoice });
        });
        const cashPage = await staff.newPage();
        cashPage.on('pageerror', error => errors.push(error.message));
        const dashboard = role === 'admin' ? '/admin/tables' : '/waiter';
        const lookupPath = role === 'admin' ? '/admin/invoices' : '/waiter/invoices';
        await cashPage.goto(`${origin}${dashboard}`);
        await cashPage.getByRole('button', { name: 'Xác nhận thanh toán tiền mặt', exact: true }).click();
        await cashPage.getByRole('button', { name: /Đã nhận/ }).waitFor();
        // Ensure the socket is joined before delivering the release event.
        await new Promise((resolve, reject) => { const deadline = Date.now() + 5000; const check = () => io.sockets.sockets.size ? resolve() : Date.now() > deadline ? reject(new Error('Staff socket did not connect')) : setTimeout(check, 25); check(); });
        await cashPage.getByRole('button', { name: /Đã nhận/ }).click();
        await cashPage.getByRole('dialog', { name: 'Xác nhận thanh toán tiền mặt', exact: true }).waitFor({ state: 'detached' });
        assert.equal(await cashPage.getByRole('button', { name: 'Xác nhận thanh toán tiền mặt', exact: true }).count(), 0);
        releaseReceipt();
        const success = cashPage.getByRole('dialog', { name: 'Thanh toán tiền mặt thành công', exact: true });
        await success.waitFor();
        for (const expected of ['A01', '300.000', 'Tiền mặt', code]) assert.ok((await success.innerText()).includes(expected));
        assert.equal(await success.getByRole('link', { name: 'Xem / In hóa đơn' }).count(), 1);
        assert.equal(pdfReads, 0);
        assert.equal(await cashPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await cashPage.screenshot({ path: path.join(artifacts, `cash-${role}-${width}.png`), fullPage: true });
        if (width === 375) {
          await success.getByRole('button', { name: 'Đóng', exact: true }).click();
          await cashPage.reload();
          if (role === 'admin') await cashPage.getByRole('button', { name: 'Mở điều hướng' }).click();
          await cashPage.getByRole('link', { name: 'Tra cứu hóa đơn', exact: true }).click();
          await cashPage.getByRole('region', { name: 'Hóa đơn tiền mặt gần đây' }).getByRole('link', { name: new RegExp(code) }).click();
        } else await success.getByRole('link', { name: 'Xem / In hóa đơn' }).click();
        await cashPage.waitForURL(`**${lookupPath}?invoiceCode=${code}`);
        const detail = cashPage.getByRole('region', { name: 'Kết quả tra cứu' });
        await detail.waitFor();
        const cashText = await detail.innerText();
        for (const expected of ['Tiền mặt (CASH)', 'Nguyễn An', 'SAVE50', 'Không tính tiền', 'Hết nguyên liệu', '300.000']) assert.ok(cashText.includes(expected), expected);
        assert.doesNotMatch(cashText, /Mã VNPAY|txnRef/);
        await cashPage.reload(); await detail.waitFor();
        for (let i = 0; i < 2; i++) {
          const downloaded = cashPage.waitForEvent('download');
          await cashPage.getByRole('button', { name: 'Tải lại PDF', exact: true }).click();
          assert.equal((await downloaded).suggestedFilename(), `SmartOrder-${code}.pdf`);
        }
        assert.equal(settlements, 1); assert.equal(pdfReads, 2);
        done(`${role} ${width}px: CASH result survives table release; lookup/reload/history and repeated PDF use the original invoice`);
        await staff.close();
      }
    }
    assert.deepEqual(errors, []);
    console.log(`Invoice browser: ${passed.length}/${passed.length} PASS`);
  } finally { await browser?.close(); await new Promise(resolve => io.close(resolve)); server.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
