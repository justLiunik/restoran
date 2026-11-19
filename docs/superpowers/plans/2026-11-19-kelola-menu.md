# Kelola Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, in this session) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin/supervisor dapat menambah, mengubah, menonaktifkan menu dan mengelola kategori dari tab baru "Kelola Menu".

**Architecture:** Endpoint baru di bawah `/api/admin/*` yang dijaga middleware `requireRole`, tanpa perubahan skema. Klien (vanilla JS di `public/index.html`) mendapat tab, dua dialog, dan perbaikan render gambar/escape. Pesanan berjalan tidak tersentuh; `buildOrderItems` hanya menolak menu nonaktif yang baru ditambahkan.

**Tech Stack:** Node.js, Express 4, mysql2 (pool di `db.js`), MySQL 8, HTML/JS tanpa framework. Tanpa dependensi baru.

**Spec:** `docs/superpowers/specs/2026-11-19-kelola-menu-design.md`

## Global Constraints

- Tanpa dependensi baru dan tanpa perubahan skema/migrasi.
- Teks UI dan pesan error berbahasa Indonesia; error server berbentuk `{ error: "pesan" }` (pakai `HttpError` yang sudah ada).
- Role yang boleh: `admin` dan `supervisor`; selain itu 403 `"Hanya admin atau supervisor"`.
- Harga: bilangan bulat 1–100.000.000. Nama menu 1–100, nama kategori 1–50 (dipangkas). Stok awal 0–100.000 (default 0). Batas stok menipis 0–1000 (default 5). Link foto kosong → `NULL`, selain itu `http(s)://` dan ≤ 500 karakter.
- Nama menu kembar dalam satu kategori ditolak (tanpa beda huruf besar/kecil, termasuk menu nonaktif) → 409. Nama kategori kembar → 409 `"Nama kategori sudah dipakai"`.
- Stok awal > 0 → baris `stock_movements` `restock`, catatan `"Stok awal"`, transaksi yang sama.
- Jangan commit/push sebelum pengguna meminta.
- Pengujian memakai database terpisah `kasir_test` + server port 3100; database asli tidak disentuh. Skrip uji disimpan di scratchpad, bukan di repo.

## Review Focus

1. Urutan kategori dengan id kurang, kembar, atau tak dikenal → 400 dan tidak ada yang berubah.
2. Mengubah menu tanpa mengganti nama (atau hanya mengganti huruf besar/kecil namanya sendiri) tidak boleh memicu "nama kembar".
3. Nama berisi `<b>`, tanda kutip, dan emoji tampil aman di Katalog, panel pesanan, Kelola Menu, dan tabel Kelola Stok (di-escape).
4. Klik ganda "Simpan" hanya membuat satu menu (flag sibuk).
5. Baris pesanan belum tersimpan dari menu yang baru saja dinonaktifkan → server menolak dengan pesan jelas saat simpan/bayar, tanpa merusak pesanan lain.
6. Link foto `javascript:...` ditolak; link berisi tanda kutip tidak merusak atribut `src`.

---

### Task 1: Penjaga role dan endpoint menu admin

**Files:**
- Modify: `server.js` (tambah di bagian MASTER DATA, sesudah `GET /api/products`/sebelum rute stok tidak masalah; rute `/api/admin/*` dikelompokkan sendiri)
- Test (scratchpad, bukan repo): `<scratchpad>/menu-api-tests.mjs`

**Interfaces:**
- Produces:
  - `function requireRole(...roles: string[]): express.RequestHandler` → 403 bila `req.user.role` tidak termasuk.
  - `const requireAdmin = requireRole('admin', 'supervisor')`
  - `function parseProductInput(body, { creating: boolean }): { name, category_id, price, image_url, low_stock_threshold, stock? }` — melempar `HttpError(400, ...)`; `stock` hanya ada saat `creating`.
  - `async function assertUniqueProductName(conn, categoryId, name, exceptId = null)` — melempar `HttpError(409, ...)`.
  - Endpoint: `GET /api/admin/products`, `POST /api/admin/products`, `PUT /api/admin/products/:id`, `PATCH /api/admin/products/:id/active`.

- [ ] **Step 1: Siapkan harness uji.** Buat DB `kasir_test` dari dump (`sed s/kasir_restoran/kasir_test/` ke `docker exec ... mysql`), jalankan `DB_NAME=kasir_test SEED_PASSWORD=<pw-uji> SEED_PIN=4321 node seed-users.js`, lalu jalankan server `DB_NAME=kasir_test PORT=3100 node server.js` di background. Skrip uji punya helper `login(username)` → token dan `call(token, method, path, body)` → `{status, body}`. Verifikasi: login admin/supervisor/kasir mengembalikan token.
- [ ] **Step 2: Tulis tes gagal** di `menu-api-tests.mjs`: `kasir_forbidden_on_all_admin_endpoints` (8 endpoint, kasir → 403), `admin_and_supervisor_allowed`, `create_product_with_initial_stock` (stok 10 → produk muncul di `GET /api/products` dan `stock_movements` punya `restock` "Stok awal"), `create_product_zero_stock_is_habis`, `edit_product_keeps_stock`, `edit_same_name_other_case_ok`, `duplicate_name_same_category_409`, `deactivate_and_reactivate` (hilang/muncul di `GET /api/products`, idempoten), `validation_matrix` (harga 0/-5/12.5/"abc"/1e9, nama kosong/101 huruf, link `ftp://x`/`javascript:alert(1)`, kategori tak ada → 400; tidak ada baris berubah). Jalankan: semua FAIL (404).
- [ ] **Step 3: Implement `requireRole`, `parseProductInput`, `assertUniqueProductName`** di `server.js` (dekat helper `HttpError`), memakai aturan di Global Constraints.
- [ ] **Step 4: Implement empat endpoint** dengan `authMiddleware` yang sudah berlaku untuk `/api/*` plus `requireAdmin`. `GET` mengembalikan semua produk (aktif dan nonaktif) via `PRODUCT_SELECT` tanpa filter `is_active`, urut kategori lalu nama. `POST` dan stok awal dalam satu transaksi (`insertStockMovement` yang sudah ada, `type='restock'`, `note='Stok awal'`). `PUT` tidak menyentuh `stock`/`is_available`. `PATCH active` menerima `{is_active: boolean}`, 404 bila tak ada.
- [ ] **Step 5: Jalankan tes.** Expected: semua PASS.

### Task 2: Endpoint kategori admin

**Files:**
- Modify: `server.js`
- Test: `<scratchpad>/menu-api-tests.mjs` (tambah)

**Interfaces:**
- Consumes: `requireAdmin`, `HttpError` (Task 1)
- Produces: `POST /api/admin/categories`, `PUT /api/admin/categories/order` (didaftarkan **sebelum** `PUT /api/admin/categories/:id`), `PUT /api/admin/categories/:id`, `DELETE /api/admin/categories/:id`. Semua respons sukses `{ ok: true, ... }`; tambah mengembalikan `{ ok, category }`.

- [ ] **Step 1: Tulis tes gagal:** `create_category_appends_last`, `rename_category`, `duplicate_category_409` (termasuk beda huruf besar/kecil), `reorder_changes_get_categories_order`, `reorder_rejects_incomplete_duplicate_unknown_ids` (kasus Review Focus 1: 400 dan urutan tidak berubah), `delete_category_with_products_409` (juga bila hanya berisi menu nonaktif; pesan memuat jumlah menu), `delete_empty_category_ok`, `category_validation` (nama kosong, 51 huruf).
- [ ] **Step 2: Jalankan tes** → FAIL.
- [ ] **Step 3: Implement empat endpoint.** Urutan dalam satu transaksi bila perlu; duplikat nama ditangkap lewat `ER_DUP_ENTRY` → 409.
- [ ] **Step 4: Jalankan semua tes** → PASS.

### Task 3: Tolak menu nonaktif yang baru ditambahkan ke pesanan

**Files:**
- Modify: `server.js:55-99` (`buildOrderItems`), `server.js:747-798` (`POST /api/orders/:id/items`)
- Test: `<scratchpad>/menu-api-tests.mjs` (tambah)

**Interfaces:**
- Consumes: `priceSnapshot: Map<productId, price>` yang sudah dipakai `buildOrderItems`.
- Produces: `buildOrderItems` memilih kolom `is_active`; produk `is_active = 0` yang tidak ada di `priceSnapshot` → `Error("Menu <nama> sudah dinonaktifkan")`. Rute lama menolak produk nonaktif dengan pesan yang sama kecuali sudah ada di pesanan.

- [ ] **Step 1: Tulis tes gagal:** `new_order_with_inactive_product_rejected` (400 + pesan), `held_order_with_product_deactivated_later_can_resume_and_pay` (buat order → hold → nonaktifkan menu → `PUT` dengan item yang sama berhasil → bayar berhasil dengan harga lama), `price_change_does_not_touch_open_order` (ubah harga → `GET /api/orders/:id` tetap harga lama; order baru memakai harga baru), `rename_does_not_change_old_order_items`, `unsaved_inactive_line_rejected_on_put` (Review Focus 5).
- [ ] **Step 2: Jalankan** → tes penolakan FAIL, tes lanjut/bayar sudah PASS.
- [ ] **Step 3: Implement** perubahan di dua tempat di atas.
- [ ] **Step 4: Jalankan semua tes** → PASS.

### Task 4: Tab "Kelola Menu", dialog, escape, dan placeholder gambar

**Files:**
- Modify: `public/index.html` — tombol tab (setelah `Kelola Stok` di `.nav-tabs`, `id="tab-btn-kelolamenu"`, tersembunyi default), panel `id="tab-pane-kelolamenu"`, modal `modal-menu-form` dan `modal-categories` (letakkan sebelum `modal-supervisor-pin`), JS baru (kelompok "Kelola Menu" dekat fungsi stok), `switchTab` (`btns[5]`), `updateUserProfileHeader` (panggil `applyRoleUi()`), `renderMenu`/`handleImageFallback`, serta semua `innerHTML` yang memasukkan nama produk/kategori.

**Interfaces:**
- Consumes: endpoint Task 1–2; helper klien `api`, `esc`, `showToast`, `openModal`, `closeModal`, `formatRp`, `fetchProducts`, `fetchCategories`, `fetchAlerts`, `currentTab`.
- Produces (fungsi klien):
  - `applyRoleUi(): void` — menampilkan `#tab-btn-kelolamenu` hanya bila `currentUser.role` ∈ {admin, supervisor}.
  - `fetchMenuAdmin(): Promise<void>`, `renderMenuAdmin(): void`, `setMenuAdminFilter(key, value)`.
  - `openMenuForm(productId?: number): void`, `submitMenuForm(): Promise<void>` (flag `menuFormBusy`), `toggleMenuActive(productId: number, active: boolean): Promise<void>` (konfirmasi hanya saat menonaktifkan).
  - `openCategoriesModal(): void`, `renderCategoriesModal(): void`, `addCategory()`, `renameCategory(id)`, `moveCategory(id, dir: -1|1)`, `deleteCategory(id)`.
  - `afterMenuChange(): void` → `fetchCategories(); fetchProducts(); fetchAlerts(); fetchMenuAdmin()` bila `currentTab === 'kelolamenu'`.
  - `menuImageSrc(item): string | null` dan `placeholderHtml(item)` — foto: `image_url`, lalu `DEFAULT_MENU_IMAGES[id]` hanya untuk `id` 1–15, selain itu placeholder (kotak berwarna + huruf pertama nama).

- [ ] **Step 1: Tulis daftar verifikasi browser** (dijalankan lewat panel browser di `http://localhost:3100`): tab muncul untuk admin/supervisor, tidak untuk kasir; tambah menu (stok awal 8) → muncul di Katalog; ubah harga/nama; nonaktifkan (ada konfirmasi) → hilang dari Katalog dan terlihat dengan filter "Tampilkan nonaktif"; aktifkan; kategori: tambah, ganti nama, naik/turun, hapus yang kosong, hapus yang berisi → pesan error; klik ganda Simpan → satu menu; nama `<b>x</b> "q" 🍜` aman di semua tampilan; menu baru tanpa foto → placeholder, menu seed 1–15 tetap berfoto; link foto rusak → placeholder.
- [ ] **Step 2: Implement markup** (tab button, pane, dua modal) mengikuti gaya `modal-restock`/pane Kelola Stok (kelas `modal-card`, `modal-field-label`, `modal-input`, `field-error`, `table-responsive`, `pill-btn`, `btn btn-sm`).
- [ ] **Step 3: Implement fungsi klien** di atas. Dialog menu: stok awal hanya tampil saat tambah; pesan error validasi ditampilkan di `field-error` dan error server lewat `api()` (toast) tanpa menutup dialog.
- [ ] **Step 4: Escape dan placeholder.** Telusuri `innerHTML` yang memuat `.name`, `product_name`, `category_name`, `image_url` (`Grep`), bungkus dengan `esc()`; ganti logika gambar di `renderMenu` dengan `menuImageSrc`/`placeholderHtml`; `handleImageFallback` memakai placeholder yang sama.
- [ ] **Step 5: Jalankan daftar verifikasi** dan perbaiki hingga semua lolos; cek konsol browser bersih dari error.

### Task 5: README, regresi, dan jalankan ulang server

**Files:**
- Modify: `README.md`
- Test: `<scratchpad>/menu-api-tests.mjs`

- [ ] **Step 1: README** — tambah bagian "Kelola Menu" (siapa boleh, tambah/ubah/nonaktifkan, "hapus" = nonaktif, kategori hanya bisa dihapus bila kosong, foto berupa link) dan catatan bahwa pembaruan ini **tidak** memerlukan `npm run db:migrate`; perbarui daftar fitur/struktur bila ada.
- [ ] **Step 2: Regresi** — jalankan seluruh skrip uji API, lalu di browser: alur pesanan (buat, simpan, hold, lanjutkan, bayar, void) dan Kelola Stok (restock, koreksi). Semua harus tetap berfungsi.
- [ ] **Step 3: Bersihkan** — hentikan server uji port 3100, `DROP DATABASE kasir_test`; pastikan `git status` hanya memuat `server.js`, `public/index.html`, `README.md`, `docs/`.
- [ ] **Step 4: Jalankan ulang server utama** (port 3000) agar memakai kode baru (hentikan task latar belakang lama, jalankan `npm start` kembali) dan cek `GET /api/products/stock-summary` serta halaman termuat.
