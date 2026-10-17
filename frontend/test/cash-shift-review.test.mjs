import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CashShiftReview } from '../src/features/finance/CashShiftReview.tsx';

const base = {
  id: 'shift', staffId: 'staff', staffName: 'Waiter', status: 'OPEN', canSubmit: true, canVerify: false,
  openedAt: '2026-10-18T00:00:00Z', closedAt: null, openingCash: 50000, cashSales: 8000, expectedCash: 58000,
  declaredCash: null, declaredVariance: null, verifiedCash: null, verifiedVariance: null,
  submittedAt: null, verifiedAt: null, actualCash: null, variance: null,
  transactions: [], transactionCount: 1, page: 1, pageSize: 50,
};
const render = (detail, admin = false, count = '') => renderToStaticMarkup(createElement(CashShiftReview, {
  detail: { ...base, ...detail }, admin, count, saving: false, loading: false,
  onCount() {}, onAction() {}, onReload() {}, onPage() {},
}));
const pending = { status: 'PENDING_REVIEW', canSubmit: false, declaredCash: 57000, declaredVariance: -1000, submittedAt: '2026-10-18T01:00:00Z' };

test('OPEN is blind even if an old response contains totals, before and after entering a declaration', () => {
  for (const count of ['', '57000']) {
    const html = render({}, false, count);
    assert.match(html, /Đếm toàn bộ tiền mặt thực tế/);
    assert.match(html, /Gửi đối soát/);
    assert.doesNotMatch(html, /58\.000|8\.000|Tiền mặt dự kiến|CASH đã thu|Hóa đơn CASH|Chênh lệch|Tiền xác minh/);
  }
});

test('submitted declaration is read only for Waiter and exposes the server result', () => {
  const html = render(pending);
  assert.match(html, /Chờ Admin xác minh/);
  assert.match(html, /58\.000/);
  assert.match(html, /57\.000/);
  assert.match(html, /-1\.000/);
  assert.doesNotMatch(html, /<input|<form|Xác nhận xác minh/);
});

test('Admin verification displays both amounts and starts with an empty verified input', () => {
  const html = render({ ...pending, canVerify: true }, true);
  assert.match(html, /Tiền kê khai/);
  assert.match(html, /Tiền xác minh \(VND\)/);
  assert.match(html, /Xác nhận xác minh/);
  assert.match(html, /value=""/);
  assert.equal((html.match(/<input/g) ?? []).length, 1);
});

test('CLOSED preserves both counts and highlights declared versus verified discrepancy without editing', () => {
  const html = render({ ...pending, status: 'CLOSED', verifiedCash: 58000, verifiedVariance: 0 }, true);
  assert.match(html, /57\.000/);
  assert.match(html, /58\.000/);
  assert.match(html, /Tiền kê khai khác tiền Admin xác minh/);
  assert.doesNotMatch(html, /<input|<form/);
});

test('legacy CLOSED amounts remain explicit legacy evidence', () => {
  const html = render({ status: 'CLOSED', canSubmit: false, actualCash: 56000, variance: -2000 });
  assert.match(html, /Thực tế nộp \(ca cũ\)/);
  assert.match(html, /56\.000/);
  assert.match(html, /-2\.000/);
  assert.match(html, /chưa có bằng chứng kê khai và xác minh riêng/);
  assert.doesNotMatch(html, /Tiền đã xác minh|<input/);
});

test('Admin own pending shift asks for a different Admin and has no verify form', () => {
  const html = render(pending, true);
  assert.match(html, /một Admin khác xác minh/);
  assert.doesNotMatch(html, /<input|Xác nhận xác minh/);
});
