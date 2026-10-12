# Git hygiene inventory

Phân loại ngày 12/10/2026, sau stabilization checkpoint #1–#9. Có **47 file untracked** trước lần cập nhật tài liệu này: 11 source, 21 test/harness, 12 config/startup và 3 docs. Đây là danh sách để đưa vào cùng bộ thay đổi; không phải danh sách file đã được stage/commit.

## Cần giữ và commit cùng các thay đổi hiện có

### Source — 11 files

```text
backend/src/gateway/socket-auth.module.ts
backend/src/gateway/socket-auth.service.ts
backend/src/gateway/socket-payload.dto.ts
backend/src/modules/order/order-transition.rules.ts
backend/src/modules/session/lifecycle-transaction.ts
frontend/src/hooks/use-snapshot-refresh.ts
frontend/src/services/customer-access.ts
frontend/src/services/customer-recovery.ts
frontend/src/services/payment-recovery.ts
frontend/src/services/snapshot-refresh.ts
frontend/src/services/socket-client.ts
```

### Regression tests và test harness — 21 files

```text
backend/src/modules/auth/auth.regression.spec.ts
backend/src/modules/order/order-state-machine.concurrent.spec.ts
backend/src/modules/order/order.transaction.spec.ts
backend/src/modules/session/session.lifecycle.spec.ts
backend/src/modules/vnpay/vnpay.transaction.spec.ts
backend/test/jest-common.cjs
backend/test/jest-e2e.cjs
backend/test/jest-integration.cjs
backend/test/jest-unit-ci.cjs
backend/test/jest-unit.cjs
backend/test/mongo-isolation.integration.spec.ts
backend/test/mongo-safety.spec.ts
backend/test/support/mongo-global-setup.cjs
backend/test/support/mongo-global-teardown.cjs
backend/test/support/mongo-safety.cjs
backend/test/support/mongo-setup.cjs
backend/test/support/no-env.cjs
backend/test/support/test-database.ts
backend/test/support/unit-setup.cjs
frontend/test/auth.test.mjs
frontend/test/recovery.test.mjs
```

### CI, Docker và cấu hình — 12 files

```text
.env.example
.github/workflows/ci.yml
backend/.dockerignore
backend/docker/bootstrap-admin.cjs
backend/docker/healthcheck.cjs
backend/docker/runtime.cjs
backend/docker/startup.cjs
backend/jest.config.cjs
backend/tsconfig.docker.json
docker/mongo-healthcheck.js
frontend/.dockerignore
frontend/nginx.conf
```

Các script startup/health/bootstrap là source cần thiết cho image; không phải generated output. `.env.example` chứa placeholder, cần đi cùng Compose. CI và cả test harness phải đi cùng regression tests để clean checkout chạy được.

### Docs — 3 files đã có, thêm inventory này

- `DOCKER.md`: hướng dẫn runtime và bootstrap chủ động.
- `backend/test/README.md`: test isolation, full unit và E2E CI scope.
- `PROJECT_DEEP_DIVE.md`: giữ bản phân tích cũ, đã thêm nhãn historical; không dùng các kết luận cũ làm evidence hiện tại.
- `GIT_HYGIENE.md`: inventory mới của lần này. `README.md` chính đã tracked và được viết lại.

## Generated / temp / log / output — không commit

Các thư mục/file hiện có sau đây đã được ignore:

- `backend/node_modules/`, `frontend/node_modules/`.
- `backend/dist/`, `frontend/dist/`, `backend/coverage/`.
- `backend/test-results/`, `frontend/test-results/`.
- `tmp/`, `.tmp/`: log, JSON kết quả, smoke probe và output Docker/checkpoint cục bộ.
- Các báo cáo sinh ra trong `docs/evaluation/`, `docs/*lint.json`; thư mục `docs/` hiện được ignore toàn bộ.

Rule hiện tại đã bao phủ các output tìm thấy; không cần mở rộng `.gitignore`. README chỉ link tài liệu/source được đưa vào repository, không phụ thuộc báo cáo trong thư mục bị ignore.

## Secret / local configuration — không commit

- `backend/.env`, `token.json` hiện tồn tại và được ignore; không trích giá trị vào tài liệu.
- `.env` và các biến thể `.env.*`, private key/certificate đã có ignore rule; giữ exception cho `.env.example`.
- `.agents/` là cấu hình công cụ cục bộ. `AI.md`, `PROGRESS.md` và các tài liệu phase cũ dưới `docs/` được giữ local theo rule hiện có.

Các env file đang tracked chỉ là `backend/.env.example` và `frontend/.env.example`; root `.env.example` nằm trong nhóm config mới ở trên. Kiểm tra mẫu credential trong 47 file untracked không phát hiện private key, provider key hay Mongo URI chứa credential thật; đây không phải kiểm toán secret toàn bộ lịch sử Git.

## Không còn cần cho runtime / có thể tái tạo

Build output, coverage, log và smoke probe cũ trong `tmp/`/`.tmp/` có thể tái tạo. Giữ chúng ngoài Git. Không xác định source/test/config nào trong 44 file mới là dư thừa; không xóa file trong lần phân loại này. Các ghi chú lịch sử được giữ nguyên nội dung ngoài nhãn historical.

## Kiểm tra trước khi commit

```sh
git status --short --untracked-files=all
git diff --check
git diff --cached --stat
```

Đối chiếu danh sách trên với file được stage, đặc biệt helpers auth/Socket, lifecycle transaction, frontend recovery, CI và Docker scripts. `git diff --stat` thông thường chỉ tính tracked diff, nên không phản ánh các file mới còn untracked. Không force-add env, token hay output để làm sạch status.
