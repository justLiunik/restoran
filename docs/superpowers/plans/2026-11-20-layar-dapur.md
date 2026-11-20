# Layar Dapur — Rencana

Desain: `docs/superpowers/specs/2026-11-20-layar-dapur-design.md`

- [x] **1. Migrasi 007 dan dump SQL**
  - `database/migrations/007_kitchen_screen.sql`: `users.role` + `'dapur'`; kolom `orders.kitchen_status`,
    `kitchen_status_at`, `kitchen_alert`; isi pesanan lama hanya saat kolom baru ditambahkan.
  - Kedua dump SQL (identik) + tiga pesanan contoh. Uji: DB lama dimigrasi dua kali, isi tidak tertimpa.
- [x] **2. Server** (`server.js`)
  - Daftar putih akun dapur sesudah `authMiddleware`; endpoint `GET /api/kitchen/orders`,
    `PATCH /api/kitchen/orders/:id`, `POST /api/kitchen/orders/:id/ack`; alias `/dapur`.
  - Tanda DIUBAH di PUT/tambah item/ubah jumlah (bandingkan isi sebelum dan sesudah), DIBATALKAN di void,
    penyamaan dari `PATCH /api/orders/:id/status`.
  - Kelola User: peran `dapur` tanpa PIN.
- [x] **3. Klien kasir** (`public/index.html`): peran Dapur di Kelola User (pilihan, lencana, keterangan); akun dapur dialihkan
  ke `/dapur.html` saat login, saat halaman dibuka, dan saat peran berubah.
- [x] **4. Layar dapur** (`public/dapur.html`): login, tiket, pewaktu, tombol, strip siap, bunyi, mode lihat, layar penuh.
- [x] **5. Verifikasi dan dokumen**: tes API `kitchen-api-tests.mjs`, uji mutasi, semua suite lama, uji di browser;
  README dan migrasi database asli.
