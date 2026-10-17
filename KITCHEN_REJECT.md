# Kitchen Reject Order Item

## 1. Business rule

Chỉ Kitchen được từ chối món Pending, với lý do sau trim dài 1–250 ký tự. Ghi `rejectionReason`, `rejectedBy`, `rejectedAt` và item status history (`kitchen_reject`, actor, thời gian, lý do, tổng tiền sau thay đổi). Giữ nguyên tên, giá, quantity và món trong Order.

Không cho Admin/Waiter/Customer reject. Không reject Preparing/Ready/Served/Rejected, hoặc bất kỳ món nào thuộc Order Paid/Cancelled/Served. Session phải còn Active.

## 2. Transition matrix

| Item hiện tại | Item tiếp theo | Role |
|---|---|---|
| Pending | Preparing | Kitchen, Admin (policy cũ) |
| Pending | Rejected | Kitchen |
| Preparing | Ready | Kitchen, Admin (policy cũ) |
| Ready | Served | Waiter, Admin (policy cũ) |
| Rejected / Served | Không có transition staff tiếp theo | — |

Aggregate Order: tất cả món Served/Rejected và có món Served → Served; tất cả Rejected → Cancelled, tổng tiền 0. Order Served có món Rejected vẫn qua được payment state machine. Phiên chỉ có các đơn Cancelled không cần thu tiền và có thể dọn bàn theo guard hiện có.

## 3. Files changed trong tính năng này

Các thay đổi CASH/migration có sẵn trong working tree không được tính vào danh sách dưới đây.

| Nhóm | Files |
|---|---|
| Status, history | `backend/src/common/enums/order-status.enum.ts`, `backend/src/common/schemas/status-history.schema.ts` |
| Order model/rules | `backend/src/modules/order/order.schema.ts`, `order-transition.rules.ts`, `order-state-machine.service.ts`, `order-billing.ts` |
| Order API/query | `backend/src/modules/order/order.controller.ts`, `order.service.ts`, `order.module.ts`, `dto/transition-order-item.dto.ts` |
| Promotion | `backend/src/modules/promotion/promotion-amounts.ts`, `promotion.service.ts` |
| Payment | `backend/src/modules/vnpay/vnpay.service.ts` |
| Invoice | `backend/src/modules/order/invoice.service.ts`, `backend/src/modules/invoice/invoice-lookup.service.ts`, `dto/invoice.dto.ts` |
| Tương thích trạng thái mới | `backend/src/modules/admin/admin.service.ts`, `backend/src/modules/menu/recommendation.service.ts` |
| UI | `frontend/src/components/ui.tsx`, `frontend/src/features/kitchen/KitchenDisplay.tsx`, `frontend/src/features/menu/OrderProgress.tsx`, `CustomerMenu.tsx`, `frontend/src/features/waiter/WaiterDashboard.tsx`, `frontend/src/features/admin/InvoiceLookup.tsx` |
| Frontend API types | `frontend/src/services/api/order.ts`, `payment.ts`, `invoice.ts` |
| Backend tests | `backend/src/modules/order/kitchen-reject.transaction.spec.ts`, `order-state-machine.service.spec.ts`, `order.transaction.spec.ts`, `invoice.service.spec.ts`, `backend/test/kitchen-reject.e2e-spec.ts`, `backend/test/jest-common.cjs` |
| Frontend tests | `frontend/test/order-progress.test.mjs`, `frontend/test/recovery.test.mjs` |
| Báo cáo | `KITCHEN_REJECT.md` |

## 4. Payment / invoice

`itemCharge(Rejected) = 0`. Khi reject, transaction tính lại subtotal/discount/total của Order. Session summary, VNPAY và CASH cùng đọc snapshot này; fallback subtotal của đơn cũ cũng loại Rejected. Báo cáo Top dishes loại món Rejected khỏi số lượng/doanh thu.

Đơn mới lưu rule promotion tại lúc chấp nhận đơn (`type`, `value`, `minOrderAmount`). Reject dùng cùng hàm tính discount: phần trăm làm tròn VND; cố định không vượt subtotal; dưới minimum thì discount bằng 0. Không reserve/release usage lần nữa: usage vẫn đếm lượt Order đã chấp nhận theo semantics hiện tại. Mã/rule gốc vẫn giữ để đối chiếu, kể cả khi discount sau reject bằng 0.

Invoice JSON, PDF và trang tra cứu giữ món bị từ chối, số lượng, giá gốc, lý do và ghi rõ không tính tiền. Line charge = 0; tổng hóa đơn phải khớp PaymentIntent. Đơn all-Rejected được Cancelled, không tạo receipt thanh toán cho riêng đơn đó.

## 5. Concurrency / checkout

Reject chạy trong MongoDB transaction: đọc và kiểm tra state, ghi Session để đồng bộ với checkout/lifecycle, kiểm tra unresolved PaymentIntent theo Session hoặc covered Order, CAS Order theo status/sessionId/`__v`, ghi item/history/amount/aggregate/table rồi commit.

Reject và Preparing cùng đọc một version: chỉ một write thắng; bên thua nhận 409 hoặc lỗi state hiện có sau khi đọc lại. Transaction không tự diễn giải lại reject trên snapshot mới. Checkout creation cũng ghi Session và Order để không giữ snapshot thanh toán cũ qua một thay đổi đồng thời.

Nếu có checkout unresolved (Pending hoặc Failed chưa IPN-confirmed, kể cả đã hết hạn local), reject trả 409 và không sửa payment history. Paid không thể reject. Socket chỉ emit sau khi service transaction hoàn tất.

## 6. UI / realtime

Kitchen: nút Từ chối chỉ hiện cho Kitchen trên Pending; modal nhỏ nhập lý do và xác nhận, khóa nút trong lúc xử lý, hiển thị lỗi server. Không đổi bố cục hàng đợi.

Customer: `order:updated` kích hoạt snapshot refresh hiện có; thấy Rejected, lý do, nhãn Không tính tiền và tổng thanh toán mới. All-Rejected hiển thị không còn món cần thanh toán.

Waiter: vùng món bị từ chối hiển thị bàn/món/lý do trong phiên Active; không có nút Serve cho Rejected hoặc món Ready của đơn đã Cancelled. Có thể dọn bàn khi toàn bộ đơn đã Paid/Cancelled và backend guard cho phép.

## 7. Tests và kết quả

- 26 unit tests: state machine, promotion, nội dung PDF (bao gồm hai đường render invoice).
- 46 integration tests: 13 Kitchen Reject; 33 hồi quy Order concurrency/create, VNPAY và CASH.
- 1 E2E: HTTP auth/DTO, Customer/Waiter Socket.IO thực nhận state/amount, waiter query.
- 30 frontend tests: OrderProgress VI/EN và recovery khi nhận event/reconnect.
- Tổng 103 tests qua. MongoDB tests dùng replica set riêng của test harness.
- Backend build và frontend production build qua.
- ESLint cho toàn bộ source backend liên quan và hai test mới qua; frontend lint không có lỗi, còn warning `CustomerMenu` useEffect dependency đã có trước.
- `git diff --check` qua.

## 8. Giới hạn

- Đơn cũ có promotion/discount nhưng thiếu rule snapshot bị chặn reject (409); không đoán rule và không tự backfill dữ liệu cũ.
- Không hỗ trợ reject sau khi bắt đầu chế biến, reject một phần quantity, undo reject hoặc refund.
- Giữ chiến lược chặn khi checkout chưa được xác nhận; không tự invalidate checkout.
- VNPAY được kiểm thử bằng URL và IPN ký hợp lệ trên môi trường test, chưa thực hiện giao dịch tiền thật. UI được kiểm tra bằng build/render/recovery tests, chưa chạy thao tác thủ công trên trình duyệt.
