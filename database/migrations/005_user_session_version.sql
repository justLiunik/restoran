-- Migrasi 005: kolom session_version pada users (untuk "Kelola User").
-- Token login memuat session_version; token ditolak bila angkanya tidak sama dengan yang di database. Angka dinaikkan saat
-- password direset/diganti atau akun dinonaktifkan, sehingga sesi lama langsung berhenti.
-- Aman dijalankan berulang kali dan untuk database yang sudah berisi data: semua user lama mulai dari 0, dan token lama
-- (yang belum memuat session_version) tetap dianggap 0 sehingga sesi yang sedang berjalan tidak terputus.
-- Jalankan: npm run db:migrate
--
-- MySQL 8 tidak punya "ADD COLUMN IF NOT EXISTS", jadi keberadaan kolom dicek dulu.

SET @has_session_version := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'session_version'
);
SET @ddl := IF(@has_session_version = 0,
  'ALTER TABLE users ADD COLUMN session_version INT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''dinaikkan untuk mengakhiri semua sesi login user ini'' AFTER is_active',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
