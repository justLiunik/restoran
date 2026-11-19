# User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, in this session). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Admin mengelola user dari tab "Kelola User", semua peran bisa mengganti password sendiri, dan perubahan akun berlaku seketika.

**Architecture:** Kolom `users.session_version` (migrasi 005); `authMiddleware` memuat user dari database di tiap permintaan (peran dari database, cek aktif dan `sv`); endpoint `/api/me*` dan `/api/admin/users*`; `seed-users.js` aman secara bawaan; klien: tombol 🔑 + dialog Akun Saya, tab Kelola User, sinkron `/api/me`.

**Tech Stack:** Node.js, Express 4, bcryptjs, jsonwebtoken, mysql2, MySQL 8, HTML/JS tanpa framework, tanpa dependensi baru.

**Spec:** `docs/superpowers/specs/2026-11-19-user-management-design.md`

## Global Constraints

- Tanpa dependensi baru. UI dan pesan berbahasa Indonesia; error `{ error }` lewat `HttpError`.
- Username `^[a-z0-9._-]{3,30}$` (input diubah ke huruf kecil), nama 1–100, password 8–72 karakter, PIN `^\d{4}$`; peran `kasir|supervisor|admin`.
- `password_hash` dan `pin_hash` tidak pernah ada di respons. bcrypt dengan 10 putaran (seperti `seed-users.js`).
- Token lama tanpa `sv` = `sv 0`. Peran selalu dari database.
- Jangan commit/push sebelum diminta (perubahan laporan penjualan juga belum di-commit; keduanya ada di working tree). Uji memakai DB terpisah `kasir_test`/`kasir_old` dan server port 3100; skrip uji di scratchpad; DB asli dimigrasi di langkah akhir. Uji tidak mengubah akun bawaan (`admin`, `spv`, `budi`, `sari`) kecuali yang dikembalikan di akhir.

## Review Focus

1. Dua admin yang saling menurunkan bersamaan → selalu tersisa satu admin aktif.
2. Dua admin menyimpan PIN yang sama untuk dua supervisor bersamaan → satu berhasil.
3. Token sebelum migrasi (tanpa `sv`) tetap valid; token user nonaktif/tidak ada → 401 (klien keluar otomatis).
4. Kasir (juga supervisor) tidak bisa memanggil endpoint admin user atau `PUT/POST` lain dengan token yang peran aslinya sudah berubah.
5. Nama berisi `<b>`, tanda kutip, emoji aman (di-escape) di tabel, dialog, dan header.
6. `db:seed` bawaan tidak menyentuh password yang sudah diganti.

---

### Task 1: Migrasi 005, dump, dan seed yang aman

**Files:** Create `database/migrations/005_user_session_version.sql`; Modify `database/kasir_restoran.sql`, `kasir_restoran.sql` (identik), `seed-users.js`, `package.json` (tidak perlu bila skrip tetap).

**Interfaces:** Produces `users.session_version INT UNSIGNED NOT NULL DEFAULT 0`; `seed-users.js` mendukung `--all` / `SEED_ALL=1`.

- [ ] **Step 1:** Buat `kasir_old` dari dump **sebelum diedit** + seed user (uji); verifikasi kolom belum ada.
- [ ] **Step 2:** Tulis migrasi idempotent (pola 004) dan perbarui kedua dump (kolom di definisi `users`).
- [ ] **Step 3:** `DB_NAME=kasir_old node migrate.js` dua kali → sukses; kolom ada; semua `session_version = 0`.
- [ ] **Step 4:** Ubah `seed-users.js`: bawaan hanya `UPDATE ... WHERE password_hash = 'GANTI_DENGAN_HASH_BCRYPT'` dan PIN supervisor/admin yang masih placeholder; `--all`/`SEED_ALL=1` menimpa semua (dan menaikkan `session_version`, dibungkus try/catch bila kolom belum ada); pesan jelas bila tidak ada yang diisi.
- [ ] **Step 5:** Buat `kasir_test` dari dump baru + seed (`SEED_PASSWORD`/`SEED_PIN` uji); jalankan `node --watch server.js` di port 3100.

### Task 2: Backend

**Files:** Modify `server.js`; Test (scratchpad) `user-api-tests.mjs`.

**Interfaces:**
- Produces:
  - `authMiddleware` async: `req.user = { id, name, username, role }` dari database; 401 bila user tidak ada/nonaktif atau `sv` tidak cocok.
  - `function signUserToken(user): string` (payload `{id, username, name, role, sv}`, 8 jam).
  - `function parseUserInput(body, { creating }): { name, username, role, password?, pin? }` (`HttpError(400)`).
  - `async function withPinLock(fn)` — `GET_LOCK('kasir_user_pin', 5)` pada koneksi khusus, `RELEASE_LOCK` di `finally`; `HttpError(503)` bila gagal.
  - `async function assertPinUnique(conn, pin, exceptUserId)` → `HttpError(409)`.
  - Endpoint sesuai tabel pada spec.
- Consumes: `requireRole`, `HttpError`, `bcrypt`.

- [ ] **Step 1: Tulis tes gagal** (`user-api-tests.mjs`; pengguna uji dibuat sendiri): `auth_and_roles`, `create_user`, `validation_matrix`, `pin_rules_and_verify_pin`, `pin_race`, `edit_user_and_role_rules`, `last_admin_guard_race` (menonaktifkan sementara admin bawaan lewat SQL dan memulihkannya di `finally`), `password_reset_and_sessions`, `deactivate_activate`, `role_change_immediate`, `legacy_token_and_unknown_user`, `me_password_and_pin`, `no_hashes_in_responses`, `seed_script` (jalankan `node seed-users.js` dengan `DB_NAME=kasir_test`; bawaan hanya placeholder, `--all` menimpa semua). Jalankan → FAIL.
- [ ] **Step 2: Implement** helper dan middleware (login memakai `signUserToken`, menyertakan `sv`).
- [ ] **Step 3: Implement `/api/me`, `/api/me/password`, `/api/me/pin`** (tidak melewati `requireAdmin`).
- [ ] **Step 4: Implement `/api/admin/users*`** dengan `requireRole('admin')`, transaksi, `FOR UPDATE` pada baris admin untuk penjaga admin terakhir, dan `withPinLock` untuk semua penyimpanan PIN.
- [ ] **Step 5:** Jalankan `user-api-tests.mjs` dan tes lama (`menu`, `reservation`, `table`, `report`) → semua PASS.

### Task 3: Klien

**Files:** Modify `public/index.html` (header, modal Akun Saya, tab dan modal Kelola User, CSS kecil, JS, `applyRoleUi`, `switchTab`, polling).

**Interfaces:**
- Consumes: Task 2; `api`, `esc`, `showToast`, `openModal`, `closeModal`, `askConfirm`, `parseStockInput`, `currentUser`, `authToken`.
- Produces: `openMyAccount()`, `submitMyPassword()`, `submitMyPin()`, `syncMe(): Promise<void>`, `fetchUsersAdmin()`, `renderUsersAdmin()`, `openUserForm(id?)`, `submitUserForm()`, `openUserSecret(id, 'password'|'pin')`, `submitUserSecret()`, `toggleUserActive(id, makeActive)`, `isAdminRole(): boolean`.

- [ ] **Step 1: Daftar verifikasi browser** (server uji 3100): tombol 🔑 untuk semua peran dan Akun Saya (PIN hanya supervisor/admin); ganti password sendiri → tetap login dan token baru tersimpan; tab Kelola User hanya admin; tambah (peran kasir/supervisor, PIN), ubah, reset password, atur PIN, nonaktifkan (konfirmasi) dan aktifkan; tombol dimatikan untuk diri sendiri; kesalahan server tampil di dialog; peran diubah admin lain → tampilan pengguna itu menyesuaikan dalam 15 detik tanpa login ulang; user dinonaktifkan → keluar otomatis; teks berbahaya aman; lebar tablet; konsol bersih.
- [ ] **Step 2: Implement** markup dan fungsi (pola dialog Atur Meja/Kelola Menu); `applyRoleUi` menampilkan tab untuk admin saja; polling 15 detik memanggil `syncMe()`.
- [ ] **Step 3:** Jalankan daftar verifikasi dan perbaiki sampai lolos.

### Task 4: README, migrasi DB asli, regresi, jalankan ulang

**Files:** Modify `README.md`.

- [ ] **Step 1: README:** bagian "Kelola User" (siapa boleh, aksi, aturan, sesi berlaku seketika, Akun Saya), `db:seed -- --all`, catatan **wajib `npm run db:migrate`**, perbarui bagian login/seed dan pemecahan masalah.
- [ ] **Step 2: Regresi:** semua rangkaian tes API PASS; browser: login/logout, void/diskon dengan PIN, alur pesanan.
- [ ] **Step 3: Bersihkan:** hentikan server uji, drop `kasir_test`/`kasir_old`; `git status` hanya berkas yang diharapkan.
- [ ] **Step 4: DB asli:** `npm run db:migrate`, verifikasi kolom dan semua user `session_version = 0` dan masih bisa login; jalankan ulang server utama (port 3000) dan cek endpoint dengan login admin.
