# Cash settlement và checkout VNPAY cũ

Phạm vi: xác nhận tiền mặt, đóng phiên, giải phóng bàn, giữ lịch sử thanh toán và phục hồi phía khách. Không thay đổi Kitchen Reject.

## Root cause được xác minh trong mã nguồn

1. `frontend/src/features/admin/TableManager.tsx` gửi `status` qua `PUT /tables/:id` khi lưu form sửa bàn.
2. `TableService.update` trước đây dùng `findByIdAndUpdate(id, dto)` trực tiếp. Đổi sang `available` không đi qua `TableService.clear`.
3. Vì vậy Session cũ vẫn `ACTIVE`, `Table.currentSessionId` vẫn giữ nguyên và các Order/PaymentIntent vẫn chưa được thanh toán. Bàn chỉ trông như đã trống.
4. Waiter dùng `PATCH /tables/:id/clear`. Đường này đã có transaction và chặn giỏ hàng, đơn chưa trả, payment chưa giải quyết; không phải nguyên nhân bypass.
5. QR bootstrap trong `SessionService.getOrCreateActiveSession` ưu tiên `currentSessionId`, nên tiếp tục resume Session cũ. Đây là nguồn tái xuất hiện checkout.
6. `loadSessionBilling`, create checkout và waiter payment summary lọc theo Session; payment status/invoice kiểm tra cả txnRef, sessionId và tableId. Không tìm thấy fallback lấy checkout chỉ theo bàn.
7. Frontend giữ scope trong URL và customer grant trong localStorage. Phiên cũ phải đóng và grant phải hết hiệu lực; chỉ sửa badge bàn không đáp ứng điều này.

## Business rule và API

- Chỉ Admin/Waiter hiện đang được cấp quyền mới dùng được `GET` và `POST /payments/tables/:tableId/cash-settlement`.
- GET trả số tiền từ snapshot Order, sessionId, version và confirmationKey. POST chỉ nhận các điều kiện xác nhận này; không nhận amount, order IDs hay status từ client.
- Server tự tìm Session đang sở hữu bàn, kiểm tra toàn bộ nhóm bàn, giỏ trống và tất cả đơn cần trả đều Served với toàn bộ món Served.
- Đơn Paid/Cancelled không được chuyển lại sang Paid. Nếu VNPAY đã thành công cho Session hoặc các Order liên quan, CASH bị từ chối.
- Version và confirmationKey buộc staff xem lại hóa đơn nếu cart, ownership, tập đơn hoặc số tiền thay đổi sau khi mở hộp thoại, kể cả hủy đơn không tăng Session.version.
- `PUT /tables/:id` không đổi lifecycle bàn có Session. Tạo bàn phải bắt đầu ở `available`; xóa bàn có Session/nhóm cũng bị chặn. Admin có action Dọn bàn gọi endpoint clear vốn kiểm tra đầy đủ invariant.

## Một transaction CASH

1. Đọc lại và xác minh ownership, Session, Order, amount và PaymentIntent unresolved.
2. CAS Session theo ACTIVE/version/cart trống, đánh dấu CLOSED/endedAt; ghi này tranh chấp với cart, create-order, move, merge và clear.
3. Gọi `OrderStateMachineService.transitionManyToPaid`, giữ rule Served → Paid, ghi `paymentMethod=CASH`, paidAt và history có userId/role/time/source/amount.
4. Tạo PaymentIntent receipt riêng có method CASH, status succeeded, invoiceCode duy nhất, coveredOrderIds, amount và actor. Receipt không mang xác nhận IPN.
5. Đánh dấu checkout VNPAY unresolved là `superseded`, thêm `resolutionSource=cash_settlement`, resolvedAt và supersededByPaymentId trỏ đến receipt.
6. Giải phóng tất cả bàn thuộc Session: `currentSessionId=null`, `status=available`, xóa liên kết nhóm. Bất kỳ bước nào lỗi đều rollback toàn bộ.
7. Sau commit: gửi session:closed rồi ngắt socket khách; cập nhật dashboard. Frontend hủy request đang chờ, bỏ giỏ/payment cũ và grant cũ. Scan QR lại bootstrap Session mới.

## VNPAY, invoice và concurrency

- Không xóa intent cũ, không đổi txnRef/amount/createdAt/invoiceCode/provider fields khi thu CASH. `superseded` không match `UNRESOLVED_PAYMENT_FILTER`; không cần thay unique partial indexes hiện có.
- CASH không đặt `ipnConfirmed=true`, không giả provider failed. Invoice CASH dùng snapshot đơn; mã invoice của checkout cũ vẫn tra cứu được và chỉ tới mã receipt thay thế.
- IPN đến trước và commit thanh toán: CASH thất bại/rollback.
- CASH commit trước: IPN thật vẫn được kiểm tra chữ ký, merchant, amount và provider result. Chỉ ghi lateProviderStatus/transactionNo/responseCode/time và ipnConfirmed từ callback thật; không gọi state machine lần nữa. Status intent vẫn superseded.
- Nếu IPN muộn báo thành công, `reconciliationRequired=true`; màn tra cứu invoice cũ hiển thị cần đối soát. Đây là tín hiệu để nhân viên kiểm tra/hoàn khoản thu trùng, không phải hoàn tiền tự động.
- IPN lặp trả acknowledgement đã xác nhận; kết quả mâu thuẫn trả lỗi để kiểm tra. Hai staff chỉ tạo được một receipt. Không tự diễn giải lại xác nhận staff trên snapshot mới sau transaction conflict.
- Chuyển bàn vẫn có thể giải phóng bàn nguồn và giữ Session/đơn ở bàn đích theo transaction hiện có; đây không phải thao tác tất toán. Cleanup bỏ qua mọi Session từng có Order.

## Files của thay đổi này

Backend:

- `src/modules/vnpay/{cash-settlement.controller.ts,vnpay.service.ts,payment-intent.schema.ts,vnpay.module.ts}`
- `src/modules/order/{order-state-machine.service.ts,order.schema.ts,invoice.service.ts}`
- `src/modules/invoice/{invoice-lookup.service.ts,dto/invoice.dto.ts}`
- `src/modules/table/table.service.ts`
- `src/gateway/{app.gateway.ts,app.gateway.spec.ts}`
- `src/modules/vnpay/cash-settlement.transaction.spec.ts`
- `test/{cash-settlement.e2e-spec.ts,jest-common.cjs}`

Frontend:

- `src/components/CashSettlementAction.tsx`
- `src/features/admin/{TableManager.tsx,InvoiceLookup.tsx}`
- `src/features/waiter/WaiterDashboard.tsx`
- `src/features/menu/CustomerMenu.tsx`
- `src/features/payment/PaymentResult.tsx`
- `src/services/{customer-access.ts,customer-recovery.ts,payment-recovery.ts,api/payment.ts,api/invoice.ts}`
- `test/recovery.test.mjs`

Các sửa đổi migration/reconciliation VNPAY, `.env.example`, `package.json`, script và tài liệu đã có trước trong workspace được giữ lại; không chạy chúng trên dữ liệu thật.

## Kiểm chứng

Kết quả local ngày 16/10/2026:

| Nhóm | Kết quả |
|---|---|
| Transaction CASH/VNPAY/session trên replica set tạm | 31/31 pass |
| HTTP/RBAC và scan lại QR | 2/2 pass |
| Socket.IO/state machine/invoice/VNPAY unit | 43/43 pass |
| Frontend recovery | 14/14 pass |
| Build backend + frontend | Pass |
| ESLint cash controller/service/schema/table và test mới | Pass |
| Frontend lint | Không có error; còn warning dependency useEffect có sẵn trong CustomerMenu |

Tổng 90 test liên quan đã pass. Kiểm tra lint mở rộng tới gateway/state machine vẫn gặp lỗi có sẵn ở phần không sửa (đã đối chiếu gateway với HEAD); không mở rộng phạm vi xử lý chúng. Frontend build còn cảnh báo chunk lớn hơn 500 kB. Build frontend local dùng VITE_API_URL=http://localhost:3000, không phải cấu hình deploy.

Chạy test DB bằng harness tạo replica set MongoDB tạm, không dùng database ứng dụng:

```powershell
# Trong backend, đặt đường dẫn mongod phù hợp máy chạy.
$env:MONGOD_BINARY = 'C:\Program Files\MongoDB\Server\8.2\bin\mongod.exe'
npm run test:integration -- --runInBand --runTestsByPath src/modules/vnpay/cash-settlement.transaction.spec.ts src/modules/vnpay/vnpay.transaction.spec.ts src/modules/session/session.lifecycle.spec.ts
npm run test:e2e -- --runInBand --runTestsByPath test/cash-settlement.e2e-spec.ts
npm run test:unit -- --runTestsByPath src/gateway/app.gateway.spec.ts src/modules/order/order-state-machine.service.spec.ts src/modules/order/invoice.service.spec.ts src/modules/vnpay/vnpay.service.spec.ts
npm run build
```

```powershell
# Trong frontend
node --import ./test/register-tsx.mjs --test test/recovery.test.mjs
npm run lint
$env:VITE_API_URL = 'http://localhost:3000'
npm run build
```

Checklist demo sau khi triển khai bản sửa:

1. Scan QR, tạo và phục vụ hết đơn; tạo checkout VNPAY rồi quay lại mà chưa thanh toán.
2. Thử Dọn bàn: phải bị từ chối. Không thể đổi trạng thái thủ công trong form sửa bàn.
3. Admin/Waiter chọn Xác nhận thanh toán tiền mặt, kiểm tra bàn/session/số tiền và xác nhận đã nhận đủ.
4. Kiểm tra Order Paid/CASH/history; invoice CASH và PDF đúng giảm giá/tổng tiền; intent VNPAY cũ superseded và không có IPN giả.
5. Bàn trống, currentSessionId null, Session CLOSED; màn khách cũ kết thúc. Scan cùng QR có sessionId mới, summary trống và không nhận được checkout cũ.
6. Trong môi trường test, kiểm tra tranh chấp và IPN muộn bằng các suite ở trên. Nếu provider thật thu tiền muộn, đối soát khoản thu trùng bằng intent cũ và receipt CASH liên kết.

Chưa triển khai production hoặc thực hiện giao dịch tiền thật. Chưa xác minh giao diện bằng trình duyệt tương tác; đã kiểm chứng HTTP, Socket.IO thật, frontend recovery, PDF và build local.
