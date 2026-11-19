-- Migrasi 003: reservasi meja
-- Aman dijalankan berulang kali dan untuk database yang sudah berisi data.
-- Jalankan: npm run db:migrate
--
-- reserved_at adalah jam dinding WIB (DATETIME tanpa zona waktu); aplikasi membandingkannya
-- dengan jam WIB yang dihitung di Node, bukan dengan NOW() milik MySQL.

CREATE TABLE IF NOT EXISTS reservations (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  customer_name VARCHAR(100) NOT NULL,
  phone         VARCHAR(30)  NULL,
  party_size    SMALLINT UNSIGNED NOT NULL,
  table_id      INT UNSIGNED NOT NULL,
  reserved_at   DATETIME NOT NULL COMMENT 'jam booking (jam dinding WIB)',
  note          VARCHAR(255) NULL,
  status        ENUM('menunggu','datang','tidak_datang','batal') NOT NULL DEFAULT 'menunggu',
  order_id      BIGINT UNSIGNED NULL COMMENT 'pesanan yang dibuat untuk tamu ini',
  arrived_at    DATETIME NULL,
  created_by    INT UNSIGNED NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_resv_table FOREIGN KEY (table_id)   REFERENCES restaurant_tables(id),
  CONSTRAINT fk_resv_order FOREIGN KEY (order_id)   REFERENCES orders(id),
  CONSTRAINT fk_resv_user  FOREIGN KEY (created_by) REFERENCES users(id),
  INDEX idx_resv_table_status_time (table_id, status, reserved_at),
  INDEX idx_resv_status_time (status, reserved_at)
) ENGINE=InnoDB;

-- Status meja "reservasi" sekarang dihitung dari tabel reservations, bukan disimpan di meja.
-- Status lama yang tersimpan (data awal: T08 dan T11) tidak punya reservasi nyata dan tidak bisa dilepas, jadi dikosongkan.
UPDATE restaurant_tables SET status = 'kosong' WHERE status = 'reservasi';
