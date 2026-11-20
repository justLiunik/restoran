# Layar Dapur — Desain (singkat)

Tanggal: 2026-11-20
Status: disetujui

## Tujuan dan alasan

Dapur belum punya layar sendiri; pesanan hanya terlihat di daftar Pesanan Aktif milik kasir. Dapur butuh antrean tiket
yang jelas di perangkat khusus dapur, dengan akun sendiri yang tidak bisa menyentuh data penjualan.

## Sasaran

- Peran baru `dapur` dan halaman terpisah `/dapur.html` (tema gelap, huruf besar, tanpa harga atau tombol bayar).
- Antrean tiket: pesanan paling lama di atas; nomor, meja atau jenis pesanan (Dine-in, Take Away, platform delivery),
  item × jumlah, catatan item mencolok, pewaktu hijau/kuning/merah (kuning 10 menit, merah 20 menit).
- Tombol **Mulai Masak** dan **Siap Saji**; strip **Baru siap** (15 menit) dengan **Batalkan**; bunyi saat tiket baru,
  tiket diubah, atau tiket dibatalkan; pembaruan tiap 5 detik.
- **DIUBAH** (item berubah setelah Mulai Masak, atau setelah Siap Saji) dan **DIBATALKAN** (void) tetap tampil sampai
  dapur menekan "Sudah dilihat".
- Akun `dapur` hanya boleh membuka layar dapur; semua endpoint lain ditolak (403).
- Kelola User bisa membuat dan mengubah akun dengan peran Dapur (tanpa PIN, tanpa shift).

## Bukan sasaran

- Batas warna yang bisa diatur dari layar (tetap 10 dan 20 menit, satu tempat di server).
- Filter stasiun Makanan/Minuman, rekap per menu, tombol menu habis, centang selesai per item, cetak tiket, notifikasi
  ke layar kasir, laporan kecepatan dapur.
- Menampilkan harga, total, atau data pembayaran di layar dapur.

## Anti-sasaran

- Tiket hilang dari dapur saat pesanan dibayar di muka (take-away, delivery).
- Dapur memasak pesanan yang sudah di-void, atau tidak tahu item diubah setelah mulai masak.
- Akun dapur membaca laporan, pesanan, atau data penjualan, atau memanggil endpoint kasir.
- Tiket lama yang tak pernah ditutup menumpuk di layar.
- Perubahan alur kasir.

## Pendekatan

`orders.status` mencampur status dapur dan status pembayaran (pembayaran mengubahnya menjadi `selesai`). Tiga cara:

1. Layar dapur membaca `status` apa adanya. Ditolak: tiket pesanan yang dibayar di muka hilang sebelum jadi.
2. Menambah penanda "sudah dibayar" dan tetap memakai `status`. Ditolak: mengubah alur kasir yang sudah berjalan.
3. **Status dapur terpisah (dipilih):** kolom `kitchen_status` yang berjalan sendiri; `status` kasir tetap, dan keduanya
   saling menyamakan hanya pada perpindahan yang masuk akal.

## Keputusan

- **Migrasi 007** (idempotent, cek `information_schema`):
  - `users.role` ditambah `'dapur'`.
  - `orders.kitchen_status ENUM('baru','diproses','siap') NOT NULL DEFAULT 'baru'`,
    `orders.kitchen_status_at DATETIME NULL`, `orders.kitchen_alert ENUM('diubah','dibatalkan') NULL`.
  - Isi pesanan lama **hanya saat kolom baru ditambahkan**: `baru`→`baru`, `diproses`→`diproses`, `hold`→`baru`,
    selain itu `siap` (riwayat lama tidak muncul di dapur). Kedua dump SQL diperbarui, termasuk tiga pesanan contoh.
- **Isi antrean** (`GET /api/kitchen/orders`, semua peran yang login): pesanan dibuka dalam 12 jam terakhir dan bukan
  `hold`/`void` dengan `kitchen_status` baru/diproses; pesanan `void` dengan tanda `dibatalkan`; strip "siap" =
  `kitchen_status='siap'` dalam 15 menit. Umur tiket dihitung di MySQL (`TIMESTAMPDIFF`), jadi tidak bergantung zona
  waktu. Tidak ada harga, total, atau data pembayaran di jawaban.
- **Perpindahan** (`PATCH /api/kitchen/orders/:id {kitchen_status}`, hanya akun `dapur`): baru→diproses, baru→siap,
  diproses→siap, siap→diproses (batalkan); status yang sama = berhasil tanpa perubahan; lainnya 409. Pesanan hold atau
  void ditolak 409. Perpindahan menyamakan `orders.status` hanya bila nilainya baru/diproses/siap_saji (diproses↔`diproses`,
  siap↔`siap_saji`); `belum_dibayar`, `selesai`, `hold` tidak disentuh. Pada perpindahan ke siap, tanda diubah dihapus.
- **Sinkron dari kasir**: `PATCH /api/orders/:id/status` dengan `diproses` atau `siap_saji` ikut menyamakan status
  dapur (siap_saji juga menghapus tanda diubah); nilai lain tidak mengubah dapur.
- **Tanda DIUBAH**: dipasang di simpan pesanan (PUT), tambah item, dan ubah jumlah **hanya bila isi item benar-benar
  berbeda** (dibandingkan sebelum dan sesudah) dan status dapur `diproses`/`siap`; bila `siap`, tiket kembali ke
  `diproses`. Pesanan yang belum dimulai (`baru`) tidak diberi tanda. **DIBATALKAN**: void pada pesanan non-hold yang
  status dapurnya baru/diproses.
- **Sudah dilihat** (`POST /api/kitchen/orders/:id/ack`, hanya `dapur`): menghapus tanda; untuk dibatalkan, tiket juga
  ditutup (`kitchen_status='siap'`).
- **Akses akun dapur**: daftar putih setelah autentikasi: `GET /api/me`, `POST /api/me/password`, tiga endpoint dapur.
  Selain itu 403 `Akun dapur hanya dapat memakai layar dapur`. Peran dibaca dari database tiap permintaan.
- **Halaman**: `/dapur.html` (alias `/dapur`). Admin, supervisor, dan kasir yang membuka halaman ini hanya melihat
  (tanpa tombol, ada keterangan mode lihat). Akun dapur yang login di aplikasi kasir dialihkan ke `/dapur.html`.
- **Kelola User**: pilihan Dapur, lencana peran, keterangan peran; memberi PIN pada akun dapur ditolak
  ("Akun dapur tidak memiliki PIN"); pindah ke dapur menghapus PIN seperti kasir.

## Pengujian penerimaan

1. Akun dapur: hanya `/api/me`, ganti password, dan tiga endpoint dapur yang terbuka; selain itu 403; tanpa token 401.
2. Kasir, admin, supervisor bisa `GET` antrean tetapi `PATCH`/`ack` 403.
3. Tiket muncul dengan item, catatan, jenis/meja, umur; hold tidak muncul; jawaban tanpa harga atau total.
4. Pesanan dibayar di muka tetap di antrean sampai dapur menandai siap.
5. Perpindahan dan penyamaan status sesuai aturan; perpindahan terlarang 409; kasir yang mengubah status ikut
   menyamakan dapur.
6. Tanda diubah (hanya bila isi berubah; kembali ke diproses bila sudah siap), dibatalkan, dan "sudah dilihat".
7. Jendela 12 jam dan strip siap 15 menit.
8. Kelola User: membuat akun dapur tanpa PIN, PIN ditolak, pindah peran, daftar menampilkan peran.
9. Migrasi pada database lama (isi pesanan lama sesuai pemetaan, aman dijalankan dua kali tanpa menimpa).
10. Layar: tiket, pewaktu, tombol, bunyi, strip siap, mode lihat untuk non-dapur, login dan keluar.
11. Regresi: semua suite lama, alur kasir, dan mode hanya-lihat admin tetap jalan.
