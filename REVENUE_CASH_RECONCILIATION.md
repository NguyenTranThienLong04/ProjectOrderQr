# Admin Revenue Report + Cash Shift Reconciliation

Phạm vi: báo cáo các khoản thu đã settlement và đối soát ca CASH. Không thêm accounting, refund hoặc correction workflow. Không commit.

## 1. Existing source of truth

- `payment_intents` là ledger hiện có. CASH tạo receipt `succeeded`; VNPAY IPN hợp lệ chuyển intent sang `succeeded`, `ipnConfirmed=true` trong transaction thanh toán.
- `VnpayService.settleCash()` và `settleIntent()` gọi `OrderStateMachineService.transitionManyToPaid()`. Order có `Paid`/`paidAt` phục vụ lifecycle; báo cáo mới lấy tiền từ snapshot `PaymentIntent.amount` và thời gian từ `completedAt`.
- `coveredOrderIds`, `sessionId`, `tableId`, `invoiceCode`, `settledByUserId`, `transactionNo` cung cấp truy vết. Hóa đơn/PDF tiếp tục dùng `InvoiceLookupService` hiện có.
- Không suy ra khoản thu từ trạng thái bàn. Analytics cũ vẫn tổng hợp Order; UI tổng quan đã có liên kết và mô tả nguồn dữ liệu để mở báo cáo settlement mới.

## 2. Data model

Thêm collection `cash_shifts`:

`staffId`, `staffName`, `openedAt`, `closedAt`, `openingCash`, `expectedCash`, `actualCash`, `variance`, `status: OPEN|CLOSED`, `closedBy`, `closedByName`, `version`.

- Partial unique index `one_open_cash_shift_per_staff` bảo đảm một OPEN shift/staff trên mọi instance. Index được tạo trước khi nhận traffic.
- `staffId`, tên người mở, `openingCash`, `openedAt` immutable. `expectedCash`, `actualCash`, `variance` chỉ persist khi close; OPEN response tính expected từ receipt.
- Thêm `PaymentIntent.cashShiftId` scalar immutable và index phục vụ tra cứu ca; thêm index `status/completedAt/_id` phục vụ revenue range. Không tạo collection payment mới.
- CASH mới lưu `settledByUserId` dạng ObjectId. Read layer normalize cả ObjectId và chuỗi của receipt cũ, không migrate lịch sử.
- Receipt cũ thiếu `invoiceCode` được cấp mã khi xuất hiện trên trang báo cáo bằng CAS `ensureInvoiceCode()` sẵn có. Chỉ điền mã còn thiếu; không sửa số tiền, thời điểm, coverage hoặc trạng thái payment.

## 3. Revenue calculation

`GET /admin/revenue?from=2026-10-01&to=2026-10-17&paymentMethod=CASH&staffId=<id>&page=1`

- Chỉ `status=succeeded` và (`paymentMethod=CASH` hoặc `paymentMethod=vnpay` với `ipnConfirmed=true`). Không cộng pending/failed/superseded/provider_rejected/internal_zero.
- Server aggregate trả `totalRevenue`, `cashRevenue`, `vnpayRevenue`, `transactionCount`, `byDay`, `byPaymentMethod`, `cashByStaff`, `transactions`.
- `totalRevenue = cashRevenue + vnpayRevenue`, theo bộ lọc đang chọn. Lọc staff chỉ giữ receipt do staff đó thu. Các tổng và breakdown tính trên toàn khoảng; bảng phân trang 50 receipt/trang.
- `cashRevenue = cashInClosedShifts + cashInOpenShifts + unassignedHistoricalCash`. API aggregate và Admin UI hiển thị riêng cả ba số; nhóm cuối có nhãn **Unassigned / Historical CASH**. Phân loại theo trạng thái hiện tại của ca, chỉ cộng doanh thu trong khoảng đang lọc, không cộng opening cash. Receipt thiếu ca hoặc không còn tham chiếu ca hợp lệ vào nhóm unassigned; không tự gán lại lịch sử hay đưa vào variance của ca mới.
- Mỗi dòng gồm mã invoice, session, order IDs, tiền, phương thức chuẩn hóa CASH/VNPAY, `paidAt`, nhân viên, bàn, shift, provider transaction, status.
- Ngày `YYYY-MM-DD` được hiểu theo `Asia/Ho_Chi_Minh`, gồm hết ngày `to`. Khoảng DB dùng `[from, toExclusive)`. ISO timestamp phải có timezone; `to` dạng timestamp là cận trên exclusive. Mặc định hôm nay; giới hạn 366 ngày. UI và nhóm ngày đều UTC+7, cùng timezone hiển thị hóa đơn hiện tại.
- `GET /admin/revenue/staff` cấp bộ lọc nhân viên.

## 4. Cash shift flow

| API | Chức năng |
| --- | --- |
| `POST /cash-shifts` `{openingCash}` | Mở ca cho chính người đăng nhập |
| `GET /cash-shifts/current` | Ca OPEN và tiền dự kiến của mình |
| `GET /cash-shifts/mine?page=1` | Lịch sử ca của mình |
| `GET /cash-shifts/:id?page=1` | Tiền ca và receipt CASH trong ca |
| `POST /cash-shifts/:id/close` `{actualCash, version}` | Đóng ca với snapshot đã xem |
| `GET /admin/cash-shifts?status=OPEN&staffId=<id>&page=1` | Đối soát toàn bộ nhân viên |
| `GET /admin/cash-shifts/:id?page=1` | Chi tiết đối soát của Admin |

Staff phải mở ca trước khi thu CASH. Settlement tự tìm ca OPEN theo actor, tăng `version` và lưu `cashShiftId` trong cùng MongoDB transaction với receipt/Order Paid/session/table release. Client không chọn nhân viên hoặc ca nhận khoản thu.

Close cũng ghi vào chính document ca, với điều kiện `OPEN` và `version` từ preview. CASH/close cạnh tranh gây write conflict hoặc version mismatch: bên thua trả 409, transaction rollback, cần tải lại. Không tự retry thao tác staff sang ca mới hoặc snapshot mới.

Double CASH vẫn dùng lifecycle/state-machine fence hiện có. Duplicate VNPAY IPN giữ handling idempotent hiện có và không thay đổi cash shift.

## 5. Variance / reconciliation

`expectedCash = openingCash + SUM(successful CASH receipts thuộc shift)`

`variance = actualCash - expectedCash`

Không có refund support trong project nên không thêm khoản trừ giả định. Staff chỉ nhập actual khi close; `version` là token do UI lấy từ server, không phải số tiền nhập tay. Payload tự truyền `expectedCash`/`variance` bị từ chối.

Kết quả close, thời điểm và người đóng được persist. Không có PATCH/DELETE/reopen/correction API. Đóng lại trả 409. Ca CLOSED không nhận receipt mới; ca tiếp theo có ID mới. UI hiển thị chữ “Có chênh lệch” cùng highlight, không kết luận gian lận.

UI: Admin `/admin/revenue`, `/admin/cash-shifts`; Waiter `/waiter/cash-shifts`. Admin cũng mở ca riêng khi trực tiếp thu CASH. Bảng receipt liên kết tới màn hình invoice hiện tại.

## 6. Authorization

- Revenue, staff filter và reconciliation toàn hệ thống: chỉ Admin, qua JWT + RolesGuard.
- Waiter/Admin mở ca của mình; Waiter xem/đóng ca của mình. Admin xem/đóng ca bất kỳ, `closedBy` ghi đúng người thực hiện.
- Anonymous bị 401; Kitchen không có quyền CASH/shift/revenue. Waiter không thể dùng ID ca người khác để đọc hoặc đóng.
- DTO whitelist/forbidNonWhitelisted chặn amount/status/staff/expected injection. Tiền nhập phải là số nguyên VND không âm.

## 7. Files changed

Backend mới:

- `backend/src/modules/finance/cash-shift.schema.ts`
- `backend/src/modules/finance/cash-shift.service.ts`
- `backend/src/modules/finance/finance.controller.ts`
- `backend/src/modules/finance/finance.dto.ts`
- `backend/src/modules/finance/finance.module.ts`
- `backend/src/modules/finance/revenue-period.ts`
- `backend/src/modules/finance/revenue.service.ts`

Backend tích hợp: `backend/src/app.module.ts`, `backend/src/modules/vnpay/{payment-intent.schema.ts,vnpay.module.ts,vnpay.service.ts}`.

Frontend mới:

- `frontend/src/services/api/finance.ts`
- `frontend/src/features/admin/RevenueDashboard.tsx`
- `frontend/src/features/finance/{CashShifts.tsx,FinanceShared.tsx,finance-format.ts}`

Frontend tích hợp: `frontend/src/App.tsx`, `frontend/src/components/CashSettlementAction.tsx`, `frontend/src/features/admin/{AdminDashboard.tsx,AdminLayout.tsx}`, `frontend/src/features/staff/StaffLayout.tsx`.

Kiểm thử mới: `backend/test/revenue-cash-shifts.e2e-spec.ts`, `backend/test/tsconfig.revenue.json`, `frontend/scripts/revenue-cash-shifts-browser-smoke.cjs`.

Cập nhật fixture/constructor của test sẵn có: `backend/test/{cash-settlement.e2e-spec.ts,payment-intent-migration.integration.spec.ts}`, `backend/src/modules/vnpay/{cash-settlement.transaction.spec.ts,vnpay.transaction.spec.ts,vnpay.service.spec.ts}`, `backend/src/modules/order/kitchen-reject.transaction.spec.ts`, `backend/src/modules/session/session.lifecycle.spec.ts`, `frontend/scripts/invoices-browser-smoke.cjs`.

Trạng thái sau final stabilization (không stage/commit):

| Phân loại | Modified | Untracked | Tổng |
| --- | ---: | ---: | ---: |
| Production backend | 4 | 7 | 11 |
| Frontend source | 5 | 5 | 10 |
| Tests/config kiểm thử/browser scripts | 8 | 3 | 11 |
| Docs: tài liệu này | 0 | 1 | 1 |
| **Tổng** | **17** | **16** | **33** |

Các mục “mới” ở trên là untracked; các mục tích hợp/cập nhật là modified. Không đổi dependency/lockfile. Log, ảnh và bản HEAD dùng kiểm thử nằm ngoài git hoặc trong `.tmp/` bị ignore.

## 8. Tests / validation

Final stabilization đã chạy lại canonical suites đầy đủ trên working tree và bản source HEAD riêng biệt `c3681e11fd163570f155116bc809d8bfdc94a9de`, cùng dependencies hiện có. Bảng này thay thế kết quả 76 tests theo feature ở vòng triển khai trước:

| Canonical command | HEAD trước feature | Sau stabilization | Kết quả |
| --- | ---: | ---: | --- |
| Backend `npm run test:unit` | 764 / 33 suites | 764 / 33 suites | PASS |
| Backend `npm run test:integration -- --runInBand` | 71 / 9 suites | 71 / 9 suites | PASS |
| Backend `npm run test:e2e:ci` | 180 / 18 suites | 191 / 19 suites | PASS |
| Frontend `npm test` | 36 / 4 suites | 36 / 4 suites | PASS |
| **Tổng canonical tests** | **1051** | **1062** | **0 failed / skipped / todo** |

Không dùng test-name/path filter cho các lần chạy canonical. Static scan không có khai báo test `.skip`, `.only`, `.todo`. Đối chiếu từng test name: không bỏ test cũ; một test parameterized cũ có ObjectId ngẫu nhiên trong tên được normalize khi so sánh (file không thay đổi).

Tăng đúng 11 E2E trong `backend/test/revenue-cash-shifts.e2e-spec.ts`:

1. `separates open, closed and historical CASH over the whole multi-day range, independently of pagination`
2. `Admin CASH uses the Admin own shift and keeps discounted/rejected invoice, ledger and drawer amounts equal`
3. `invalid merchant/status never settles and late IPN after CASH stays superseded without double revenue`
4. `sums successful receipts at Vietnam day boundaries, groups methods/staff, and excludes all non-settlements`
5. `paginates receipts without changing server totals`
6. `attributes CASH to the collector/active shift, computes expected and persists actual/variance; closed membership stays fixed`
7. `enforces one OPEN shift across concurrent requests, and duplicate CASH never increments sales twice`
8. `close winning while CASH is in flight rolls back the entire settlement`
9. `CASH winning forces a concurrent close to reload before it can persist`
10. `duplicate verified VNPAY IPN counts once and never enters a cash drawer`
11. `restricts revenue/reconciliation to Admin and staff to their own drawer; Admin can close another staff drawer`

Trong vòng stabilization bổ sung ba case đầu; tám case còn lại đã có từ vòng implement. Các suite cũ chỉ cập nhật dependency/fixture, không thêm/bớt test. Full integration bắt được mock constructor trong migration test lệch vị trí sau khi thêm CashShift dependency; đã sửa đúng vị trí và chạy lại toàn bộ integration đạt 71/71.

Chạy lại **toàn bộ** `test:e2e:ci` với `TZ=UTC`: **191/191**, bao gồm boundary 00:00, cuối ngày Việt Nam, custom nhiều ngày và ISO tương đương.

Browser trên production bundle: **23/23** checks, gồm 18 invoice checks cũ (cập nhật mock ca OPEN cho thao tác CASH) và 5 checks mới trong `revenue-cash-shifts-browser-smoke.cjs`. Bao phủ tổng/filter/link invoice, historical CASH, responsive 375px + landscape, error/empty, waiter open/close/stale version, Admin discrepancy/detail. Đây là checks dùng API fixture local, không phải kiểm thử browser với backend live.

Backend `npm run typecheck`, `npm run build`, typecheck suite mới và ESLint finance: PASS. Frontend `npm run typecheck`, `npm run build`, `npm run lint`: PASS; còn warning cũ `CustomerMenu` hook và bundle lớn.

Mongo tests dùng replica set tạm do harness tạo, không đọc `.env` hay DB ứng dụng. IPN được ký bằng cấu hình test và gọi local; không gọi VNPAY thật. Log/JSON/count comparison nằm trong `.tmp/revenue-stabilization/`; ảnh trong `.tmp/revenue-verification/` và `.tmp/invoice-verification/`.

Lệnh chính (PowerShell, thư mục backend):

```powershell
$env:MONGOD_BINARY = 'C:/Program Files/MongoDB/Server/8.2/bin/mongod.exe'
npm run test:unit
npm run test:integration -- --runInBand
npm run test:e2e:ci
npm run typecheck
npm run build
node node_modules/typescript/bin/tsc -p test/tsconfig.revenue.json
```

Frontend build kiểm thử dùng `VITE_API_URL=http://127.0.0.1:3000`. Chạy script browser với `PLAYWRIGHT_CORE_PATH` trỏ tới playwright-core đã cài và Chromium tương ứng. Không thêm dependency.

Git review: đã kiểm tra `git status --short --untracked-files=all`, `git diff --stat`, `git diff --check`; whitespace check đạt. Rà soát toàn bộ file modified/untracked bằng pattern scan cho Mongo URI, JWT literal/secret, VNPAY secret, API key, private key và đường dẫn dữ liệu/backup: không phát hiện credential thật, production data hoặc backup mới. Những literal bị đánh dấu thuộc fixture test đã tồn tại nguyên văn trong HEAD. `.env` không nằm trong diff. Scan này là kiểm tra phạm vi thay đổi, không phải audit toàn bộ git history.

## 9. Limitations

- CASH trước feature chưa có shift vẫn tính revenue và tách tổng **Unassigned / Historical CASH**; không tự gán vào ca mới. Order Paid cũ không có settlement receipt, hoặc receipt không có `completedAt`, không được tự suy đoán thành revenue.
- `internal_zero` không nằm trong CASH/VNPAY nên không tính vào số hóa đơn của báo cáo này. VNPAY late success sau supersession giữ cảnh báo reconciliation sẵn có, không cộng trùng.
- Không hỗ trợ refund, cash adjustment, correction hoặc review workflow. Ca đã đóng không thể sửa/xóa qua API. Nếu cần correction sau này phải thêm audit record riêng.
- Analytics/AI cũ vẫn dùng Order và quy ước UTC cũ; báo cáo settlement mới dùng giờ Việt Nam của invoice và ghi rõ trên UI. Không refactor analytics cũ hoặc payment architecture.
- Dùng MongoDB replica set và index bắt buộc, như settlement hiện tại. Chưa triển khai/migrate lên môi trường chạy thật.
- Canonical backend typecheck chỉ kiểm source production theo `tsconfig.build.json`; không tuyên bố toàn bộ fixture test cũ typecheck sạch. Thử kiểm rộng fixture ở vòng trước gặp lỗi generic `Model`/Mongoose có sẵn; suite mới có typecheck riêng đã qua. Toàn bộ canonical runtime suites đã xanh như bảng trên.
