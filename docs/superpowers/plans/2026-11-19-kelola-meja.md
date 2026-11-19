# Kelola Meja Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, in this session). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Admin/supervisor dapat menambah, mengubah, dan menonaktifkan meja dari dialog "Atur Meja".

**Architecture:** Kolom `restaurant_tables.is_active` (migrasi 004); endpoint `/api/admin/tables*` di belakang `requireAdmin`; `GET /api/tables` hanya meja aktif; pembuatan pesanan dan reservasi menolak meja nonaktif dengan mengunci baris meja; dialog klien memakai pola dialog Kategori.

**Tech Stack:** Node.js, Express 4, mysql2, MySQL 8, HTML/JS tanpa framework, tanpa dependensi baru.

**Spec:** `docs/superpowers/specs/2026-11-19-kelola-meja-design.md`

## Global Constraints

- Tanpa dependensi baru; UI dan pesan error berbahasa Indonesia; error `{ error }` lewat `HttpError`.
- Kode meja 1–10 karakter, kapasitas bilangan bulat 1–50, area opsional ≤ 30 (kosong → `NULL`).
- Menonaktifkan ditolak (409) bila ada pesanan aktif (`ACTIVE_ORDER_STATUSES`), reservasi `menunggu`, atau reservasi `datang` tanpa `order_id`.
- Jangan commit/push sebelum diminta. Uji memakai DB terpisah (`kasir_old`, `kasir_test`) dan server port 3100; skrip uji di scratchpad. DB asli dimigrasi hanya di langkah akhir.

## Review Focus

1. Nonaktifkan dan `POST /api/orders` bersamaan pada meja kosong → tidak pernah ada meja nonaktif dengan pesanan aktif.
2. Mengganti kode meja yang punya pesanan/reservasi: nama kode di daftar reservasi dan pesanan ikut berubah.
3. Meja nonaktif tidak muncul di denah, "Pesanan Baru", maupun form reservasi, dan muncul lagi setelah diaktifkan.
4. Kode/area berisi `<b>`, tanda kutip, emoji tampil aman (di-escape) di dialog, denah, dan form reservasi.
5. Migrasi aman diulang dan meja lama tetap aktif.

---

### Task 1: Migrasi 004 dan dump

**Files:** Create `database/migrations/004_table_is_active.sql`; Modify `database/kasir_restoran.sql`, `kasir_restoran.sql` (akar, harus identik).

**Interfaces:** Produces kolom `restaurant_tables.is_active TINYINT(1) NOT NULL DEFAULT 1` (setelah `status`).

- [ ] **Step 1:** Buat DB `kasir_old` dari dump **sebelum diedit** (sed ganti nama; pastikan tidak ada sisa `kasir_restoran`), seed user (`SEED_PASSWORD`/`SEED_PIN` uji). Verifikasi kolom `is_active` belum ada.
- [ ] **Step 2:** Tulis migrasi idempotent (cek `information_schema.columns` lalu `PREPARE`/`EXECUTE`), perbarui kedua dump (kolom di definisi tabel).
- [ ] **Step 3:** `DB_NAME=kasir_old node migrate.js` dua kali. Expected: sukses dua kali; kolom ada; semua baris `is_active = 1`.
- [ ] **Step 4:** Buat `kasir_test` dari dump baru + seed user; jalankan server uji `DB_NAME=kasir_test PORT=3100 node --watch server.js`.

### Task 2: Endpoint meja dan penolakan meja nonaktif

**Files:** Modify `server.js` (helper dekat helper reservasi, rute sebelum `GET /api/tables`, serta `GET /api/tables`, `POST /api/orders`, `lockTable`, pesan `requireRole`); Test (scratchpad) `table-api-tests.mjs` (helper seperti `reservation-api-tests.mjs`).

**Interfaces:**
- Produces: `parseTableInput(body): { code, capacity, area }` (`HttpError(400)`); `async function tableBusyReason(conn, tableId): Promise<string|null>`; endpoint `GET/POST /api/admin/tables`, `PUT /api/admin/tables/:id`, `PATCH /api/admin/tables/:id/active` (respons `{ ok, table }` dengan `table = { id, code, capacity, area, is_active }`; GET mengembalikan array dengan tambahan `in_use_reason`).
- Consumes: `requireAdmin`, `HttpError`, `parseWholeNumber`, `ACTIVE_ORDER_STATUSES`, `lockTable`, `RESERVATION_STATUS_LABEL`.

- [ ] **Step 1: Tulis tes gagal** (`table-api-tests.mjs`): `roles_and_auth`; `create_table` (pangkas, kapasitas teks angka, area kosong → null, muncul di `GET /api/tables` sebagai kosong); `duplicate_code_409` (beda huruf; kode milik meja nonaktif → pesan menyarankan aktifkan); `validation_matrix`; `edit_table` (+ ganti huruf besar/kecil kode sendiri, clash 409, 404, nama kode ikut di `GET /api/reservations` dan `GET /api/orders/:id`); `deactivate_reactivate` (hilang/muncul di `GET /api/tables`, admin list, idempoten, body salah 400, 404); `deactivate_blocked_when_in_use` (pesanan aktif → pesan memuat nomor pesanan; reservasi menunggu → memuat jam dan nama; tamu duduk belum memesan; `in_use_reason` terisi di list admin; setelah pesanan di-void / reservasi dibatalkan → boleh); `inactive_table_rejected` (`POST /api/orders` dine-in 400 "tidak aktif"; `POST /api/reservations` 400; `PUT` reservasi pindah ke meja nonaktif 400); `deactivate_vs_order_race` (50 putaran bergantian: `Promise.all([PATCH active false, POST order])` pada meja baru; tidak pernah meja nonaktif sekaligus punya pesanan aktif). Jalankan → FAIL.
- [ ] **Step 2: Implement** helper dan empat endpoint; `tableBusyReason` memeriksa pesanan aktif, reservasi `menunggu` (jam `HH:mm` + nama), reservasi `datang` tanpa `order_id`; nonaktifkan: transaksi, `SELECT ... FOR UPDATE` baris meja lalu `tableBusyReason`; kode kembar: pra-cek + tangkap `ER_DUP_ENTRY`.
- [ ] **Step 3: Implement penolakan meja nonaktif:** `GET /api/tables` menambah `WHERE t.is_active = 1`; `POST /api/orders` (dine-in dengan `table_id`) mengunci baris meja (`FOR UPDATE`) dan menolak bila tidak ada/nonaktif ("Meja tidak aktif"); `lockTable` menolak meja nonaktif (400); pesan `requireRole` jadi "Hanya admin atau supervisor yang dapat mengelola menu dan meja".
- [ ] **Step 4:** Jalankan `table-api-tests.mjs`, `reservation-api-tests.mjs`, `menu-api-tests.mjs` → semua PASS.

### Task 3: Dialog "Atur Meja"

**Files:** Modify `public/index.html` (tombol di header kartu denah `id="btn-manage-tables"`, modal `modal-tables-admin`, CSS kecil, JS kelompok "KELOLA MEJA", `applyRoleUi`).

**Interfaces:**
- Consumes: `canManageMenu`, `askConfirm`, `api`, `esc`, `showToast`, `openModal`, `closeModal`, `parseStockInput`, `fetchTables`, `fetchReservations`, `tables`.
- Produces: `openTablesAdmin()`, `fetchAdminTables(): Promise<void>`, `renderTablesAdmin()`, `addTable()`, `startEditTable(id)`, `cancelEditTable()`, `saveEditTable(id)`, `toggleTableActive(id, makeActive)`, `afterTableChange(): Promise<void>` (`fetchTables` + `fetchAdminTables` + `fetchReservations`).

- [ ] **Step 1: Daftar verifikasi browser** (server uji 3100): tombol hanya untuk admin/supervisor; tambah meja → muncul di denah; kode kembar menampilkan pesan di dialog; ubah di tempat; Nonaktifkan dimatikan dengan alasan untuk meja dipakai; nonaktifkan meja kosong dengan konfirmasi → hilang dari denah, "Pesanan Baru", dan form reservasi; aktifkan lagi; `<b>x</b> "q"` aman; lebar tablet; konsol bersih.
- [ ] **Step 2: Implement** markup dan fungsi di atas (pola dialog Kategori; area dengan `<datalist>` dari area yang ada).
- [ ] **Step 3:** Jalankan daftar verifikasi dan perbaiki sampai lolos.

### Task 4: README, regresi, migrasi DB asli, jalankan ulang

**Files:** Modify `README.md`.

- [ ] **Step 1: README:** bagian "Kelola Meja" (siapa boleh, aksi, nonaktifkan = tidak dihapus, syarat meja tidak dipakai), catatan wajib `npm run db:migrate`, daftar migrasi/struktur bila perlu.
- [ ] **Step 2: Regresi:** ketiga rangkaian tes API PASS; alur pesanan biasa (klik meja kosong → simpan → bayar) dan reservasi di browser.
- [ ] **Step 3: Bersihkan:** hentikan server uji, drop `kasir_test` dan `kasir_old`; `git status` hanya memuat berkas yang diharapkan.
- [ ] **Step 4: DB asli:** jalankan `npm run db:migrate`, verifikasi kolom `is_active` ada dan semua meja aktif; jalankan ulang server utama (port 3000) dan cek endpoint dengan login admin.
