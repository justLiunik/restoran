# Kasir Restoran

Aplikasi kasir (POS) restoran berbasis web: login per peran, pesanan meja, pembayaran, diskon dengan otorisasi PIN supervisor, shift kasir, kelola stok, menu, meja, user, dan tarif pajak & service, reservasi meja, dan laporan penjualan (per periode, dengan ekspor CSV).

**Teknologi:** Node.js + Express (backend), MySQL 8 yang berjalan di Docker (database), HTML/CSS/JS biasa (frontend, ada di `public/index.html`).

---

## Daftar Isi

1. [Yang Perlu Disiapkan](#1-yang-perlu-disiapkan)
2. [Instalasi Langkah demi Langkah](#2-instalasi-langkah-demi-langkah)
3. [Login ke Aplikasi](#3-login-ke-aplikasi)
4. [Menjalankan Lagi di Hari Berikutnya](#4-menjalankan-lagi-di-hari-berikutnya) (termasuk [setelah `git pull`](#setelah-git-pull-memperbarui-kode))
5. [Perintah Database](#5-perintah-database)
6. [Masalah Umum (Troubleshooting)](#6-masalah-umum-troubleshooting)
7. [Opsional: Semua Jalan di Docker](#7-opsional-semua-jalan-di-docker)
8. [Struktur Proyek](#8-struktur-proyek)

---

## 1. Yang Perlu Disiapkan

Pasang dua aplikasi ini dulu, lalu pastikan keduanya berjalan:

| Kebutuhan | Versi | Cara cek |
|---|---|---|
| [Node.js](https://nodejs.org) | 18 atau lebih baru | `node -v` |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | Compose v2 | `docker compose version` |

> **Penting:** buka aplikasi Docker Desktop dan tunggu sampai statusnya *running* sebelum lanjut. Kalau Docker belum menyala, perintah `npm run db:up` akan gagal.

Semua perintah di bawah dijalankan di **terminal** (PowerShell di Windows, Terminal di macOS/Linux) dari dalam folder proyek.

---

## 2. Instalasi Langkah demi Langkah

Cukup dilakukan **sekali** saat pertama kali.

### Langkah 1: Unduh proyek

```bash
git clone https://github.com/justLiunik/restoran.git
cd restoran
```

### Langkah 2: Pasang dependensi

```bash
npm install
```

### Langkah 3: Buat file `.env`

File `.env` berisi pengaturan rahasia milikmu. File ini **tidak ikut di-upload ke Git**. Salin dari contoh yang tersedia:

Windows (PowerShell atau CMD):

```powershell
copy .env.example .env
```

macOS / Linux:

```bash
cp .env.example .env
```

### Langkah 4: Isi `JWT_SECRET` di `.env`

`JWT_SECRET` adalah kunci rahasia untuk menandatangani token login. Server **tidak mau menyala** kalau nilainya kosong atau kurang dari 32 karakter.

1. Buat kunci acak dengan perintah ini:

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

2. Salin hasilnya (teks panjang berisi huruf dan angka).
3. Buka file `.env`, lalu tempel di belakang `JWT_SECRET=`, misalnya:

   ```
   JWT_SECRET=a3f9...teks-panjang-hasil-tadi...c1d2
   ```

Pengaturan lain di `.env` (database, port) boleh dibiarkan seperti bawaan.

### Langkah 5: Nyalakan database

```bash
npm run db:up
```

Perintah ini mengunduh dan menjalankan MySQL di Docker. Pertama kali bisa memakan waktu beberapa menit karena ada unduhan.

### Langkah 6: Tunggu database siap

```bash
docker compose ps
```

Lihat kolom `STATUS` pada baris `kasir-db`. Tunggu sampai tertulis **`healthy`** (sekitar 30-60 detik). Jalankan lagi perintahnya kalau masih `starting`.

### Langkah 7: Buat password dan PIN pengguna

```bash
npm run db:seed
```

Perintah ini membuat **password acak** untuk pengguna yang belum punya password sungguhan (pada instalasi baru: semua) dan **PIN 4 digit acak** untuk supervisor/admin, lalu menampilkannya **sekali saja**:

```
✅ User hashes successfully seeded! (password: 4 user, PIN: 2 user; user lain tidak diubah)
ℹ️ Password (user yang diisi): xxxxxxxxxxxx
ℹ️ PIN (supervisor/admin yang diisi): 0000
```

**Catat keduanya sekarang**, karena tidak akan ditampilkan lagi. Perintah ini **tidak menimpa** password dan PIN yang sudah diganti lewat aplikasi (Kelola User / Akun Saya). Kalau lupa dan ingin **menimpa semua** pengguna dengan yang baru, jalankan `npm run db:seed -- --all` (semua sesi login juga berakhir).

Kalau mau menentukan sendiri password dan PIN-nya (password minimal 8 karakter, PIN tepat 4 angka):

```powershell
# Windows PowerShell
$env:SEED_PASSWORD = "passwordKuat123"; $env:SEED_PIN = "4821"; npm run db:seed
```

```bash
# macOS / Linux
SEED_PASSWORD="passwordKuat123" SEED_PIN="4821" npm run db:seed
```

### Langkah 8: Jalankan server

```bash
npm start
```

Kalau berhasil, muncul tulisan:

```
🚀 Kasir Restoran server running on http://localhost:3000
```

### Langkah 9: Buka aplikasi

Buka browser ke **http://localhost:3000**, lalu login (lihat bagian berikut). Biarkan terminal tetap terbuka selama aplikasi dipakai. Tekan `Ctrl + C` untuk menghentikan server.

---

## 3. Login ke Aplikasi

| Username | Peran | Keterangan |
|---|---|---|
| `budi` | Kasir | Transaksi harian: menjalankan shift dan menangani pesanan |
| `sari` | Kasir | Transaksi harian: menjalankan shift dan menangani pesanan |
| `spv` | Supervisor | Punya PIN untuk otorisasi. Memantau dan mengelola, **hanya lihat** untuk pesanan |
| `admin` | Admin | Punya PIN untuk otorisasi. Memantau dan mengelola, **hanya lihat** untuk pesanan |

- **Password:** yang ditampilkan di Langkah 7 (sama untuk semua pengguna). Setelah masuk, admin bisa menambah akun dan mengganti password atau PIN lewat tab **Kelola User**, dan siapa pun bisa mengganti password sendiri lewat tombol **🔑** (lihat di bawah).
- **PIN:** yang ditampilkan di Langkah 7. PIN diminta saat kasir memberi **diskon di atas 20%** atau **membatalkan (void) transaksi**, lalu supervisor atau admin memasukkan PIN-nya.

> Password dan PIN hanya untuk pengembangan lokal. Kalau aplikasi dipasang di server sungguhan, ganti dengan nilai yang kuat lewat `SEED_PASSWORD` dan `SEED_PIN`.

### Siapa yang Menangani Pesanan

**Hanya kasir** yang menjalankan shift dan membuat atau mengubah pesanan. **Admin dan supervisor** adalah akun pemantau dan pengelola: mereka melihat semuanya, tetapi tidak bisa menyentuh pesanan.

| | Kasir | Admin / Supervisor |
|---|---|---|
| Kartu **Shift Kasir Aktif**, buka/tutup shift, kas keluar | Ya | Tidak tampil, server menolak (403) |
| **+ Pesanan Baru**, klik meja kosong, klik kartu menu untuk menambah item | Ya | Tidak tampil / tidak bisa diklik, server menolak (403) |
| Simpan, Hold, Bayar, ubah jumlah, catatan item, diskon, ubah status | Ya | Tidak ada tombolnya, server menolak (403) |
| Melihat ringkasan, denah meja, daftar pesanan, riwayat transaksi, laporan, stok | Ya | Ya |
| Membuka pesanan aktif (tombol **Lihat**: item, catatan, total, status, nama kasir) | Bisa mengubah | **Hanya baca** |
| Cetak ulang struk, **void** dengan PIN supervisor, tambah stok, koreksi stok | Ya | Ya |

Admin dan supervisor melihat lencana **Mode Admin (hanya lihat)** di bagian atas supaya jelas mengapa tombol pesanan tidak ada. Penolakan server berbunyi *"Akun admin tidak dapat membuat atau mengubah pesanan"*. Peran dibaca dari database pada setiap permintaan, jadi mengubah peran seseorang berlaku seketika.

- **Pesanan dan shift lama** yang dibuat akun admin atau supervisor tetap ada dan tetap masuk laporan; tidak ada yang dihapus. Kalau sebuah akun admin/supervisor masih punya **shift yang terbuka** di database, shift itu tidak bisa lagi ditutup dari aplikasi (dan akun itu tidak bisa dinonaktifkan selama shiftnya terbuka). Tutup manual dengan satu perintah SQL, ganti `<id admin>` dengan id akunnya (lihat lewat `SELECT id, username, role FROM users;`):

  ```sql
  UPDATE shifts SET status='closed', closed_at=NOW() WHERE cashier_id = <id admin> AND status='open';
  ```
- **Reservasi** tetap bisa dicatat dan diubah semua peran, tetapi tombol **Tamu Datang** dan **Buka Pesanan** (yang membuka pesanan baru) hanya muncul untuk kasir.
- **Mengizinkan supervisor ikut menangani pesanan** nanti cukup mengubah dua tempat: `ORDER_HANDLER_ROLES` di `server.js` dan fungsi `canHandleOrders()` di `public/index.html`.

### Alur Pesanan

Membuat atau menyimpan pesanan butuh **shift yang sudah dibuka** (kasir `budi` sudah punya shift terbuka di data awal). Alur di bawah ini untuk **kasir**; admin dan supervisor hanya bisa melihat pesanan (lihat bagian di atas).

| Aksi | Hasilnya |
|---|---|
| Klik meja kosong atau **+ Pesanan Baru** | Membuka pesanan baru di panel kanan. Belum tersimpan sampai kamu menekan salah satu tombol di bawah. |
| **Simpan Pesanan** | Pesanan disimpan dengan status *Baru* (ke dapur), meja jadi *Terisi*, panel ditutup, dan pesanan muncul di Antrean Pesanan Berjalan. Nomor invoice berurutan (INV-0001, INV-0002, ...). |
| Klik meja terisi, atau **Buka** pada daftar | Membuka lagi pesanan yang sudah tersimpan beserta item dan catatannya. Ubah, lalu **Simpan Pesanan** lagi untuk memperbarui. |
| **Hold (tahan)** | Menyimpan pesanan sebagai *Hold* untuk pelanggan yang akan lanjut nanti. Muncul di tab **Hold** pada Antrean dengan tombol **Lanjutkan**. |
| **Bayar & Cetak** | Pesanan baru maupun yang sudah tersimpan dibayar: status *Selesai*, meja kembali *Kosong*, stok berkurang, struk dicetak (lengkap dengan catatan item). |
| **+ Catatan** pada item | Pilih chip cepat (Tidak pedas, Pedas, Tanpa es, Kurang manis, Dibungkus) dan/atau ketik catatan sendiri. Produk yang sama dengan catatan berbeda menjadi baris terpisah; catatan sama digabung. |

- Saat menutup panel (✕), menekan **+ Pesanan Baru**, atau membuka meja/pesanan lain padahal ada perubahan yang belum disimpan, muncul pilihan **Simpan / Buang / Batal**.
- Perubahan yang belum disimpan disimpan sementara di browser, jadi tidak hilang kalau halaman di-refresh.
- Pesanan kosong tidak bisa disimpan, di-hold, atau dibayar.

### Kelola Stok

Tombol **Tambah Stok** ada di setiap kartu menu (untuk semua peran) dan di tab **📦 Kelola Stok**.

| Aksi | Hasilnya |
|---|---|
| **Tambah Stok** | Isi jumlah (bilangan bulat ≥ 1, atau pakai chip +5 / +10 / +25 / +50) dan catatan opsional. Stok bertambah dan menu otomatis tersedia lagi. |
| **Koreksi** (tab Kelola Stok) | Mengatur stok ke angka pasti saat stock opname. Wajib alasan dan **PIN Supervisor / Admin**; tercatat sebagai koreksi, bukan restock. |
| **Tandai Habis / Aktifkan Kembali** | Hanya muncul untuk menu yang stoknya masih ada. Menu dengan stok 0 sudah otomatis *Habis* dan hanya punya tombol Tambah Stok. |
| Klik baris produk (tab Kelola Stok) | Menampilkan 20 riwayat stok terakhir: restock, koreksi, penjualan, dan void. |

Status stok: **Habis** (stok 0 atau ditandai habis), **Menipis** (stok ≤ batas, bawaan 5), **Aman**. Saat pembayaran atau koreksi membuat stok menipis, muncul notifikasi satu kali.

Kalau database kamu dibuat sebelum fitur ini, jalankan `npm run db:migrate` sekali untuk menambah tabel riwayat stok.

### Kelola Menu

Tab **🛠️ Kelola Menu** hanya muncul untuk **Admin** dan **Supervisor** (kasir tidak melihatnya, dan server menolak permintaannya). Perubahan bisa dilakukan kapan saja, termasuk saat restoran sedang ramai.

| Aksi | Hasilnya |
|---|---|
| **+ Tambah Menu** | Isi nama, kategori, harga (bilangan bulat rupiah), link foto (opsional), batas stok menipis, dan **stok awal**. Stok awal di atas 0 tercatat di riwayat stok sebagai "Stok awal". |
| **Ubah** | Mengubah nama, kategori, harga, link foto, dan batas stok menipis. Stok tidak berubah di sini; gunakan tab Kelola Stok. |
| **Nonaktifkan / Aktifkan** | Menu nonaktif hilang dari kasir, tapi tidak dihapus. Aktifkan lagi lewat kotak centang **Tampilkan nonaktif**. |
| **🗂️ Kategori** | Tambah, ganti nama, atur urutan dengan tombol ▲ ▼ (urutan yang sama dipakai tombol kategori di Katalog Menu), dan hapus. Kategori hanya bisa dihapus kalau tidak berisi menu, termasuk menu nonaktif. |

- **Riwayat tidak berubah.** Nama dan harga pada transaksi lama tetap seperti saat transaksi. Pesanan yang masih terbuka atau di-hold tetap memakai harga yang sudah tercatat di pesanan itu; menu yang baru ditambahkan memakai harga terbaru.
- **Menu nonaktif aman untuk pesanan berjalan.** Pesanan yang sudah berisi menu itu tetap bisa dilanjutkan dan dibayar, tetapi menu itu tidak bisa ditambahkan ke pesanan lain.
- Nama menu tidak boleh kembar dalam satu kategori (menu nonaktif ikut dihitung), dan nama kategori tidak boleh kembar.
- Foto berupa **link gambar** (diawali `http://` atau `https://`). Menu tanpa foto tampil sebagai kotak berwarna dengan huruf pertama namanya.
- Fitur ini **tidak** menambah tabel atau kolom, jadi `npm run db:migrate` tidak perlu dijalankan khusus untuknya.

### Reservasi

Kartu **📅 Reservasi** ada di tab **Denah Meja & Pesanan**, di bawah denah. Semua peran (kasir, supervisor, admin) bisa mencatat dan memproses reservasi, kecuali **Tamu Datang** dan **Buka Pesanan** yang membuka pesanan baru dan hanya untuk kasir. Reservasi dicatat langsung oleh staf saat tamu datang ke restoran (belum ada booking lewat telepon atau online).

| Aksi | Hasilnya |
|---|---|
| **+ Reservasi** | Isi nama tamu, jumlah tamu, meja, tanggal, dan jam. Telepon dan catatan boleh kosong. Jumlah tamu melebihi kapasitas meja hanya diberi peringatan. |
| **Tamu Datang** | Reservasi jadi *Datang*, meja jadi *Terisi*, dan panel **pesanan baru untuk meja itu terbuka otomatis** (nama tamu sudah terisi). Pesanan yang disimpan otomatis tertaut ke reservasi itu. |
| **Tidak Datang** | Baru bisa dipakai **15 menit setelah jam booking**. Meja dilepas. |
| **Batal** | Bisa kapan saja selagi *Menunggu*, atau untuk tamu yang sudah duduk tetapi belum memesan. Meja dilepas. |
| **Ubah** | Hanya untuk reservasi *Menunggu*: nama, telepon, jumlah, meja, tanggal/jam, catatan. |

Klik sebuah baris (atau meja biru di denah) untuk membuka rincian dan semua aksinya. Daftar diurutkan menurut jam; filter **Menunggu / Hari ini / Semua** (7 hari terakhir dan yang akan datang).

**Aturan waktu** (semua memakai jam WIB):
- Meja tampil **biru "Reservasi"** mulai **30 menit sebelum** jam booking sampai reservasinya diselesaikan (Datang / Tidak Datang / Batal). Sebelum itu meja masih bisa dipakai tamu biasa; meja kosong yang punya booking nanti diberi teks kecil "Resv 19:00".
- **Pengingat** muncul 30 menit sebelum jam booking, lagi saat waktunya, dan sebagai "terlambat" bila lewat jam. Pengingat tampil di lonceng notifikasi, sebagai pesan singkat sekali saja, dan baris reservasinya disorot.
- **Satu meja tidak bisa dipesan dua kali** bila jam dua reservasi *Menunggu* di meja itu berselisih **kurang dari 2 jam** (tepat 2 jam boleh).
- Booking tidak boleh di masa lalu (toleransi 5 menit) dan paling jauh 60 hari ke depan.
- **Tamu Datang** ditolak kalau meja masih dipakai pesanan lain; ubah meja reservasinya lewat **Ubah**.
- Tamu yang sudah duduk tetapi pesanannya dibuang: meja tetap *Terisi*. Klik meja itu (atau **Buka Pesanan**) untuk membuka pesanan lagi, atau **Batal** kalau tamunya pergi.

> ⚠️ Fitur ini menambah tabel `reservations`. **Jalankan `npm run db:migrate`** pada database yang sudah ada. Migrasi juga mengembalikan meja T08 dan T11 dari status "reservasi" bawaan data awal (yang tidak punya reservasi nyata) ke *Kosong*.

### Kelola Meja

Tombol **⚙️ Atur Meja** di kartu **Denah Meja** hanya muncul untuk **Admin** dan **Supervisor** (kasir tidak melihatnya, dan server menolak permintaannya). Isinya dialog daftar meja untuk menambah, mengubah, dan menghentikan pemakaian meja tanpa SQL.

| Aksi | Hasilnya |
|---|---|
| **Tambah** | Isi kode (maksimal 10 karakter, tidak boleh kembar), jumlah kursi (1-50), dan area (opsional, mis. Indoor / Outdoor / VIP). Meja baru langsung muncul di denah sebagai *Kosong*. |
| **Ubah** | Mengubah kode, kursi, dan area. Boleh dilakukan saat meja sedang dipakai; nama kode di pesanan dan reservasi lama ikut berubah. |
| **Nonaktifkan / Aktifkan** | Meja nonaktif hilang dari denah, daftar meja di **Pesanan Baru**, dan pilihan meja di form reservasi. Meja **tidak dihapus**, jadi riwayat pesanan dan reservasinya tetap utuh, dan meja bisa diaktifkan kembali kapan saja. |

- **Meja yang sedang dipakai tidak bisa dinonaktifkan:** ada pesanan aktif, ada reservasi yang menunggu, atau ada tamu reservasi yang sudah duduk tetapi belum memesan. Tombolnya mati dan keterangannya menyebut apa yang harus diselesaikan dulu.
- Kode meja nonaktif tetap dianggap terpakai. Kalau kamu menambah meja dengan kode itu, aplikasi menyarankan mengaktifkan kembali meja lamanya.
- Urutan meja di denah mengikuti urutan pembuatan. Belum ada pengaturan tata letak atau penggabungan meja.

> ⚠️ Fitur ini menambah kolom `is_active` pada tabel meja. **Jalankan `npm run db:migrate`** pada database yang sudah ada. Semua meja lama tetap aktif dan data tidak berubah.

### Laporan Penjualan

Tab **📊 Penjualan & Laporan** menampilkan laporan penjualan. Fitur ini tidak mengubah database, jadi `npm run db:migrate` tidak perlu dijalankan khusus untuknya.

| Peran | Yang bisa dilakukan |
|---|---|
| **Kasir** | Melihat laporan **hari ini** saja. Permintaan periode lain ditolak server. |
| **Admin / Supervisor** | Memilih periode (**Hari ini, Kemarin, 7 hari terakhir, Bulan ini, Bulan lalu**, atau tanggal **Dari** dan **Sampai**, paling lama 366 hari) dan mengunduh CSV. |

**Isi laporan** (semuanya mengikuti periode yang dipilih):
- **Ringkasan:** total penjualan, jumlah transaksi, rata-rata, subtotal, diskon, pajak, service, dan void (jumlah dan nilainya).
- **Penjualan per hari** (periode lebih dari 1 hari; per bulan bila lebih dari 31 hari), **per metode bayar**, **per tipe pesanan** (Dine-in, Take Away, GoFood, GrabFood, ShopeeFood), **per kasir**, **per jam**, dan **menu terlaris** (10 teratas, bisa ditampilkan semua).
- **Ekspor CSV:** **CSV Transaksi** (setiap nota selesai dan void pada periode itu) dan **CSV Menu** (jumlah terjual dan omzet per menu).

**Cara menghitung:**
- Yang dihitung hanya pesanan yang sudah dibayar (*Selesai*), menurut **tanggal pembayarannya**. Pesanan **void tidak masuk penjualan**; jumlahnya ditampilkan terpisah.
- **Total penjualan sudah termasuk pajak dan service**, sama seperti kartu "Total Penjualan Hari Ini" di bagian atas halaman.
- **Penjualan per metode bayar memakai nilai bersih:** kembalian tidak dihitung. Contoh: tagihan Rp 51.750 dibayar Tunai Rp 100.000 dicatat Tunai Rp 51.750. Untuk pembayaran ganda, kembalian dikurangkan dari bagian Tunai.
- **Per kasir** berarti kasir yang menerima pembayaran, bukan yang membuka pesanan.
- **Omzet menu** dihitung dari harga item sebelum diskon, pajak, dan service, jadi jumlahnya tidak sama dengan total penjualan.

**Membuka CSV di Excel:** berkas memakai pemisah titik koma dan UTF-8, sehingga langsung terbuka rapi di Excel versi Indonesia (klik dua kali). Kalau memakai Excel bahasa Inggris dan semua isi tampil dalam satu kolom, pakai **Data → From Text/CSV** lalu pilih pemisah *Semicolon*. Teks yang diawali `=`, `+`, `-`, atau `@` diberi tanda petik di depannya supaya tidak dijalankan sebagai rumus.

**Perbaikan kas shift:** angka "kas yang seharusnya" (saat tutup shift dan kartu **Shift Kasir Aktif** di atas) sebelumnya memakai uang yang diserahkan pelanggan, bukan uang yang benar-benar tersisa setelah kembalian, sehingga kasir yang menutup shift dengan uang yang benar melihat selisih minus. Sekarang kas dihitung dari nilai bersih: kas awal + penjualan tunai bersih + kas masuk − kas keluar.

### Kelola User

Tab **👥 Kelola User** hanya muncul untuk **Admin** (supervisor dan kasir tidak melihatnya, dan server menolak permintaannya). Di sini admin mengatur semua akun tanpa SQL atau `db:seed`.

| Aksi | Hasilnya |
|---|---|
| **+ Tambah User** | Isi nama, username, peran, dan password awal. Supervisor dan admin **wajib** diberi PIN 4 digit; kasir tidak punya PIN. |
| **Ubah** | Mengubah nama, username, dan peran. Kasir → supervisor/admin wajib mengisi PIN; menjadi kasir menghapus PIN. |
| **Password** | Reset password user lain. Semua sesi login user itu berakhir seketika. |
| **PIN** | Mengatur PIN supervisor/admin. PIN tidak boleh sama dengan PIN supervisor atau admin aktif lain, karena PIN dipakai untuk mencatat siapa yang menyetujui diskon besar dan void. |
| **Nonaktifkan / Aktifkan** | Akun nonaktif tidak bisa login dan sesinya berakhir seketika. Akun tidak dihapus, jadi riwayat pesanan dan shiftnya tetap utuh. |

**Aturan:**
- **Username:** 3-30 karakter (huruf, angka, titik, garis bawah, strip), huruf besar otomatis jadi kecil, dan tidak boleh kembar. **Password:** 8-72 karakter.
- Kamu tidak bisa menonaktifkan atau mengubah peran **akun sendiri**, dan **admin aktif terakhir** tidak bisa dinonaktifkan atau diturunkan. User yang **masih punya shift terbuka** tidak bisa dinonaktifkan (tutup shiftnya dulu).
- **Mengaktifkan kembali** supervisor/admin menghapus PIN lamanya; atur PIN baru dengan tombol **PIN**.
- **Berlaku seketika:** perubahan peran, nonaktifkan, dan reset password langsung berlaku tanpa menunggu token login habis. Tampilan pengguna yang sedang login ikut menyesuaikan dalam sekitar 15 detik.
- Password dan PIN tidak pernah ditampilkan.

### Akun Saya

Tombol **🔑** di pojok atas (untuk semua peran) membuka **Akun Saya**: ganti **password** sendiri dan, untuk supervisor dan admin, ganti **PIN** sendiri. Keduanya meminta password saat ini. Setelah password diganti, login di perangkat lain berakhir, sedangkan sesi yang sedang dipakai tetap berjalan.

> ⚠️ Fitur ini menambah kolom `session_version` pada tabel pengguna. **Jalankan `npm run db:migrate`** pada database yang sudah ada. Semua akun, password, dan PIN tetap seperti semula, dan sesi yang sedang login tidak terputus.

### Kelola Pajak & Service

Tarif **pajak** (PB1, awalnya 10%) dan **service** (awalnya 5%) sekarang bisa diubah dari aplikasi, tanpa mengubah kode. Hanya **Admin** yang bisa mengubahnya: tombol **Atur** muncul di kartu **Pajak (…%) & Service (…%)** di bagian atas halaman (supervisor dan kasir hanya melihat tarifnya, dan server menolak permintaan ubah dari mereka).

- **Isian:** pajak dan service dalam persen, 0 sampai 100, maksimal 2 angka di belakang koma (contoh: `7,5`). Isi **0** untuk mematikan; barisnya lalu tidak tampil di panel pesanan dan struk. Dialog menunjukkan contoh hitung untuk Rp 100.000 yang ikut berubah saat kamu mengetik, dan meminta konfirmasi dengan nilai lama → baru. Di dialog juga tertulis siapa yang terakhir mengubah dan kapan.
- **Service hanya untuk dine-in**, seperti sebelumnya. Take-away dan delivery tidak dikenai service. Pajak berlaku untuk semua jenis pesanan, dihitung dari subtotal setelah diskon.
- **Tarif dikunci per pesanan.** Tarif yang kamu simpan hanya berlaku untuk **pesanan baru**. Pesanan yang sedang terbuka atau di-hold tetap memakai tarif saat pesanan itu dibuat, sampai dibayar atau dibatalkan, jadi total yang sudah dilihat pelanggan tidak bergeser. Struk lama yang dicetak ulang dari **Riwayat Transaksi** juga tetap menampilkan persentase yang dulu dipakai.
- **Kasir yang sedang menyusun pesanan baru** melihat tarif terbaru dalam sekitar 15 detik. Kalau tarif berubah tepat sebelum ia menekan bayar, pembayaran dihentikan dengan pemberitahuan total terbaru (pesanan tetap tersimpan), supaya ia tidak menagih angka yang salah.
- **Laporan** tidak berubah: pajak dan service di laporan adalah jumlah nominal yang benar-benar dikenakan pada tiap nota.
- Pembulatan ke rupiah terdekat (setengah naik). Untuk 10% dan 5% hasilnya sama persis dengan sebelumnya.

> ⚠️ Fitur ini menambah tabel `app_settings` serta kolom `tax_rate` dan `service_rate` pada tabel pesanan. **Jalankan `npm run db:migrate`** pada database yang sudah ada. Pesanan lama otomatis diisi 10% dan 5% (service 0% untuk take-away dan delivery), yaitu tarif yang selalu dipakai sebelumnya, jadi semua total dan struk lama tidak berubah. Menjalankan migrasi lagi tidak menimpa tarif yang sudah kamu ubah.

---

## 4. Menjalankan Lagi di Hari Berikutnya

Instalasi tidak perlu diulang. Cukup:

1. Pastikan Docker Desktop menyala.
2. Nyalakan database dan server:

   ```bash
   npm run db:up
   npm start
   ```

3. Buka http://localhost:3000.

Data tetap tersimpan di volume Docker (`dbdata`) walaupun komputer dimatikan.

Untuk berhenti: `Ctrl + C` pada server, lalu `npm run db:down` untuk mematikan database. Data **tidak** hilang.

### Setelah `git pull` (memperbarui kode)

> ⚠️ **Wajib jalankan `npm run db:migrate` setelah `git pull`.** Versi baru bisa menambah tabel database. Kalau langkah ini dilewati, sebagian fitur akan error (misalnya pembayaran dan void gagal karena tabel `stock_movements` belum ada, atau denah meja gagal dimuat karena tabel `reservations` atau kolom `is_active` pada meja belum ada; tanpa kolom `session_version` pada pengguna, semua permintaan gagal; tanpa tabel `app_settings` dan kolom tarif pada pesanan, pesanan baru tidak bisa dibuat).

Urutan yang aman:

1. Hentikan server (`Ctrl + C`).
2. Ambil kode terbaru:

   ```bash
   git pull
   ```

3. Pasang dependensi kalau ada yang baru:

   ```bash
   npm install
   ```

4. Perbarui database (data tidak dihapus, aman dijalankan berulang kali):

   ```bash
   npm run db:migrate
   ```

5. Jalankan server lagi: `npm start`.

Database harus menyala saat `db:migrate` dijalankan (`npm run db:up`). Tidak perlu `db:reset` dan password tidak berubah.

---

## 5. Perintah Database

| Perintah | Fungsi |
|---|---|
| `npm run db:up` | Menyalakan database |
| `npm run db:down` | Mematikan database (data aman) |
| `npm run db:logs` | Melihat log database (`Ctrl + C` untuk keluar) |
| `npm run db:shell` | Membuka MySQL interaktif (diminta password root, yaitu `DB_PASSWORD` di `.env`) |
| `npm run db:seed` | Mengisi password dan PIN pengguna yang belum punya (instalasi baru); tidak menimpa yang sudah diganti. `npm run db:seed -- --all` menimpa **semua** pengguna |
| `npm run db:migrate` | Menambahkan tabel/kolom baru dari `database/migrations/` ke database yang sudah ada, **tanpa menghapus data**. Aman dijalankan berulang kali. Jalankan setelah memperbarui kode (`git pull`) |
| `npm run db:reset` | **Menghapus semua data** dan membuat ulang database dari `database/kasir_restoran.sql`. Setelahnya jalankan `npm run db:seed` lagi |
| `npm run db:dump` | Mengekspor kondisi database sekarang ke `database/kasir_restoran.sql` |

### Menyambungkan dengan DBeaver / HeidiSQL

| Isian | Nilai |
|---|---|
| Host | `localhost` |
| Port | `3307` |
| User | `root` |
| Password | isi `DB_PASSWORD` di `.env` (bawaan: `rootpass`) |
| Database | `kasir_restoran` |

### Hal yang perlu diketahui

- File `database/kasir_restoran.sql` hanya dijalankan **sekali**, yaitu saat database pertama kali dibuat (volume masih kosong). Kalau file ini diubah, jalankan `npm run db:reset` agar perubahannya dipakai (data lama terhapus).
- File itu diawali `DROP DATABASE IF EXISTS kasir_restoran;`. Jangan pernah menjalankannya manual ke database yang berisi data asli.
- Jangan pernah meng-commit file `.env` ke Git.

---

## 6. Masalah Umum (Troubleshooting)

**`JWT_SECRET belum diatur atau terlalu lemah` saat `npm start`**
`JWT_SECRET` di `.env` masih kosong atau kurang dari 32 karakter. Ulangi [Langkah 4](#langkah-4-isi-jwt_secret-di-env).

**`Cannot connect to the Docker daemon` / `docker: error during connect`**
Docker Desktop belum menyala. Buka aplikasinya, tunggu sampai *running*, lalu ulangi `npm run db:up`.

**`Port 3307 is already in use`**
Port itu dipakai aplikasi lain. Ubah `DB_PORT` di `.env` (misalnya `DB_PORT=3308`), lalu jalankan `npm run db:up` lagi.

**`EADDRINUSE: address already in use :::3000`**
Port 3000 sedang dipakai. Tutup server lain yang berjalan, atau ubah `PORT` di `.env`.

**`ECONNREFUSED` atau gagal terhubung ke database saat `db:seed` / `npm start`**
Database belum siap. Cek `docker compose ps` sampai `healthy`, lalu ulangi.

**`Access denied for user 'root'`**
`MYSQL_ROOT_PASSWORD` harus sama dengan `DB_PASSWORD` di `.env`. MySQL hanya membaca password saat pertama kali dibuat, jadi kalau kamu mengubahnya setelah database ada, jalankan `npm run db:reset` lalu `npm run db:seed`.

**`Table 'kasir_restoran.stock_movements' doesn't exist`, `...reservations' doesn't exist`, atau `Unknown column 'is_active'` (atau tabel/kolom lain yang tidak ada) saat bayar / void, atau denah meja dan daftar reservasi tidak mau muncul**
Database belum diperbarui setelah `git pull`. Jalankan `npm run db:migrate`, lalu coba lagi. Data tidak hilang.

**Login selalu gagal dengan "Username atau password salah"**
Password hasil `db:seed` hanya muncul sekali. Kalau ada admin yang masih bisa login, minta ia mereset passwordmu di tab **Kelola User**. Kalau tidak ada, jalankan `npm run db:seed -- --all` dan pakai password baru yang tampil (ini menimpa password dan PIN **semua** pengguna).

**Semua permintaan gagal atau muncul `Unknown column 'session_version'` setelah `git pull`**
Database belum diperbarui. Jalankan `npm run db:migrate`, lalu muat ulang halaman. Data dan akun tidak berubah.

**"Pengaturan pajak dan service belum lengkap" atau `Unknown column 'tax_rate'` saat membuat atau membayar pesanan**
Database belum diperbarui setelah `git pull`. Jalankan `npm run db:migrate`, lalu muat ulang halaman. Data tidak hilang.

**"Akun admin tidak dapat membuat atau mengubah pesanan" (atau tidak ada tombol Pesanan Baru dan kartu Shift)**
Itu disengaja: hanya akun **Kasir** yang menangani pesanan dan shift. Login sebagai kasir (mis. `budi`) untuk membuat pesanan. Lihat [Siapa yang Menangani Pesanan](#siapa-yang-menangani-pesanan).

**Tiba-tiba keluar sendiri ("Sesi berakhir" atau "Akun tidak aktif")**
Itu disengaja: password akunmu baru direset atau diganti, atau akunmu dinonaktifkan oleh admin. Login lagi dengan password yang baru, atau minta admin mengaktifkan akunmu di tab **Kelola User**.

**Database `unhealthy` atau tidak mau jalan**
Lihat penyebabnya dengan `npm run db:logs`.

---

## 7. Opsional: Semua Jalan di Docker

Kalau mau aplikasi **dan** database sama-sama berjalan di Docker (tanpa `npm start`):

```bash
docker compose --profile full up -d --build
```

Syaratnya `JWT_SECRET` sudah terisi di `.env`. Setelah database `healthy`, buat password dan PIN dari komputermu (database terbuka di port 3307):

```bash
npm run db:seed
```

Aplikasi bisa dibuka di http://localhost:3000.

---

## 8. Struktur Proyek

```
restoran/
├── server.js                    # Server Express dan semua endpoint API
├── db.js                        # Koneksi MySQL
├── seed-users.js                # Pembuat password dan PIN pengguna
├── migrate.js                   # Menjalankan file di database/migrations/
├── public/index.html            # Tampilan aplikasi (frontend)
├── database/kasir_restoran.sql  # Skema dan data awal database (instalasi baru)
├── database/migrations/         # Pembaruan skema untuk database yang sudah ada
├── docs/superpowers/            # Catatan desain (specs/) dan rencana kerja (plans/) fitur
├── docker-compose.yml           # Konfigurasi MySQL (dan app, profil "full")
├── Dockerfile                   # Image Docker untuk aplikasi
├── .env.example                 # Contoh pengaturan; salin menjadi .env
└── package.json                 # Dependensi dan daftar perintah npm
```
