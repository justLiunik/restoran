# Alur Reservasi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, in this session) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staf dapat mencatat, mengubah, membatalkan reservasi; kasir menerima pengingat; "Tamu Datang" membuka pesanan untuk meja itu; meja dilepas bila tamu tidak datang atau batal.

**Architecture:** Tabel baru `reservations` (migrasi 003). Endpoint `/api/reservations*` dengan semua logika waktu memakai jam dinding WIB sebagai teks yang dihitung di Node. Status meja yang ditampilkan **dihitung** di `GET /api/tables` dari reservasi dan pesanan aktif (kolom `restaurant_tables.status` tidak ditulis oleh fitur ini). Klien menambah kartu Reservasi di tab Denah Meja, dialog form dan rincian, kotak meja biru, dan pengingat lewat pembaruan 15 detik yang sudah ada.

**Tech Stack:** Node.js, Express 4, mysql2 (pool `timezone: '+07:00'`), MySQL 8, HTML/JS tanpa framework, tanpa dependensi baru.

**Spec:** `docs/superpowers/specs/2026-11-19-reservasi-design.md`

## Global Constraints

- Tanpa dependensi baru. UI dan pesan error berbahasa Indonesia; error `{ error: "pesan" }` lewat `HttpError`.
- **Tidak ada `NOW()`/`CURDATE()` pada query reservasi.** "Sekarang" = `nowWib()` (teks `YYYY-MM-DD HH:mm:ss`, WIB) dari Node; selisih waktu dihitung di SQL dari teks itu (`TIMESTAMPDIFF(SECOND, ?, r.reserved_at)`).
- Konstanta server: `REMINDER_MINUTES=30`, `GRACE_MINUTES=15`, `SLOT_MINUTES=120`, `MAX_ADVANCE_DAYS=60`, `PAST_TOLERANCE_MINUTES=5`.
- Format `reserved_at` masuk/keluar API: `YYYY-MM-DD HH:mm` (ketat; tanggal tidak valid seperti 2026-02-30 ditolak).
- Status: `menunggu`, `datang`, `tidak_datang`, `batal`. Hanya `menunggu` yang menahan slot dan boleh diubah.
- Semua peran yang login boleh memakai endpoint reservasi.
- Skema: migrasi `database/migrations/003_reservations.sql` (`CREATE TABLE IF NOT EXISTS` + `UPDATE restaurant_tables SET status='kosong' WHERE status='reservasi'`), serta `database/kasir_restoran.sql` dan salinan `kasir_restoran.sql` di akar (tabel baru; T08 dan T11 `kosong`).
- Jangan commit/push sebelum pengguna meminta. Uji memakai database terpisah (`kasir_old`, `kasir_test`) dan server port 3100; skrip uji di scratchpad, bukan di repo. Database asli hanya dimigrasi pada langkah akhir.

## Review Focus

1. Dua permintaan simpan bersamaan untuk meja dan slot yang sama → tepat satu berhasil.
2. Selisih tepat 120 menit boleh, 119 menit bentrok; mengubah reservasi tanpa mengganti jam/meja tidak bentrok dengan dirinya sendiri.
3. Tanggal/jam tidak valid (`2026-02-30 10:00`, `25:00`, format lain, detik) ditolak; batas `now−5 menit` dan `60 hari` tepat di tepi.
4. Meja yang punya reservasi biru **dan** pesanan aktif menampilkan status pesanan; Tamu Datang ditolak dengan nomor pesanan di pesan.
5. Reservasi `datang` tanpa pesanan: meja `terisi`; membuat pesanan dari meja itu menautkannya (tidak menggantung); Batal melepas meja.
6. Pengingat tidak diulang setiap 15 detik atau saat muat ulang, tetapi muncul lagi bila jam booking diubah.
7. Nama/catatan berisi `<b>`, tanda kutip, dan emoji tampil aman di kartu, dialog, denah, dan notifikasi.

---

### Task 1: Migrasi dan dump database

**Files:**
- Create: `database/migrations/003_reservations.sql`
- Modify: `database/kasir_restoran.sql`, `kasir_restoran.sql` (akar; salinan, jaga sama persis)
- Test (scratchpad): perintah SQL manual

**Interfaces:**
- Produces: tabel `reservations(id BIGINT UNSIGNED PK AI, customer_name VARCHAR(100) NOT NULL, phone VARCHAR(30) NULL, party_size SMALLINT UNSIGNED NOT NULL, table_id INT UNSIGNED NOT NULL FK→restaurant_tables, reserved_at DATETIME NOT NULL, note VARCHAR(255) NULL, status ENUM('menunggu','datang','tidak_datang','batal') NOT NULL DEFAULT 'menunggu', order_id BIGINT UNSIGNED NULL FK→orders, arrived_at DATETIME NULL, created_by INT UNSIGNED NOT NULL FK→users, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`; indeks `(table_id, status, reserved_at)` dan `(status, reserved_at)`.

- [ ] **Step 1: Siapkan DB `kasir_old`** dari dump **sebelum diedit** (ganti nama database dengan `sed`, pastikan `grep -c kasir_restoran` hasilnya 0 sebelum dimasukkan), jalankan `DB_NAME=kasir_old SEED_PASSWORD=<pw-uji> SEED_PIN=4321 node seed-users.js`. Verifikasi: `SELECT code,status FROM restaurant_tables WHERE status='reservasi'` mengembalikan T08 dan T11; tabel `reservations` belum ada.
- [ ] **Step 2: Tulis migrasi 003** sesuai Interfaces (idempotent) dan perbarui kedua dump (definisi tabel setelah `orders`, T08/T11 `kosong`).
- [ ] **Step 3: Jalankan `DB_NAME=kasir_old node migrate.js`** dua kali. Expected: kedua kali sukses; `reservations` ada; T08/T11 `kosong`; `SHOW CREATE TABLE reservations` memuat FK dan indeks.
- [ ] **Step 4: Buat `kasir_test`** dari dump baru, seed user, lalu verifikasi tabel `reservations` ada dan tidak ada meja berstatus `reservasi`. Jalankan server uji: `DB_NAME=kasir_test PORT=3100 node --watch server.js` (background).

### Task 2: Endpoint reservasi

**Files:**
- Modify: `server.js` (blok helper reservasi dekat helper menu; rute di bagian master data sebelum `GET /api/tables`)
- Test (scratchpad): `reservation-api-tests.mjs` (helper `call`, `login`, `ensureShift` seperti `menu-api-tests.mjs`; helper `wib(offsetMinutes)` → `YYYY-MM-DD HH:mm`; koneksi mysql2 ke `kasir_test` lewat `createRequire('E:/restoran/package.json')` + `dotenv` dari `.env` untuk menggeser `reserved_at` ke masa lalu)

**Interfaces:**
- Produces:
  - `const RESERVATION = { REMINDER_MINUTES, GRACE_MINUTES, SLOT_MINUTES, MAX_ADVANCE_DAYS, PAST_TOLERANCE_MINUTES }`
  - `function nowWib(): string` → `YYYY-MM-DD HH:mm:ss` (UTC+7 dari `Date.now()`)
  - `function parseReservedAt(value): string` → `YYYY-MM-DD HH:mm:00`; `HttpError(400)` bila format/tanggal tidak valid
  - `function parseReservationInput(body): { customer_name, phone, party_size, table_id, reserved_at, note }`
  - `async function assertSlotFree(conn, tableId, reservedAt, exceptId = null)` → `HttpError(409)` memuat kode meja, jam `HH:mm`, nama
  - `function reservationPhase(secondsUntil): 'later'|'soon'|'now'|'late'`
  - `async function loadReservation(connOrDb, id)` → baris lengkap: `id, customer_name, phone, party_size, table_id, table_code, table_capacity, reserved_at ('YYYY-MM-DD HH:mm'), note, status, order_id, order_no, arrived_at, seconds_until, minutes_until (=ceil(seconds_until/60)), phase (null bila status bukan menunggu)`
  - Endpoint: `GET /api/reservations` → `{ config:{reminder_minutes,grace_minutes,slot_minutes}, now, reservations:[...] }` (sejak 7 hari lalu, urut `reserved_at`), `POST /api/reservations` (201 `{ok, reservation}`), `PUT /api/reservations/:id`, `POST /api/reservations/:id/arrive` (`{ok, reservation, table:{id,code}}`), `POST /api/reservations/:id/no-show`, `POST /api/reservations/:id/cancel` (`{ok, reservation}`).

- [ ] **Step 1: Tulis tes gagal** (`reservation-api-tests.mjs`): `all_roles_create_and_unauthenticated_401`; `create_and_list_sorted_by_time` (format teks, konfigurasi, `minutes_until`, urutan); `time_rules` (now−4 menit boleh, now−6 ditolak, 60 hari boleh, 61 ditolak, `2026-02-30 10:00`, `25:00`, `2026-11-20 10:00:30`, kosong → 400); `validation_matrix` (nama kosong/101 huruf, jumlah 0/51/1.5/"abc", meja tak ada, telepon berhuruf, catatan 256 → 400 dan tidak ada baris baru); `slot_conflict_rules` (119 menit 409 dengan pesan memuat kode meja, jam, nama; tepat 120 menit 201; meja lain 201; setelah cancel slot bebas; dua POST bersamaan via `Promise.all` → satu 201 dan satu 409); `edit_rules` (hanya menunggu; konflik tidak menghitung dirinya; ganti meja/jam; status akhir → 409; 404); `arrive_rules` (sukses → status datang + `arrived_at` + `table`; kedua kali 409; meja dengan pesanan aktif → 409 pesan memuat nomor pesanan dan reservasi tetap menunggu; meja dengan reservasi datang tanpa pesanan → 409); `no_show_after_grace` (sebelum → 400 pesan memuat `HH:mm`; setelah menggeser `reserved_at` ke now−20 menit lewat SQL → 200; kedua kali 409); `cancel_rules` (menunggu → batal; datang tanpa pesanan → batal; datang dengan pesanan → 409; batal lagi → 409). Jalankan → semua FAIL (404).
- [ ] **Step 2: Implement helper** `RESERVATION`, `nowWib`, `parseReservedAt`, `parseReservationInput`, `reservationPhase`, `assertSlotFree` (kunci baris meja `SELECT id FROM restaurant_tables WHERE id=? FOR UPDATE` dipanggil pemanggil; hitung bentrok `ABS(TIMESTAMPDIFF(MINUTE, r.reserved_at, ?)) < SLOT` hanya untuk status `menunggu`, kecuali `exceptId`), `loadReservation`.
- [ ] **Step 3: Implement enam endpoint** dengan transaksi + kunci meja pada create/edit/arrive. `arrive` memeriksa pesanan aktif di meja (status di `ACTIVE_ORDER_STATUSES`) dan reservasi `datang` tanpa `order_id` lain di meja itu; `no-show` memeriksa `nowWib() ≥ reserved_at + GRACE`; `cancel` boleh untuk `menunggu` atau `datang` tanpa `order_id`.
- [ ] **Step 4: Jalankan tes** → semua PASS.

### Task 3: Status meja turunan, tautan pesanan, dan pengingat

**Files:**
- Modify: `server.js` (`GET /api/tables`, `POST /api/orders`, `GET /api/dashboard/alerts`)
- Test (scratchpad): `reservation-api-tests.mjs` (tambah)

**Interfaces:**
- Consumes: `nowWib`, `RESERVATION`, `reservationPhase`, `loadReservation` (Task 2)
- Produces: `GET /api/tables` — tiap meja memuat `status` (turunan), `reservation: { id, customer_name, party_size, reserved_at ('HH:mm' dan 'YYYY-MM-DD HH:mm' pada `reserved_at_full`), phase } | null`, `seated_reservation: { id, customer_name } | null`, `next_reservation_at: 'HH:mm' | null`. `GET /api/dashboard/alerts` memuat `reservations: [{ id, customer_name, table_code, party_size, reserved_at ('HH:mm'), reserved_at_full, minutes_until, phase }]` untuk reservasi `menunggu` dengan `seconds_until ≤ 30*60`, termasuk yang sudah lewat.

- [ ] **Step 1: Tulis tes gagal:** `table_status_derivation` (meja bebas → `kosong` + `next_reservation_at` untuk reservasi > 30 menit hari ini; reservasi 20 menit lagi → `reservasi` + objek `reservation`; reservasi yang jamnya sudah lewat (geser lewat SQL) tetap `reservasi` sampai diselesaikan; setelah arrive → `terisi` + `seated_reservation`; pesanan aktif di meja mengalahkan reservasi; setelah cancel → `kosong`); `order_links_seated_reservation` (arrive → `POST /api/orders` untuk meja itu → `GET /api/reservations` menunjukkan `order_id`/`order_no`; bayar → meja `kosong`, reservasi tetap `datang`); `seated_without_order_can_be_cancelled_and_table_released`; `alerts_include_due_reservations` (25 menit lagi dan yang terlambat masuk; 90 menit lagi tidak; yang sudah datang/batal tidak); `walk_in_orders_unaffected` (pesanan di meja tanpa reservasi, dan di meja yang reservasinya > 30 menit lagi, tetap berhasil). Jalankan → FAIL.
- [ ] **Step 2: Implement turunan status** di `GET /api/tables`: ambil meja seperti sekarang, lalu satu query reservasi relevan (`menunggu` dengan `seconds_until ≤ 30*60`, `menunggu` berikutnya hari ini, `datang` tanpa `order_id`), hitung status di Node dengan prioritas pada spec (pesanan aktif → datang tanpa pesanan → reservasi dalam jendela → tersimpan).
- [ ] **Step 3: Tautkan di `POST /api/orders`:** untuk `dine_in` dengan `table_id`, dalam transaksi yang sama, `UPDATE reservations SET order_id = ? WHERE table_id = ? AND status = 'datang' AND order_id IS NULL`.
- [ ] **Step 4: Tambah `reservations` ke `GET /api/dashboard/alerts`.**
- [ ] **Step 5: Jalankan semua tes** (reservasi dan `menu-api-tests.mjs`) → PASS.

### Task 4: Kartu Reservasi, form, dan dialog rincian

**Files:**
- Modify: `public/index.html` — kartu di `#tab-pane-meja` (antara denah dan Antrean), modal `modal-reservation-form` dan `modal-reservation-detail`, CSS, JS baru (kelompok "RESERVASI").

**Interfaces:**
- Consumes: API Task 2–3; helper klien `api`, `esc`, `showToast`, `openModal`, `closeModal`, `askConfirm`, `guardUnsaved`, `startNewOrder`, `fetchTables`, `fetchAlerts`, `tables`.
- Produces (fungsi klien): `fetchReservations(): Promise<void>`, `setReservationFilter('menunggu'|'hari_ini'|'semua')`, `renderReservations(): void`, `openReservationForm(id?: number)`, `updateReservationCapacityWarning()`, `submitReservationForm(): Promise<void>` (flag `reservationBusy`), `openReservationDetail(id)`, `reservationAction(id, 'arrive'|'no-show'|'cancel'): Promise<void>`, `afterReservationChange(): Promise<void>` (`fetchReservations` + `fetchTables` + `fetchAlerts`). `fetchReservations` juga dipanggil dari `fetchAllData` dan interval 15 detik.

- [ ] **Step 1: Daftar verifikasi browser** (server uji port 3100, login lewat API): tambah reservasi lewat form (peringatan kapasitas muncul untuk 6 tamu di meja 2 kursi; error bentrok tampil di dialog tanpa menutupnya); urutan dan filter Menunggu/Hari ini/Semua; ubah (hanya menunggu); Tamu Datang; Tidak Datang nonaktif sebelum masa tenggang dengan keterangan jam; Batal dengan konfirmasi; nama `<b>x</b> "q" 🍜` aman; lebar tablet tanpa gulir horizontal; tanpa error konsol.
- [ ] **Step 2: Implement markup** (kartu, dua modal) mengikuti gaya kartu/modal yang ada (`card-title-bar`, `pill-btn`, `modal-card`, `modal-field-label`, `modal-input`, `field-error`, `btn-touch`).
- [ ] **Step 3: Implement fungsi klien** di atas. Form: nama, telepon, jumlah tamu, meja (hanya `<option>` kode + kapasitas + area dari `tables`), tanggal (bawaan hari ini WIB dari `now` server), jam, catatan. Lencana fase dari `phase`/`minutes_until`.
- [ ] **Step 4: Jalankan daftar verifikasi** dan perbaiki hingga lolos.

### Task 5: Denah meja, alur Tamu Datang, dan pengingat

**Files:**
- Modify: `public/index.html` — `renderTables`, `handleTableClick`, `fetchAlerts`, `fetchAllData`, interval polling, CSS kotak meja.

**Interfaces:**
- Consumes: Task 4; `tables[].reservation`, `seated_reservation`, `next_reservation_at`; `data.reservations` dari alerts.
- Produces: `arriveReservation(id): Promise<void>` (`guardUnsaved` → `POST …/arrive` → `startNewOrder({ target: code, table_id, type: 'dine_in', customer_name })` → `afterReservationChange()`); `openSeatedTable(tbl)` (klik meja `terisi` tanpa pesanan aktif → `guardUnsaved` → `startNewOrder` untuk meja itu dengan nama tamu); `checkReservationReminders(list): void` (toast sekali per `id|reserved_at_full|phase`, disimpan di `sessionStorage` kunci `pos_resv_reminded`); lonceng menampilkan entri per reservasi dengan judul "Reservasi 30 menit lagi" / "Waktunya reservasi" / "Reservasi terlambat N menit".

- [ ] **Step 1: Daftar verifikasi browser:** meja biru menampilkan jam dan nama; klik meja biru membuka dialog rincian; meja kosong dengan reservasi nanti menampilkan "Resv HH:mm"; Tamu Datang → meja Terisi + panel pesanan baru terbuka dengan nama tamu, simpan pesanan → reservasi menampilkan nomor pesanan; buang pesanan → meja tetap Terisi, klik meja membuka panel lagi, Batal melepas meja; Tamu Datang di meja yang dipakai → pesan tampil dan tidak ada perubahan; pengingat: toast sekali (muat ulang dan polling berikutnya tidak mengulang), jam diubah → pengingat baru, setelah diselesaikan entri lonceng hilang; klik meja biru tidak membuka pesanan tamu biasa.
- [ ] **Step 2: Implement** perubahan `renderTables` (kelas dari `status` turunan; baris jam+nama pada biru; "Resv HH:mm" pada kosong), `handleTableClick` (cabang `reservasi` → dialog rincian; `terisi` tanpa `active_order_id` dengan `seated_reservation` → `openSeatedTable`), `arriveReservation`, `checkReservationReminders`, serta penyisipan entri lonceng di `fetchAlerts` dan panggilan `fetchReservations` pada interval.
- [ ] **Step 3: Jalankan daftar verifikasi**; geser jam reservasi lewat SQL pada DB uji untuk menguji fase `soon`/`now`/`late`.

### Task 6: README, regresi, migrasi database asli, dan jalankan ulang server

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README** — bagian "Reservasi" (alur, aturan 30/15/120 menit, status meja, siapa boleh), catatan **wajib `npm run db:migrate`** (migrasi 003 membuat tabel dan mengembalikan T08/T11 ke Kosong), dan perbarui bagian struktur/daftar fitur bila perlu.
- [ ] **Step 2: Regresi** — jalankan `menu-api-tests.mjs` dan `reservation-api-tests.mjs` (semua PASS); di browser: pesanan dine-in/take away, simpan, hold, lanjutkan, bayar, void, Kelola Stok, Kelola Menu.
- [ ] **Step 3: Bersihkan** — hentikan server uji, `DROP DATABASE kasir_test; DROP DATABASE kasir_old`; `git status` hanya memuat `server.js`, `public/index.html`, `README.md`, kedua dump, migrasi 003, dan `docs/`.
- [ ] **Step 4: Migrasi database asli** — periksa dulu `SELECT id,code,status FROM restaurant_tables WHERE status='reservasi'` (harus hanya T08/T11 tanpa reservasi nyata), jalankan `npm run db:migrate`, verifikasi tabel ada dan meja kembali `kosong`.
- [ ] **Step 5: Jalankan ulang server utama** (port 3000, hentikan yang lama lalu `npm start`) dan cek halaman, `GET /api/tables`, dan `GET /api/reservations` dengan login admin.
