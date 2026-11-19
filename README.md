# Kasir Restoran

Aplikasi kasir (POS) restoran berbasis web: login per peran, pesanan meja, pembayaran, diskon dengan otorisasi PIN supervisor, shift kasir, dan dashboard penjualan.

**Teknologi:** Node.js + Express (backend), MySQL 8 yang berjalan di Docker (database), HTML/CSS/JS biasa (frontend, ada di `public/index.html`).

---

## Daftar Isi

1. [Yang Perlu Disiapkan](#1-yang-perlu-disiapkan)
2. [Instalasi Langkah demi Langkah](#2-instalasi-langkah-demi-langkah)
3. [Login ke Aplikasi](#3-login-ke-aplikasi)
4. [Menjalankan Lagi di Hari Berikutnya](#4-menjalankan-lagi-di-hari-berikutnya)
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

Perintah ini membuat **password acak** untuk semua pengguna dan **PIN 4 digit acak** untuk supervisor/admin, lalu menampilkannya **sekali saja**:

```
✅ User hashes successfully seeded!
ℹ️ Password (semua user): xxxxxxxxxxxx
ℹ️ PIN (supervisor/admin): 0000
```

**Catat keduanya sekarang**, karena tidak akan ditampilkan lagi. Kalau lupa, jalankan `npm run db:seed` lagi untuk membuat yang baru.

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
| `budi` | Kasir | Transaksi harian |
| `sari` | Kasir | Transaksi harian |
| `spv` | Supervisor | Punya PIN untuk otorisasi |
| `admin` | Admin | Punya PIN untuk otorisasi |

- **Password:** yang ditampilkan di Langkah 7 (sama untuk semua pengguna).
- **PIN:** yang ditampilkan di Langkah 7. PIN diminta saat kasir memberi **diskon di atas 20%** atau **membatalkan (void) transaksi**, lalu supervisor atau admin memasukkan PIN-nya.

> Password dan PIN hanya untuk pengembangan lokal. Kalau aplikasi dipasang di server sungguhan, ganti dengan nilai yang kuat lewat `SEED_PASSWORD` dan `SEED_PIN`.

### Alur Pesanan

Membuat atau menyimpan pesanan butuh **shift yang sudah dibuka** (kasir `budi` sudah punya shift terbuka di data awal).

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

---

## 5. Perintah Database

| Perintah | Fungsi |
|---|---|
| `npm run db:up` | Menyalakan database |
| `npm run db:down` | Mematikan database (data aman) |
| `npm run db:logs` | Melihat log database (`Ctrl + C` untuk keluar) |
| `npm run db:shell` | Membuka MySQL interaktif (diminta password root, yaitu `DB_PASSWORD` di `.env`) |
| `npm run db:seed` | Membuat ulang password dan PIN semua pengguna |
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

**Login selalu gagal dengan "Username atau password salah"**
Password hasil `db:seed` hanya muncul sekali. Jalankan `npm run db:seed` lagi dan pakai password baru yang tampil.

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
├── docker-compose.yml           # Konfigurasi MySQL (dan app, profil "full")
├── Dockerfile                   # Image Docker untuk aplikasi
├── .env.example                 # Contoh pengaturan; salin menjadi .env
└── package.json                 # Dependensi dan daftar perintah npm
```
