# Kelola Menu — Desain

Tanggal: 2026-11-19
Status: menunggu persetujuan

## Tujuan dan alasan

Sekarang menu (tambah, ubah harga, ganti nama, nonaktifkan) dan kategori hanya bisa diubah lewat SQL.
Ini membuat aplikasi belum bisa dipakai harian oleh admin/supervisor tanpa menyentuh database.

Fitur ini memberi **admin dan supervisor** layar untuk mengelola menu dan kategori dari dalam aplikasi,
**kapan saja**, termasuk saat restoran sedang ramai.

## Sasaran

- Tab baru **"Kelola Menu"**, hanya terlihat oleh role `admin` dan `supervisor`.
- Menu: **tambah**, **ubah** (nama, kategori, harga, link foto, batas stok menipis), **nonaktifkan / aktifkan kembali**.
- Kategori: **tambah**, **ganti nama**, **atur urutan**, **hapus** (hanya jika tidak punya menu sama sekali).
- Saat menambah menu, **stok awal** bisa diisi dan tercatat di riwayat stok.
- Perubahan langsung terlihat di tab Katalog Menu dan panel pesanan.

## Bukan sasaran

- Upload foto dari perangkat (lihat Keputusan: foto hanya berupa link).
- Hapus permanen menu. "Hapus" = nonaktifkan.
- Mengubah stok. Itu tetap di tab Kelola Stok (restock/koreksi).
- Kelola user, kelola meja, riwayat perubahan harga (audit log), PIN konfirmasi saat ubah harga.
- Ekspor/impor menu massal (CSV).

## Anti-sasaran (dianggap gagal walau fiturnya jalan)

- Mengubah transaksi, struk, atau laporan lama. Riwayat tetap memakai nama dan harga saat transaksi.
- Merusak pesanan yang sedang terbuka atau di-hold saat menunya diubah atau dinonaktifkan.
- Kasir bisa memanggil endpoint kelola menu dengan request buatan sendiri (menyembunyikan tab saja tidak cukup).

## Batasan

- Mengikuti kode yang ada: Express + mysql2, satu file `server.js`, satu file `public/index.html` (vanilla JS), tanpa dependensi baru.
- Teks antarmuka berbahasa Indonesia. Target sentuh nyaman untuk tablet (seperti panel pesanan dan Kelola Stok).
- Pola error server: `{ error: "pesan" }` dengan status HTTP yang tepat (`HttpError` sudah ada).
- **Tidak ada perubahan skema database**, jadi tidak perlu migrasi baru. `products.is_active`, `products.image_url`,
  `products.low_stock_threshold`, dan `categories.sort_order` sudah ada, dan `categories.name` sudah `UNIQUE`.
- Role dibaca dari JWT (`req.user.role`, berlaku 8 jam). Token lama tetap berlaku sampai habis, sama seperti perilaku sekarang.

## Pendekatan yang dipertimbangkan

| | Pendekatan | Kelebihan | Kekurangan |
|---|---|---|---|
| A | Mode edit di tab "Katalog Menu" (tombol ubah di tiap kartu) | Paling cepat, perubahan langsung terlihat di kartu | Kartu jadi ramai; menu nonaktif dan kategori tidak punya tempat jelas |
| **B** | **Tab baru "Kelola Menu" khusus admin/supervisor (dipilih)** | Katalog kasir tetap bersih; menu nonaktif bisa diaktifkan lagi; kategori punya tempat; konsisten dengan Kelola Stok | Tab ke-6 (bar tab sudah `flex-wrap`) |

Dipilih **B** oleh pemilik proyek.

## Keputusan yang sudah diambil

**Antarmuka (tab Kelola Menu)**
- Toolbar: `+ Tambah Menu`, `Kategori` (membuka dialog kelola kategori), kolom cari, pilihan kategori, kotak centang `Tampilkan nonaktif` (default mati).
- Tabel: Nama · Kategori · Harga · Stok (hanya baca) · Status (Aktif/Nonaktif) · Aksi (`Ubah`, `Nonaktifkan`/`Aktifkan`).
- Dialog **Tambah/Ubah Menu**: nama, kategori, harga, link foto (opsional, dengan pratinjau kecil), batas stok menipis (default 5), dan **stok awal hanya saat tambah**.
- Dialog **Kelola Kategori**: daftar kategori dengan tombol naik/turun, ganti nama, hapus, dan baris tambah kategori.
- Nonaktifkan meminta satu konfirmasi singkat ("Menu tidak lagi muncul di kasir. Pesanan yang sudah berjalan tidak terpengaruh."). Mengaktifkan kembali langsung jalan.
- Setelah setiap perubahan berhasil: muat ulang daftar menu dan kategori di klien (Katalog, panel pesanan, Kelola Stok ikut segar) dan tampilkan toast.

**Server (semua di bawah `authMiddleware` + pengecekan role `admin`/`supervisor`, selain itu 403 "Hanya admin atau supervisor")**

| Endpoint | Fungsi |
|---|---|
| `GET /api/admin/products` | Semua menu termasuk nonaktif (nama, kategori, harga, foto, stok, status) |
| `POST /api/admin/products` | Tambah menu `{name, category_id, price, image_url?, low_stock_threshold?, stock?}` |
| `PUT /api/admin/products/:id` | Ubah `{name, category_id, price, image_url, low_stock_threshold}` (tidak menyentuh stok) |
| `PATCH /api/admin/products/:id/active` | `{is_active}`; idempoten |
| `POST /api/admin/categories` | Tambah `{name}`; `sort_order` = paling akhir |
| `PUT /api/admin/categories/:id` | Ganti nama `{name}` |
| `PUT /api/admin/categories/order` | Atur urutan `{ids:[...]}` (harus memuat semua kategori; `sort_order` = indeks) dalam satu transaksi |
| `DELETE /api/admin/categories/:id` | Hanya jika tidak ada menu (aktif maupun nonaktif); selain itu 409 "Kategori masih berisi N menu" |

**Aturan validasi**
- Nama menu: dipangkas spasi, 1–100 karakter. Nama kategori: 1–50 karakter.
- Harga: bilangan bulat rupiah, 1 sampai 100.000.000 (tidak ada desimal, 0 tidak boleh; untuk gratis pakai diskon).
- Stok awal: bilangan bulat 0–100.000 (default 0). Jika lebih dari 0, tulis baris `stock_movements` bertipe `restock`, catatan "Stok awal", dalam transaksi yang sama dengan pembuatan menu. Menu dengan stok 0 tampil "habis" sampai di-restock.
- Batas stok menipis: bilangan bulat 0–1000 (default 5).
- Link foto: kosong → `NULL`; jika diisi harus diawali `http://` atau `https://` dan maksimal 500 karakter.
- Nama menu tidak boleh kembar dalam kategori yang sama (tanpa membedakan huruf besar/kecil), termasuk dengan menu nonaktif; pesan error menyarankan mengaktifkan kembali menu lama. Nama kategori kembar → 409 "Nama kategori sudah dipakai".
- Kategori tujuan harus ada (400 jika tidak).
- Menu tidak ditemukan → 404.

**Perilaku terhadap pesanan**
- Mengubah harga atau nama hanya berlaku untuk item yang ditambahkan sesudahnya. Pesanan terbuka/hold tetap memakai harga yang sudah tersimpan (sudah begitu lewat `priceSnapshot`). Riwayat lama memakai salinan `order_items.product_name`/`price`.
- Nonaktifkan aman bagi pesanan berjalan: `buildOrderItems` tidak memeriksa `is_active`, jadi pesanan hold yang berisi menu itu tetap bisa dilanjutkan dan dibayar.
- Agar layar kasir yang belum dimuat ulang tidak bisa menambah menu yang baru dinonaktifkan: `buildOrderItems` menolak produk `is_active = 0` **kecuali** produk itu sudah ada di pesanan tersebut (`priceSnapshot.has(id)`); pesan: "Menu <nama> sudah dinonaktifkan". Rute lama `POST /api/orders/:id/items` mendapat pengecekan yang sama.

**Foto (keputusan saya)**
- Hanya kolom link (opsional). Upload file ditunda karena butuh dependensi dan penyimpanan file baru.
- Perbaikan terkait: sekarang `renderMenu` memakai `DEFAULT_MENU_IMAGES[((id-1)%15)+1]` bila `image_url` kosong, sehingga menu baru akan tampil dengan foto masakan lain. Ganti jadi: `image_url`, lalu gambar bawaan hanya untuk menu seed bernomor 1–15, selain itu **placeholder polos** (kotak berwarna dengan huruf pertama nama). Foto yang gagal dimuat juga jatuh ke placeholder.

**Dokumentasi**
- README: bagian "Kelola Menu" (siapa yang boleh, cara tambah/ubah/nonaktifkan, arti "hapus" = nonaktif) dan catatan bahwa fitur ini **tidak** butuh `db:migrate`.

## Pengujian penerimaan

1. Token kasir ke semua endpoint `/api/admin/*` → 403; token admin dan supervisor → berhasil. Tab "Kelola Menu" tidak muncul untuk kasir.
2. Tambah menu (stok awal 10) → muncul di Katalog pada kategori yang benar dengan stok 10; `stock_movements` punya baris `restock` "Stok awal". Stok awal 0 → tampil "habis".
3. Ubah harga → pesanan baru memakai harga baru; pesanan terbuka yang sudah berisi menu itu tetap memakai harga lama dan bisa dibayar dengan harga lama.
4. Ganti nama → Katalog menampilkan nama baru; transaksi lama di Riwayat tetap menampilkan nama lama.
5. Nonaktifkan → hilang dari Katalog dan panel pesanan; pesanan hold yang berisi menu itu bisa dilanjutkan dan dibayar; menambahkannya ke pesanan baru lewat API → 400 "sudah dinonaktifkan". Aktifkan kembali → muncul lagi.
6. Nama menu kembar dalam kategori yang sama → 409; nama kategori kembar → 409.
7. Hapus kategori yang masih berisi menu (termasuk menu nonaktif) → 409; kategori kosong → terhapus. Ubah urutan → urutan pil kategori di Katalog ikut berubah.
8. Validasi: harga 0, negatif, desimal, bukan angka; nama kosong dan 101 karakter; link foto tanpa `http(s)://` → 400 dengan pesan jelas; tidak ada data berubah.
9. Menu baru tanpa foto tampil dengan placeholder, bukan foto masakan lain; link foto yang rusak jatuh ke placeholder.
10. Regresi: alur pesanan (simpan, hold, lanjutkan, bayar, void) dan Kelola Stok tetap jalan.

## Diserahkan ke pembangun

- Tampilan visual rinci: ukuran kolom, warna dan huruf placeholder, susunan dialog, teks toast dan konfirmasi.
- Nama fungsi dan struktur kode klien (ikuti pola Kelola Stok).
- Cara paling rapi menaruh pengecekan role (middleware `requireRole(...)` yang dipakai ulang).
- Menyesuaikan cache klien (`menu`, `categories`) setelah perubahan.
- Urutan rute: `PUT /api/admin/categories/order` harus didaftarkan **sebelum** `PUT /api/admin/categories/:id`, supaya kata "order" tidak terbaca sebagai id.

## Keputusan saya (mohon dikoreksi bila tidak cocok)

1. Supervisor ikut boleh, sesuai permintaan; kasir tidak.
2. Foto hanya link; upload ditunda.
3. Nama menu kembar dalam satu kategori ditolak.
4. Harga bilangan bulat rupiah, minimal 1.
5. Urutan kategori diatur dengan tombol naik/turun, bukan seret-lepas.
6. Tidak ada audit log perubahan harga dan tidak ada PIN tambahan.
7. Nonaktifkan butuh satu konfirmasi; ubah dan aktifkan tidak.
