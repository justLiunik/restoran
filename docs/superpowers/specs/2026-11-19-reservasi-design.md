# Alur Reservasi — Desain

Tanggal: 2026-11-19
Status: menunggu persetujuan

## Tujuan dan alasan

Status meja "reservasi" sekarang hanya angka di database (T08 dan T11 di data awal). Tidak ada cara mencatat,
melihat, mengubah, atau membatalkan reservasi, dan meja bertanda reservasi tidak bisa dipakai sama sekali.

Reservasi di restoran ini dibuat **langsung di tempat**: tamu datang, menyebut jumlah orang, memilih meja, dan memilih
waktu; staf mencatatnya di dashboard kasir. Saat tamu kembali pada waktunya, kasir menekan **Tamu Datang** dan pesanan
untuk meja itu langsung terbuka. Fitur ini membuat alur itu nyata: daftar reservasi sederhana (bukan sistem booking
lengkap), pengingat sebelum waktunya, dan pelepasan meja bila tamu tidak datang.

## Sasaran

- Kartu **"Reservasi"** di tab Denah Meja: daftar reservasi mendatang urut waktu dengan status
  **Menunggu / Datang / Tidak Datang / Batal**, tombol **+ Reservasi**, dan form tambah/ubah/batal.
- Data reservasi: nama tamu (wajib), jumlah tamu, meja, tanggal, jam, telepon (opsional), catatan (opsional).
- Meja tampil **Reservasi (biru)** di denah dari **30 menit sebelum jam booking** sampai reservasinya diselesaikan
  (Datang / Tidak Datang / Batal). Di luar jendela itu meja tetap bisa dipakai tamu biasa.
- **Pengingat** 30 menit sebelum jam booking dan lagi pada jam booking (nama, meja, jumlah tamu, jam), plus status
  "terlambat" bila lewat.
- **Tamu Datang**: reservasi jadi *Datang*, meja jadi *Terisi*, dan panel **pesanan baru untuk meja itu terbuka otomatis**.
- **Tidak Datang** (baru bisa setelah masa tenggang 15 menit dari jam booking) dan **Batal** (kapan saja selagi
  Menunggu): meja dilepas.
- **Satu meja tidak bisa dipesan dua kali di slot waktu yang sama.**

## Bukan sasaran

- Booking lewat telepon, WhatsApp, atau online; pemberitahuan ke pelanggan; deposit.
- Reservasi berulang, daftar tunggu, menggabung meja, laporan/statistik reservasi.
- Menandai Tidak Datang secara otomatis (selalu keputusan kasir).
- Larangan keras kelebihan kapasitas (hanya peringatan).
- Mengubah reservasi yang sudah Datang, Tidak Datang, atau Batal.

## Anti-sasaran (dianggap gagal walau fiturnya jalan)

- Meja yang macet biru atau "Terisi" tanpa jalan keluar bagi kasir.
- Dua reservasi bentrok di meja dan slot yang sama, termasuk saat dua staf menyimpan bersamaan.
- Tamu didudukkan di meja yang masih dipakai pesanan lain.
- Pesanan tamu biasa (walk-in) di meja yang tidak sedang dipesan berubah perilakunya.
- Waktu salah karena zona waktu, atau pengingat muncul berulang di setiap pembaruan layar/muat ulang.

## Batasan

- Mengikuti kode yang ada: Express + mysql2, `server.js`, `public/index.html` (vanilla JS), tanpa dependensi baru.
- UI berbahasa Indonesia, nyaman untuk tablet. Pola error `{ error }` dengan `HttpError`.
- **Perlu migrasi database** (`database/migrations/003_reservations.sql`) dan pembaruan `database/kasir_restoran.sql`
  serta salinan `kasir_restoran.sql` di akar. README wajib menyebut `npm run db:migrate`.
- **Waktu**: pool MySQL memakai `timezone: '+07:00'` sedangkan server MySQL bisa berzona lain. Karena itu semua
  perbandingan waktu reservasi memakai **jam dinding WIB sebagai teks** (`YYYY-MM-DD HH:mm:ss`) yang dihitung di Node
  (`nowWib()`), **tidak memakai `NOW()` atau `CURDATE()` di SQL**.
- Semua peran yang sudah login (kasir, supervisor, admin) boleh mengelola reservasi (staf "kasir atau pelayan").
- Konstanta di server, dikirim ke klien lewat respons daftar: `REMINDER_MINUTES = 30`, `GRACE_MINUTES = 15`,
  `SLOT_MINUTES = 120`, `MAX_ADVANCE_DAYS = 60`.

## Pendekatan yang dipertimbangkan

| | Pendekatan | Kelebihan | Kekurangan |
|---|---|---|---|
| **A** | **Status meja diturunkan dari tabel `reservations` saat `GET /api/tables` (dipilih)** | Tanpa penjadwal/timer; benar walau server restart; biru muncul sendiri pada T-30; status tersimpan di meja tidak disentuh | Query daftar meja sedikit lebih rumit |
| B | Menulis status `reservasi` ke `restaurant_tables` pada T-30 lewat timer | Denah tetap membaca satu kolom | Butuh pekerjaan latar; bisa tidak sinkron saat restart; bayar/void menimpa status dengan `kosong` |
| C | Hanya penanda meja tanpa catatan reservasi | Paling sederhana | Tidak menyimpan jam, pengingat, atau cek bentrok |

Penempatan UI: **kartu di tab Denah Meja** (bukan tab baru), karena kasir butuh melihat denah, daftar, dan pengingat
sekaligus.

## Keputusan yang sudah diambil

**Data** — tabel `reservations`:
`id`, `customer_name` (100), `phone` (30, boleh kosong), `party_size`, `table_id` (FK), `reserved_at` (DATETIME),
`note` (255, boleh kosong), `status` ENUM(`menunggu`,`datang`,`tidak_datang`,`batal`) default `menunggu`,
`order_id` (FK ke `orders`, boleh kosong), `arrived_at` (boleh kosong), `created_by` (FK users), `created_at`,
`updated_at`; indeks `(table_id, status, reserved_at)` dan `(status, reserved_at)`.
Migrasi juga menjalankan `UPDATE restaurant_tables SET status='kosong' WHERE status='reservasi'` (menghapus status
palsu T08/T11 yang tidak punya reservasi nyata; aman diulang). Data awal baru: T08 dan T11 `kosong`.

**Peralihan status**
- `menunggu` → `datang` (Tamu Datang) | `tidak_datang` (hanya jika sekarang ≥ jam booking + 15 menit) | `batal`.
- `datang` yang **belum punya pesanan** (tamu sudah duduk, belum memesan) → `batal` (tamu pergi).
- Status lain bersifat akhir. Hanya `menunggu` yang boleh diubah (nama, telepon, jumlah, meja, tanggal/jam, catatan).

**Status meja yang ditampilkan** (dihitung di `GET /api/tables`, urutan prioritas):
1. Ada pesanan aktif di meja → status tersimpan seperti sekarang (`terisi` / `menunggu_bayar`).
2. Ada reservasi `datang` tanpa `order_id` → `terisi` (+ `seated_reservation_id`).
3. Ada reservasi `menunggu` dengan jam booking ≤ sekarang + 30 menit (termasuk yang sudah lewat, sampai
   diselesaikan) → `reservasi` (+ id, nama, jumlah, jam). Bila beberapa, ambil yang paling awal.
4. Selain itu → status tersimpan (`kosong`).
Meja `kosong` yang punya reservasi `menunggu` lebih lambat hari ini mendapat `next_reservation_at` untuk teks kecil
"Resv 19:00" agar kasir tahu sebelum menerima tamu biasa.

**Endpoint** (semua di belakang `authMiddleware`; tanpa pembatasan peran):

| Endpoint | Fungsi |
|---|---|
| `GET /api/reservations` | Reservasi sejak 7 hari lalu ke depan, urut `reserved_at`; tiap baris memuat kode/kapasitas meja, `order_no`, `minutes_until`, `phase` (`later`/`soon`/`now`/`late` untuk Menunggu); respons juga memuat konstanta |
| `POST /api/reservations` | Buat `{customer_name, party_size, table_id, reserved_at, phone?, note?}` |
| `PUT /api/reservations/:id` | Ubah (hanya `menunggu`) |
| `POST /api/reservations/:id/arrive` | Tamu Datang |
| `POST /api/reservations/:id/no-show` | Tidak Datang |
| `POST /api/reservations/:id/cancel` | Batal |

`reserved_at` dikirim sebagai `YYYY-MM-DD HH:mm` (jam dinding WIB) dan dikembalikan dalam format yang sama.
`GET /api/dashboard/alerts` mendapat `reservations`: reservasi `menunggu` yang jam bookingnya ≤ 30 menit lagi atau sudah
lewat (nama, meja, jumlah, jam, `minutes_until`, `phase`).

**Aturan validasi**
- Nama 1–100 (dipangkas). Jumlah tamu bilangan bulat 1–50. Telepon opsional, ≤ 30 karakter, hanya angka, spasi, `+`, `-`,
  `(`, `)`. Catatan ≤ 255. Meja harus ada (400).
- Waktu: format valid, tidak lebih awal dari sekarang − 5 menit (toleransi mencatat booking yang baru saja dibuat), dan
  paling jauh 60 hari ke depan. Saat mengubah, aturan waktu hanya dicek bila tanggal/jam diubah.
- **Bentrok**: reservasi `menunggu` lain di meja yang sama dengan selisih jam < 120 menit → 409
  "Meja T08 sudah direservasi pukul 19:00 atas nama Budi. Pilih jam atau meja lain." Selisih tepat 120 menit boleh.
  Hanya reservasi `menunggu` yang menahan slot (tamu yang sudah duduk ditangani status pesanan/meja).
  Baris meja dikunci (`SELECT ... FOR UPDATE`) saat membuat, mengubah, dan Tamu Datang agar dua staf tidak lolos bersamaan.
- Kelebihan kapasitas **hanya peringatan** di form (tidak ditolak server).
- **Tamu Datang** ditolak (409) bila meja masih punya pesanan aktif ("Meja T05 masih terisi pesanan INV-0007. Ubah meja
  reservasi atau tunggu pesanan selesai.") atau ada reservasi `datang` lain yang belum punya pesanan di meja itu.
- **Tidak Datang** sebelum masa tenggang → 400 "Baru bisa ditandai Tidak Datang setelah 19:15".
- Peralihan yang tidak diizinkan dari status saat ini → 409; reservasi tidak ditemukan → 404.

**Hubungan dengan pesanan**
- `POST /api/orders` untuk meja dine-in: dalam transaksi yang sama, reservasi `datang` tanpa `order_id` di meja itu
  otomatis diisi `order_id` pesanan baru (tanpa parameter baru dari klien). Dengan begitu tidak ada reservasi
  "menggantung" bila kasir membuat pesanan dari meja yang sudah diduduki.
- Setelah dibayar atau di-void, meja kembali `kosong` lewat jalur yang sudah ada; reservasi tetap `datang` sebagai riwayat.

**Klien**
- Kartu Reservasi: judul + jumlah yang menunggu, chip filter **Menunggu** (default) / **Hari ini** / **Semua**, tombol
  **+ Reservasi**. Baris: jam (dengan tanggal bila bukan hari ini), nama (+ telepon), jumlah tamu, meja, lencana status,
  lencana fase ("30 mnt lagi" / "Waktunya" / "Terlambat 12 mnt"), dan tombol utama **Tamu Datang**. Klik baris membuka
  dialog rincian dengan semua aksi (Tamu Datang, Ubah, Tidak Datang, Batal; Tidak Datang nonaktif beserta keterangan jam
  sebelum masa tenggang habis). Reservasi `datang` tanpa pesanan menampilkan **Buka Pesanan** dan **Batal**.
- Form tambah/ubah: nama, telepon, jumlah tamu, meja (kode, kapasitas, area), tanggal (bawaan hari ini), jam, catatan;
  peringatan kapasitas; error server (mis. bentrok) tampil di dalam dialog tanpa menutupnya.
- Denah: kotak biru memuat jam dan nama; klik meja biru membuka dialog rincian reservasi; klik meja `terisi` tanpa
  pesanan aktif membuka panel pesanan baru untuk meja itu (nama tamu terisi di pesanan). Meja `kosong` dengan reservasi
  nanti menampilkan "Resv HH:mm".
- **Tamu Datang** di klien: `guardUnsaved` (pilihan Simpan/Buang/Batal bila ada pesanan belum tersimpan) → panggil API →
  `startNewOrder({ table_id, type: 'dine_in', customer_name })` → segarkan denah dan daftar.
- Pengingat: ditampilkan di lonceng notifikasi (judul "Reservasi 30 menit lagi" / "Waktunya reservasi" /
  "Reservasi terlambat N menit"), toast sekali per (reservasi, jam booking, tahap) dan sorotan baris. Tahap yang sudah
  ditoast diingat di `sessionStorage` agar tidak muncul lagi tiap 15 detik atau saat muat ulang; mengubah jam booking
  memicu pengingat baru. Memakai pembaruan 15 detik yang sudah ada.
- Nama tamu dan teks bebas selalu di-escape saat dirender.

**Dokumentasi**
- README: bagian "Reservasi" (alur, aturan waktu 30/15/120 menit, status meja), catatan **wajib `npm run db:migrate`**
  setelah `git pull`, dan entri struktur proyek bila perlu.

## Pengujian penerimaan

1. Buat reservasi lewat form → muncul di daftar urut jam. Meja masih Kosong dengan teks "Resv HH:mm" bila > 30 menit lagi;
   reservasi 20 menit lagi → meja biru "Reservasi" dengan jam dan nama.
2. Bentrok: meja sama dengan selisih < 120 menit → 409; tepat 120 menit → berhasil; meja lain → berhasil; setelah Batal
   slot bebas lagi; dua permintaan bersamaan ke slot yang sama → hanya satu yang berhasil.
3. Validasi: waktu lampau (> 5 menit), > 60 hari, format salah, nama kosong/101 huruf, jumlah 0/51/desimal, meja tidak ada,
   telepon berisi huruf → 400, tidak ada data berubah.
4. Ubah: hanya `menunggu`; ganti meja/jam dicek bentrok tanpa menghitung dirinya sendiri; status lain → 409.
5. Tamu Datang: reservasi `datang`, meja `Terisi`, panel pesanan baru terbuka dengan nama tamu; setelah Simpan pesanan,
   reservasi memuat nomor pesanan; setelah bayar, meja Kosong dan reservasi tetap Datang.
6. Tamu Datang di meja yang punya pesanan aktif → 409 dengan pesan, tidak ada perubahan.
7. Pesanan baru dibuang setelah Tamu Datang → meja tetap Terisi; klik meja membuka lagi panel pesanan baru; Batal pada
   reservasi itu melepas meja.
8. Tidak Datang sebelum jam + 15 menit → 400 dengan jam yang benar; sesudahnya berhasil dan meja Kosong. Batal pada
   `menunggu` melepas meja. Status akhir tidak bisa diubah (409).
9. Pengingat: reservasi 25 menit lagi → lonceng dan toast sekali; saat waktunya → "Waktunya reservasi"; lewat jam →
   "Terlambat"; muat ulang tidak menampilkan toast yang sama lagi; setelah diselesaikan, pengingat hilang.
10. Ketiga peran dapat membuat dan memproses reservasi; tanpa token → 401.
11. Migrasi pada database dari dump lama: tabel terbuat, T08/T11 kembali `kosong`, dijalankan dua kali tetap aman. Instalasi
    baru dari dump baru: tabel ada dan tidak ada meja biru palsu.
12. Regresi: pesanan dine-in/take away/delivery, hold, lanjutkan, bayar, void, Kelola Stok, Kelola Menu tetap jalan; meja
    biru tidak bisa dipakai untuk pesanan tamu biasa (toast menyebut jam reservasi); meja kosong biasa tetap bisa.
13. Tidak ada `NOW()`/`CURDATE()` pada query reservasi (periksa kode).

## Diserahkan ke pembangun

- Tampilan rinci (ukuran, warna lencana, susunan dialog, teks toast dan konfirmasi), nama fungsi klien (ikuti pola Kelola Stok/Menu).
- Bentuk persis kolom tambahan di `GET /api/tables` selama memuat field di atas.
- Cara menyajikan "fase" (`phase`) di klien dan penempatan kartu terhadap Antrean Pesanan.

## Keputusan saya (mohon dikoreksi bila tidak cocok)

1. Biru muncul **30 menit sebelum** jam booking (sampai diselesaikan); sebelum itu meja bebas dipakai tamu biasa.
2. "Slot" yang sama = selisih jam kurang dari **2 jam** (120 menit); masa tenggang **15 menit**.
3. Kelebihan kapasitas hanya diperingatkan, tidak ditolak.
4. Semua peran boleh membuat dan memproses reservasi.
5. Kartu Reservasi diletakkan di tab Denah Meja, bukan tab baru.
6. Hanya reservasi `menunggu` yang menahan slot; tamu yang sudah duduk dikelola lewat status pesanan.
7. Tamu Datang ditolak bila meja masih dipakai; kasir mengubah meja reservasi lewat **Ubah**.
8. Tamu yang sudah duduk tetapi pesanannya dibuang: meja tetap Terisi dan bisa dibuka lagi, atau dilepas dengan **Batal**.
9. Status palsu "reservasi" di T08/T11 dihapus oleh migrasi.
10. Booking boleh dicatat sampai 5 menit lewat dari sekarang dan paling jauh 60 hari ke depan.
