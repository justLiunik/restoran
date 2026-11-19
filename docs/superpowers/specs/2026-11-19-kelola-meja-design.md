# Kelola Meja — Desain (singkat)

Tanggal: 2026-11-19
Status: disetujui

## Tujuan dan alasan

Meja (T01–T12) hanya bisa ditambah, diubah, atau dibuang lewat SQL. Admin dan supervisor perlu mengatur meja dari
dalam aplikasi: menambah meja baru, mengubah kode/kapasitas/area, dan menghentikan pemakaian meja.

## Sasaran

- Tombol **⚙️ Atur Meja** di kartu Denah Meja (hanya admin dan supervisor) membuka dialog daftar meja:
  **Tambah**, **Ubah**, **Nonaktifkan / Aktifkan**.
- Data meja: **kode** (1–10 karakter, unik tanpa membedakan huruf besar/kecil, meja nonaktif ikut dihitung),
  **kapasitas** (bilangan bulat 1–50), **area** (opsional, ≤ 30 karakter; saran dari area yang sudah ada).
- Meja nonaktif hilang dari denah, daftar meja di "Pesanan Baru", dan pilihan meja di form reservasi.
  Riwayat (pesanan, reservasi) tidak berubah.

## Bukan sasaran

- Hapus permanen meja, menggeser tata letak denah, menggabung meja, mengatur urutan (denah tetap menurut urutan
  pembuatan), pengelompokan denah per area.

## Anti-sasaran

- Meja yang sedang dipakai (pesanan aktif, reservasi menunggu, tamu duduk belum memesan) bisa dinonaktifkan.
- Pesanan atau reservasi baru bisa dibuat di meja nonaktif, termasuk lewat permintaan buatan sendiri atau saat
  nonaktifkan dan pembuatan pesanan terjadi bersamaan.
- Kasir bisa memanggil endpoint kelola meja.

## Pendekatan

Satu-satunya cara yang masuk akal: kolom baru `restaurant_tables.is_active` (migrasi 004) dan "hapus" = nonaktifkan,
karena pesanan dan reservasi lama terikat ke meja lewat kunci asing. Semua layar membaca `GET /api/tables`, jadi
menyaringnya di sana cukup untuk denah, "Pesanan Baru", dan form reservasi. Dialog (bukan tab baru) dipilih karena
daftarnya pendek dan polanya sama dengan dialog Kategori di Kelola Menu.

## Keputusan

- **Izin**: `admin` dan `supervisor` (middleware `requireAdmin` yang sudah ada); selain itu 403.
- **Skema**: migrasi `database/migrations/004_table_is_active.sql` menambah `is_active TINYINT(1) NOT NULL DEFAULT 1`
  secara idempotent (cek `information_schema` + `PREPARE`, karena MySQL 8 tidak punya `ADD COLUMN IF NOT EXISTS`);
  kedua dump SQL (database/ dan salinan di akar) diperbarui. README: wajib `npm run db:migrate` setelah `git pull`.
- **Endpoint** (di belakang `requireAdmin`):

| Endpoint | Fungsi |
|---|---|
| `GET /api/admin/tables` | Semua meja termasuk nonaktif: `id, code, capacity, area, is_active, in_use_reason` (teks alasan bila sedang dipakai, selain itu `null`) |
| `POST /api/admin/tables` | Tambah `{code, capacity, area?}` → 201 |
| `PUT /api/admin/tables/:id` | Ubah `{code, capacity, area}` (boleh saat meja dipakai) |
| `PATCH /api/admin/tables/:id/active` | `{is_active}`; idempoten; menonaktifkan ditolak (409) bila meja sedang dipakai |

- **Meja sedang dipakai** = ada pesanan aktif, ada reservasi `menunggu`, atau ada reservasi `datang` yang belum
  punya pesanan. Alasan menyebut apa yang harus diselesaikan (nomor pesanan, jam dan nama reservasi).
- **Kode kembar**: 409; bila yang memakai kode itu meja nonaktif, pesan menyarankan mengaktifkannya kembali.
- **Konsistensi**: `GET /api/tables` hanya mengembalikan meja aktif; `POST /api/orders` (dine-in) dan reservasi
  (buat, ubah) menolak meja nonaktif ("Meja ... tidak aktif"). Pembuatan pesanan dan reservasi mengunci baris meja
  yang sama dengan proses menonaktifkan, sehingga keduanya tidak bisa lolos bersamaan.
- **Klien**: dialog daftar dengan baris Tambah, ubah di tempat, konfirmasi saat menonaktifkan, tombol Nonaktifkan
  dimatikan dengan keterangan alasan bila meja dipakai; setelah perubahan denah dan form reservasi dimuat ulang.
  Semua teks di-escape.

## Pengujian penerimaan

1. Kasir ke semua endpoint kelola meja → 403; tanpa token → 401; admin dan supervisor berhasil.
2. Tambah: kode dipangkas, kapasitas/area valid, muncul di denah sebagai Kosong; kode kembar (beda huruf besar/kecil)
   → 409; validasi (kode kosong/11 karakter, kapasitas 0/51/1.5/teks, area 31 karakter) → 400 tanpa perubahan.
3. Ubah: kode/kapasitas/area berubah, nama kode di pesanan dan reservasi lama ikut; ganti huruf besar/kecil kode sendiri boleh.
4. Nonaktifkan/aktifkan: hilang/muncul di denah, "Pesanan Baru", dan form reservasi; idempoten; riwayat utuh.
5. Nonaktifkan ditolak bila ada pesanan aktif, reservasi menunggu, atau tamu duduk belum memesan; setelah selesai/dibatalkan
   boleh.
6. Meja nonaktif menolak pesanan dine-in baru dan reservasi baru/pindah ke meja itu; nonaktifkan dan buat pesanan
   bersamaan tidak pernah menyisakan meja nonaktif dengan pesanan aktif.
7. Migrasi pada database lama: kolom ditambahkan, semua meja lama aktif, aman dijalankan dua kali.
8. Regresi: alur pesanan, reservasi, Kelola Menu, dan Kelola Stok tetap jalan.
