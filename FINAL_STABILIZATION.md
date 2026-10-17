# Final stabilization: CASH settlement + Kitchen Reject Item

## Checkpoint Git — cập nhật sau khi sửa E2E fixtures

Verification local trước checkpoint: unit **763/763**, integration **71/71**,
frontend **36/36**, full E2E **181/181** (18 suites); tổng **1.051/1.051 PASS**.
Backend/frontend typecheck, build và `git diff --check` đều PASS.
`npm run test:e2e:ci` hiện gọi canonical full E2E, đã chạy local đạt 181/181
và có cùng tập test với `npm run test:e2e`; chưa xác minh GitHub-hosted runner.
80 failure trong sáu suite AI/order-note/catalog đã được chạy trên baseline
`10a98a4`: 23 pass / 80 fail, trùng workspace trước sửa. Chỉ cập nhật test
module/auth/QR/order/IPN fixtures, không sửa production trong lượt sửa E2E,
không skip/only/todo hoặc giảm số test. AI dùng fake/mock và test DB cô lập.

Các mục bên dưới là **báo cáo lịch sử trước khi sửa E2E**. Các con số 38 fail,
920 tests, inventory và đề xuất commit cũ không mô tả checkpoint hiện tại.

Phạm vi: chỉ kiểm tra hai feature và các integration point liên quan; không thêm feature, refactor hoặc test mới. Không stage/commit.

## 1. Checks đã chạy

| Check | Kết quả cuối |
| --- | --- |
| Backend `npm run typecheck` | PASS |
| Backend `npm run build` | PASS |
| Frontend `npm run typecheck` | PASS |
| Frontend `npm run build` | PASS; dùng `VITE_API_URL=http://localhost:3000` |
| Backend `npm run test:unit` | PASS: 33 suites, 763 tests |
| Backend `npm run test:integration -- --runInBand` | PASS: 9 suites, 71 tests |
| Backend E2E chọn theo phạm vi bên dưới | 3 suites pass, 5 suites fail; 12 tests pass, 38 fail |
| Frontend `npm test` | PASS: 36 tests |
| Frontend `npm run lint` | PASS, 1 warning cũ |
| `git -c core.safecrlf=false diff --check` | PASS |

Integration/E2E sử dụng MongoDB local: `MONGOD_BINARY=C:\Program Files\MongoDB\Server\8.2\bin\mongod.exe`.

Lệnh E2E đã chạy từ `backend`:

```text
npm run test:e2e -- --runInBand --runTestsByPath test/app.e2e-spec.ts test/session-payment.e2e-spec.ts test/session-merge.e2e-spec.ts test/session-abandonment.e2e-spec.ts test/invoices.e2e-spec.ts test/cash-settlement.e2e-spec.ts test/kitchen-reject.e2e-spec.ts test/admin-analytics.e2e-spec.ts
```

## 2. Pass/fail và integration point

Chưa đạt trạng thái toàn bộ checks xanh: 38 lỗi E2E có sẵn vẫn còn. Đã xuất source/test tại HEAD `10a98a4` sang thư mục tạm và chạy lại cùng 6 suite cũ. Baseline có 9 pass / 38 fail; bản hiện tại có thêm 3 test E2E mới đều pass. So sánh tên test và thông báo lỗi đầu tiên: không có lỗi mới, lỗi được giải quyết hoặc thông báo lỗi khác. Thư mục baseline và log/JSON tạm đã được dọn.

| E2E suite | Pass | Fail | Nguyên nhân đã có ở HEAD |
| --- | ---: | ---: | --- |
| `app.e2e-spec.ts` | 1 | 0 | — |
| `cash-settlement.e2e-spec.ts` | 2 | 0 | — |
| `kitchen-reject.e2e-spec.ts` | 1 | 0 | — |
| `session-abandonment.e2e-spec.ts` | 8 | 1 | Fixture truy cập session thiếu signed QR/customer headers, trả 401 |
| `session-merge.e2e-spec.ts` | 0 | 8 | Fixture truy cập session thiếu signed QR/customer headers, trả 401 |
| `session-payment.e2e-spec.ts` | 0 | 2 | Fixture IPN thiếu tham số bắt buộc và transaction number không hợp lệ, trả RspCode 97 |
| `invoices.e2e-spec.ts` | 0 | 20 | Test module thiếu UserService cho JwtStrategy, lỗi khởi tạo suite |
| `admin-analytics.e2e-spec.ts` | 0 | 7 | Test module thiếu UserService cho JwtStrategy, lỗi khởi tạo suite |

Review giới hạn ở các integration point được yêu cầu, kết hợp các test hiện có:

- Kitchen Reject ↔ Payment: món Rejected tính 0; CASH/VNPAY dùng chung quy tắc tính tiền; chặn reject order Paid; unresolved checkout trả 409; cập nhật tổng tiền và history trong transaction.
- Kitchen Reject ↔ Order: Served + Rejected hoàn tất đúng; tất cả Rejected chuyển Cancelled và tổng 0; CAS và Session write fence bảo vệ các thao tác đồng thời; lưu lịch sử từ chối.
- CASH ↔ VNPAY: receipt CASH không giả IPN; checkout cũ được superseded; late IPN lưu kết quả provider/reconciliation mà không thanh toán lần hai; VNPAY đã succeeded chặn CASH.
- CASH ↔ Session/Table: đóng session, clear currentSessionId, trả table về AVAILABLE (trống); QR scan mới tạo session mới và không phục hồi payment cũ.
- Invoice: thể hiện phương thức CASH; giữ dòng món Rejected với số tiền tính 0; tổng invoice được đối chiếu với amount của settlement.
- Realtime/recovery: emit sau transaction commit; reject cập nhật Customer/Waiter; CASH đóng session và kích hoạt refresh/clear dữ liệu session phía frontend. E2E mới dùng MongoDB và Socket.IO thực trong môi trường test.

Không phát hiện regression production mới trong phạm vi đã kiểm tra. Các nhận định trên không thay thế kiểm thử provider/browser thực tế.

## 3. Regression tìm thấy và đã sửa

Lần chạy full backend unit đầu tiên có 15 fail do test VNPAY chưa theo kịp hợp đồng mới. Chỉ sửa `backend/src/modules/vnpay/vnpay.service.spec.ts`:

- Bổ sung `sessionModel.updateOne` mock, phản ánh Session write fence khi tạo checkout.
- Bổ sung `status` trong expected item của payment summary; giữ assertion so sánh chính xác, bao gồm ánh xạ order Paid sang item Served.

Sau sửa: full unit suite 763/763 pass. Không sửa logic production và không thêm test trong lần stabilization này.

## 4. Tổng test cuối

| Nhóm | Pass | Fail | Tổng |
| --- | ---: | ---: | ---: |
| Backend unit | 763 | 0 | 763 |
| Backend integration | 71 | 0 | 71 |
| Backend E2E được chọn | 12 | 38 | 50 |
| Frontend | 36 | 0 | 36 |
| **Tổng** | **882** | **38** | **920** |

Regression riêng: CASH **20/20** (18 integration + 2 E2E), Kitchen Reject **14/14** (13 integration + 1 E2E). Đây là tập con của tổng 920, không cộng lần nữa. Không tính lần chạy baseline hoặc các lần chạy lặp vào tổng.

## 5. Files còn modified/untracked

45 modified, 17 untracked, bao gồm báo cáo này. Trong lần stabilization chỉ sửa test VNPAY nêu trên và thêm báo cáo này; các thay đổi khác đã tồn tại từ trước.

Modified:

```text
backend/.env.example
backend/package.json
backend/src/common/enums/order-status.enum.ts
backend/src/common/schemas/status-history.schema.ts
backend/src/gateway/app.gateway.spec.ts
backend/src/gateway/app.gateway.ts
backend/src/modules/admin/admin.service.ts
backend/src/modules/invoice/dto/invoice.dto.ts
backend/src/modules/invoice/invoice-lookup.service.ts
backend/src/modules/menu/recommendation.service.ts
backend/src/modules/order/dto/transition-order-item.dto.ts
backend/src/modules/order/invoice.service.spec.ts
backend/src/modules/order/invoice.service.ts
backend/src/modules/order/order-state-machine.service.spec.ts
backend/src/modules/order/order-state-machine.service.ts
backend/src/modules/order/order-transition.rules.ts
backend/src/modules/order/order.controller.ts
backend/src/modules/order/order.module.ts
backend/src/modules/order/order.schema.ts
backend/src/modules/order/order.service.ts
backend/src/modules/order/order.transaction.spec.ts
backend/src/modules/promotion/promotion.service.ts
backend/src/modules/table/table.service.ts
backend/src/modules/vnpay/payment-intent.schema.ts
backend/src/modules/vnpay/vnpay.module.ts
backend/src/modules/vnpay/vnpay.service.spec.ts
backend/src/modules/vnpay/vnpay.service.ts
backend/src/modules/vnpay/vnpay.transaction.spec.ts
backend/test/jest-common.cjs
frontend/src/components/ui.tsx
frontend/src/features/admin/InvoiceLookup.tsx
frontend/src/features/admin/TableManager.tsx
frontend/src/features/kitchen/KitchenDisplay.tsx
frontend/src/features/menu/CustomerMenu.tsx
frontend/src/features/menu/OrderProgress.tsx
frontend/src/features/payment/PaymentResult.tsx
frontend/src/features/waiter/WaiterDashboard.tsx
frontend/src/services/api/invoice.ts
frontend/src/services/api/order.ts
frontend/src/services/api/payment.ts
frontend/src/services/customer-access.ts
frontend/src/services/customer-recovery.ts
frontend/src/services/payment-recovery.ts
frontend/test/order-progress.test.mjs
frontend/test/recovery.test.mjs
```

Untracked:

```text
CASH_SETTLEMENT.md
FINAL_STABILIZATION.md
KITCHEN_REJECT.md
PROJECT_INTERVIEW_GUIDE.md
backend/scripts/migrate-payment-intents.ts
backend/scripts/payment-intent-migration.md
backend/scripts/query-payment-intents.ts
backend/scripts/reconcile-provider-rejections.ts
backend/src/modules/order/kitchen-reject.transaction.spec.ts
backend/src/modules/order/order-billing.ts
backend/src/modules/promotion/promotion-amounts.ts
backend/src/modules/vnpay/cash-settlement.controller.ts
backend/src/modules/vnpay/cash-settlement.transaction.spec.ts
backend/test/cash-settlement.e2e-spec.ts
backend/test/kitchen-reject.e2e-spec.ts
backend/test/payment-intent-migration.integration.spec.ts
frontend/src/components/CashSettlementAction.tsx
```

## 6. Commit plan

Chưa thỏa điều kiện tất cả checks xanh. Kế hoạch nhóm thay đổi dưới đây chỉ áp dụng sau khi điều kiện đó được đáp ứng và có yêu cầu commit:

1. `feat: add audited cash settlement flow`: CASH endpoint/settlement, lifecycle và superseded checkout, invoice/realtime/recovery liên quan, UI CASH, regression tests và tài liệu CASH.
2. `feat: support kitchen item rejection`: rejection state/history/CAS, quy tắc billable total, tích hợp invoice/payment, UI Kitchen/Customer/Waiter, regression tests và tài liệu Kitchen Reject; kèm cập nhật unit fixture VNPAY và báo cáo stabilization.

Các file dùng chung cần chia theo hunk khi stage. Không đưa tự động các script migration/reconciliation hoặc `PROJECT_INTERVIEW_GUIDE.md` đã tồn tại vào hai commit. Chưa stage hoặc commit file nào.

## 7. Limitation thật sự còn lại

- 38 lỗi E2E cũ nêu trên vẫn còn; không sửa ngoài phạm vi. Vì vậy chưa thể xác nhận toàn bộ pipeline xanh, dù các regression suite của hai feature đều pass.
- Chưa chạy thanh toán với hệ thống VNPAY bên ngoài hoặc thao tác thủ công trên browser thật trong lượt stabilization này. Test dùng request/callback fixtures, MongoDB và Socket.IO local; frontend có automated tests và production build.
- Warning cũ giữ nguyên: duplicate index `{code: 1}` ở Promotion; Mongoose deprecated `new` option; `CustomerMenu.tsx:107` thiếu dependency `loadMenu` trong useEffect; Vite chunk lớn hơn 500 kB. Không mở rộng phạm vi để sửa.
