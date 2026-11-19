# Kelola Pajak & Service — Rencana

Desain: `docs/superpowers/specs/2026-11-19-pajak-service-design.md`

Urutan dipilih supaya setiap langkah bisa diuji sebelum langkah berikutnya.

- [x] **1. Migrasi 006 dan dump SQL**
  - `database/migrations/006_tax_service_settings.sql`: tabel `app_settings` + `INSERT IGNORE` 10/5; kolom
    `orders.tax_rate`, `orders.service_rate`; isi pesanan lama hanya saat kolom baru ditambahkan (cek
    `information_schema` disimpan di variabel sebelum `ADD COLUMN`).
  - `database/kasir_restoran.sql` dan salinan di akar: tabel, kolom, tarif pada tiga pesanan contoh (tetap identik).
  - Uji: DB lama (`kasir_old`) dimigrasi dua kali; tarif yang diubah di antaranya tidak tertimpa.
- [x] **2. Server**
  - Helper `parseRate`, `loadChargeSettings(conn, {forUpdate|forShare})`, `effectiveRates(orderType, settings)`,
    `chargeAmount(taxable, rate)`; `calculateOrderTotals(items, discountPercent, rates)`.
  - `POST /api/orders` membaca tarif (FOR SHARE) dan menyimpan snapshot; `PUT /:id`, add-item, patch qty, dan `pay`
    memakai tarif milik pesanan.
  - `GET /api/settings/charges` (semua peran) dan `PUT /api/admin/settings/charges` (`requireOnlyAdmin`).
  - Uji API di scratchpad: `charges-api-tests.mjs` (butir 1–7 desain).
- [x] **3. Klien**
  - `chargeRates` + `fetchChargeRates()` (dimuat di `fetchAllData`, dan di polling 15 detik); `orderAmounts(order)`
    menggantikan empat salinan hitungan; `orderFromServer` membawa `taxRate`/`serviceRate`.
  - Label dan baris panel dinamis (baris 0 disembunyikan), kartu header dinamis + tombol **Atur** (admin),
    dialog `modal-charges` dengan pratinjau hidup dan konfirmasi, struk memakai tarif pesanan.
  - `payCurrentOrder`: bandingkan total setelah simpan dengan total yang tampil; berbeda → hentikan dengan pemberitahuan.
- [x] **4. Verifikasi dan dokumen**
  - Uji di browser (butir 9), regresi semua suite API yang ada (menu 26, reservasi 14, meja 9, laporan 9, user 14).
  - README: bagian Kelola Pajak & Service, catatan `db:migrate`, troubleshooting; migrasi DB asli.
