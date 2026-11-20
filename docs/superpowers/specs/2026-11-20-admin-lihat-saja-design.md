# Admin Hanya Lihat (Kasir yang Menangani Pesanan) — Desain (singkat)

Tanggal: 2026-11-20
Status: disetujui (permintaan pengguna lengkap dengan aturan dan tes penerimaan)

## Tujuan dan alasan

Akun admin dipakai untuk memantau dan mengelola, bukan melayani pelanggan. Hanya akun **kasir** yang boleh menjalankan
shift dan membuat atau mengubah pesanan; admin tidak boleh melakukannya, baik lewat layar maupun lewat permintaan
langsung ke server.

## Sasaran

- Satu daftar peran di server (`ORDER_HANDLER_ROLES = ['kasir']`) dan satu fungsi di klien (`canHandleOrders()`), tanpa
  perbandingan peran lain yang tersebar.
- Server: middleware `requireOrderHandler` pada `POST /api/orders`, `PUT /api/orders/:id`, `POST /api/orders/:id/items`,
  `PATCH /api/orders/:id/items/:itemId`, `PATCH /api/orders/:id/status`, `POST /api/orders/:id/pay`,
  `POST /api/shifts/open`, `/cash-movement`, `/close`. Jawaban: 403 `Akun <peran> tidak dapat membuat atau mengubah pesanan`.
- `GET /api/shifts/current` untuk akun non-kasir menjawab 200 `{shift: null, hidden: true}`.
- Klien: kartu Shift, tombol "+ Pesanan Baru", dan semua tombol aksi pesanan hilang; meja kosong dan kartu menu tidak
  bisa diklik (tanpa kursor pointer); panel pesanan terbuka hanya-baca (item, catatan, total, status, nama kasir);
  lencana "Mode Admin (hanya lihat)" di header; mode tetap setelah refresh dan ikut berubah saat peran berubah.

## Bukan sasaran

- Mengubah skema database, menghapus pesanan atau shift lama milik admin, atau menutup otomatis shift admin yang masih
  terbuka (disediakan satu perintah SQL untuk menutupnya manual).
- Memblokir void, cetak ulang, stok (tambah dan koreksi), laporan, dan semua `GET`.

## Anti-sasaran

- Admin membuat atau mengubah pesanan lewat `curl` atau konsol browser.
- Peran dibaca dari token/variabel klien (peran harus dibaca dari database setiap permintaan; sudah begitu di
  `authMiddleware`).
- Fitur kasir berubah.

## Keputusan

- **Supervisor ikut hanya-lihat.** Aturan pengguna: "hanya peran kasir"; contoh helper-nya `role === 'kasir'`. Supervisor
  tadinya bisa menangani pesanan, sekarang tidak. Untuk mengizinkannya lagi: tambah `'supervisor'` di dua tempat
  (server dan klien). Pesan penolakan memakai nama perannya (`Akun supervisor ...`); untuk admin persis seperti diminta.
- **Reservasi bukan pesanan**: endpoint reservasi tetap terbuka bagi semua peran. Yang disembunyikan hanya tombol
  "Tamu Datang" dan "Buka Pesanan" (membuka pesanan baru); untuk non-kasir klik meja berisi tamu membuka rincian reservasi.
- **Pesanan aktif dibuka dengan tombol "Lihat"** (daftar Pesanan Aktif dan klik meja terisi). Status pesanan tampil
  sebagai teks, bukan pilihan; "Split" (simulasi hitung) tetap ada karena tidak mengubah data.
- **Pertahanan berlapis di klien**: selain menyembunyikan tombol, fungsi yang mengubah pesanan atau shift
  (`startNewOrder`, `addItemToOrder`, `changeItemQty`, `openNoteEditor`, `handleDiscountChange`, `setPaymentMethod`,
  `runOrderAction`, `handleOrderStatusChange`, fungsi shift, `arriveReservation`, `openSeatedOrder`, `restoreDraft`)
  langsung berhenti bila `canHandleOrders()` salah.
- **Peran berubah saat halaman terbuka** (`syncMe` tiap 15 detik): `applyOrderModeUi()` menggambar ulang meja, daftar
  pesanan, menu, reservasi, dan panel; pesanan yang sedang ditulis ditutup bila akun menjadi non-kasir.
- **Shift admin lama yang masih terbuka** tidak disentuh; karena tidak bisa ditutup dari aplikasi, README memuat
  `UPDATE shifts SET status='closed', closed_at=NOW() WHERE cashier_id = <id admin> AND status='open';`.
  Di database asli saat ini tidak ada shift atau pesanan milik admin/supervisor.

## Pengujian penerimaan

1. Login admin: kartu Shift dan "+ Pesanan Baru" tidak tampak; lencana hanya-lihat tampil.
2. Klik meja kosong dan kartu menu sebagai admin: tidak ada yang terjadi.
3. Klik pesanan aktif sebagai admin: terbuka hanya-baca tanpa tombol ubah, simpan, bayar, hold.
4. `POST /api/orders` (dan semua endpoint di daftar) sebagai admin dan supervisor: 403 dengan pesan di atas, tidak ada
   baris yang berubah; tanpa token 401; badan kosong tetap 403.
5. `POST /api/shifts/open`: 403; `GET /api/shifts/current`: 200 `{shift:null, hidden:true}`, shift admin lama tidak tersentuh.
6. Login kasir: shift, "+ Pesanan Baru", klik meja, dan alur pesanan penuh bekerja seperti sebelumnya.
7. Admin: ringkasan, riwayat transaksi, laporan, cetak ulang, void dengan PIN, tambah stok, dan koreksi stok tetap jalan.
8. Refresh halaman sebagai admin: tetap hanya-lihat. Peran yang diubah di database langsung berlaku di permintaan berikutnya.
