-- Migrasi 004: kolom is_active pada meja (untuk "Atur Meja": meja yang tidak dipakai dinonaktifkan, bukan dihapus,
-- karena pesanan dan reservasi lama terikat ke meja).
-- Aman dijalankan berulang kali dan untuk database yang sudah berisi data: semua meja lama tetap aktif.
-- Jalankan: npm run db:migrate
--
-- MySQL 8 tidak punya "ADD COLUMN IF NOT EXISTS", jadi keberadaan kolom dicek dulu.

SET @has_is_active := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'restaurant_tables' AND column_name = 'is_active'
);
SET @ddl := IF(@has_is_active = 0,
  'ALTER TABLE restaurant_tables ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT ''0 = meja dinonaktifkan (tidak tampil di denah)'' AFTER status',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
