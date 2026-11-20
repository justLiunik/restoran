-- Migrasi 007: Layar Dapur.
--   * users.role: peran baru 'dapur' (akun perangkat dapur; hanya boleh membuka layar dapur).
--   * orders.kitchen_status: status dapur yang berjalan sendiri (baru -> diproses -> siap), terpisah dari orders.status
--     milik kasir. Dengan begitu tiket pesanan yang dibayar di muka (status 'selesai') tetap tampil di dapur sampai siap.
--   * orders.kitchen_status_at: kapan status dapur terakhir berubah.
--   * orders.kitchen_alert: 'diubah' (item berubah setelah mulai masak) atau 'dibatalkan' (void); hilang saat dapur
--     menekan "Sudah dilihat".
-- Aman dijalankan berulang kali dan untuk database yang sudah berisi data:
--   * pesanan lama diisi HANYA pada saat kolom kitchen_status baru ditambahkan: baru -> baru, diproses -> diproses,
--     hold -> baru, selain itu siap (riwayat lama tidak muncul di layar dapur). Migrasi berikutnya tidak menyentuhnya.
-- Jalankan: npm run db:migrate
--
-- MySQL 8 tidak punya "ADD COLUMN IF NOT EXISTS", jadi keberadaan kolom dicek dulu.

-- 1. Peran dapur
SET @role_type := (
  SELECT column_type FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'role'
);
SET @ddl := IF(@role_type LIKE '%''dapur''%',
  'SELECT 1',
  'ALTER TABLE users MODIFY role ENUM(''kasir'',''supervisor'',''admin'',''dapur'') NOT NULL DEFAULT ''kasir''');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Kolom dapur pada orders
SET @has_kitchen_status := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'kitchen_status'
);
SET @has_kitchen_status_at := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'kitchen_status_at'
);
SET @has_kitchen_alert := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'kitchen_alert'
);

SET @ddl := IF(@has_kitchen_status = 0,
  'ALTER TABLE orders ADD COLUMN kitchen_status ENUM(''baru'',''diproses'',''siap'') NOT NULL DEFAULT ''baru'' COMMENT ''status di layar dapur, terpisah dari status kasir'' AFTER status',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl := IF(@has_kitchen_status_at = 0,
  'ALTER TABLE orders ADD COLUMN kitchen_status_at DATETIME NULL COMMENT ''kapan status dapur terakhir berubah'' AFTER kitchen_status',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl := IF(@has_kitchen_alert = 0,
  'ALTER TABLE orders ADD COLUMN kitchen_alert ENUM(''diubah'',''dibatalkan'') NULL COMMENT ''tanda untuk dapur sampai dilihat'' AFTER kitchen_status_at',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3. Isi pesanan lama: hanya bila kitchen_status baru saja ditambahkan oleh migrasi ini
SET @ddl := IF(@has_kitchen_status = 0,
  'UPDATE orders SET kitchen_status = CASE status WHEN ''baru'' THEN ''baru'' WHEN ''diproses'' THEN ''diproses'' WHEN ''hold'' THEN ''baru'' ELSE ''siap'' END',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
