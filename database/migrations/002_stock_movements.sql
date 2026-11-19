-- Migrasi 002: riwayat pergerakan stok (restock, koreksi, penjualan, void)
-- Aman dijalankan berulang kali dan untuk database yang sudah berisi data (tidak mengubah tabel lain).
-- Jalankan: npm run db:migrate

CREATE TABLE IF NOT EXISTS stock_movements (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id  INT UNSIGNED NOT NULL,
  type        ENUM('restock','correction','sale','void_restore') NOT NULL,
  qty_change  INT NOT NULL COMMENT 'selisih stok bertanda (+ tambah, - kurang)',
  stock_after INT NOT NULL COMMENT 'stok setelah pergerakan ini',
  note        VARCHAR(255) NULL,
  order_id    BIGINT UNSIGNED NULL,
  user_id     INT UNSIGNED NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_stockmov_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_stockmov_order   FOREIGN KEY (order_id)   REFERENCES orders(id),
  CONSTRAINT fk_stockmov_user    FOREIGN KEY (user_id)    REFERENCES users(id),
  INDEX idx_stockmov_product_created (product_id, created_at)
) ENGINE=InnoDB;
