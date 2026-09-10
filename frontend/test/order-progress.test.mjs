import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrderProgress } from '../src/features/menu/OrderProgress.tsx';

const orderId = '6aa236820f1f176633798bed';
const item = {
  dishName: 'Cơm chiên bò', nameEn: 'Beef fried rice', imageUrl: '/snapshot.jpg',
  unitPrice: 50_000, quantity: 1, note: 'Không hành',
};
const order = {
  orderId, orderNumber: 1, status: 'Pending', itemCount: 1, items: [item],
  subtotalAmount: 50_000, discountAmount: 10_000, totalAmount: 40_000,
};
const render = (orders = [order], lang = 'vi') =>
  renderToStaticMarkup(createElement(OrderProgress, { orders, lang }));
const text = (html) => html.replace(/<[^>]*>/g, '');

test('one order / one item renders snapshot unit price, name, note and image, never Mongo ID', () => {
  const html = render();
  const visible = text(html);
  assert.match(visible, /Lượt gọi món #1/);
  assert.match(visible, /Cơm chiên bò/);
  assert.match(visible, /x1 · 50\.000\s*₫/);
  assert.match(visible, /Ghi chú: Không hành/);
  assert.match(html, /src="\/snapshot.jpg"/);
  assert.doesNotMatch(html, new RegExp(orderId));
  assert.doesNotMatch(visible, /40\.000|Beef fried rice/);
});

test('renders every line, including the same dish with different notes and quantities', () => {
  const html = render([{ ...order, itemCount: 4, items: [
    { ...item, quantity: 2 },
    { ...item, note: 'Ít cay' },
    { dishName: 'Trà đá', unitPrice: 5_000, quantity: 1 },
  ] }]);
  assert.equal((text(html).match(/Cơm chiên bò/g) ?? []).length, 2);
  assert.match(text(html), /4 món/);
  assert.match(text(html), /x2 · 50\.000\s*₫/);
  assert.match(text(html), /Ít cay/);
  assert.match(text(html), /Trà đá/);
  assert.match(text(html), /x1 · 5\.000\s*₫/);
});

test('EN uses snapshot English and localized progress labels', () => {
  const visible = text(render(undefined, 'en'));
  assert.match(visible, /Order progress/);
  assert.match(visible, /Order #1/);
  assert.match(visible, /1 item/);
  assert.match(visible, /Beef fried rice/);
  assert.match(visible, /Note: Không hành/);
  assert.doesNotMatch(visible, /Cơm chiên bò/);
});

for (const nameEn of [undefined, '', '   ']) {
  test(`legacy/blank English (${JSON.stringify(nameEn)}) falls back to VI with placeholder and no note`, () => {
    const html = render([{ ...order, items: [{ dishName: item.dishName, unitPrice: item.unitPrice, quantity: 1, nameEn }] }], 'en');
    assert.match(text(html), /Cơm chiên bò/);
    assert.match(html, /lucide-image-off/);
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(text(html), /Note:|Ghi chú:/);
  });
}

test('blank note is omitted and zero snapshot price is preserved', () => {
  const visible = text(render([{ ...order, items: [{ ...item, note: ' ', unitPrice: 0 }] }]));
  assert.doesNotMatch(visible, /Ghi chú:/);
  assert.match(visible, /x1 · 0\s*₫/);
});

for (const [status, label] of Object.entries({ Pending: 'Chờ xác nhận', Preparing: 'Đang chế biến', Ready: 'Sẵn sàng phục vụ', Served: 'Đã phục vụ', Paid: 'Đã thanh toán', Cancelled: 'Đã hủy' })) {
  test(`keeps ${status} badge in VI and EN when summary refreshes`, () => {
    assert.match(text(render([{ ...order, status }])), new RegExp(label));
    assert.match(text(render([{ ...order, status }], 'en')), new RegExp(status));
  });
}

test('multiple rounds retain their own items, number and status', () => {
  const html = render([order, { ...order, orderId: '6aa236820f1f176633798bee', orderNumber: 2, status: 'Ready', items: [{ dishName: 'Trà đá', quantity: 3, unitPrice: 5_000 }], itemCount: 3 }]);
  assert.match(text(html), /Lượt gọi món #2/);
  assert.match(text(html), /Sẵn sàng phục vụ/);
  assert.match(text(html), /Trà đá/);
  assert.doesNotMatch(html, /6aa236820f1f176633798be/);
});
