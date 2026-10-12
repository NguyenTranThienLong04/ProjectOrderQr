# PROJECT DEEP DIVE — SmartOrder

> **Historical snapshot — trước các thay đổi #1–#9.** Những mô tả refresh token, Socket authorization, transaction, test isolation và Docker bên dưới có phần đã lỗi thời. Giữ tài liệu này làm ghi chú học tập; xem [README hiện tại](README.md), [test setup](backend/test/README.md) và [Docker setup](DOCKER.md) cho trạng thái sau stabilization checkpoint 12/10/2026.

> Phân tích tĩnh source code tại workspace ngày 18/09/2026. Đây là tài liệu học và chuẩn bị phỏng vấn; không phải kết quả kiểm thử môi trường production. **Project hiện tại là NestJS/TypeScript + React + MongoDB, không phải ASP.NET Core/.NET + EF Core + SQL.** Khi phỏng vấn .NET, hãy nói đúng stack đã làm, rồi liên hệ các khái niệm tương đương. Không nhận mình đã dùng EF Core, LINQ, `DbContext`, migrations hay C# trong project này.

## 0. Cách đọc evidence và phạm vi

- Đường dẫn dưới đây là file thật trong repository. `backend/.env` và `token.json` được giữ kín, không trích giá trị; cấu hình được giải thích từ source và `.env.example`. `docs/render-deployment.md` tự ghi deployment Render **chưa được xác minh**. Không có truy cập database hay dịch vụ ngoài trong đợt phân tích này.
- `[Đã có]` nghĩa là source chứa route/service/UI liên kết; không tự động khẳng định đã chạy production. `[Một phần]` nghĩa là có thiếu sót/điều kiện cấu hình. `[Chưa dùng]` chỉ dependency/API có mặt nhưng không tìm thấy đường gọi thực tế. `[Chưa xác nhận]` dùng khi source không đủ chứng cứ.
- Các đoạn `Why` là **lý do kỹ thuật suy ra từ cấu trúc**, không phải lời kể lịch sử của tác giả. Khi không có bằng chứng về ý định hoặc bug đã xảy ra, không khẳng định đã xảy ra.

## 1. Project overview và mental model đầu tiên

**Mục tiêu:** hệ thống vận hành nhà hàng: quản trị bàn/QR, menu, gọi món theo bàn, giỏ hàng chung theo phiên ăn, màn hình bếp và phục vụ, thanh toán VNPAY, hóa đơn, đánh giá và phân tích. Người dùng: khách quét QR; nhân viên bếp (`kitchen`), phục vụ (`waiter`), quản trị (`admin`). Evidence: `frontend/src/App.tsx`, `backend/src/modules/schemas.module.ts`, `backend/src/modules/order/order.controller.ts`, `backend/src/modules/vnpay/vnpay.controller.ts`.

```text
Khách / nhân viên trên React 19 (Vite)
  ├─ Axios HTTP → NestJS 11 Controller → injectable Service → Mongoose Model → MongoDB
  └─ Socket.IO ↔ AppGateway ↔ SessionService / các service phát sự kiện
                                    ├─ Cloudinary: ảnh món
                                    ├─ VNPAY: redirect + IPN thanh toán
                                    └─ OpenAI/Gemini/Groq: các tác vụ AI tùy cấu hình
```

MongoDB có thể chạy bằng `mongo:7` trong `docker-compose.yml`, hoặc URI cấu hình trỏ Atlas. Backend dùng Node 24; frontend được build thành static files và Dockerfile phục vụ bằng nginx. Có tài liệu hướng dẫn Render nhưng chưa xác nhận deploy thực. Evidence: `backend/package.json`, `frontend/package.json`, `backend/src/database/database.module.ts`, `docker-compose.yml`, hai `Dockerfile`, `docs/render-deployment.md`.

## 2. Technology stack: đang dùng ở đâu và trade-off

| Công nghệ | Source chứng minh / vai trò | Vì sao phù hợp; ưu điểm / trade-off; câu hỏi phỏng vấn |
|---|---|---|
| TypeScript + Node.js 24 | `backend/tsconfig.json`, `frontend/tsconfig.app.json`, Dockerfiles; cùng ngôn ngữ hai phía | DTO/type giúp đọc contract; type biến mất lúc chạy nên vẫn cần validation. Hỏi: compile-time type khác runtime validation? |
| NestJS 11 | `backend/src/main.ts`, `app.module.ts`, các `*.module.ts`; module, decorator, controller, DI | Tách HTTP và nghiệp vụ rõ; decorator/DI cần hiểu provider scope. Hỏi: module exports/imports hoạt động thế nào? |
| Mongoose 9 + MongoDB | `database.module.ts`, `*.schema.ts`, `@InjectModel` trong services | Document phù hợp session/cart và order item nhúng; cross-collection consistency cần transaction/thao tác bù, không có FK DB. Hỏi: `findOneAndUpdate` khác `save`? |
| class-validator + class-transformer | `main.ts` `ValidationPipe`, `modules/**/dto/*` | Chặn request không hợp lệ ở runtime; DTO không bao phủ payload Socket.IO. Hỏi: `whitelist`, `forbidNonWhitelisted`, `transform`? |
| Passport JWT + bcrypt | `auth.service.ts`, `jwt.strategy.ts`, `user.service.ts` | Stateless access 15 phút, refresh 7 ngày lưu hash; access token khó thu hồi tức thì. Hỏi: kiểm tra refresh token và logout thế nào? |
| React 19 + React Router 7 | `frontend/src/main.tsx`, `App.tsx` | UI theo vai trò, component/hook; trạng thái cục bộ đơn giản nhưng `CustomerMenu` lớn. Hỏi: route guard có thay backend authorization không? |
| Vite 8 + Tailwind CSS 4 | `vite.config.ts`, `index.css` | Build SPA nhanh, token CSS ở `@theme`; URL API được đóng vào build. Hỏi: env `VITE_` là bí mật được không? |
| Axios | `frontend/src/services/api/axios-client.ts` | Một nơi thêm Bearer và refresh; queue giảm refresh song song. Hỏi: interceptor xử lý 401 thế nào? |
| Socket.IO | `backend/src/gateway/app.gateway.ts`, `CustomerMenu.tsx`, `KitchenDisplay.tsx` | Phát cart/order/table theo thời gian thực; room authorization hiện yếu, cần scale adapter nếu nhiều instance. Hỏi: room khác authentication ra sao? |
| VNPAY + Node crypto | `vnpay.service.ts`, `payment-intent.schema.ts` | IPN có HMAC và transaction; phụ thuộc sandbox/callback. Hỏi: browser return có thể đánh dấu Paid không? |
| Cloudinary + Multer | `dish.controller.ts`, `cloudinary.service.ts` | Ảnh không phụ thuộc disk backend; thao tác upload/xóa DB cần xử lý lỗi liên dịch vụ. Hỏi: file validation ở đâu? |
| QRCode + PDFKit | `table.service.ts`, `order/invoice.service.ts` | QR mở menu theo bàn; PDF hóa đơn từ snapshot. Hỏi: vì sao lưu snapshot giá? |
| OpenAI HTTP, `@google/genai`, Groq HTTP | `ai/providers/*`, `ai-orchestrator.service.ts` | Structured output, timeout/retry/audit; chi phí, độ trễ và độ tin cậy là trade-off. Hỏi: AI được phép truy cập DB như thế nào? |
| Recharts + lucide-react | `AdminDashboard.tsx`, nhiều component UI | Biểu đồ và icon; tăng bundle nếu import đồng bộ. Hỏi: biểu đồ lấy số liệu từ đâu? |
| Jest/Supertest, Node test | `backend/package.json`, `backend/test/*.e2e-spec.ts`, `frontend/test/order-progress.test.mjs` | Có unit/integration/e2e và browser smoke script; chưa chạy trong lần phân tích. Hỏi: unit test khác e2e? |

`@nestjs/serve-static` có trong `backend/package.json` nhưng `app.module.ts` ghi rõ đã bỏ `ServeStaticModule`; backend `socket.io-client` chỉ thấy trong `backend/test-scripts`, không thấy import trong runtime `backend/src`. `reflect-metadata`/`rxjs` là phần phụ thuộc nền Nest; không gán feature riêng khi chưa có usage cụ thể. Evidence: `backend/package.json`, `backend/src/app.module.ts`, `backend/test-scripts/socket-client.js`.

## 3. Architecture thực tế và trách nhiệm

Đây là **modular layered application** theo feature: `Controller` nhận HTTP và guard; `Service` xử lý quy tắc; service inject trực tiếp `Mongoose Model`; schema xác định document/index; gateway xử lý realtime; frontend có page/component và API service. Ví dụ `OrderController → OrderService → @InjectModel(Order.name) Model<OrderDocument>`. Không có lớp repository/interface cho CRUD hay EF Core `DbContext`, không đủ evidence gọi Clean Architecture/Repository Pattern toàn hệ thống. Riêng AI dùng interface `AiProvider` + token `AI_PROVIDER` + resolver, là abstraction có chứng cứ. Evidence: `backend/src/modules/order/order.module.ts`, `order.service.ts`, `backend/src/modules/ai/providers/ai-provider.interface.ts`, `backend/src/modules/ai/ai.module.ts`.

DI Nest: `@Module` khai báo imports/providers/exports, `@Injectable` mặc định singleton trong application context khi không chỉ định scope; `@InjectModel` cung cấp Model do `MongooseModule.forFeature`. `forwardRef` giải quyết vòng tham chiếu `SessionModule ↔ GatewayModule`; đây cũng là dấu hiệu coupling. Không thấy provider `Scope.REQUEST` hay `Scope.TRANSIENT`. Không nên áp các tên Scoped/Singleton/Transient của ASP.NET vào code này theo nghĩa `AddScoped`. Evidence: `session.module.ts`, `gateway/gateway.module.ts`, `modules/ai/ai.module.ts`.

DTO có cả request validation class (`CreateOrderDto`) và response object/type, không phải mọi response đều có class riêng. `SessionService.toCartResponse`, `OrderService.createCustomerOrder`, `UserService.toResponse` tự map; một số CRUD trả Mongoose document (`DishService`, `CategoryService`). Lợi ích DTO: giới hạn dữ liệu nhạy cảm, tách API khỏi schema và đảm bảo input; trade-off là mapping lặp và contract chưa nhất quán. Evidence: `backend/src/modules/order/dto/create-order.dto.ts`, `session/session.service.ts`, `user/user.service.ts`.

Pattern khác có chứng cứ: state machine (`order-state-machine.service.ts`), strategy/provider (`ai/providers`), adapter API Axios (`frontend/src/services/api`), route guard (`RequireRole.tsx`), snapshot/transaction (`payment-intent.schema.ts`, `vnpay.service.ts`), event gateway (`app.gateway.ts`). Không có React Context/Redux/provider state trong `frontend/src`; state chủ yếu là `useState`, refs, hooks và localStorage.

## 4. Project structure

```text
/
├─ backend/
│  ├─ src/main.ts; app.module.ts; app.controller.ts; app.service.ts
│  ├─ src/database/           Mongo connection
│  ├─ src/common/             enum, guard, decorator, config, embedded schemas, receipt
│  ├─ src/gateway/            Socket.IO gateway/module
│  ├─ src/modules/
│  │  ├─ auth, user, table, category, dish, cloudinary
│  │  ├─ menu, session, order, promotion, vnpay, invoice, review, admin
│  │  └─ ai/                 orchestrator, providers, prompt, AI features, audit
│  ├─ test/; scripts/; assets/fonts/; Dockerfile; package*.json
├─ frontend/
│  ├─ src/main.tsx; App.tsx; index.css
│  ├─ src/config/; src/services/api/; src/components/
│  ├─ src/features/{auth,admin,staff,kitchen,waiter,menu,payment}/
│  ├─ test/; scripts/; public/; Dockerfile; vite.config.ts; package*.json
├─ docker-compose.yml; README.md; docs/ (định hướng/xác minh)
└─ PROJECT_DEEP_DIVE.md
```

`backend/src/modules/schemas.module.ts` gom các domain module; module khác import/export provider để dùng chéo. `backend/test` chứa HTTP e2e; `*.spec.ts` cạnh source kiểm thử unit; `scripts` chứa seed/evaluation, **không chạy để phân tích**. `frontend/features` tổ chức theo màn hình, `services/api` là contract HTTP, `components/ui.tsx` là shared UI. `frontend/public` là static asset. `dist`, `coverage`, `node_modules`, `test-results` là artifact/dependency, không phải source kiến trúc. Evidence: cây file và các file module/package tương ứng.

## 5. Important files — bản đồ mở code

| File | Responsibility; classes/functions; dependencies → used by; input → processing → output; interview note |
|---|---|
| `backend/src/main.ts` | `bootstrap`: nạp env, production secret check, NestFactory, CORS, Helmet, HTTP rate limit, ValidationPipe, listen. Input env/request → middleware → Nest app. Nói thứ tự global middleware/pipe. |
| `backend/src/app.module.ts` | `AppModule` import Config/Database/Schemas/Gateway/AI/VNPAY/...; root composition. `main.ts` dùng. Nói Nest module thay vì `Program.cs`. |
| `backend/src/app.service.ts`, `app.controller.ts` | `GET /health` trả trạng thái đơn giản; ở non-production khi DB rỗng, bootstrap tạo admin mặc định và log credential. Nói rõ đây là rủi ro, không lặp lại credential. |
| `backend/src/database/database.module.ts` | `DatabaseModule`, `MongooseModule.forRootAsync(MONGODB_URI)`, connection logger. Các Model provider dùng connection. Nói MongoDB, không có `DbContext`. |
| `backend/src/modules/auth/{auth.controller,auth.service,jwt.strategy}.ts` | Login/register/refresh/logout/me; `AuthService` dùng `UserService`, `JwtService`, `ConfigService`; request DTO → bcrypt/JWT/hash refresh → token/user JSON. Nói access/refresh riêng. |
| `backend/src/common/guards/{jwt-auth,roles}.guard.ts` + `roles.decorator.ts` | JWT Passport và metadata role; các protected controller dùng. Input Bearer → `req.user` → 401/403 hoặc vào handler. |
| `backend/src/modules/user/{user.schema,user.service,user.controller}.ts` | `User`, CRUD quản lý nhân viên và hash; `AuthService` dùng UserService; admin dùng `/users`. Input `CreateUserDto` → hash/save → `UserResponse`. |
| `backend/src/modules/table/{table.schema,table.service,table.controller}.ts` | `Table`, QR, clear table; admin/waiter UI. Input table DTO → QR URL theo ObjectId → Mongoose document. Bàn trỏ `currentSessionId`. |
| `backend/src/modules/category/*`, `dish/*`, `cloudinary/*` | Danh mục/món, metadata, upload ảnh; admin UI và menu. `DishService` dùng `CloudinaryService`, `Model<Dish>`; trả document. Nói validate file + DB schema. |
| `backend/src/modules/session/{session.schema,session.service,session.controller}.ts` | Phiên ăn/giỏ chung/merge/move/unmerge; gateway, order, promotion, waiter dùng. Input table/session ID → atomic update/transaction → cart/session view. Đây là service phức tạp nhất. |
| `backend/src/gateway/app.gateway.ts` | `AppGateway`, rooms, `cart:add/update/remove`, waiter call, broadcast. Frontend socket dùng. Input event → SessionService → `cart:synced`/`order:updated`. Lưu ý security room. |
| `backend/src/modules/order/{order.schema,order.controller,order.service,order-state-machine.service}.ts` | Tạo Order từ cart, danh sách bếp/phục vụ, chuyển trạng thái. Mongoose models/Promotion/Session/Gateway. Input `CreateOrderDto` → snapshot/DB → response. |
| `backend/src/modules/promotion/*` | Preview, reserve atomic usage, discount snapshot; order tạo dùng. Input code/subtotal → mức giảm/tổng. |
| `backend/src/modules/vnpay/{vnpay.controller,vnpay.service,payment-intent.schema}.ts` | Tạo URL, return, IPN, thanh toán theo Session. Input `CreatePaymentUrlDto`/callback → HMAC/transaction → PaymentIntent/Order Paid → status/PDF. |
| `backend/src/modules/invoice/invoice-lookup.service.ts`, `order/invoice.service.ts` | Lookup code, kiểm tra snapshot, render PDFKit; admin/customer dùng. Input invoice code/intent → PDF blob. |
| `backend/src/modules/review/*`, `admin/*` | Review sau Paid; dashboard aggregation MongoDB; admin/AI tools dùng. Input rating/date → Review/aggregation → JSON. |
| `backend/src/modules/ai/{ai.module,ai.config,ai-orchestrator.service}.ts` | Provider interface/resolver, timeout/retry/structured validation/audit; từng AI feature dùng. Input prompt + schema → validated result hoặc `AiError`. |
| `backend/src/modules/ai/{menu-search,order-note,catalog-draft,admin-analytics,review-intelligence}/` | Feature AI chuyên biệt; prompt registry + orchestrator + dữ liệu backend giới hạn → response/warnings. `review-intelligence` enrich tối đa 5 review/lần. |
| `frontend/src/main.tsx`, `App.tsx` | StrictMode → App/BrowserRouter → routes; `RequireRole` bọc staff/admin. Nói `/menu` và `/payment-result` public. |
| `frontend/src/config/api-url.ts`, `services/api/axios-client.ts` | Base URL và Bearer/refresh interceptor/queue/logout local. Các API service dùng. Input request → Axios → response `data`/error. |
| `frontend/src/services/api/{auth,menu,order,session,payment,ai}.ts` | Hàm typed gọi endpoint; pages import. Nói đây là client layer, không phải repository DB. |
| `frontend/src/features/menu/CustomerMenu.tsx` | QR/tableId, menu, cart socket, promotion, order, payment, note/review/search/recommendation; nhiều state/ref. Input thao tác khách → API/socket → UI. |
| `frontend/src/features/kitchen/KitchenDisplay.tsx`, `waiter/WaiterDashboard.tsx` | Bếp lấy món Pending/Preparing; waiter lấy Ready, bàn, merge/move/clear; socket kích hoạt reload. |
| `frontend/src/features/admin/{AdminLayout,AdminDashboard,TableManager,DishManager,UserManager}.tsx` | Admin navigation, biểu đồ, CRUD; dùng API layer và local state. `AnalyticsCopilot`, `ReviewIntelligence`, `DishAiDraft` là UI AI con. |
| `frontend/src/features/payment/PaymentResult.tsx` | Sau redirect VNPAY: socket/status check, hiển thị pending/paid/failed, tải PDF. Nói IPN mới có quyền đổi Paid. |

## 6. Application startup

**Backend:** `main.ts` nạp `dotenv/config`, tùy `CUSTOM_DNS_SERVERS` đổi DNS resolver, kiểm tra JWT secret ở `NODE_ENV=production` → `NestFactory.create(AppModule)` → `ConfigModule.forRoot` + `DatabaseModule` kết nối Mongo → các module đăng ký controller/provider/schema → `enableCors` → Helmet → HTTP rate limit 100000/15 phút → global `ValidationPipe` (`whitelist`, reject extra field, transform) → `listen(PORT)` mặc định 3000. Nest lifecycle khi bootstrap còn chạy `AppService.onApplicationBootstrap` (seed admin chỉ non-production nếu rỗng) và `AbandonedSessionCleanupService.onApplicationBootstrap` (dọn Session cũ); thứ tự giữa các hook không nên suy ra từ chuỗi import. Nest guard chạy cho route được gắn `@UseGuards`, không phải global. Error mặc định theo Nest exception layer; không thấy custom global exception filter. Evidence: `main.ts`, `app.module.ts`, `app.service.ts`, `database.module.ts`, `session/abandoned-session-cleanup.service.ts`.

**Frontend:** `index.html` root → `main.tsx` `createRoot`/`StrictMode` → `App.tsx` `BrowserRouter` + `RouteFocus` → route `/login`, `/menu`, `/payment-result`, `/admin/*`, `/kitchen`, `/waiter` → `AdminLayout`/`StaffLayout` + page. Route `RequireRole` chỉ đọc `localStorage.user.role`; quyền thật được backend guard kiểm tra. Không có app-wide auth Context/theme Context. Evidence: `frontend/index.html`, `src/main.tsx`, `src/App.tsx`, `src/components/RequireRole.tsx`.

## 7. Request lifecycle: sáu flow có thể kể ở phỏng vấn

| Flow | Frontend → HTTP/socket → backend → DB → response/UI |
|---|---|
| Đăng nhập | `Login.tsx` → `authApi.login` `POST /auth/login` `{email,password}` (`LoginDto`) → `AuthController.login` → `AuthService.validateUser/generateTokens` → `UserService.findByEmailWithPassword/updateRefreshToken` → `users` → `{accessToken,refreshToken,user}` → localStorage/navigate theo role. Sai thông tin: 401 → Feedback. |
| Mở QR và giỏ chung | `CustomerMenu.tsx` → `GET /menu?tableId&lang` (`GetMenuDto`) → `MenuService` → `tables/categories/dishes` → menu JSON; đồng thời `GET /sessions/active?tableId` (`GetActiveSessionDto`) → `SessionService.getOrCreateActiveSession` → `tables/sessions/orders` → cart/session JSON. Sau đó `cart:join`, `cart:add` qua Socket.IO → `AppGateway` → `SessionService.addToCart` atomic update `sessions.cart` → `cart:synced` → React state. Socket event **không phải HTTP endpoint/DTO class**. |
| Tạo đơn + giảm giá | `CustomerMenu.submitOrder` → `menuApi.createOrder` `POST /orders` (`CreateOrderDto`: `tableId`, optional `promotionCode`, `note`) → `OrderController.create` → `OrderService.createCustomerOrder` → `PromotionService` + `SessionService.consumeCartForOrder` + Dish/Order/Table models → `sessions`, `dishes`, `orders`, `promotions`, `tables` → object `{orderId,sessionId,status,subtotalAmount,discountAmount,totalAmount,...}` → `refreshPaymentSummary`, thông báo; gateway phát `cart:synced`/`order:updated`. |
| Bếp → phục vụ | `KitchenDisplay`/`WaiterDashboard` → `orderApi.transitionItem` `PATCH /orders/:orderId/items/:itemId/status` (`TransitionOrderItemDto`) → JWT + RolesGuard → `OrderStateMachineService.transitionItem` → `orders.items/statusHistory`, có thể `tables.status` → Order document → gateway `order:updated` → page reload list. Bếp: Pending→Preparing→Ready; waiter: Ready→Served; khi tất cả Served, order Served. |
| Thanh toán và hóa đơn | `CustomerMenu` → `POST /vnpay/create-payment-url` (`CreatePaymentUrlDto`: `sessionId`,`tableId`) → `VnpayService.createPaymentUrl` → `orders/sessions/tables/payment_intents` → `{paymentUrl,txnRef,amount,coveredOrderIds}` → redirect. VNPAY gọi `GET /vnpay/ipn` → verify HMAC/amount → transaction `PaymentIntent` + nhiều `Order` Paid → socket `session:payment-updated`; `/vnpay/return` chỉ redirect sang `PaymentResult`, page gọi `GET /vnpay/payment-status` và `GET /vnpay/session-invoice` để lấy PDF. |
| Đánh giá và AI insights | `ReviewFeedback.tsx` → `POST /reviews` (`CreateReviewDto`) → `ReviewService.create` xác minh order thuộc session và Paid → `reviews` → review response/UI cảm ơn. `ReviewIntelligence.tsx` → admin `POST /ai/admin/review-insights/analyze` (batch tối đa 5) và `GET ...`/`POST .../summary` → `ReviewIntelligenceService` + `AiOrchestratorService` → `reviews.aiInsight`/aggregation → facts/warnings/chart. |

Không có repository riêng trong các flow; mũi tên từ service đi thẳng tới injected Mongoose `Model`. Một request đọc điển hình khác: `AdminDashboard` → `adminApi.getRevenue` → `GET /admin/analytics/revenue` → `AdminController` → `AdminService.getRevenue` → Mongo `$match/$group/$sort` trên `orders` → `RevenuePoint[]` → Recharts. Evidence: các page/API/controller/service/schema nêu trong bảng.

## 8. Main features: trạng thái, lỗi và UI

| Feature / trạng thái | Page → API/event → xử lý/collection → UI và lỗi |
|---|---|
| Login nhân viên **[Đã có]** | `Login` → `POST /auth/login` → Auth/User → `users`; lưu token, chuyển role; Feedback khi lỗi. |
| Quản lý user **[Đã có]** | `UserManager` → `/users` CRUD → UserController/Service → `users`; reload list, thông báo lỗi. `POST /auth/register` admin cũng có nhưng UI dùng `/users`, nên route này **[chưa dùng trực tiếp bởi UI]**. |
| Quản lý bàn/QR **[Đã có]** | `TableManager` → `/tables` CRUD, `/regenerate-qr`, `/clear` → TableService → `tables/sessions/orders`; reload + success/error. |
| Danh mục/món/ảnh/metadata **[Đã có]** | `CategoryManager`, `DishManager`, `DishAiDraft` → `/categories`, `/dishes`, `/dishes/metadata-options`, `POST /ai/admin/dish-draft` → Category/Dish/Cloudinary/AI → `categories/dishes`; reload form/list, lỗi hiển thị. AI draft là đề xuất cho form, không tự lưu món. |
| Menu QR song ngữ **[Đã có]** | `CustomerMenu` → `/menu`; `MenuService` lọc category active/dish available, fallback tên tiếng Việt; render menu/error. |
| Giỏ hàng chung/realtime **[Đã có]** | `CustomerMenu` → `cart:*` Socket.IO → Gateway/SessionService → `sessions.cart`; `cart:synced` cập nhật UI, `cart:error` hiện lỗi. |
| Order + bếp + phục vụ **[Đã có]** | `CustomerMenu` `/orders`; `KitchenDisplay`/`WaiterDashboard` GET/PATCH `/orders` → OrderService/StateMachine → `orders/tables`; socket reload, lỗi từng page. Customer cancel route có trong backend `PATCH /orders/:id/cancel` nhưng **[chưa thấy nút UI gọi]**. |
| Chuyển/ghép/tách bàn **[Đã có]** | `WaiterDashboard` → `/sessions/table-operation-options`, `/:id/move-table`, `/merge-tables`, `/unmerge` → SessionService transaction → `tables/sessions/orders`; reload/success/error. `/sessions/merge` là endpoint tương thích cũ **[chưa thấy UI gọi]**. |
| Gọi phục vụ **[Đã có]** | `CustomerMenu` `waiter:call` → Gateway cooldown 30s → room waiter/admin; `WaiterDashboard` giữ danh sách cuộc gọi trong state, clear tại client. Lỗi Socket.IO qua `waiter:call:error`. |
| Khuyến mãi **[Đã có]** | `PromotionManager` CRUD `/promotions`; `CustomerMenu` `POST /promotions/preview`; OrderService reserve usage → `promotions/orders`; preview/discount/feedback. |
| Thanh toán VNPAY + PDF + tra cứu **[Đã có, cần cấu hình ngoài]** | `CustomerMenu`/`PaymentResult`/`InvoiceLookup` → `/vnpay/*`, `/admin/invoices/*` → Vnpay/Invoice → `payment_intents/orders`; status, PDF, lỗi. Giao dịch live/IPN thực **⚠️ Chưa thể xác nhận từ source code hiện tại.** |
| Review khách **[Đã có]** | `ReviewFeedback` → `/reviews` → ReviewService → `reviews`; đánh giá sau Paid, một review/dish/order, lỗi UI. |
| Dashboard số liệu **[Đã có]** | `AdminDashboard` → `/admin/analytics/*` → AdminService aggregation → `orders/reviews/tables`; Recharts và lỗi tải. |
| AI tìm menu/ghi chú/recommendations **[Đã có, AI tùy config]** | `MenuSearch`, `OrderNotePreview`, `MenuRecommendations` → `/ai/menu/search`, `/ai/order-notes/analyze`, `/menu/recommendations`; fallback tìm text và thuật toán recommendation dùng DB; warning/error UI. |
| AI analytics/dish draft/review intelligence **[Đã có, AI tùy config]** | `AnalyticsCopilot`, `DishAiDraft`, `ReviewIntelligence` → `/ai/admin/*` → orchestrator/provider + DB facts; giới hạn output và warning. `AI_ENABLED=false` mặc định trong `.env.example`; trạng thái thực tế của backend đang chạy **⚠️ Chưa thể xác nhận từ source code hiện tại.** |

**API/code chưa thấy đường gọi từ UI/runtime:** `authApi.registerStaff`, `authApi.logout`, `authApi.getProfile` chỉ định nghĩa ở frontend API layer; `OrderService.generateInvoice` và single-order `OrderStateMachineService.transition` không thấy caller trong `backend/src` (luồng thanh toán dùng `transitionManyToPaid`); `POST /sessions/merge` giữ compatibility; customer/admin cancel routes có backend nhưng không thấy UI gọi. Điều này không chứng minh chúng hoàn toàn vô dụng với client ngoài hoặc test. Evidence: `frontend/src/services/api/auth.ts`, `backend/src/modules/order/{order.service,order-state-machine.service}.ts`, `session.controller.ts`, `order.controller.ts`.

## 9. Authentication & authorization thật

```text
POST /auth/login → UserService tìm email +passwordHash → bcrypt.compare
→ AuthService ký access JWT (15m), refresh JWT (7d), hash refresh lưu User
→ Login.tsx lưu accessToken/refreshToken/user trong localStorage
→ Axios interceptor thêm Authorization: Bearer accessToken
→ Passport JwtStrategy verify chữ ký/hạn → req.user {id,email,role,fullName}
→ RolesGuard đọc @Roles → controller/service
401 → Axios gọi POST /auth/refresh với refresh token
→ service decode lấy sub, verify refresh secret, bcrypt.compare hash → rotate cả hai token
```

`POST /auth/register` chỉ admin; quản lý tài khoản khác qua admin `/users`. `POST /auth/logout` xóa refresh hash ở DB nhưng UI `handleLogout` chỉ xóa localStorage, không gọi endpoint này; access JWT vẫn hợp lệ đến khi hết hạn. `authApi.logout` và `getProfile` có hàm nhưng không thấy page gọi. Role được lưu trong JWT; `JwtStrategy.validate` không truy vấn lại `User` mỗi request, nên đổi role/vô hiệu user không lập tức vô hiệu access token. `RequireRole` chỉ bảo vệ giao diện, còn quyền API ở `JwtAuthGuard`/`RolesGuard`. Các route khách public dùng ID phiên/bàn như capability, không có staff JWT. Evidence: `auth.controller.ts`, `auth.service.ts`, `jwt.strategy.ts`, `frontend/src/services/api/{auth,axios-client}.ts`, `RequireRole.tsx`.

Refresh chỉ lưu **một** refresh hash/user: login khác sẽ thay hash cũ. Trong `refreshTokens`, nếu verify token thất bại thì hash của user được xóa; vì `sub` được decode trước khi verify, một token sai chữ ký nhưng chứa `sub` hợp lệ có thể gây từ chối refresh cho user đó (availability risk). Không nhầm decode với verify. Evidence: `auth.controller.ts`, `auth.service.ts`, `user.service.ts`.

## 10. Database: documents, quan hệ và constraints

MongoDB/Mongoose sinh `_id: ObjectId` cho collection; đây **không phải SQL table/foreign key thực thi ở DB**. `ref` là tham chiếu mức application/Mongoose. `@Schema({timestamps:true})` thêm `createdAt/updatedAt`. Không có migration EF Core, Fluent API, cascade delete/Restrict/NoAction kiểu SQL hay soft delete chung. `isActive/isAvailable` là flag riêng; Category/Dish/User delete dùng hard delete. Evidence: các `*.schema.ts`, `category.service.ts`, `dish.service.ts`, `user.service.ts`.

| Collection/entity | Mục đích, PK, trường chính | Quan hệ và index |
|---|---|---|
| `users`/User | nhân viên; `_id`; fullName,email,passwordHash,refreshTokenHash,role,isActive | email unique; `{role,isActive}` index. Hash `select:false`. |
| `tables`/Table | bàn/QR; `_id`; tableCode,status,qrCodeUrl,currentSessionId,groupedWithTableIds,capacity,merge lock | tableCode unique; refs Session/Table; index status,currentSessionId. |
| `categories`/Category | nhóm món; `_id`; name,nameEn,sortOrder,isActive | index `{isActive,sortOrder}`, name. |
| `dishes`/Dish | món; `_id`; name,price,categoryId,imageUrl,isAvailable,allergen/dietary/spice/ingredients/modifiers | ref Category; index `{categoryId,isAvailable}`, text name. |
| `sessions`/Session | phiên ăn/giỏ; `_id`; tableId,tableIds,status,cart,version,lastActivityAt,merge snapshots | refs Table/Dish/Session; compound index table/status, tableIds/status, status/lastActivityAt, mergedIntoSessionId. CartItem là subdocument. |
| `orders`/Order | mỗi lượt gọi món; `_id`; sessionId,tableId,items,status,subtotal/discount/total,promotionCode,paidAt | refs Session/Table; Item nhúng snapshot Dish + statusHistory; index `{tableId,status,createdAt}`, `{sessionId,createdAt}`, `{status,createdAt}`. |
| `promotions`/Promotion | mã giảm; `_id`; code,type,value,date range,usageLimit,usedCount | code unique; atomic `usedCount`. |
| `payment_intents`/PaymentIntent | snapshot checkout; `_id`; invoiceCode,txnRef,coverageKey,sessionId,tableId,coveredOrderIds,amount,status,expiresAt | refs Session/Table/Order; unique txnRef; invoiceCode unique partial; coverageKey unique khi Pending; status/expiresAt index. |
| `reviews`/Review | đánh giá món đã Paid; `_id`; orderId,dishId,tableId,sessionId,rating,comment,aiInsight | refs Order/Dish/Table/Session; unique `{orderId,dishId}`; `{dishId,createdAt}`, paging index. |
| `ai_interactions`/AiInteraction | audit metadata AI; `_id`; feature,provider,model,promptVersion,latency,tokens,success,errorCode,createdAt | index `{feature,createdAt}`, `{success,createdAt}`; không lưu raw prompt/secret. |

```text
Category 1 ── many Dish
Table many ↔ Session (một Session có thể ghép nhiều Table; Table.currentSessionId trỏ phiên hiện tại)
Session 1 ── many Order; Session chứa nhiều CartItem subdocument
Order 1 ── many OrderItem subdocument; OrderItem tham chiếu Dish + snapshot tên/giá
Session 1 ── many PaymentIntent; PaymentIntent chứa nhiều coveredOrderIds
Order 1 ── many Review; Dish 1 ── many Review; unique (Order,Dish)
Session ↔ Session qua mergedFromSessionIds/mergedIntoSessionId
```

`OrderItem.statusHistory`, `Order.statusHistory`, `Review.aiInsight`, `OrderNoteAnalysis` là embedded documents; không phải collection riêng. Index có thể tăng tốc đọc nhưng tốn chi phí ghi/bộ nhớ. Không có DB-enforced FK/cascade: xóa Dish/Category có thể để ref lịch sử, Order snapshot vẫn giữ thông tin lúc đặt. Việc xử lý dữ liệu orphan khi xóa **⚠️ Chưa thể xác nhận từ source code hiện tại.** Evidence: `order.schema.ts`, `review.schema.ts`, `session.schema.ts`, `table.schema.ts`.

## 11. ORM/ODM và truy vấn: điều có và không có

Project dùng **Mongoose ODM**: `MongooseModule.forRootAsync` tương đương khái niệm kết nối, `forFeature` đăng ký model; `Model.find/aggregate/findOneAndUpdate/save` là API thật. `DishService.findAll().populate('categoryId')` tải ref; `MenuService.getSearchCatalog().lean()` trả plain object không cần hydrate document; `AdminService.getRevenue()` dùng Mongo aggregation `$match/$group/$sort`. `SessionService.addToCart()` dùng atomic `$inc` và compare-and-set; merge/unmerge dùng `Connection.startSession().withTransaction`. `VnpayService.handleIpn` dùng `connection.transaction` để cập nhật Intent và nhiều Order. Evidence: các service nêu trên.

Với .NET: `DbContext/DbSet`, LINQ, `Include`, `AsNoTracking`, `SaveChangesAsync`, `Migration`, `Fluent API`, Change Tracking của EF Core **không xuất hiện trong project**. Có thể liên hệ `populate` với tải navigation, `lean` với query chỉ đọc, `save` với persist document, nhưng **không đồng nhất cơ chế**. Mongoose `unique` dựa vào Mongo index, `ref` không bảo đảm FK. Query đáng chú ý: `MenuService.getPublicMenu()` lọc toàn bộ dishes cho từng category trong memory (O(C×D)); `DishService.findAll` không pagination; `OrderService.listForKitchen/Waiter` đọc danh sách không limit nhưng batch-load table/session tránh N+1 rõ ràng. `ReviewIntelligenceService.sources` có page 20. Evidence: `menu.service.ts`, `dish.service.ts`, `order.service.ts`, `review-intelligence.service.ts`.

## 12. DTO và dữ liệu qua biên API

```text
HTTP body → ValidationPipe → CreateOrderDto → OrderService → Order/OrderItem snapshot → MongoDB
MongoDB → Mongoose document → service map object → JSON → Axios `response.data` → React state
```

`CreateOrderDto` không nhận item/price: server lấy cart và giá từ DB, giảm nguy cơ client sửa giá. `CreatePaymentUrlDto` không nhận amount: server tự tính `payableTotal`. `CreateReviewDto` validate ID/rating nhưng service vẫn phải xác minh order thuộc session và Paid. `UserResponse` không trả passwordHash. Một số CRUD trả Entity document trực tiếp, có nguy cơ lộ field mới hoặc coupling với schema; `passwordHash`/`refreshTokenHash` được `select:false` nhưng nên giữ response contract rõ. Evidence: `order/dto/create-order.dto.ts`, `vnpay/dto/create-payment-url.dto.ts`, `review/dto/create-review.dto.ts`, `user/user.service.ts`, `dish/dish.service.ts`.

## 13. Async/await, DI và error handling

I/O bound thực tế: `await bcrypt.compare/hash`, `await Model.find(...).exec()`, `await order.save()`, `await axiosClient.get/post`, `await cloudinary` stream, `await fetch` AI. `Promise.all` dùng để ghép truy vấn độc lập ở `AdminService.getOverview`/`CustomerMenu.loadMenu`; không dùng song song operation trên cùng Mongo transaction (`SessionService.mergeTables` ghi rõ hạn chế). Node event loop không bị chặn khi đang chờ I/O; `async` không làm query nhanh hơn mà giúp phục vụ nhiều request. Không có `Task<T>`, `ToListAsync`, `FirstOrDefaultAsync`, `SaveChangesAsync` C#/EF Core. Evidence: `admin.service.ts`, `session.service.ts`, `frontend/src/features/menu/CustomerMenu.tsx`.

Lỗi trong service thường ném Nest `BadRequestException`/`NotFoundException`/`ForbiddenException`/`ConflictException` → Nest trả HTTP 400/404/403/409; guard trả 401/403; `ValidationPipe` trả 400. `VnpayService.handleIpn` trả `RspCode` cho provider. Frontend Axios reject → page `catch` lấy `response.data.message` hoặc fallback rồi render `Feedback`; 401 thử refresh, refresh thất bại xóa local auth và điều hướng login. Socket.IO có `cart:error`, `join:error`, `waiter:call:error`, tách khỏi HTTP errors. Không thấy global custom exception filter; nhiều `catch` cố ý bỏ lỗi gateway vì DB đã commit. Evidence: `main.ts`, `order.controller.ts`, `app.gateway.ts`, `axios-client.ts`, `CustomerMenu.tsx`, `vnpay.service.ts`.

## 14. Frontend architecture và frontend ↔ backend

`App.tsx` route đồng bộ (không thấy `React.lazy/Suspense`); layout qua `Outlet`; state per page qua `useState/useRef/useCallback/useMemo`, không Redux/React Context. `src/index.css` `@import 'tailwindcss'` + `@theme` token; `components/ui.tsx` tạo UI dùng chung, Lucide icon. `AdminDashboard` dùng Recharts. Client `API_URL` lấy `VITE_API_URL` lúc build; dev mặc định `http://localhost:3000`. Axios request interceptor đọc access token, response interceptor queue request 401 và refresh một lần. Socket.IO dùng cùng `API_URL` nhưng **không qua Axios interceptor**, nên không tự mang Bearer. Evidence: `frontend/src/{App.tsx,index.css,config/api-url.ts,services/api/axios-client.ts}`, `features/admin/AdminDashboard.tsx`, `features/menu/CustomerMenu.tsx`.

Một vòng đầy đủ: khách mở `/menu?tableId=...` → `menuApi.get()` → `GET /menu` → `MenuController` → `MenuService.getPublicMenu` → Mongoose `Table/Category/Dish` → menu JSON → `CustomerMenu.setMenu` → card món. Khi thêm món, socket `cart:add` → `AppGateway.addCartItem` → `SessionService.addToCart` → Mongo `sessions.cart` → gateway `cart:synced` → `setSharedCart` → UI giỏ. Đây là hai transport khác nhau trong cùng trang. Evidence: `frontend/src/services/api/menu.ts`, `backend/src/modules/menu/{menu.controller,menu.service}.ts`, `backend/src/gateway/app.gateway.ts`, `frontend/src/features/menu/CustomerMenu.tsx`.

## 15. Design patterns, SOLID và quyết định thiết kế

| Pattern có evidence | Ý nghĩa / áp dụng / lợi ích / trade-off |
|---|---|
| Controller–Service | `OrderController` nhận request, `OrderService` giữ logic. Dễ cô lập kiểm thử HTTP/logic; service Order/Session khá lớn. |
| Dependency Injection | Nest cung cấp `UserService`, Mongoose Model, AI provider. Đổi mock trong test dễ hơn; imports/forwardRef phải quản lý. |
| DTO + validation | `CreateOrderDto`, `CreateReviewDto` và global pipe; loại field thừa, rõ contract; Socket.IO còn cần validate riêng. |
| Strategy/Adapter ở AI | `AiProvider`, `AI_PROVIDER`, `AiProviderResolver`, OpenAI/Gemini/Groq; thay provider theo config, chi phí tăng do nhiều adapter và kiểm thử. |
| State machine | `OrderStateMachineService` quy định cạnh trạng thái; tránh controller tự đổi Order.status. Nhưng admin branch cho phép nhiều transition, cần kiểm soát thêm. |
| Snapshot | `OrderItem` lưu tên/giá, `PaymentIntent.coveredOrderIds/amount`, phục vụ hóa đơn/lịch sử ổn định; dữ liệu lặp và cần đồng bộ khi tạo. |
| Transaction/compare-and-set | `SessionService.mergeTables/unmergeSession`, `VnpayService.handleIpn`, cart `$inc`; giảm race, yêu cầu Mongo replica set và code phức tạp. |
| Event-based realtime | `AppGateway` phát `order:updated`, `cart:synced`, `tables:updated`; UI nhận rồi reload; dễ phát quá rộng và room thiếu quyền. |
| Provider/Context React | **Không thấy React Context Provider riêng**; `BrowserRouter` là router provider từ library. Không nên kể có Redux/Context quản lý auth. |
| Repository Pattern | **Không thấy repository implementation/interface tách khỏi service**; Mongoose Model là data access primitive, không tự gọi là Repository Pattern custom. |

**SOLID đánh giá theo evidence:** SRP: `AuthService` tách auth khỏi User CRUD; nhưng `SessionService` gánh cart, table merge, session lifecycle và dài ~49 KB, nên trách nhiệm rộng. OCP: thêm AI provider cần cập nhật `AiProviderResolver` switch và module, chỉ mở rộng một phần. LSP: `AiProvider` có 3 implementation cùng chữ ký `generateStructured`; unit tests provider hỗ trợ hợp đồng nhưng runtime behavior khác nhau, không khẳng định LSP hoàn hảo. ISP: `AiProvider` một method nhỏ; domain services không có interface, thiếu evidence áp rộng. DIP: orchestrator inject `AI_PROVIDER` abstraction; nhiều service khác inject trực tiếp Mongoose Models nên DIP chỉ thể hiện rõ ở AI. Evidence: `ai/providers/ai-provider.interface.ts`, `ai.module.ts`, `ai-orchestrator.service.ts`, `session.service.ts`, `order.service.ts`.

## 16. Security review

### Implemented well

- Password và refresh token được hash bcrypt; password/refresh hash `select:false`; access/refresh secret khác nhau; production yêu cầu cấu hình JWT secret. JWT Bearer, guard role ở admin/staff routes. Evidence: `user.schema.ts`, `user.service.ts`, `auth.service.ts`, `main.ts`.
- `ValidationPipe` reject field thừa; DTO xác thực `ObjectId`/enum/rating; `Helmet`, CORS allowlist; HTTP rate limit và rate limit 10/phút cho một số AI routes. File ảnh giới hạn 10 MB, MIME jpg/jpeg/png/gif/webp ở Multer. Evidence: `main.ts`, `common/config/public-urls.ts`, `ai/ai-rate-limit.ts`, `dish.controller.ts`.
- VNPAY kiểm tra HMAC SHA-512 bằng `timingSafeEqual`, so amount, dùng transaction/idempotency; browser return không tự đánh dấu Paid. `OrderNote` metadata có HMAC receipt ràng buộc session/dish/note/expiry. AI response qua schema + class-validator, audit chỉ metadata, search không cho AI tạo Mongo predicate. Evidence: `vnpay.service.ts`, `payment-intent.schema.ts`, `common/order-note-receipt.ts`, `ai-orchestrator.service.ts`, `menu-search-ai.service.ts`.
- Mongo query thông qua Model và DTO thay vì ghép raw SQL, nên **SQL injection không áp dụng**; NoSQL injection vẫn cần xem tại Socket.IO và các input không có DTO. React text interpolation mặc định escape, không thấy `dangerouslySetInnerHTML` trong `frontend/src`. Không đủ bằng chứng để tuyên bố miễn nhiễm mọi XSS. Evidence: source tương ứng.

### Potential risks (chỉ ghi nhận, không sửa)

- **Critical:** `AppGateway.joinRoom` chấp nhận tên room bất kỳ, `cart:join` chỉ cần `sessionId`; không có Socket.IO authentication/authorization. Client lạ có thể vào `admin`/`kitchen`/`waiter` hoặc `session:<id>`, xem event, và gọi `cart:add/update/remove` nếu biết session ID. CORS kiểm tra browser origin, không xác thực người dùng. Evidence: `backend/src/gateway/app.gateway.ts`, `common/config/public-urls.ts`.
- **High:** Public routes xem/mutate theo `tableId`/`sessionId` là capability dựa trên ID trong QR/response, không có chứng thực riêng. `POST /orders`, `PATCH /orders/:id/cancel`, `POST /reviews`, `/vnpay/*` dựa trên quan hệ ID. QR công khai có tableId; độ khó đoán ObjectId không thay quyền truy cập. Tấn công cụ thể cần biết session/order ID; không khẳng định đã khai thác. Evidence: `table.service.ts`, `session.controller.ts`, `order.controller.ts`, `review.service.ts`.
- **High:** `JwtStrategy.validate` chỉ kiểm claim, không lookup `isActive`/role hiện tại. Access token của user bị disable/delete hoặc đổi role còn hiệu lực tối đa 15 phút. Logout UI chỉ xóa localStorage, không gọi `/auth/logout`; server refresh hash có thể còn hợp lệ 7 ngày nếu bị lộ. Evidence: `jwt.strategy.ts`, `auth.service.ts`, `axios-client.ts`, `AdminLayout.tsx`, `StaffLayout.tsx`.
- **High:** `AuthController.refresh` decode `sub` trước verify; `AuthService.refreshTokens` clear refresh hash của user khi verify thất bại. Token giả có `sub` của user có thể vô hiệu refresh token đang lưu của user đó. Evidence: `auth.controller.ts`, `auth.service.ts`.
- **High:** `AppService.onApplicationBootstrap` tạo tài khoản admin mặc định với credential cố định khi **non-production** và DB chưa có user, rồi ghi credential vào log. Không trích credential vào tài liệu; rủi ro nếu môi trường public cấu hình sai `NODE_ENV`. Evidence: `app.service.ts`.
- **Medium:** token trong localStorage dễ bị lấy nếu XSS; route guard dựa vào user JSON local có thể bị sửa để vào UI nhưng API guard vẫn giữ quyền. Không dùng cookie nên CSRF truyền thống với cookie tự gửi giảm, nhưng không thể kết luận toàn bộ CSRF posture nếu có tích hợp khác. Evidence: `Login.tsx`, `axios-client.ts`, `RequireRole.tsx`.
- **Medium:** `dish.controller.ts` chỉ kiểm MIME header, chưa thấy magic-byte scan; file upload qua memoryStorage có giới hạn 10 MB nhưng nhiều request đồng thời tăng RAM. `DishService` xóa ảnh cũ trước khi update DB thành công. Evidence: `dish.controller.ts`, `dish.service.ts`.
- **Medium:** global rate limit 100000/15 phút quá cao cho login/checkout; AI middleware chỉ ở AI routes; Socket.IO waiter cooldown là Map theo process, có thể reset/multi-instance bypass. Evidence: `main.ts`, `ai/*module.ts`, `app.gateway.ts`.
- **Low/operational:** `VNPAY_DEBUG=true` log URL/thông số giao dịch và phần đầu/cuối secret đã mask; nên tránh ở production. `.env`/`token.json` được `.gitignore` bỏ qua, không kết luận bí mật chưa từng bị lộ ở nơi khác. Evidence: `vnpay.service.ts`, `.gitignore`.

### Recommended improvements (để thảo luận, không thực hiện)

1. Xác thực Socket.IO handshake và kiểm quyền trước `join`/`cart:*`; dùng scoped session capability có hạn dùng cho khách.
2. Ràng buộc customer action với chứng thực/nonce theo QR session; rate limit theo route/actor, thêm audit.
3. Refresh chỉ tác động user sau khi verify signature; revoke server-side khi logout, xem xét phiên/token version nếu cần thu hồi access sớm.
4. Không dùng credential mặc định trong môi trường có thể truy cập công khai; không log credential.
5. Kiểm byte signature ảnh; làm upload/DB update an toàn hơn; hạn chế log nhạy cảm.

## 17. Performance, quality và technical debt

**Backend:** có index cho truy vấn chính và aggregation tại Mongo (`AdminService`); `OrderService` batch-load bảng/session thay vì query từng order; `RecommendationService` cache lịch sử có TTL và giới hạn, sau đó đọc catalog mới; `ReviewIntelligenceService` batch 5 và sources page 20. Ngược lại `GET /dishes`, `/categories`, `/tables`, kitchen/waiter orders không có pagination/limit; menu load toàn bộ món khả dụng và `categories.map(...dishes.filter(...))` O(C×D); nhiều service trả document lớn. Index `status/createdAt` chưa chắc khớp `items.status` multikey query. Cần explain plan/metric để xác nhận bottleneck thực. Evidence: `admin.service.ts`, `menu.service.ts`, `recommendation.service.ts`, `review-intelligence.service.ts`, `dish.service.ts`, `order.service.ts`.

**Frontend:** `CustomerMenu.tsx` có nhiều state/effect/socket callback, file ~34 KB; `WaiterDashboard` ~21 KB; có nguy cơ rerender/coupling. Có `useMemo`, abort controller và coalescing request, nhưng route imports đều eager trong `App.tsx`, Recharts/AI pages có thể tăng initial bundle. Socket event thường reload toàn bộ list (`KitchenDisplay`, `WaiterDashboard`, `AdminDashboard`); event nhiều có thể gây API traffic, dù waiter/customer có coalescing ref ở vài chỗ. Ảnh menu dùng `loading="lazy"`. Chưa đo profiler/bundle nên **⚠️ Chưa thể xác nhận bottleneck runtime từ source code hiện tại.** Evidence: các page và `App.tsx`.

**Maintainability:** domain modules dễ định vị; DTO/test khá phong phú. Nhưng `SessionService` đa trách nhiệm, `CustomerMenu` lớn, response object không nhất quán, một số `any` trong Axios queue/auth controller, và vòng `forwardRef` làm test/refactor khó. CRUD Category/Table hard delete không kiểm ref, có thể để data mồ côi. `OrderStateMachineService.transitionItem` dùng read-modify-save, không có version compare-and-set rõ như payment path; hai staff thao tác cùng item có thể race. Evidence: `session.service.ts`, `CustomerMenu.tsx`, `axios-client.ts`, `auth.controller.ts`, `category.service.ts`, `table.service.ts`, `order-state-machine.service.ts`.

## 18. Bugs / risks có bằng chứng

| Severity | File/Area | Problem → impact | Recommendation (chỉ đề xuất) |
|---|---|---|---|
| Critical | `gateway/app.gateway.ts` | Room bất kỳ + cart mutation không auth; lộ staff event/cart, sửa giỏ nếu biết ID | Handshake auth, role/session authorization mỗi event. |
| High | `order/order.service.ts`, `session/session.service.ts` | `consumeCartForOrder` clear cart trước khi validate Dish/reserve promotion/save Order; lỗi sau đó làm mất cart. `catch` chỉ release promotion. | Checkout transaction hoặc restore cart có version guard. |
| High | `auth/auth.controller.ts`, `auth/auth.service.ts` | Refresh decode chưa verify; verify thất bại clear hash user, có thể gây logout cưỡng bức | Verify token trước mọi mutation, dùng subject từ verified payload. |
| High | `app.service.ts` | Non-production seed admin credential cố định và log credential | Provision thủ công/one-time secret, tránh public dev deployment. |
| High | `gateway/app.gateway.ts`, public customer controllers | ID từ QR/session là gần như quyền truy cập; không có customer authorization | Session capability ký/hạn dùng, scope per table/operation. |
| High | `docker-compose.yml`, `session.service.ts`, `vnpay.service.ts` | Mongo Compose chạy standalone (`mongo:7`, không replSet), còn merge/unmerge/IPN/cleanup cần transaction; các flow này có thể lỗi ở Compose. | Dùng replica set test/local đúng; xác minh transaction trong deployment. |
| High | `docker-compose.yml`, `frontend/vite.config.ts`, `frontend/Dockerfile` | Compose không truyền `VITE_API_URL` vào build trong khi Vite production bắt buộc biến này; build frontend mặc định sẽ fail nếu không có env trong build context. | Truyền build arg/env hoặc pipeline cấu hình rõ, kiểm tra build. |
| High | `promotion/promotion.service.ts`, `vnpay/vnpay.service.ts`, `table/table.service.ts` | Mã giảm 100% có thể tạo Order `totalAmount=0`, nhưng createPaymentUrl từ chối `payableTotal <= 0`; Order Served vẫn chưa Paid nên không clear bàn theo luồng thường. | Xác định nghiệp vụ đơn miễn phí và một transition server-side có audit. |
| Medium | `auth/jwt.strategy.ts`, `frontend/src/services/api/axios-client.ts` | Disable/logout không revoke access ngay; UI logout không gọi server logout | Token version/revocation strategy, gọi logout API. |
| Medium | `order/order-state-machine.service.ts` | Admin được cho phép transition item sang mọi enum (kể cả Paid) nhưng order-level state không luôn đồng bộ; read-modify-save dễ race | Giới hạn edge admin và dùng atomic concurrency check. |
| Medium | `order/order-state-machine.service.ts` | `cancelByAdmin` cho hủy cả Order đã Paid, trong khi PaymentIntent có thể vẫn Succeeded; báo cáo/hóa đơn có thể lệch nhau. | Định nghĩa refund/void riêng và bất biến kế toán. |
| Medium | `table/table.service.ts` | `clear` đóng Session rồi mới update Tables không transaction; lỗi giữa chừng để pointer/status lệch | Transaction và kiểm modified count. |
| Medium | `dish/dish.service.ts` | Xóa ảnh cũ trước DB update/delete; nếu DB fail sẽ còn document trỏ ảnh đã xóa | Xóa ảnh sau commit, job cleanup bù. |
| Medium | `category/category.service.ts`, `dish/dish.service.ts`, `table/table.service.ts` | Hard delete không thấy kiểm tham chiếu hoặc cascading policy; ref cũ có thể orphan | Kiểm dependent references/soft delete có chủ đích. |
| Medium | `frontend/Dockerfile`, `frontend/src/App.tsx` | nginx static không cấu hình SPA fallback; reload `/admin/*`, `/menu`, `/payment-result` trong container có thể 404 | Cấu hình `try_files`/host rewrite; xác minh browser refresh. |
| Medium | `frontend/src/features/payment/PaymentResult.tsx` | Khi pending chỉ check status một lần sau socket join; nếu mất event/connection, UI có thể pending mãi | Bổ sung polling/backoff hoặc recheck khi reconnect/focus. |
| Low | `backend/src/app.controller.ts` | `/health` chỉ trả `{status:'ok'}`, không xác minh Mongo/VNPAY | Readiness check riêng với timeout. |
| Low | `admin/admin.service.ts` | Top-dish `revenue` cộng giá item trước giảm giá, còn tổng revenue dùng `Order.totalAmount` sau discount; hai chỉ số không cộng khớp nếu có promotion. | Ghi rõ gross/net hoặc phân bổ discount khi báo cáo. |

Severity là mức ảnh hưởng tiềm năng từ đường code; không khẳng định lỗi đã xảy ra ở production. Đặc biệt Mongo transaction cần replica set là điều kiện kỹ thuật; Compose source không cấu hình replica set. `docs/render-deployment.md` ghi cần replica set cho test. Không chạy thao tác nào để xác nhận runtime.

## 19. Testing, Docker và deployment

**Tests có trong source:** Jest unit cạnh module (`order-state-machine.service.spec.ts`, `session.service.spec.ts`, `promotion.service.spec.ts`, AI provider/orchestrator specs, gateway spec), integration (`order.integration.spec.ts`), HTTP e2e Supertest trong `backend/test` (payment/merge/abandonment/invoice/menu/AI), frontend Node test cho `OrderProgress`, browser smoke scripts trong `frontend/scripts`. `backend/test/session-payment.e2e-spec.ts` dùng **Mongo thật** và tạo/xóa document test; không chạy với DB không cô lập. Có scripts `npm test`, `test:e2e`, `test:ai-release`, `test:order-progress`. **Đợt phân tích này không chạy build/test** vì yêu cầu read-only và một số lệnh có thể tạo artifact hoặc ghi DB. Evidence: `backend/package.json`, `backend/test/session-payment.e2e-spec.ts`, `frontend/package.json`, `frontend/test/order-progress.test.mjs`.

**Infrastructure trong source:** `docker-compose.yml` có Mongo, backend, frontend; backend multi-stage Node 24 build, frontend multi-stage build/nginx static. `backend/nest-cli.json` copy font vào `dist/assets`, nên PDFKit path trong `invoice.service.ts` có asset trong build nếu build đúng. `frontend/vite.config.ts` yêu cầu `VITE_API_URL` khi production build; `FRONTEND_URL`/`CORS_ORIGIN` phải hợp lệ, `MONGODB_URI` được `getOrThrow`. Env keys được liệt kê trong `.env.example`, giá trị bí mật không đưa vào đây. Không thấy `.github/workflows` hay manifest CI/CD được track; docs Render là hướng dẫn, `docs/render-deployment.md` nói rõ actual Render deployment chưa verify. `VNP_IPN_URL` có trong example/Compose nhưng service không dùng để đăng ký callback, cần cấu hình ở VNPAY bên ngoài. Evidence: `docker-compose.yml`, Dockerfiles, `backend/nest-cli.json`, `frontend/vite.config.ts`, `backend/src/common/config/public-urls.ts`, `docs/render-deployment.md`.

**Khi interviewer hỏi có deploy chưa:** “Repository có Docker Compose và Dockerfile; có hướng dẫn Render nhưng tôi chưa có evidence trong source xác nhận một deployment Render live. Tôi sẽ demo local hoặc trình bày quy trình, không nhận đã vận hành production.”

## 20. Complete system mental model

```text
React Page ──(typed Axios service + Bearer JWT nếu staff)──> Nest Controller
                                      │                         ↓ ValidationPipe / Guard
                                      │                  Injectable Service
                                      │                         ↓ @InjectModel
                                      └── response.data ← Mongoose Model ↔ MongoDB

React Socket.IO ── event ──> AppGateway ──> SessionService ──> MongoDB
React Socket.IO ←─ room event (`cart:synced`, `order:updated`, `tables:updated`)

External: Cloudinary ↔ DishService; VNPAY IPN → VnpayService → transaction → Paid;
          AI provider → AiOrchestrator → validated output → feature service.
```

JWT nằm trước protected controller và trong Axios header; refresh xử lý 401; DTO/ValidationPipe ở biên HTTP; DI tạo service/model; Mongo schema/index ở persistence; gateway phát event sau thao tác; Order/PaymentIntent snapshot giữ lịch sử thanh toán. `GET /menu` và customer routes public vẫn phải tự kiểm tra quan hệ table/session ở service. Evidence: `main.ts`, `App.tsx`, `axios-client.ts`, `app.gateway.ts`, `order.service.ts`, `vnpay.service.ts`.

## 21. Lời giới thiệu project để luyện phỏng vấn

### 2–3 minute project introduction

“Em tìm hiểu và phát triển một hệ thống SmartOrder phục vụ quy trình nhà hàng: khách quét QR của bàn để xem menu, cùng phiên ăn dùng giỏ hàng thời gian thực, gửi order; bếp chuyển món qua Pending, Preparing, Ready; phục vụ xác nhận Served; khách thanh toán VNPAY và tải hóa đơn. Admin quản lý bàn, món, tài khoản, khuyến mãi và xem thống kê/đánh giá. Frontend dùng React, TypeScript, React Router, Axios và Socket.IO; backend là NestJS/TypeScript, MongoDB với Mongoose, module/controller/service và DI. Đây là project Node.js, không phải backend .NET.

Một flow em có thể giải thích sâu là tạo order: client chỉ gửi tableId và mã giảm, backend lấy giỏ từ Session trong Mongo, kiểm món/giá, lưu snapshot món và giá vào Order, rồi phát event để bếp và khách cập nhật. Thanh toán có PaymentIntent lưu đúng nhóm Order, xác minh HMAC và amount từ VNPAY IPN, sau đó transaction chuyển các Order sang Paid; browser return chỉ để hiển thị trạng thái. Auth nhân viên dùng access JWT/refresh token và role guards, còn luồng khách dựa vào bàn/phiên ăn. Phần khó là đồng bộ giỏ/ghép bàn và giữ tính nhất quán khi nhiều thao tác đồng thời. Code dùng atomic update và transaction ở một số điểm; em cũng nhận ra cần gia cố quyền Socket.IO và xử lý rollback cart khi checkout lỗi. Qua project em học cách trace một request từ UI đến DB và phân biệt validation, authorization, realtime và transaction. Khi trao đổi .NET, em có thể ánh xạ khái niệm controller/service/DI/DTO sang ASP.NET Core, nhưng em không nói mình đã dùng EF Core trong project này.”

### 30–45 second pitch

“SmartOrder là hệ thống đặt món bằng QR và vận hành nhà hàng. Khách xem menu, dùng giỏ hàng realtime, gửi order và thanh toán VNPAY; bếp, phục vụ và admin có giao diện theo vai trò. Frontend React/TypeScript gọi API NestJS và Socket.IO; dữ liệu ở MongoDB/Mongoose. Em có thể giải thích luồng order, JWT role guard và IPN thanh toán dùng transaction. Phần em chú ý nhất là tính nhất quán của giỏ chung và quyền truy cập realtime. Đây là stack TypeScript, còn các khái niệm controller, service, DI, DTO có thể liên hệ khi học ASP.NET Core.”

## 22. Technical interview questions — 64 câu gắn với source

### 12 câu trọng tâm, có câu trả lời mẫu

**1. Question:** Project dùng kiến trúc gì?\
**Short Answer:** NestJS module theo feature, controller–service–Mongoose Model; React page–API client.\
**Detailed Answer:** Controller xử lý HTTP/guard, service áp quy tắc, Model truy cập Mongo; module đăng ký DI. Không có repository tách riêng và không có Clean Architecture đầy đủ.\
**Project Example:** `order.controller.ts → order.service.ts → @InjectModel(Order.name)`; `CustomerMenu.tsx → menuApi`.

**2. Question:** Tại sao không gọi đây là project .NET/EF Core?\
**Short Answer:** Backend là NestJS TypeScript, dữ liệu MongoDB/Mongoose.\
**Detailed Answer:** Không có `.csproj`, `Program.cs`, `DbContext`, migration hay LINQ query. Có các khái niệm tương đồng controller/service/DI/DTO, nhưng implementation/framework khác.\
**Project Example:** `backend/package.json`, `backend/src/main.ts`, `database/database.module.ts`.

**3. Question:** Tạo order có tin giá do client gửi không?\
**Short Answer:** Không; request chỉ gửi tableId, note, promotionCode.\
**Detailed Answer:** Service consume cart ở Session, query Dish khả dụng rồi snapshot giá/tên hiện tại vào OrderItem. Điều này ngăn client trực tiếp sửa amount, nhưng hiện cart bị clear trước khi toàn bộ việc lưu thành công.\
**Project Example:** `order/dto/create-order.dto.ts`, `order/order.service.ts`, `session/session.service.ts`.

**4. Question:** `cart:add` khác `POST /orders` thế nào?\
**Short Answer:** Cart dùng Socket.IO event, order dùng HTTP.\
**Detailed Answer:** Gateway nhận event, gọi SessionService atomic update và broadcast `cart:synced`; controller HTTP nhận DTO, tạo Order snapshot và phát `order:updated`. Realtime event không tự là REST API và không đi qua Axios interceptor.\
**Project Example:** `gateway/app.gateway.ts`, `CustomerMenu.tsx`, `order.controller.ts`.

**5. Question:** JWT access và refresh khác nhau thế nào?\
**Short Answer:** Access 15 phút để gọi protected API; refresh 7 ngày để lấy token mới.\
**Detailed Answer:** Refresh hash lưu ở User, service verify signature + bcrypt compare và rotate. Access strategy chỉ verify JWT claim, không kiểm user đang active mỗi request. Logout UI hiện chỉ local.\
**Project Example:** `auth.service.ts`, `jwt.strategy.ts`, `axios-client.ts`.

**6. Question:** Backend phân quyền admin ra sao?\
**Short Answer:** `JwtAuthGuard` xác thực Bearer; `RolesGuard` so `req.user.role` với `@Roles(ADMIN)`.\
**Detailed Answer:** Frontend RequireRole chỉ điều hướng UI; API phải tự dùng guard. Controller `/users` và `/admin/invoices` có class-level guard/role.\
**Project Example:** `common/guards/roles.guard.ts`, `user.controller.ts`, `RequireRole.tsx`.

**7. Question:** Vì sao VNPAY return không thể đánh dấu Paid?\
**Short Answer:** Browser redirect không là nguồn xác nhận; chỉ IPN hợp lệ xử lý thanh toán.\
**Detailed Answer:** IPN xác minh chữ ký HMAC/amount, tìm PaymentIntent và transaction cập nhật Intent + các Order snapshot. Return chỉ chuyển sang PaymentResult để đọc status.\
**Project Example:** `vnpay.controller.ts`, `vnpay.service.ts`, `PaymentResult.tsx`.

**8. Question:** Idempotency checkout xử lý double click thế nào?\
**Short Answer:** `coverageKey` cho cùng session + coveredOrderIds, unique partial index khi Pending.\
**Detailed Answer:** Nếu intent pending còn hạn, trả URL cũ; nếu hai insert đụng nhau, code xử lý duplicate key và đọc winner. IPN kiểm status và cập nhật bằng transaction/compare-and-set.\
**Project Example:** `payment-intent.schema.ts`, `vnpay.service.ts`.

**9. Question:** Vì sao lưu giá/tên trong OrderItem?\
**Short Answer:** Giữ hóa đơn và lịch sử đúng tại thời điểm đặt.\
**Detailed Answer:** Dish có thể sửa giá/tên hoặc bị xóa; Order snapshot tách lịch sử giao dịch khỏi catalog live. Trade-off là dữ liệu lặp và cần chọn đúng thời điểm snapshot.\
**Project Example:** `order.schema.ts`, `order.service.ts`, `invoice.service.ts`.

**10. Question:** Khi hai khách cùng thêm món vào giỏ, tránh mất cập nhật ra sao?\
**Short Answer:** `SessionService.addToCart` dùng atomic `$inc`/`$push` có điều kiện và retry.\
**Detailed Answer:** Thay vì đọc quantity rồi `save` gây lost update, service update document tại Mongo và tăng `version`; khi client khác vừa insert, retry nhánh `$inc`.\
**Project Example:** `session/session.service.ts` `addToCart`.

**11. Question:** AI có quyền tự tạo query Mongo hoặc quyết định sự thật dinh dưỡng không?\
**Short Answer:** Không.\
**Detailed Answer:** AI phân loại filter theo JSON schema, backend đọc catalog thật và tự lọc/rank; search chặn yêu cầu y tế/dinh dưỡng không có source. Analytics AI chạy tool allowlist lấy facts rồi chọn answer từ candidate.\
**Project Example:** `ai/menu-search/menu-search-ai.service.ts`, `menu/menu.service.ts`, `ai/admin-analytics/admin-analytics-ai.service.ts`.

**12. Question:** Rủi ro lớn nhất em thấy và cách xử lý?\
**Short Answer:** Socket.IO room/cart chưa có authentication/authorization.\
**Detailed Answer:** `join` nhận room name do client gửi, `cart:join` chỉ cần sessionId; CORS không thay authorization. Nên kiểm JWT staff ở handshake và dùng capability ràng buộc phiên/bàn cho khách trước mỗi event. Đây là đề xuất, chưa sửa code.\
**Project Example:** `gateway/app.gateway.ts`, `common/config/public-urls.ts`.

### 52 câu hỏi luyện thêm (13–64)

| # / nhóm | Question | Short Answer và project example |
|---|---|
| 13 Project | Ai là actor chính? | Khách QR, bếp, phục vụ, admin; `App.tsx`. |
| 14 Project | Session khác Order thế nào? | Session là phiên ăn/giỏ; Order là một lượt gọi món snapshot; `session.schema.ts`, `order.schema.ts`. |
| 15 Project | Vì sao một Session có nhiều Order? | Khách gọi thêm nhiều lượt, thanh toán tổng; `vnpay.service.ts` billing. |
| 16 C# | `Task<T>` liên hệ gì với `Promise<T>`? | Cùng mô tả kết quả bất đồng bộ, runtime/scheduler khác; code này dùng Promise trong services. |
| 17 C# | `async/await` C# có trong code không? | Không; code TypeScript async/await; `order.service.ts`. |
| 18 .NET | `Program.cs` tương ứng file nào về ý nghĩa? | `backend/src/main.ts` bootstrap Nest, không cùng API. |
| 19 .NET | `IServiceCollection.AddScoped` có dùng không? | Không; Nest module provider mặc định singleton; `app.module.ts`. |
| 20 ASP.NET Core | Middleware pipeline tương ứng ở đâu? | `main.ts` CORS/Helmet/rateLimit/ValidationPipe; Nest guard ở controller. |
| 21 ASP.NET Core | `Authorize(Roles=...)` liên hệ gì? | Nest `@UseGuards(JwtAuthGuard,RolesGuard)` + `@Roles`; `user.controller.ts`. |
| 22 REST API | GET `/sessions/active` có side effect gì? | Có thể tạo Session và đổi Table; cần giải thích trade-off REST semantic; `session.controller.ts`. |
| 23 REST API | Status code login thành công? | 200 do `@HttpCode(HttpStatus.OK)`; `auth.controller.ts`. |
| 24 REST API | Vì sao `POST /orders` không nhận items? | Server dùng cart authoritative; `CreateOrderDto`, `order.service.ts`. |
| 25 EF Core | Project có `DbContext`? | Không; Mongoose `Model` và connection; `database.module.ts`. |
| 26 EF Core | Có `Include/AsNoTracking`? | Không; Mongoose `populate/lean` là tương tự ở mức mục đích, không cùng semantics; `dish.service.ts`, `menu.service.ts`. |
| 27 EF Core | Migration nằm đâu? | Không thấy EF/SQL migration; schema/index Mongoose; `*.schema.ts`. |
| 28 SQL | PK/FK SQL trong project? | `_id` Mongo; `ref` không phải FK enforced; `order.schema.ts`. |
| 29 SQL | Vì sao transaction Mongo cần replica set? | Multi-document transaction yêu cầu replica set; merge/IPN dùng transaction, Compose không cấu hình; `docker-compose.yml`. |
| 30 SQL | Unique constraint nào quan trọng? | User email, Table code, Promotion code, Review(order,dish), Intent txnRef/coverageKey; schema files. |
| 31 LINQ | Có LINQ không? | Không; Mongo query/aggregation, ví dụ `AdminService.getRevenue`. |
| 32 LINQ | `$group` tương đương tư duy gì? | Group theo ngày/tháng/năm tại DB; `admin.service.ts`; không gọi là LINQ implementation. |
| 33 async/await | `await` có giúp query nhanh hơn không? | Không trực tiếp; giải phóng luồng/event loop khi chờ I/O; `MenuService.getSearchCatalog`. |
| 34 async/await | Dùng `Promise.all` khi nào? | Query độc lập; không song song Mongo operations trong cùng transaction; `AdminService.getOverview`, `SessionService.mergeTables`. |
| 35 DI | `@InjectModel` làm gì? | Inject Mongoose Model đã đăng ký bằng `forFeature`; `order.module.ts`, `order.service.ts`. |
| 36 DI | Vì sao `forwardRef` xuất hiện? | `SessionModule` ↔ `GatewayModule` tham chiếu vòng; `session.module.ts`, `gateway.module.ts`. |
| 37 Repository Pattern | Project có repository custom? | Không thấy; service gọi Model trực tiếp; `order.service.ts`. |
| 38 DTO | `whitelist`/`forbidNonWhitelisted` có tác dụng gì? | Bỏ/reject field thừa, code cấu hình reject; `main.ts`. |
| 39 DTO | DTO có đảm bảo business rule? | Không; rating/ID format ở DTO, Paid/ownership ở ReviewService; `create-review.dto.ts`, `review.service.ts`. |
| 40 JWT | Claim gì được ký? | `sub,email,role,fullName`; `auth.service.ts`. |
| 41 JWT | Access token hết hạn được xử lý ở đâu? | Axios response interceptor 401 gọi refresh/queue/retry; `axios-client.ts`. |
| 42 Refresh Token | Refresh được lưu plaintext trong DB không? | Không, lưu bcrypt hash; `user.service.ts`. |
| 43 Refresh Token | Logout server có revoke access ngay không? | Không, chỉ clear refresh hash; `auth.service.ts`, `jwt.strategy.ts`. |
| 44 Security | CORS có bảo vệ socket room không? | Không; chỉ origin policy, không chứng thực room; `public-urls.ts`, `app.gateway.ts`. |
| 45 Security | XSS nguy hiểm hơn vì sao? | Token ở localStorage có thể bị lấy nếu script độc chạy; `Login.tsx`. |
| 46 Security | CSRF áp dụng ra sao? | JWT được gắn thủ công vào header, không cookie session; rủi ro truyền thống thấp hơn, vẫn cần xem toàn bộ endpoint. |
| 47 Security | Password hash dùng gì? | bcrypt salt rounds 10; `user.service.ts`. |
| 48 React | State toàn app quản lý ở đâu? | Chủ yếu local state; không có Redux/Context auth; `CustomerMenu.tsx`, `App.tsx`. |
| 49 React | `useEffect` socket cần cleanup gì? | Remove listeners/disconnect khi unmount hoặc session đổi; `CustomerMenu.tsx`. |
| 50 React | Route nào public? | `/login`, `/menu`, `/payment-result`; `App.tsx`. |
| 51 React | `RequireRole` đủ bảo mật không? | Không, backend guard quyết định quyền; `RequireRole.tsx`, `user.controller.ts`. |
| 52 API integration | Base URL đến từ đâu? | `VITE_API_URL`, dev fallback localhost; `config/api-url.ts`. |
| 53 API integration | Socket có dùng Axios interceptor không? | Không; socket kết nối riêng `io(API_URL)`; `CustomerMenu.tsx`. |
| 54 API integration | Vì sao queued requests khi refresh? | Tránh nhiều refresh cùng lúc, retry với access mới; `axios-client.ts`. |
| 55 Architecture | Ai nắm source of truth của cart? | `sessions.cart` trên MongoDB; `SessionService.consumeCartForOrder`. |
| 56 Architecture | Vì sao PaymentIntent lưu coveredOrderIds? | Cố định order cutoff cho giao dịch; `payment-intent.schema.ts`, `vnpay.service.ts`. |
| 57 Docker | Compose chạy service nào? | Mongo, backend, frontend/nginx; `docker-compose.yml`. |
| 58 Docker | Vì sao build frontend Compose có thể fail? | Vite build bắt `VITE_API_URL`, Compose không truyền; `vite.config.ts`, `docker-compose.yml`. |
| 59 Docker | File font PDF đi đâu khi build? | `nest-cli.json` copy font vào `dist/assets`; `invoice.service.ts` load theo path dist. |
| 60 Debugging | Nếu món không hiện menu, kiểm gì? | category active, dish available, table ID, `/menu` response; `menu.service.ts`. |
| 61 Debugging | Nếu thanh toán pending mãi, kiểm gì? | IPN signature/amount/intent status, callback config, socket/status endpoint; `vnpay.service.ts`, `PaymentResult.tsx`. |
| 62 Debugging | Nếu 401 liên tục, kiểm gì? | Bearer expiry, refresh hash, secret, role/user, Axios interceptor; `auth.service.ts`, `axios-client.ts`. |
| 63 Debugging | Nếu merge bàn lỗi ở local Compose, kiểm gì? | Replica set requirement/transaction, lock token/status; `session.service.ts`, `docker-compose.yml`. |
| 64 Debugging | Nếu hóa đơn PDF lỗi, kiểm gì? | Paid Intent/Order, invoice code/index, font asset path, Content-Disposition; `invoice-lookup.service.ts`, `invoice.service.ts`. |

## 23. “Why” questions — trả lời đúng scope project

| Why? | Trả lời phù hợp source, trade-off |
|---|---|
| Why .NET / ASP.NET Core? | **Không áp dụng cho implementation này.** Nếu ứng tuyển .NET: “Em đang học ASP.NET Core vì typed C#, DI, middleware và tooling phù hợp backend; project SmartOrder của em hiện dùng NestJS nên em sẽ so sánh khái niệm, không nhận đã xây nó bằng .NET.” |
| Why React? | UI nhiều vai trò/trạng thái realtime, component/page/hook giúp tổ chức; trade-off nhiều state/effect ở `CustomerMenu`. Evidence: `App.tsx`, `CustomerMenu.tsx`. |
| Why SQL? | **Không áp dụng.** DB hiện là MongoDB; không nói chọn SQL. Nếu thiết kế lại, có thể cân nhắc SQL cho giao dịch/quan hệ, cần benchmark và ràng buộc nghiệp vụ. |
| Why MongoDB? | Session/cart/order item dạng document/embedded phù hợp; Mongoose schema/index; trade-off thiếu FK và transaction cần replica set. Evidence: `session.schema.ts`, `order.schema.ts`, `database.module.ts`. |
| Why EF Core? | **Không áp dụng.** Project dùng Mongoose; liên hệ ORM/ODM chỉ ở mức mapping/query, không nhận đã dùng LINQ/EF migration. |
| Why Mongoose? | Model/schema, validator, index, population, atomic Mongo update; trade-off repository/DTO chưa tách đều. Evidence: `*.schema.ts`, `session.service.ts`. |
| Why Repository? | **Không có repository custom để biện minh.** Service inject Model trực tiếp, giảm file/layer nhưng DB coupling cao. Evidence: `order.service.ts`. |
| Why Service Layer? | Giữ quy tắc Order/Payment/Auth ngoài controller, dễ test và tái dùng; `OrderService` được nhiều flow gọi. Trade-off service có thể phình to. |
| Why DTO? | Runtime validation, giới hạn input/response, client không đặt giá trực tiếp; mapping tốn công và CRUD hiện chưa thống nhất. Evidence: `create-order.dto.ts`, `UserResponse`. |
| Why async/await? | DB/network/bcrypt là I/O/CPU async APIs; mã flow dễ đọc, không chặn event loop khi chờ I/O; phải xử lý lỗi/transaction/race. Evidence: services. |
| Why JWT? | Staff gọi API tách frontend/backend với Bearer và role claim; trade-off thu hồi access chậm. Evidence: `auth.service.ts`, `jwt.strategy.ts`. |
| Why Refresh Token? | Access 15 phút, refresh 7 ngày giảm login lại; hash + rotation, nhưng logout/revoke cần đúng. Evidence: `auth.service.ts`. |
| Why Dependency Injection? | Nest module cung cấp service/model/provider, có thể mock trong tests; `forwardRef` báo coupling. Evidence: `order.module.ts`, `ai.module.ts`. |
| Why separate frontend/backend? | React SPA và Nest API/Socket có lifecycle và deploy riêng; `VITE_API_URL`/CORS cấu hình giao tiếp. Trade-off CORS/build env/realtime deployment. Evidence: `frontend/vite.config.ts`, `backend/src/main.ts`, Dockerfiles. |

## 24. Technical challenges có thể trình bày, không bịa lịch sử

**Challenge 1 — giỏ chung đồng thời.** Problem: nhiều khách cùng sửa cart. Root Cause: read–modify–write có thể mất cập nhật. Solution currently used: atomic `$inc/$push/$pull`, conditional filter, retry và `version` trong `SessionService`. Why it works: Mongo cập nhật một document nguyên tử. What I learned: source of truth phải ở server và transaction boundary rõ. Possible improvement: bảo vệ room và rollback checkout. Evidence: `session.service.ts`, `app.gateway.ts`.

**Challenge 2 — ghép/tách bàn.** Problem: hai bàn có Session/cart/order cần một ownership thống nhất. Root Cause: nhiều document và client đang ở room cũ. Solution currently used: merge lock + Mongo transaction, snapshot pre/post merge, cập nhật table/session/order, gateway chuyển room. Why it works: transaction giữ DB đồng bộ, snapshot hỗ trợ unmerge an toàn. What I learned: luồng realtime và persistence cần tách; socket fail sau commit cần reconnect recovery. Possible improvement: giảm `forwardRef`, test race trên replica set. Evidence: `session.service.ts`, `session.controller.ts`, `app.gateway.ts`.

**Challenge 3 — thanh toán nhiều lượt gọi món.** Problem: một lần trả tiền cho nhiều Order không được trả sai/đúp. Root Cause: redirect/callback đến bất đồng bộ, double click và IPN retry. Solution currently used: `coveredOrderIds`/amount snapshot, coverageKey unique, HMAC, compare-and-set và Mongo transaction. Why it works: IPN chỉ đóng đúng nhóm Order đã chốt, hoặc rollback cả intent. What I learned: return URL không là nguồn tin cậy. Possible improvement: chạy replica set local và giám sát callback. Evidence: `payment-intent.schema.ts`, `vnpay.service.ts`, `order-state-machine.service.ts`.

**Challenge 4 — AI dùng dữ liệu thật.** Problem: model có thể đưa kết quả sai hoặc suy đoán dị ứng/doanh thu. Root Cause: LLM không là nguồn dữ liệu; output không tin cậy. Solution currently used: JSON schema + class-validator, timeout/retry/audit, backend catalog filtering, analytics facts allowlist, warning/fallback. Why it works: backend kiểm số liệu và scope, model chỉ phân loại/diễn đạt trong giới hạn. What I learned: kiểm input/output và giữ fact từ DB. Possible improvement: đánh giá định kỳ với dataset và chi phí. Evidence: `ai-orchestrator.service.ts`, `menu-search-ai.service.ts`, `admin-analytics-ai.service.ts`, `scripts/ai-evaluation`.

**Challenge 5 — lifecycle session bỏ quên.** Problem: QR mở session nhưng khách không order, bàn bị giữ Occupied. Root Cause: session không có terminal action. Solution currently used: `AbandonedSessionCleanupService` định kỳ tìm session cũ, transaction kiểm chưa từng có Order rồi expire và giải phóng bàn. Why it works: điều kiện được kiểm lại trong transaction. What I learned: background job cần idempotency/concurrency. Possible improvement: đo số session stale và bảo đảm replica set. Evidence: `session/abandoned-session-cleanup.service.ts`.

Không có bằng chứng rằng các challenge trên là bug lịch sử đã được cá nhân người dùng xử lý; đây là thách thức kỹ thuật đọc được từ source hiện tại.

## 25. Code walkthrough khi interviewer yêu cầu mở file

| Thứ tự | Mở file | Nên nói gì |
|---|---|---|
| 1 | `backend/src/main.ts` | “Đây là bootstrap: env, CORS, Helmet, rate limit, validation.” |
| 2 | `backend/src/app.module.ts` + `database/database.module.ts` | “Nest module lắp các feature và Mongo connection; không phải ASP.NET Program/DbContext.” |
| 3 | `backend/src/modules/session/session.schema.ts` + `order/order.schema.ts` | “Session chứa giỏ, Order lưu snapshot và trạng thái; các ObjectId là ref.” |
| 4 | `backend/src/modules/order/dto/create-order.dto.ts` + `order.controller.ts` | “Biên request không nhận giá/items; guarded route khác public route.” |
| 5 | `backend/src/modules/order/order.service.ts` + `session/session.service.ts` | “Trace giỏ server → kiểm Dish/promotion → Order. Nêu atomic cart và rủi ro rollback.” |
| 6 | `backend/src/gateway/app.gateway.ts` | “Socket realtime sync cart/order; nêu room authorization còn thiếu.” |
| 7 | `backend/src/modules/order/order-state-machine.service.ts` | “Bếp/phục vụ chuyển item theo role, thanh toán chỉ IPN.” |
| 8 | `backend/src/modules/auth/auth.service.ts` + `jwt.strategy.ts` | “Bcrypt, JWT 15m/7d, refresh hash/rotation, hạn chế revoke.” |
| 9 | `backend/src/modules/vnpay/vnpay.service.ts` + `payment-intent.schema.ts` | “Snapshot coverage, HMAC, IPN transaction/idempotency.” |
| 10 | `frontend/src/main.tsx` + `App.tsx` | “React entry, routes public/staff/admin.” |
| 11 | `frontend/src/services/api/axios-client.ts` + `menu.ts` | “BaseURL/Bearer/refresh và typed API.” |
| 12 | `frontend/src/features/menu/CustomerMenu.tsx`, `kitchen/KitchenDisplay.tsx`, `waiter/WaiterDashboard.tsx` | “Trình diễn khách đặt → bếp xử lý → phục vụ, HTTP + socket.” |
| 13 | `backend/src/modules/admin/admin.service.ts` và `frontend/src/features/admin/AdminDashboard.tsx` | “Aggregation Mongo trả dữ liệu Recharts.” |

## 26. Knowledge gaps để học theo ưu tiên

### 🔴 Must Know

1. Phân biệt stack **NestJS/Mongoose** hiện tại và **ASP.NET Core/EF Core** định ứng tuyển; nói rõ điểm tương đồng/khác nhau. Evidence: `backend/package.json`, `database.module.ts`.
2. Trace 3 flow login, cart/order, VNPAY IPN đến DB/UI; nhớ method/endpoint/DTO/guard. Evidence: `auth.controller.ts`, `order.controller.ts`, `vnpay.controller.ts`.
3. JWT signature vs decode, access/refresh lifecycle, role backend guard, Socket.IO authorization gap. Evidence: `auth.service.ts`, `app.gateway.ts`.
4. Mongo embedded document, ObjectId/ref/index/unique, atomic update, transaction replica set. Evidence: schema, `session.service.ts`, `vnpay.service.ts`.
5. HTTP status/validation/exception, async/await, DI/module import/export. Evidence: `main.ts`, `app.module.ts`.

### 🟡 Should Know

1. PaymentIntent cutoff/idempotency, order snapshot, status state machine, promotion reservation. Evidence: `payment-intent.schema.ts`, `order-state-machine.service.ts`, `promotion.service.ts`.
2. React route/guard/state/effect cleanup, Axios refresh queue, socket event/reload. Evidence: `App.tsx`, `axios-client.ts`, `CustomerMenu.tsx`.
3. Mongo aggregation, index trade-off, pagination/large response và query plan. Evidence: `admin.service.ts`, `review-intelligence.service.ts`.
4. Kiểm thử unit/e2e, test Mongo cô lập, Docker env build/runtime khác nhau. Evidence: package scripts, `session-payment.e2e-spec.ts`, Dockerfiles.

### 🟢 Nice To Know

1. AI structured output/provider adapter/evaluation/fallback; không nhận AI là nguồn sự thật. Evidence: `ai-orchestrator.service.ts`, `scripts/ai-evaluation`.
2. Socket.IO scale đa instance/Redis adapter, HMAC timingSafeEqual, transaction retry/compensation. Evidence: `app.gateway.ts`, `vnpay.service.ts`.
3. Cách chuyển thiết kế sang .NET: ASP.NET Core controllers/minimal APIs, DI lifetimes, EF Core nếu chọn SQL, SignalR thay Socket.IO về mặt mục đích, background hosted service. Đây là **kiến thức cần học**, không phải công nghệ hiện có.

## 27. Final cheat sheet (ôn nhanh một trang)

```text
PROJECT: SmartOrder — quản lý nhà hàng và gọi món QR
PURPOSE: Khách xem menu/đặt món/thanh toán; bếp, phục vụ, admin phối hợp
FRONTEND: React 19 + TypeScript + Router 7 + Vite 8 + Tailwind 4 + Axios + Socket.IO
BACKEND: NestJS 11 + TypeScript + Mongoose; KHÔNG phải ASP.NET Core
DATABASE: MongoDB; collections users, tables, categories, dishes, sessions,
          orders, promotions, payment_intents, reviews, ai_interactions
AUTH: Staff JWT Bearer access 15m, refresh 7d hash + rotate; RolesGuard
ARCHITECTURE: Feature modules → Controller → Service → Mongoose Model; Socket Gateway
MAIN FEATURES: QR/menu, shared cart, order workflow, bàn/QR, VNPAY/PDF,
               promotion, review/analytics, AI tùy cấu hình
REQUEST FLOW: React → Axios → DTO/Guard → Controller → Service → Model → Mongo;
              hoặc React ↔ Socket Gateway → SessionService → Mongo
DESIGN PATTERNS: DI, DTO, state machine, provider strategy AI, snapshots,
                 atomic updates/transactions; không có custom repository rõ ràng
MAIN CHALLENGE: Đồng bộ cart/merge bàn và payment nhiều Order, IPN idempotent
TECHNICAL DEBT: Socket rooms chưa auth; cart checkout không rollback toàn bộ;
                Compose thiếu replica set/VITE_API_URL; service/page lớn
```

### TOP 20 QUESTIONS I MUST BE ABLE TO ANSWER

1. Stack thật của project là gì? Vì sao không nói EF Core/.NET?
2. Actor nào dùng mỗi route/page?
3. `main.ts` và `AppModule` khởi động hệ thống ra sao?
4. React route, `RequireRole`, backend guard khác nhau ra sao?
5. Login/refresh/logout và thời gian JWT hoạt động thế nào?
6. Vì sao decode JWT không bằng verify?
7. Session, Table, Order khác nhau thế nào?
8. QR/tableId dẫn vào menu/session thế nào?
9. Cart Socket.IO là source of truth ở đâu?
10. Concurrent `cart:add` tránh lost update thế nào?
11. Tạo Order lấy giá/giỏ từ đâu, và failure risk là gì?
12. Các cạnh Pending→Preparing→Ready→Served→Paid do ai đổi?
13. Promotion được reserve/snapshot ra sao?
14. Merge/unmerge bàn cần transaction và snapshot gì?
15. VNPAY return khác IPN thế nào?
16. PaymentIntent ngăn trả tiền đúp hoặc trả nhầm Order thế nào?
17. Vì sao hóa đơn dùng snapshot Order và PDFKit?
18. Mongo index, ref, embedded document khác SQL FK/EF navigation ra sao?
19. Rủi ro security lớn nhất của Socket.IO và cách khắc phục?
20. Docker/Render/test có evidence gì và phần nào chưa xác minh?

### Checklist trạng thái repository sau phân tích

- [x] Không source code nào được sửa; chỉ tài liệu này được tạo/cập nhật.
- [x] Không file nào bị xóa, rename hoặc move.
- [x] Không dependency/package nào thay đổi hoặc được cài/update.
- [x] Không chạy migration, seed, reset hay thao tác database.
- [x] Không commit/push/reset/rebase/merge Git, không thay đổi Git history.
- [x] Không sửa Docker/CI/CD; không chạy auto-fix/build/test có thể sinh artifact.
- [x] Chỉ `PROJECT_DEEP_DIVE.md` là output của công việc này.
