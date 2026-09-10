/* Production UI, mocked HTTP/Socket and explicitly synthetic review facts. */
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
  const passed = [], errors = [], calls = [];
  const done = label => { passed.push(label); console.log(`PASS ${passed.length}: ${label}`); };
  const warning = 'Chưa đủ dữ liệu để kết luận xu hướng đáng tin cậy (cần ít nhất 10 comment đã phân tích).';
  const dishId = '111111111111111111111111';
  const counts = (positive = 0, negative = 0, mixed = 0, neutral = 0) => ({ positive, negative, mixed, neutral });
  const fixture = () => ({
    facts: { totalReviews: 25, commentCount: 15, sampleSize: 10, analyzedCommentCount: 10, averageRating: 3, analysisCoveragePercentage: 66.67, minimumSample: 10,
      sentimentCounts: counts(5, 5), sentimentPercentages: counts(50, 50),
      topics: [{ topic: 'taste', label: 'Hương vị', count: 5, percentage: 50, sentiments: counts(5) }, { topic: 'temperature', label: 'Nhiệt độ', count: 5, percentage: 50, sentiments: counts(0, 5) }, { topic: 'service_speed', label: 'Tốc độ phục vụ', count: 0, percentage: 0, sentiments: counts() }],
    }, warnings: ['Chỉ một phần comment đã được phân tích; kết quả có thể chưa đại diện cho toàn bộ đánh giá.'], taxonomyVersion: 'review-topics-v1', generatedAt: '2026-09-08T12:00:00Z',
  });
  let browser, report = fixture(), mode = '', release, entered, delay = false, analyticsGets = 0;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => { localStorage.setItem('user', JSON.stringify({ role: 'admin', fullName: 'Synthetic Phase 22' })); localStorage.setItem('accessToken', 'test-only'); });
    await context.route(/\/socket.io\//, async route => { try { const url = new URL(route.request().url()); await route.fulfill({ response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }) }); } catch {} });
    await context.route('**/admin/analytics/**', route => {
      analyticsGets++;
      const pathname = new URL(route.request().url()).pathname;
      return route.fulfill({ json: pathname.endsWith('/overview') ? { totalOrders: 20, ordersToday: 2, occupiedTables: 1, avgOrderValue: 100000 }
        : pathname.endsWith('/top-rated-dishes') ? [{ dishName: 'Phở synthetic', averageRating: 4.5, reviewCount: 2 }]
        : pathname.endsWith('/top-dishes') ? [{ dishName: 'Phở synthetic', totalQuantity: 3, revenue: 300000 }]
        : [{ date: '2026-08-01', revenue: 12500000, orders: 2 }] });
    });
    await context.route('**/dishes?*', route => route.fulfill({ json: [{ _id: dishId, name: 'Phở synthetic' }] }));
    await context.route('**/ai/admin/review-insights**', async route => {
      const url = new URL(route.request().url()), method = route.request().method();
      calls.push({ url, method, body: method === 'POST' ? route.request().postDataJSON() : null });
      const snapshot = structuredClone(report), currentMode = mode;
      if (delay) { delay = false; await new Promise(resolve => { release = resolve; entered?.(); }); }
      let json = snapshot;
      if (currentMode === 'get-error' && url.pathname.endsWith('review-insights')) return route.fulfill({ status: 503, json: { code: 'AI_ANALYTICS_UNAVAILABLE' } }).catch(() => {});
      if (url.pathname.endsWith('/summary')) json = { ...snapshot, summaryStatus: currentMode === 'summary-error' ? 'unavailable' : 'ready', summary: currentMode === 'summary-error' ? null : `Đã phân tích ${snapshot.facts.sampleSize}/${snapshot.facts.commentCount} comment trong ${snapshot.facts.totalReviews} đánh giá. ${snapshot.warnings.join(' ')}`, modelVersion: 'mock:review-summary-v1' };
      if (url.pathname.endsWith('/analyze')) json = { attempted: 5, analyzed: 0, outcomes: [{ status: 'failed', code: 'AI_PROVIDER_UNAVAILABLE', warnings: [] }] };
      if (url.pathname.endsWith('/sources')) json = { page: Number(url.searchParams.get('page') || 1), pageSize: 20, total: url.searchParams.has('topic') ? 5 : 25, reviews: [{ _id: '222222222222222222222222', dishId, rating: 5, comment: 'SYNTHETIC <script>alert("injection")</script> Món ngon nhưng chờ lâu.', createdAt: '2026-08-15T12:00:00Z', aiInsight: { sentiment: 'mixed', taxonomyVersion: 'review-topics-v1', modelVersion: 'mock:review-classification-v1', analyzedAt: '2026-09-08T12:00:00Z' } }] };
      await route.fulfill({ json }).catch(() => {});
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/admin`);
    const panel = page.locator('section[aria-labelledby="review-intelligence-title"]');
    const load = panel.getByRole('button', { name: 'Xem số liệu đánh giá', exact: true });
    await page.getByRole('heading', { name: 'Xu hướng doanh thu' }).waitFor();
    assert.equal(calls.length, 0); done('dashboard remains available with no automatic AI calls or polling');
    const slowClick = async button => { delay = true; const started = new Promise(resolve => { entered = resolve; }); await button.click(); await started; };
    await slowClick(load); await panel.getByText('Đang tải dữ liệu đánh giá…', { exact: true }).waitFor();
    assert.equal(await load.isDisabled(), true); release();
    await panel.getByText('Độ phủ phân tích: 66.67%.', { exact: false }).waitFor();
    for (const [label, value] of [['Tổng đánh giá', '25'], ['Có comment', '15'], ['Comment đã phân tích (mẫu)', '10']]) assert.equal(await panel.locator('dl > div').filter({ hasText: label }).locator('dd').innerText(), value);
    done('loading, counts, explicit sample and coverage render');
    await panel.getByRole('button', { name: 'Hương vị: 5 comment', exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Nhiệt độ: 5 comment', exact: true }).waitFor();
    await panel.locator('summary').click(); await panel.getByRole('button', { name: 'Hương vị: 5 (50%)', exact: true }).waitFor(); done('positive/issues, complete topic counts and percentages render');
    await slowClick(panel.getByRole('button', { name: 'Tạo tóm tắt AI', exact: true }));
    await panel.getByText('Đang tạo tóm tắt từ số liệu…', { exact: true }).waitFor(); release();
    await panel.getByRole('heading', { name: 'Tóm tắt AI', exact: true }).waitFor(); assert.match(await panel.innerText(), /Đã phân tích 10\/15 comment/); done('AI summary renders without blocking factual dashboard');
    await panel.getByRole('button', { name: 'Hương vị: 5 comment', exact: true }).click();
    await panel.getByRole('heading', { name: 'Review nguồn · Hương vị · Tích cực' }).waitFor();
    assert.equal(calls.at(-1).url.searchParams.get('topic'), 'taste'); assert.equal(calls.at(-1).url.searchParams.get('sentiment'), 'positive');
    await panel.getByText('SYNTHETIC <script>alert("injection")</script> Món ngon nhưng chờ lâu.', { exact: true }).waitFor();
    assert.match(await panel.innerText(), /222222222222222222222222/); assert.match(await panel.innerText(), /review-classification-v1/); done('source drill-down matches topic sentiment and renders untrusted text safely');
    await panel.getByRole('button', { name: 'Xem review nguồn', exact: true }).click();
    await panel.getByRole('heading', { name: 'Review nguồn · Tất cả đánh giá' }).waitFor();
    await panel.getByRole('button', { name: 'Trang sau', exact: true }).click(); await panel.getByText('25 đánh giá khớp · Trang 2', { exact: true }).waitFor();
    assert.equal(calls.at(-1).url.searchParams.get('page'), '2'); done('source pagination works');
    mode = 'summary-error'; await panel.getByRole('button', { name: 'Tạo tóm tắt AI', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: 'AI chưa thể tạo tóm tắt' }).waitFor();
    assert.match(await panel.locator('dl').innerText(), /25/); const before = analyticsGets;
    await page.getByRole('button', { name: 'Áp dụng', exact: true }).click(); await page.waitForTimeout(150); assert.ok(analyticsGets > before); done('summary failure preserves counts, rating chart and ordinary analytics refresh');
    mode = ''; await panel.getByRole('button', { name: 'Phân tích thêm tối đa 5 comment', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'Đã phân tích thêm 0/5' }).waitFor(); done('classification failure is visible and factual report refreshes');
    mode = 'get-error'; await load.click(); await panel.getByRole('alert').filter({ hasText: 'Chưa thể tải Review Intelligence' }).waitFor();
    mode = ''; await load.click(); await panel.getByText('Độ phủ phân tích: 66.67%.', { exact: false }).waitFor(); done('read failure and retry');
    report = fixture(); report.facts.sampleSize = report.facts.analyzedCommentCount = 2; report.warnings = [warning];
    await load.click(); await panel.getByText(warning, { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Tạo tóm tắt AI', exact: true }).click(); await panel.getByRole('heading', { name: 'Tóm tắt AI', exact: true }).waitFor();
    assert.match(await panel.innerText(), /Đã phân tích 2\/15/); done('small sample warning persists in report and summary');
    await slowClick(load); await panel.getByLabel('Món cần phân tích').selectOption(dishId); release(); await page.waitForTimeout(100);
    assert.equal(await panel.locator('dl').count(), 0); await load.click(); await panel.locator('dl').waitFor(); assert.equal(calls.at(-1).url.searchParams.get('dishId'), dishId); done('dish filter clears stale response and scopes reads');
    await page.getByLabel('Từ ngày', { exact: true }).fill('2026-08-01'); await page.getByLabel('Đến ngày', { exact: true }).fill('2026-08-31');
    await load.click(); await panel.locator('dl').waitFor(); assert.equal(calls.at(-1).url.searchParams.get('fromDate'), '2026-08-01');
    await slowClick(panel.getByRole('button', { name: 'Tạo tóm tắt AI', exact: true }));
    await page.getByLabel('Đến ngày', { exact: true }).fill('2026-08-15'); release(); await page.waitForTimeout(100); assert.equal(await panel.getByRole('heading', { name: 'Tóm tắt AI', exact: true }).count(), 0); done('UTC date filter and stale summary cancellation');
    report = fixture(); report.facts.commentCount = report.facts.sampleSize = report.facts.analyzedCommentCount = 0; report.warnings = [warning];
    await load.click(); await panel.getByText('Các đánh giá chỉ có điểm số; không có comment để phân tích bằng AI.', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Phân tích thêm tối đa 5 comment', exact: true }).isDisabled(), true); done('rating-only state disables needless AI requests');
    report.facts.totalReviews = 0; report.facts.averageRating = null;
    await load.click(); await panel.getByText('Chưa có đánh giá trong bộ lọc này.', { exact: true }).waitFor(); done('empty report has explicit sample zero');
    report = fixture(); await load.click(); await panel.locator('dl').waitFor(); await panel.getByRole('button', { name: 'Xem review nguồn', exact: true }).click();
    await panel.getByRole('heading', { name: 'Review nguồn · Tất cả đánh giá' }).waitFor();
    await mkdir(path.resolve(__dirname, '../test-results'), { recursive: true });
    for (const viewport of [{ width: 1280, height: 1000 }, { width: 375, height: 812 }, { width: 812, height: 375 }]) {
      await page.setViewportSize(viewport); await panel.scrollIntoViewIfNeeded(); await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.ok((await load.boundingBox()).height >= 44);
      await page.screenshot({ path: path.resolve(__dirname, `../test-results/phase22-${viewport.width}.png`), fullPage: true });
    }
    await load.focus(); assert.equal(await load.evaluate(el => el === document.activeElement), true);
    done('desktop/mobile/landscape, reduced motion, keyboard focus and no horizontal overflow');
    assert.deepEqual(errors, []); done('zero browser JavaScript errors');
    console.log(`Phase 22: ${passed.length}/${passed.length} scenarios PASS (mock HTTP/Socket; synthetic data).`);
  } finally { await browser?.close(); await new Promise(resolve => io.close(resolve)); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
