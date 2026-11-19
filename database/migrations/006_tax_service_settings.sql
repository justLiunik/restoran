-- Migrasi 006: tarif pajak dan service yang bisa diatur (fitur "Kelola Pajak & Service").
--   * tabel app_settings: tarif berlaku untuk pesanan BARU (tax_rate = pajak %, service_rate = service % untuk dine-in).
--   * kolom orders.tax_rate dan orders.service_rate: tarif dikunci per pesanan saat pesanan dibuat, jadi pesanan yang
--     sedang terbuka/hold tidak bergeser dan struk lama tetap menampilkan persentase yang dipakai saat itu.
-- Aman dijalankan berulang kali dan untuk database yang sudah berisi data:
--   * pengaturan awal 10 dan 5 (tarif yang selalu dipakai sebelumnya) hanya diisi bila belum ada (INSERT IGNORE),
--     sehingga tarif yang sudah diubah admin tidak tertimpa;
--   * pesanan lama diisi tax_rate = 10 dan service_rate = 5 (0 untuk take-away/delivery) HANYA pada saat kolomnya baru
--     ditambahkan; migrasi berikutnya tidak menyentuh tarif pesanan.
-- Jalankan: npm run db:migrate
--
-- MySQL 8 tidak punya "ADD COLUMN IF NOT EXISTS", jadi keberadaan kolom dicek dulu.

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key   VARCHAR(50)  NOT NULL PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  updated_by    INT UNSIGNED NULL COMMENT 'admin yang terakhir mengubah',
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_app_settings_user FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB;

INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES
  ('tax_rate', '10'),
  ('service_rate', '5');

SET @has_tax_rate := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'tax_rate'
);
SET @has_service_rate := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'service_rate'
);

SET @ddl := IF(@has_tax_rate = 0,
  'ALTER TABLE orders ADD COLUMN tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0 COMMENT ''pajak % yang dikunci saat pesanan dibuat'' AFTER discount_amount',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl := IF(@has_service_rate = 0,
  'ALTER TABLE orders ADD COLUMN service_rate DECIMAL(5,2) NOT NULL DEFAULT 0 COMMENT ''service % yang dikunci saat pesanan dibuat (0 bila bukan dine-in)'' AFTER tax_amount',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Isi pesanan lama: hanya bila kedua kolom baru saja ditambahkan oleh migrasi ini
SET @ddl := IF(@has_tax_rate = 0 AND @has_service_rate = 0,
  'UPDATE orders SET tax_rate = 10, service_rate = IF(order_type = ''dine_in'', 5, 0)',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
