# Laporan Penjualan — Desain (singkat)

Tanggal: 2026-11-19
Status: disetujui

## Tujuan dan alasan

Tab "Penjualan & Laporan" hanya menampilkan tiga hal untuk hari ini (penjualan per metode, per jam, 5 menu terlaris)
dan terbuka untuk semua peran. Pemilik/supervisor butuh laporan untuk periode mana pun, rincian yang lebih lengkap,
dan ekspor ke Excel.

**Temuan:** `payments.amount` menyimpan **uang yang diserahkan pelanggan**, bukan nilai penjualan (data nyata: INV-0002
tagihan Rp 51.750, dibayar Tunai Rp 100.000). Akibatnya "Penjualan Berdasarkan Metode" dan "kas yang seharusnya" saat tutup
shift (juga angka kas shift di header) terlalu besar sebesar kembalian. Laporan memakai nilai **bersih**, dan perhitungan kas
shift diperbaiki dengan cara yang sama.

## Sasaran

- Tab "Penjualan & Laporan" mendapat **pemilih periode**: Hari ini, Kemarin, 7 hari terakhir, Bulan ini, Bulan lalu, atau
  tanggal dari–sampai (maksimal 366 hari). Semua bagian mengikuti periode.
- **Ringkasan**: total penjualan, jumlah transaksi, rata-rata, subtotal, diskon, pajak, service, void (jumlah dan nilai).
- **Rincian**: penjualan per hari (periode > 1 hari; per bulan bila > 31 hari), per metode bayar (bersih), per tipe pesanan
  (dine-in, take away, GoFood, GrabFood, ShopeeFood), per kasir, per menu (jumlah dan omzet, status stok), dan per jam.
- **Ekspor CSV**: transaksi, dan penjualan per menu. Pemisah titik koma + BOM UTF-8 (terbuka rapi di Excel Indonesia).
- Kasir hanya melihat laporan hari ini; admin dan supervisor bisa memilih periode dan mengekspor (server memaksa aturan ini).
- Kas shift (tutup shift dan angka di header) dihitung dengan nilai bersih.

## Bukan sasaran

- Ekspor .xlsx/PDF, cetak khusus, grafik interaktif, perbandingan antarperiode, laporan laba rugi/HPP, laporan per shift,
  perubahan pada kartu angka "hari ini" di bagian atas halaman.

## Anti-sasaran

- Angka laporan tidak cocok dengan transaksi (void ikut terhitung, kembalian ikut terhitung, atau hari bergeser karena zona waktu).
- Kasir melihat penjualan periode lain atau mengekspor, termasuk lewat permintaan buatan sendiri.
- Isi CSV dijalankan sebagai rumus oleh Excel (nama pelanggan yang diawali `=`, `+`, `-`, `@`).

## Pendekatan

Satu endpoint laporan `GET /api/reports/sales` mengembalikan semua bagian sekaligus (satu pembacaan data, angka selalu konsisten
satu sama lain), ditambah satu endpoint ekspor. Tab yang ada ditingkatkan (bukan tab baru). Tiga endpoint dashboard lama yang
hanya dipakai tab ini (`payment-methods`, `hourly`, `best-sellers`) dihapus karena digantikan dan salah menghitung metode bayar.
Pembagian kembalian dilakukan di Node (bukan SQL) supaya pembayaran ganda tetap tepat.

## Keputusan

- **Tanpa perubahan skema**, tanpa migrasi.
- **Yang dihitung**: pesanan `selesai` menurut `closed_at` (tanggal pembayaran) pada jam MySQL (WIB di Docker); batas periode
  dibandingkan sebagai teks `YYYY-MM-DD 00:00:00` sampai hari berikutnya (tanpa `DATE()` pada kolom). "Hari ini" memakai
  `CURDATE()` MySQL agar cocok dengan cara waktu disimpan (`NOW()`). Total sudah termasuk pajak dan service (sama seperti kartu
  Total Penjualan). Void dipisah: pesanan `void` menurut `COALESCE(closed_at, opened_at)`; tidak masuk penjualan.
- **Nilai bersih per pembayaran**: kembalian = jumlah dibayar − total pesanan (≥ 0), dikurangkan dari pembayaran Tunai
  (yang terakhir dulu), lalu dari pembayaran lain bila masih ada sisa. Helper `netPaymentAmounts(payments, orderTotal)`.
- **Kas shift**: `expected_cash` = kas awal + Σ pembayaran Tunai bersih + kas masuk − kas keluar (di `GET /api/shifts/current`
  dan `POST /api/shifts/close`); pembayaran tetap dihitung seperti sebelumnya, hanya kembalian yang dikurangkan.
- **Per kasir** = kasir yang menerima pembayaran (`shifts.cashier_id` lewat `orders.shift_id`), bukan pembuat pesanan.
- **Per menu**: omzet = Σ `qty × harga` saat transaksi (sebelum diskon, pajak, service) sehingga tidak sama dengan total
  penjualan; nama menu memakai nama saat ini, dikelompokkan per `product_id`.
- **Endpoint** (login wajib):

| Endpoint | Izin | Fungsi |
|---|---|---|
| `GET /api/reports/sales?from&to` | semua peran; kasir hanya hari ini | `period`, `summary`, `daily`, `payment_methods`, `order_types`, `cashiers`, `products`, `hourly` |
| `GET /api/reports/export?type=transactions\|products&from&to` | admin, supervisor | berkas CSV |

- **Validasi periode**: `from` dan `to` harus berpasangan (atau keduanya kosong = hari ini), format `YYYY-MM-DD` dan tanggal
  nyata, `from ≤ to`, maksimal 366 hari; selain itu 400. Kasir dengan periode selain hari ini → 403.
- **CSV**: BOM UTF-8, pemisah `;`, baris `CRLF`, bidang berisi `;` `"` atau baris baru dikutip, bidang yang diawali `=`, `+`, `-`,
  `@` diberi awalan `'`. Transaksi: No, Waktu, Status (Selesai/Void), Tipe, Meja/Platform, Pelanggan, Kasir, Metode Bayar,
  Subtotal, Diskon, Pajak, Service, Total, Alasan Void. Menu: Menu, Kategori, Jumlah Terjual, Omzet.
- **Klien**: periode dan tombol ekspor hanya untuk admin/supervisor; ekspor lewat `fetch` + Authorization lalu diunduh sebagai
  berkas; semua teks di-escape.

## Pengujian penerimaan

1. Periode: validasi (format, tanggal tidak nyata, from > to, > 366 hari, hanya satu parameter) → 400; kasir periode lain → 403,
   hari ini → 200; tanpa token → 401.
2. Angka: total/jumlah/rata-rata/diskon/pajak/service sesuai data uji; void tidak masuk penjualan tetapi terhitung di void;
   transaksi di tepi periode (23:59:59 dan 00:00:00) jatuh ke hari yang benar.
3. Metode bayar bersih: Tunai Rp 100.000 untuk tagihan Rp 51.750 dihitung Rp 51.750; pembayaran ganda (QRIS + Tunai berlebih)
   terbagi benar; jumlah semua metode = total penjualan.
4. Tipe pesanan, per kasir (kasir penerima pembayaran), per menu (urutan, omzet, kategori), per jam, per hari (hari kosong = 0).
5. Kas shift: `GET /api/shifts/current` dan tutup shift memakai nilai bersih; selisih sesuai.
6. Ekspor: hanya admin/supervisor, jenis dan periode divalidasi, isi cocok dengan laporan, BOM + `;`, kutipan dan perlindungan
   rumus; jumlah baris transaksi = selesai + void pada periode.
7. Klien: pemilih periode dan preset benar (Bulan lalu = bulan penuh sebelumnya), ekspor mengunduh berkas, tampilan kasir
   hanya hari ini, teks berbahaya aman, lebar tablet rapi.
8. Regresi: alur pesanan/bayar/void, reservasi, kelola menu/stok/meja; kartu angka header tetap benar.
