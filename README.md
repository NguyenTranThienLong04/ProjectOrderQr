# Smart Restaurant Management & QR Ordering System

Hệ thống gọi món QR cho nhà hàng: khách cùng bàn dùng shared cart, bếp/phục vụ xử lý món theo thời gian thực, thanh toán VNPAY Sandbox qua IPN đã xác thực, và Admin theo dõi doanh thu bằng MongoDB Aggregation.

## Chức năng

- QR theo bàn, menu công khai và shared cart Socket.io chống race condition.
- Luồng món `Pending → Preparing → Ready → Served`; IPN VNPAY xác thực chuyển `Served → Paid`.
- Trạng thái bàn `available → occupied → waiting_payment → available`; Waiter/Admin cập nhật real-time.
- Đổi bàn, ghép/tách Session có audit và kiểm soát race condition.
- JWT + RBAC (`admin`, `kitchen`, `waiter`), CRUD menu/bàn/người dùng, ảnh Cloudinary.
- Dashboard doanh thu/top món bằng MongoDB aggregation.

## Chạy local

Yêu cầu Node.js 24+, MongoDB Atlas hoặc MongoDB local, tài khoản Cloudinary/VNPAY Sandbox nếu dùng các chức năng đó.

```bash
copy backend\.env.example backend\.env
cd backend && npm install && npm run start:dev
cd frontend && npm install && npm run dev
```

Mở frontend tại `http://localhost:5173`, backend tại `http://localhost:3000`. Thiết lập `MONGODB_URI`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, Cloudinary và VNPAY trong `backend/.env`; không commit file này. Với IPN Sandbox, cập nhật URL HTTPS public hiện tại ở VNPAY Merchant Admin mỗi khi domain ngrok free đổi.

Tài khoản admin được seed khi database trống: `admin@restaurant.com / Admin@123`.

## Docker

```bash
docker-compose up --build
```

Frontend: `http://localhost:5173`; backend: `http://localhost:3000`; MongoDB: `localhost:27017`.

Trước khi dùng ngoài local, thay hai JWT secret trong Compose bằng secret mạnh và truyền Cloudinary/VNPAY qua biến môi trường. VNPAY IPN cần public HTTPS URL, không dùng `localhost`.

## Kiểm thử

```bash
cd backend
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run test:cov -- --runInBand
```

E2E dùng MongoDB theo `backend/.env`; không chạy trên database production. Chi tiết security review: [docs/security-review.md](docs/security-review.md).

## Dữ liệu development/demo cho AI (Phase 16)

Dataset synthetic gồm 40 món Việt / 8 danh mục, 640 historical basket và 240 comment.
Chạy `npm run validate:ai-demo` trong `backend` để kiểm tra offline.
Seed/reset cần database riêng, opt-in và `NODE_ENV=development|test`; không gọi từ
startup và không tạo Order Paid, PaymentIntent hay Review nghiệp vụ giả.
Hướng dẫn cấu hình, `seed:ai-demo`, `reset:ai-demo`, giới hạn và kiểm thử:
[docs/ai-demo-data.md](docs/ai-demo-data.md).
Test MongoDB riêng Phase 16 yêu cầu `AI_DEMO_TEST_MONGODB_URI`, luôn override sang
database test có tên duy nhất; không dùng database ứng dụng làm đích kiểm thử.

## AI Foundation (Phase 17)

Backend có `AiModule` với provider abstraction, structured output validation,
timeout/retry có giới hạn và audit metadata. AI mặc định tắt; cấu hình trong
`backend/.env.example`. Chưa có API chatbot hoặc tính năng AI nghiệp vụ.
Setup, test và live smoke opt-in: [docs/ai-setup.md](docs/ai-setup.md).
Evidence: [docs/phase17-verification.md](docs/phase17-verification.md).
Live provider chưa verify vì chưa có credential.

## Mô tả CV

Xây dựng hệ thống quản lý nhà hàng và QR ordering với NestJS, React, MongoDB và Socket.io: đồng bộ shared cart real-time bằng atomic Mongo updates, triển khai state machine món ăn có RBAC/audit trail, xác thực VNPAY IPN bằng HMAC và idempotency, và xây dashboard doanh thu bằng aggregation pipelines. Hỗ trợ dynamic QR generation, chuyển/ghép/tách bàn có kiểm soát race condition.
