# User Management — Desain (singkat)

Tanggal: 2026-11-19
Status: disetujui

## Tujuan dan alasan

Akun hanya bisa diubah lewat `db:seed` atau SQL. Admin perlu menambah kasir, mengubah data dan peran, mereset password dan PIN, dan
menonaktifkan akun dari dalam aplikasi; setiap pengguna perlu bisa mengganti password sendiri.

**Temuan:** token login berlaku 8 jam dan tidak dicek ke database, sehingga user yang dinonaktifkan atau diturunkan perannya tetap
bisa bekerja sampai tokennya habis. PIN yang sama pada dua supervisor/admin membuat otorisasi diskon/void ambigu (yang pertama
cocok yang tercatat). `db:seed` menimpa password dan PIN semua user.

## Sasaran

- Tab **👥 Kelola User** (hanya **admin**): tabel pengguna dengan **Tambah**, **Ubah** (nama, username, peran), **Reset Password**,
  **Atur PIN**, **Nonaktifkan / Aktifkan**.
- Tombol **🔑** di header untuk semua peran: **ganti password sendiri**, dan **ganti PIN sendiri** (supervisor/admin), keduanya
  dengan memasukkan password lama.
- Nonaktifkan, ubah peran, dan reset/ganti password berlaku **seketika**.
- `db:seed` tidak lagi menimpa password yang sudah diganti.

## Bukan sasaran

- Hapus permanen user, pendaftaran mandiri, pemulihan password lewat email, pembatasan percobaan login, riwayat perubahan,
  autentikasi dua langkah, peran selain kasir/supervisor/admin.

## Anti-sasaran

- User nonaktif atau yang sudah diturunkan perannya masih bisa memakai sesi lama.
- Password lama tetap berlaku di sesi lain setelah direset atau diganti.
- Tidak ada admin aktif yang tersisa (terkunci), termasuk saat dua admin saling menurunkan bersamaan.
- Dua supervisor/admin aktif memakai PIN yang sama, termasuk saat dua admin menyimpan PIN yang sama bersamaan.
- Kasir mengakses endpoint kelola user, atau hash password/PIN bocor di respons.

## Pendekatan

Kolom baru `users.session_version` (migrasi 005). Token memuat `sv`; middleware autentikasi memuat user dari database di setiap
permintaan, menolak (401) user yang tidak ada/nonaktif atau `sv` yang tidak cocok, dan memakai **peran dari database**, bukan dari
token. Reset/ganti password dan menonaktifkan menaikkan `sv`. Token lama tanpa `sv` dianggap `sv = 0` sehingga sesi yang sedang
berjalan saat pembaruan tetap valid. Klien menyinkronkan nama dan peran lewat `GET /api/me` setiap 15 detik.

## Keputusan

- **Skema**: `database/migrations/005_user_session_version.sql` menambah `users.session_version INT UNSIGNED NOT NULL DEFAULT 0`
  secara idempotent (pola migrasi 004); kedua dump SQL diperbarui. `db:migrate` wajib setelah `git pull`.
- **Izin**: endpoint `/api/admin/users*` hanya `admin` (403 selain itu). `/api/me*` untuk semua peran yang login.
- **Aturan data**:
  - nama 1–100; username 3–30 karakter `a-z 0-9 . _ -` (huruf besar diubah ke kecil), unik;
  - peran `kasir | supervisor | admin`; password 8–72 karakter (batas bcrypt);
  - PIN 4 digit, **wajib untuk supervisor dan admin**, kasir tidak boleh punya PIN (400 bila dikirim);
  - PIN **unik** di antara supervisor/admin aktif lain (409); pengecekan dan penyimpanan PIN dilindungi `GET_LOCK` agar dua admin
    tidak bisa menyimpan PIN yang sama bersamaan.
- **Aturan peran dan status**:
  - kasir → supervisor/admin wajib menyertakan PIN; → kasir menghapus PIN; supervisor ↔ admin tidak mengubah PIN;
  - admin tidak boleh mengubah peran atau menonaktifkan dirinya sendiri, dan tidak boleh mereset password dirinya lewat tab ini
    (pakai Akun Saya);
  - admin aktif terakhir tidak boleh diturunkan/dinonaktifkan (dicek dalam transaksi dengan `FOR UPDATE` pada baris admin);
  - user dengan **shift terbuka** tidak boleh dinonaktifkan;
  - **mengaktifkan kembali** supervisor/admin menghapus PIN lamanya (PIN yang unik tidak bisa diperiksa ulang); admin mengatur PIN baru.
- **Sesi**: reset password oleh admin, ganti password sendiri, dan nonaktifkan menaikkan `session_version`. Ganti password sendiri
  mengembalikan token baru sehingga sesi yang sedang dipakai tetap lanjut.
- **Endpoint**:

| Endpoint | Izin | Fungsi |
|---|---|---|
| `GET /api/me` | semua peran | `{ id, name, username, role }` terkini |
| `POST /api/me/password` | semua peran | `{ current_password, new_password }` → `{ ok, token }` |
| `POST /api/me/pin` | supervisor, admin | `{ current_password, pin }` |
| `GET /api/admin/users` | admin | daftar: `id, name, username, role, is_active, has_pin, created_at, has_open_shift` |
| `POST /api/admin/users` | admin | `{ name, username, role, password, pin? }` → 201 |
| `PUT /api/admin/users/:id` | admin | `{ name, username, role, pin? }` |
| `POST /api/admin/users/:id/password` | admin | `{ password }` |
| `PUT /api/admin/users/:id/pin` | admin | `{ pin }` (hanya supervisor/admin) |
| `PATCH /api/admin/users/:id/active` | admin | `{ is_active }` |

- **Respons** tidak pernah memuat `password_hash`/`pin_hash`.
- **`db:seed`**: bawaan hanya mengisi user yang `password_hash`/`pin_hash`-nya masih placeholder `GANTI_DENGAN_HASH_BCRYPT`;
  `npm run db:seed -- --all` (atau `SEED_ALL=1`) menimpa semua seperti sebelumnya dan menaikkan `session_version`.
- **Klien**: tombol 🔑 di header dan dialog "Akun Saya"; tab Kelola User dan dialog form/password/PIN; sinkron `GET /api/me` setiap 15 detik
  (peran/nama berubah → tampilan menyesuaikan; 401 → keluar otomatis seperti sekarang); semua teks di-escape.

## Pengujian penerimaan

1. Izin: tanpa token 401; kasir dan supervisor 403 pada semua endpoint admin; admin 200; respons tanpa hash.
2. Tambah: username huruf besar → kecil dan bisa login; username kembar (beda huruf) 409; validasi (nama, username, peran, password 7/73
   karakter, PIN salah format, PIN pada kasir, PIN wajib untuk supervisor/admin) → 400 tanpa user baru.
3. PIN: supervisor baru bisa otorisasi lewat `/api/verify-pin` dan tercatat atas namanya; PIN yang sama dengan supervisor/admin aktif lain → 409;
   dua penyimpanan PIN yang sama bersamaan → satu yang berhasil.
4. Ubah: nama/username; kasir→supervisor butuh PIN; supervisor→kasir menghapus PIN (PIN lama gagal); ubah peran sendiri 409; admin aktif
   terakhir tidak bisa diturunkan, termasuk dua admin yang saling menurunkan bersamaan (selalu tersisa satu admin aktif).
5. Sesi: reset password → token lama 401, password lama gagal, baru berhasil; nonaktifkan → token 401 seketika, login gagal, token lama tetap mati
   setelah diaktifkan lagi; peran diturunkan → izin hilang seketika; token lama tanpa `sv` tetap valid; token user yang tidak ada 401.
6. Aturan: tidak bisa menonaktifkan diri sendiri atau user dengan shift terbuka; mengaktifkan supervisor/admin menghapus PIN-nya; reset password sendiri 409.
7. Akun Saya: password lama salah ditolak; password baru lemah ditolak; berhasil → token baru, token lama 401; PIN sendiri butuh password lama,
   ditolak bila kembar; kasir tidak bisa mengatur PIN.
8. `db:seed`: bawaan tidak mengubah user yang sudah punya password sungguhan, hanya yang placeholder; `--all` menimpa semua.
9. Migrasi pada database lama: kolom ditambahkan, semua `sv = 0`, aman diulang; sesi lama tanpa `sv` tetap jalan.
10. Klien: tab dan 🔑 sesuai peran, semua dialog dan aturan tombol, perubahan peran/nonaktif tercermin tanpa login ulang, teks berbahaya aman,
    lebar tablet rapi. Regresi: alur pesanan, void/diskon dengan PIN, reservasi, laporan, kelola menu/stok/meja.
