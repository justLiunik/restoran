# Kelola Pajak & Service — Desain (singkat)

Tanggal: 2026-11-19
Status: disetujui

## Tujuan dan alasan

Pajak 10% dan service 5% tertanam di kode (server dan lima tempat di klien). Admin perlu mengubah tarifnya dari dalam
aplikasi tanpa mengubah kode, dan perubahan itu tidak boleh membuat nota yang sudah terlihat pelanggan berubah angkanya
atau struk lama tercetak dengan label yang salah.

## Sasaran

- Tarif pajak dan tarif service disimpan di database dan bisa diubah admin lewat dialog **Atur** pada kartu header
  "Pajak & Service".
- **Tarif dikunci per pesanan** saat pesanan dibuat. Perubahan hanya berlaku untuk pesanan baru; pesanan terbuka dan
  hold tetap memakai tarif lamanya sampai dibayar atau dibatalkan.
- Label di panel pesanan, struk (termasuk cetak ulang), dan kartu header mengikuti tarif sebenarnya.
- Tarif 0–100, maksimal 2 desimal; 0 berarti dimatikan (barisnya disembunyikan di panel dan struk).

## Bukan sasaran

- Harga sudah termasuk pajak (inclusive), tarif berbeda per menu atau per tipe pesanan.
- Service untuk take-away dan delivery (aturan lama tetap: service hanya dine-in).
- Riwayat perubahan tarif lengkap (hanya "diubah oleh siapa dan kapan" yang terakhir).
- Mengubah nota yang sudah dibayar.

## Anti-sasaran

- Total pesanan yang sudah dilihat pelanggan berubah karena tarif diganti.
- Struk lama tercetak ulang dengan persentase yang salah.
- Kasir atau supervisor bisa mengubah tarif, termasuk lewat permintaan buatan sendiri.
- Tarif aneh (negatif, di atas 100, tiga desimal, bukan angka) tersimpan.
- Total di layar berbeda dari total di server tanpa kasir tahu.

## Pendekatan

Tiga cara dipertimbangkan:

1. Tarif global yang dihitung ulang di setiap simpan/bayar (paling mirip kode sekarang). Ditolak: total pesanan hold bisa
   berubah diam-diam, dan struk lama salah label.
2. Tarif global, tetapi disalin ke pesanan hanya saat dibayar. Ditolak: pesanan terbuka tetap bergeser sebelum dibayar.
3. **Tarif dikunci per pesanan saat dibuat (dipilih).** Dua kolom baru di `orders`; server menghitung dari tarif milik
   pesanan itu. Nota selalu konsisten dengan yang dilihat pelanggan dan struk lama otomatis benar.

## Keputusan

- **Skema**: migrasi `database/migrations/006_tax_service_settings.sql` (idempotent):
  - tabel `app_settings(setting_key PK, setting_value, updated_by → users, updated_at)` berisi `tax_rate=10`,
    `service_rate=5` (`INSERT IGNORE`, tidak menimpa nilai yang sudah diubah);
  - kolom `orders.tax_rate` dan `orders.service_rate` `DECIMAL(5,2)`, diisi untuk pesanan lama hanya saat kolom baru
    ditambahkan: `tax_rate = 10`, `service_rate = 5` untuk dine-in dan `0` untuk lainnya (persis tarif yang selalu
    dipakai). Menjalankan migrasi lagi tidak menyentuh tarif pesanan yang sudah ada.
  Kedua dump SQL diperbarui (tabel, kolom, dan tarif pada tiga pesanan contoh).
- **Tarif efektif**: service pesanan non-dine-in disimpan 0, jadi `service_rate` pesanan = tarif yang benar-benar
  dikenakan. `calculateOrderTotals(items, discountPercent, rates)` memakai `rates = {tax_rate, service_rate}`.
- **Pembulatan**: `Math.round(taxable × tarif × 100 / 10000)` dengan tarif dalam persen dikali 100 sebagai bilangan
  bulat (tanpa kesalahan pecahan biner). Untuk 10% dan 5% hasilnya sama dengan sebelumnya. Klien memakai rumus yang
  sama persis.
- **Endpoint**:

| Endpoint | Izin | Fungsi |
|---|---|---|
| `GET /api/settings/charges` | semua peran | `{tax_rate, service_rate, updated_at, updated_by_name}` |
| `PUT /api/admin/settings/charges` | hanya `admin` | `{tax_rate, service_rate}` → tarif baru; nilai sama dengan yang ada tidak mengubah `updated_*` |

- **Validasi**: angka atau teks angka dengan titik desimal; 0–100; maksimal 2 desimal; kosong/null/NaN/teks → 400
  dengan pesan jelas dan tidak ada yang berubah.
- **Konsistensi**: `POST /api/orders` membaca tarif di dalam transaksinya dengan `FOR SHARE`, sedangkan perubahan tarif
  memakai `FOR UPDATE` pada baris yang sama; sebuah pesanan baru selalu memakai satu pasang tarif utuh (lama atau
  baru), tidak pernah campuran. Pesanan yang ada (simpan, tambah item, ubah qty, bayar) memakai tarif miliknya sendiri.
  Baris pengaturan yang hilang dilaporkan sebagai kesalahan yang menyuruh menjalankan `npm run db:migrate`, bukan
  diam-diam memakai tarif bawaan.
- **Klien**:
  - Satu fungsi hitung (`orderAmounts`) menggantikan empat salinan perhitungan; pesanan yang sudah tersimpan memakai
    tarif dari server, pesanan baru memakai tarif terbaru (diperbarui bersama polling 15 detik dan saat panel terbuka).
  - Dialog **Atur** (admin saja): dua isian, contoh hitung untuk Rp 100.000 yang hidup mengikuti isian, keterangan
    "berlaku untuk pesanan baru", "terakhir diubah oleh … pada …", konfirmasi dengan nilai lama → baru.
  - Bila tarif berubah antara layar dan simpan pesanan baru, pembayaran dihentikan dengan pemberitahuan total terbaru
    (pesanan tetap tersimpan) supaya kasir tidak menagih angka yang salah.
  - Label kartu header, baris panel, dan struk memakai tarif; baris bertarif 0 disembunyikan. Semua teks di-escape.

## Pengujian penerimaan

1. Kasir dan supervisor ke `PUT` → 403, tanpa token 401, admin berhasil; `GET` terbuka untuk semua peran.
2. Validasi (kosong, null, teks, negatif, 100,01, 3 desimal, NaN) → 400 tanpa perubahan; 0, 100, 7,5, "7.50" diterima.
3. Pesanan baru setelah perubahan memakai tarif baru dengan hitungan tepat (mis. 11% dan 6% pada Rp 100.000 →
   11.000, 6.000, total 117.000); take-away dan delivery: service 0 dan `service_rate` 0.
4. Pesanan terbuka dan hold yang dibuat sebelum perubahan tetap memakai tarif lama lewat ubah item, tambah item, ubah
   qty, dan bayar; baris `orders` tidak berubah tarifnya.
5. Tarif 0 menghasilkan pajak/service 0 dan total = subtotal − diskon.
6. `GET /api/orders/:id` dan daftar pesanan membawa `tax_rate` dan `service_rate`; cetak ulang struk lama menampilkan
   persentase lamanya.
7. Perubahan tarif bersamaan dengan pembuatan pesanan tidak menghasilkan pesanan yang nominalnya tidak cocok dengan
   tarif tersimpannya.
8. Migrasi pada database lama: kolom dan tabel ditambahkan, tarif pesanan lama terisi 10/5 (service 0 non-dine-in),
   pengaturan awal 10/5; dijalankan dua kali tidak menimpa tarif yang sudah diubah maupun tarif pesanan.
9. UI: label dinamis, tombol Atur hanya untuk admin, pratinjau hidup, konfirmasi, panel, struk, dan laporan benar.
10. Regresi: alur pesanan, bayar, void, reservasi, stok, Kelola Menu/Meja/User, dan laporan tetap jalan.
