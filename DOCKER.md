# Docker local/demo

Requires Docker Engine/Desktop running Linux containers and Docker Compose v2+.
From the repository root, copy `.env.example` to `.env` (`cp` on Bash or `Copy-Item`
on PowerShell). Generate two different JWT secrets using the command in the example,
fill them in, then run:

```sh
docker compose config --quiet
docker compose up --build -d --wait
```

Open `http://localhost:5173`; the API is `http://localhost:3000` and its health route
is `/health`. HTTP and Socket.IO use `PUBLIC_BACKEND_URL`, embedded during the frontend
build. Changing it requires rebuilding the frontend. Never set it to `http://backend:3000`.
For access from another device, set `APP_BIND=0.0.0.0` and both public URLs to the host's
LAN IP/hostname with the corresponding ports, then rebuild. QR URLs and payment returns
use the same public URLs. No separate backend/frontend `.env` files are read by Docker.

MongoDB is a single-member `rs0` on the private Compose network with no published DB port.
Its healthcheck initializes the replica set once and waits for a writable primary.
Backend startup also verifies a snapshot transaction; its healthcheck checks HTTP and Mongo.
This unauthenticated single-node database is for local/demo use, not an Internet deployment.
Data is stored in the Compose `mongodb_data` volume; ordinary `docker compose down` keeps it.

Production startup does not seed accounts or demo data. To create the first administrator,
set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in your shell (password: 12+ characters, max 72 UTF-8
bytes), then explicitly run:

```sh
docker compose exec -e ADMIN_EMAIL -e ADMIN_PASSWORD backend node docker/bootstrap-admin.cjs
```

On PowerShell use `$env:ADMIN_EMAIL = 'owner@example.com'` and set `$env:ADMIN_PASSWORD`;
on Bash export those two variables. Remove them from your shell after the command.
The command only inserts a new admin and refuses to replace an existing account. The app
starts with an empty menu; create catalog/staff/tables through the existing admin screens.
The old `seed:admin` development data script is not part of the production image.

Cloudinary/VNPAY credentials may stay empty to start the app; uploads and online payments
require valid provider credentials. VNPAY IPN requires a provider-reachable backend URL
registered with VNPAY; a localhost URL cannot receive external callbacks. AI is disabled
in this minimal Compose setup. No credentials are baked into either application image.
