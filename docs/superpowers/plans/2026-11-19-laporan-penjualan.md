# Laporan Penjualan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, in this session). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Laporan penjualan per periode (ringkasan + rincian + ekspor CSV) dan perhitungan kas shift yang benar.

**Architecture:** `GET /api/reports/sales` (satu respons berisi semua bagian) dan `GET /api/reports/export` (CSV) di `server.js`; helper `netPaymentAmounts` dipakai laporan dan kas shift; tab "Penjualan & Laporan" ditulis ulang di `public/index.html`.

**Tech Stack:** Node.js, Express 4, mysql2, MySQL 8, HTML/JS tanpa framework, tanpa dependensi baru, tanpa migrasi.

**Spec:** `docs/superpowers/specs/2026-11-19-laporan-penjualan-design.md`

## Global Constraints

- Tanpa dependensi baru dan tanpa perubahan skema. UI dan pesan berbahasa Indonesia; error `{ error }` lewat `HttpError`.
- Hanya pesanan `selesai` menurut `closed_at`; periode `from..to` inklusif, dibandingkan sebagai teks `YYYY-MM-DD 00:00:00` (batas bawah) dan hari berikutnya (batas atas eksklusif); tanpa `DATE()` pada kolom.
- Periode: `from` dan `to` berpasangan atau keduanya kosong (= hari ini menurut `CURDATE()` MySQL), tanggal nyata, `from ≤ to`, maksimal 366 hari. Kasir hanya boleh hari ini (403 selain itu); ekspor hanya admin/supervisor.
- CSV: BOM UTF-8, pemisah `;`, `CRLF`, kutip bidang, awalan `'` untuk bidang yang diawali `=`, `+`, `-`, `@`.
- Jangan commit/push sebelum diminta. Uji memakai DB terpisah `kasir_test` + server port 3100; skrip uji di scratchpad. DB asli tidak dimigrasi (tidak ada migrasi).

## Review Focus

1. Void tidak pernah masuk penjualan; transaksi tepat 23:59:59 dan 00:00:00 jatuh ke hari yang benar.
2. Kembalian tidak pernah masuk angka metode bayar; Σ metode = total penjualan, termasuk pembayaran ganda.
3. Kasir tidak bisa mendapat periode lain atau ekspor (juga dengan parameter aneh: `from`/`to` hari ini ditulis berbeda format, spasi).
4. Nama pelanggan/menu berbahaya (`=cmd`, `<b>`, tanda kutip, titik koma) aman di CSV dan di layar.
5. Periode tanpa penjualan menampilkan nol (bukan error) dan hari kosong tetap tampil di grafik harian.
6. Kas shift: tutup shift dengan uang yang benar menghasilkan selisih 0.

---

### Task 1: Backend laporan, ekspor, dan kas shift bersih

**Files:** Modify `server.js` (helper dekat helper reservasi/meja; rute sebelum `GET /api/dashboard/summary`; `GET /api/shifts/current` dan `POST /api/shifts/close`; hapus tiga endpoint dashboard lama). Test (scratchpad): `report-api-tests.mjs`.

**Interfaces:**
- Produces:
  - `function netPaymentAmounts(payments: {id, method, amount}[], orderTotal: number): Map<id, number>` — kembalian dikurangkan dari Tunai (id terbesar dulu), lalu dari pembayaran lain.
  - `async function shiftNetCash(conn, shiftId): Promise<number>` — Σ pembayaran Tunai bersih pada shift itu.
  - `function parseReportPeriod(query, user, today): { from, to, fromTs, toTs, days }` (`HttpError` 400/403).
  - `function csvCell(value): string`, `function toCsv(rows: any[][]): string` (BOM + `;` + `CRLF`).
  - Endpoint `GET /api/reports/sales` → `{ period:{from,to,days,today}, summary:{sales_total,transactions,average,subtotal,discount,tax,service,void_count,void_total}, daily:[{date,transactions,total}], payment_methods:[{name,total}], order_types:[{key,label,transactions,total}], cashiers:[{id,name,transactions,total}], products:[{product_id,name,category,qty,revenue,stock,stock_status}], hourly:[{hour,transactions,total}] }`; `GET /api/reports/export?type&from&to` → CSV.
- Consumes: `requireAdmin`, `HttpError`, `stockStatusSql`, `ACTIVE`-independent order tables.

- [ ] **Step 1:** Siapkan `kasir_test` dari dump + seed user (`SEED_PASSWORD`/`SEED_PIN` uji); jalankan server uji `node --watch`. Tulis `report-api-tests.mjs` dengan fixture `sale({...})` (buat pesanan, bayar, lalu geser `orders.closed_at` lewat SQL ke tanggal yang ditentukan di bulan fiktif yang tidak dipakai data awal) dan tes gagal: `period_validation_and_roles`, `summary_numbers_and_void`, `period_edges`, `payment_methods_net`, `types_cashiers_products_hourly_daily`, `empty_period_is_zero`, `shift_cash_net` (tutup shift dengan uang benar → selisih 0; `GET /api/shifts/current` memakai nilai bersih), `export_csv` (peran, validasi, BOM, `;`, kutipan, rumus, jumlah baris). Jalankan → FAIL.
- [ ] **Step 2: Implement helper** `netPaymentAmounts`, `shiftNetCash`, `parseReportPeriod`, `csvCell`/`toCsv`.
- [ ] **Step 3: Implement `GET /api/reports/sales`** (query terpisah per bagian, parameter berupa batas teks; pembayaran bersih dihitung di Node dari pembayaran pesanan selesai pada periode; hari tanpa penjualan diisi nol di Node; `today` dari `SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d')`).
- [ ] **Step 4: Implement `GET /api/reports/export`** (`requireAdmin`, header `Content-Type: text/csv; charset=utf-8` dan `Content-Disposition` dengan nama berkas memuat jenis dan periode).
- [ ] **Step 5: Perbaiki kas shift** di `GET /api/shifts/current` dan `POST /api/shifts/close` dengan `shiftNetCash`; hapus endpoint dashboard `payment-methods`, `hourly`, `best-sellers`.
- [ ] **Step 6:** Jalankan `report-api-tests.mjs` dan tes lama (`menu`, `reservation`, `table`) → semua PASS.

### Task 2: Tab "Penjualan & Laporan"

**Files:** Modify `public/index.html` (markup `#tab-pane-laporan`, CSS, JS: `fetchReports`, renderer baru; hapus `renderPaymentStats`/`renderBestSellers`/`renderHourlyChart` lama bila tak dipakai).

**Interfaces:**
- Consumes: Task 1; `api`, `esc`, `formatRp`, `canManageMenu`, `showToast`, `getStockStatus`, `stockStatusBadge`, `switchTab`.
- Produces: `fetchReports(): Promise<void>` (memuat `reportRange`), `setReportPreset(key)`, `applyReportDates()`, `renderReport(data)`, `downloadReportCsv(type: 'transactions'|'products')`, `reportPresetRange(key, today): {from,to}`, `addDaysStr(dateStr, n)`; state `reportRange {from,to,preset}`, `reportToday`.

- [ ] **Step 1: Daftar verifikasi browser** (server uji 3100, data fixture): kasir hanya melihat laporan hari ini tanpa kontrol periode; admin melihat preset + tanggal; tiap preset menghasilkan rentang benar (Bulan lalu = bulan penuh sebelumnya, 7 hari = hari ini−6..hari ini); tanggal tidak valid/from > to menampilkan pesan; angka ringkasan dan tabel cocok dengan API; grafik harian (≤ 31 hari) dan tabel bulanan (> 31 hari); periode kosong menampilkan nol; "Tampilkan semua" menu; ekspor CSV mengunduh berkas (isi diperiksa lewat `fetch`); nama berbahaya aman; lebar tablet tanpa gulir horizontal; konsol bersih.
- [ ] **Step 2: Implement markup dan fungsi** (gaya kartu/pil yang ada: `card`, `pill-btn`, `stat-card`, `pay-bars`, `chart-bar`, `table-responsive`, `btn-touch`).
- [ ] **Step 3:** Jalankan daftar verifikasi dan perbaiki sampai lolos.

### Task 3: README, regresi, jalankan ulang

**Files:** Modify `README.md`.

- [ ] **Step 1: README:** bagian "Laporan Penjualan" (periode, isi laporan, aturan hitung, nilai bersih, siapa boleh, ekspor CSV dan cara membukanya di Excel) dan catatan perbaikan kas shift; tidak perlu `db:migrate`.
- [ ] **Step 2: Regresi:** semua rangkaian tes API PASS; di browser: bayar tunai dengan kembalian → kas shift header bersih; alur pesanan dan reservasi tetap normal.
- [ ] **Step 3: Bersihkan:** hentikan server uji, drop `kasir_test`; `git status` hanya berkas yang diharapkan.
- [ ] **Step 4:** Jalankan ulang server utama (port 3000) dan cek `GET /api/reports/sales` dengan login admin serta 403 untuk kasir pada periode lain.
