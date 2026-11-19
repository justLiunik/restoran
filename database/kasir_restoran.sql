-- =====================================================
-- Database Dashboard Kasir Restoran (MySQL 8.0+)
-- Jalankan: mysql -u root -p < kasir_restoran.sql
-- =====================================================

DROP DATABASE IF EXISTS kasir_restoran;
CREATE DATABASE kasir_restoran CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE kasir_restoran;

-- ---------- MASTER DATA ----------

CREATE TABLE users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  username      VARCHAR(50)  NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  pin_hash      VARCHAR(255) NULL COMMENT 'PIN untuk otorisasi void/diskon besar (supervisor/admin)',
  role          ENUM('kasir','supervisor','admin') NOT NULL DEFAULT 'kasir',
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  session_version INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'dinaikkan untuk mengakhiri semua sesi login user ini',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE categories (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(50) NOT NULL UNIQUE,
  sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE products (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  category_id         INT UNSIGNED NOT NULL,
  name                VARCHAR(100) NOT NULL,
  price               DECIMAL(12,2) NOT NULL,
  image_url           VARCHAR(500) NULL,
  stock               INT NOT NULL DEFAULT 0,
  low_stock_threshold INT NOT NULL DEFAULT 5,
  is_available        TINYINT(1) NOT NULL DEFAULT 1 COMMENT '0 = ditandai habis manual',
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories(id),
  INDEX idx_products_category (category_id),
  INDEX idx_products_name (name)
) ENGINE=InnoDB;

CREATE TABLE restaurant_tables (
  id       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code     VARCHAR(10) NOT NULL UNIQUE,
  capacity TINYINT UNSIGNED NOT NULL DEFAULT 4,
  area     VARCHAR(30) NULL,
  status   ENUM('kosong','terisi','menunggu_bayar','reservasi') NOT NULL DEFAULT 'kosong',
  is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT '0 = meja dinonaktifkan (tidak tampil di denah)'
) ENGINE=InnoDB;

CREATE TABLE payment_methods (
  id        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name      VARCHAR(30) NOT NULL UNIQUE,
  is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB;

-- ---------- SHIFT ----------

CREATE TABLE shifts (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  cashier_id    INT UNSIGNED NOT NULL,
  opened_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at     DATETIME NULL,
  opening_cash  DECIMAL(12,2) NOT NULL DEFAULT 0,
  expected_cash DECIMAL(12,2) NULL,
  actual_cash   DECIMAL(12,2) NULL,
  difference    DECIMAL(12,2) NULL COMMENT 'actual_cash - expected_cash',
  status        ENUM('open','closed') NOT NULL DEFAULT 'open',
  CONSTRAINT fk_shifts_cashier FOREIGN KEY (cashier_id) REFERENCES users(id),
  INDEX idx_shifts_cashier_status (cashier_id, status)
) ENGINE=InnoDB;

CREATE TABLE cash_movements (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  shift_id   INT UNSIGNED NOT NULL,
  type       ENUM('in','out') NOT NULL,
  amount     DECIMAL(12,2) NOT NULL,
  reason     VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cash_shift FOREIGN KEY (shift_id) REFERENCES shifts(id)
) ENGINE=InnoDB;

-- ---------- PENGATURAN ----------

-- Tarif pajak dan service untuk pesanan BARU (tiap pesanan menyimpan tarifnya sendiri di orders.tax_rate/service_rate)
CREATE TABLE app_settings (
  setting_key   VARCHAR(50)  NOT NULL PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  updated_by    INT UNSIGNED NULL COMMENT 'admin yang terakhir mengubah',
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_app_settings_user FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- ---------- TRANSAKSI ----------

CREATE TABLE orders (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_no         VARCHAR(30) NOT NULL UNIQUE,
  order_type       ENUM('dine_in','take_away','delivery') NOT NULL DEFAULT 'dine_in',
  table_id         INT UNSIGNED NULL,
  platform         ENUM('gofood','grabfood','shopeefood') NULL COMMENT 'hanya untuk delivery',
  customer_name    VARCHAR(100) NULL,
  cashier_id       INT UNSIGNED NOT NULL,
  shift_id         INT UNSIGNED NULL,
  status           ENUM('baru','diproses','siap_saji','belum_dibayar','selesai','hold','void') NOT NULL DEFAULT 'baru',
  subtotal         DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount_percent DECIMAL(5,2)  NOT NULL DEFAULT 0,
  discount_amount  DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax_rate         DECIMAL(5,2)  NOT NULL DEFAULT 0 COMMENT 'pajak % yang dikunci saat pesanan dibuat',
  tax_amount       DECIMAL(12,2) NOT NULL DEFAULT 0,
  service_rate     DECIMAL(5,2)  NOT NULL DEFAULT 0 COMMENT 'service % yang dikunci saat pesanan dibuat (0 bila bukan dine-in)',
  service_amount   DECIMAL(12,2) NOT NULL DEFAULT 0,
  total            DECIMAL(12,2) NOT NULL DEFAULT 0,
  authorized_by    INT UNSIGNED NULL COMMENT 'supervisor yang menyetujui void/diskon besar',
  void_reason      VARCHAR(255) NULL,
  opened_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at        DATETIME NULL,
  CONSTRAINT fk_orders_table   FOREIGN KEY (table_id)      REFERENCES restaurant_tables(id),
  CONSTRAINT fk_orders_cashier FOREIGN KEY (cashier_id)    REFERENCES users(id),
  CONSTRAINT fk_orders_shift   FOREIGN KEY (shift_id)      REFERENCES shifts(id),
  CONSTRAINT fk_orders_auth    FOREIGN KEY (authorized_by) REFERENCES users(id),
  INDEX idx_orders_status (status),
  INDEX idx_orders_opened (opened_at),
  INDEX idx_orders_table (table_id)
) ENGINE=InnoDB;

CREATE TABLE order_items (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id     BIGINT UNSIGNED NOT NULL,
  product_id   INT UNSIGNED NOT NULL,
  product_name VARCHAR(100) NOT NULL COMMENT 'snapshot nama saat transaksi',
  price        DECIMAL(12,2) NOT NULL COMMENT 'snapshot harga saat transaksi',
  qty          INT UNSIGNED NOT NULL DEFAULT 1,
  note         VARCHAR(255) NULL,
  CONSTRAINT fk_items_order   FOREIGN KEY (order_id)   REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products(id),
  INDEX idx_items_order (order_id),
  INDEX idx_items_product (product_id)
) ENGINE=InnoDB;

CREATE TABLE payments (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id          BIGINT UNSIGNED NOT NULL,
  payment_method_id INT UNSIGNED NOT NULL,
  shift_id          INT UNSIGNED NULL,
  amount            DECIMAL(12,2) NOT NULL,
  reference_no      VARCHAR(100) NULL COMMENT 'no. referensi QRIS/kartu/e-wallet',
  paid_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pay_order  FOREIGN KEY (order_id)          REFERENCES orders(id),
  CONSTRAINT fk_pay_method FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id),
  CONSTRAINT fk_pay_shift  FOREIGN KEY (shift_id)          REFERENCES shifts(id),
  INDEX idx_pay_order (order_id),
  INDEX idx_pay_paid_at (paid_at)
) ENGINE=InnoDB;

-- ---------- RIWAYAT STOK ----------
-- (juga tersedia sebagai migrasi: database/migrations/002_stock_movements.sql)

CREATE TABLE stock_movements (
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

-- ---------- RESERVASI ----------
-- (juga tersedia sebagai migrasi: database/migrations/003_reservations.sql)
-- reserved_at = jam dinding WIB; status "reservasi" pada meja dihitung dari tabel ini, tidak disimpan di meja.

CREATE TABLE reservations (
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

-- =====================================================
-- DATA DUMMY
-- =====================================================

-- Ganti hash di bawah dengan hash bcrypt asli dari aplikasi Anda.
INSERT INTO users (name, username, password_hash, pin_hash, role) VALUES
('Admin',       'admin',  'GANTI_DENGAN_HASH_BCRYPT', 'GANTI_DENGAN_HASH_BCRYPT', 'admin'),
('Supervisor',  'spv',    'GANTI_DENGAN_HASH_BCRYPT', 'GANTI_DENGAN_HASH_BCRYPT', 'supervisor'),
('Kasir Budi',  'budi',   'GANTI_DENGAN_HASH_BCRYPT', NULL, 'kasir'),
('Kasir Sari',  'sari',   'GANTI_DENGAN_HASH_BCRYPT', NULL, 'kasir');

INSERT INTO categories (id, name, sort_order) VALUES
(1, 'Makanan', 1),
(2, 'Minuman', 2),
(3, 'Dessert', 3);

-- image_url dikosongkan: isi dengan URL gambar yang sudah Anda cek, atau path lokal.
INSERT INTO products (id, category_id, name, price, stock) VALUES
(1,  1, 'Nasi Goreng Spesial', 28000, 40),
(2,  1, 'Mie Goreng Seafood',  26000, 35),
(3,  1, 'Ayam Bakar Madu',     35000, 25),
(4,  1, 'Sate Ayam (10 tusuk)',30000, 30),
(5,  1, 'Soto Ayam',           25000, 20),
(6,  1, 'Gado-Gado',           22000, 4),
(7,  1, 'Rendang Sapi',        42000, 0),
(8,  2, 'Es Teh Manis',         6000, 100),
(9,  2, 'Es Jeruk',            10000, 80),
(10, 2, 'Kopi Susu Gula Aren', 18000, 60),
(11, 2, 'Jus Alpukat',         18000, 25),
(12, 2, 'Air Mineral',          5000, 120),
(13, 3, 'Es Campur',           15000, 20),
(14, 3, 'Pisang Goreng Keju',  12000, 15),
(15, 3, 'Klepon',              10000, 5);

INSERT INTO restaurant_tables (id, code, capacity, area, status) VALUES
(1,  'T01', 2, 'Indoor',  'kosong'),
(2,  'T02', 2, 'Indoor',  'kosong'),
(3,  'T03', 4, 'Indoor',  'terisi'),
(4,  'T04', 4, 'Indoor',  'kosong'),
(5,  'T05', 4, 'Indoor',  'menunggu_bayar'),
(6,  'T06', 6, 'Indoor',  'kosong'),
(7,  'T07', 4, 'Outdoor', 'kosong'),
(8,  'T08', 4, 'Outdoor', 'kosong'),
(9,  'T09', 6, 'Outdoor', 'kosong'),
(10, 'T10', 8, 'VIP',     'kosong'),
(11, 'T11', 8, 'VIP',     'kosong'),
(12, 'T12', 2, 'Outdoor', 'kosong');

INSERT INTO app_settings (setting_key, setting_value) VALUES
('tax_rate', '10'),
('service_rate', '5');

INSERT INTO payment_methods (id, name) VALUES
(1, 'Tunai'), (2, 'QRIS'), (3, 'Kartu'), (4, 'E-wallet');

-- Shift berjalan
INSERT INTO shifts (id, cashier_id, opening_cash, status) VALUES
(1, 3, 500000, 'open');

INSERT INTO cash_movements (shift_id, type, amount, reason) VALUES
(1, 'out', 50000, 'Beli es batu');

-- Order 1: selesai dibayar QRIS
INSERT INTO orders (id, order_no, order_type, table_id, cashier_id, shift_id, status,
                    subtotal, tax_rate, tax_amount, service_rate, service_amount, total, closed_at)
VALUES (1, 'INV-0001', 'dine_in', 2, 3, 1, 'selesai', 68000, 10, 6800, 5, 3400, 78200, NOW());

INSERT INTO order_items (order_id, product_id, product_name, price, qty) VALUES
(1, 1, 'Nasi Goreng Spesial', 28000, 2),
(1, 8, 'Es Teh Manis',          6000, 2);

INSERT INTO payments (order_id, payment_method_id, shift_id, amount, reference_no) VALUES
(1, 2, 1, 78200, 'QRIS-20260001');

-- Order 2: dine-in aktif di T03, sedang diproses dapur
INSERT INTO orders (id, order_no, order_type, table_id, cashier_id, shift_id, status,
                    subtotal, tax_rate, tax_amount, service_rate, service_amount, total)
VALUES (2, 'INV-0002', 'dine_in', 3, 3, 1, 'diproses', 45000, 10, 4500, 5, 2250, 51750);

INSERT INTO order_items (order_id, product_id, product_name, price, qty, note) VALUES
(2, 3, 'Ayam Bakar Madu', 35000, 1, 'Tidak pedas'),
(2, 9, 'Es Jeruk',        10000, 1, NULL);

-- Order 3: delivery GoFood, baru masuk
INSERT INTO orders (id, order_no, order_type, platform, customer_name, cashier_id, shift_id, status,
                    subtotal, tax_rate, tax_amount, service_rate, service_amount, total)
VALUES (3, 'INV-0003', 'delivery', 'gofood', 'Andi', 3, 1, 'baru', 52000, 10, 5200, 0, 0, 57200);

INSERT INTO order_items (order_id, product_id, product_name, price, qty) VALUES
(3, 2, 'Mie Goreng Seafood', 26000, 2);

-- =====================================================
-- CONTOH QUERY UNTUK DASHBOARD (disalin ke backend)
-- =====================================================

-- Total penjualan, jumlah transaksi, rata-rata hari ini:
-- SELECT COALESCE(SUM(total),0) AS total_penjualan,
--        COUNT(*)               AS jumlah_transaksi,
--        COALESCE(AVG(total),0) AS rata_rata
-- FROM orders
-- WHERE status = 'selesai' AND DATE(closed_at) = CURDATE();

-- Penjualan per metode bayar hari ini:
-- SELECT pm.name, SUM(p.amount) AS total
-- FROM payments p JOIN payment_methods pm ON pm.id = p.payment_method_id
-- WHERE DATE(p.paid_at) = CURDATE()
-- GROUP BY pm.name;

-- Menu terlaris hari ini (top 5):
-- SELECT oi.product_name, SUM(oi.qty) AS terjual
-- FROM order_items oi JOIN orders o ON o.id = oi.order_id
-- WHERE o.status = 'selesai' AND DATE(o.closed_at) = CURDATE()
-- GROUP BY oi.product_id, oi.product_name
-- ORDER BY terjual DESC LIMIT 5;

-- Penjualan per jam hari ini:
-- SELECT HOUR(closed_at) AS jam, SUM(total) AS total
-- FROM orders
-- WHERE status = 'selesai' AND DATE(closed_at) = CURDATE()
-- GROUP BY HOUR(closed_at) ORDER BY jam;

-- Pesanan aktif:
-- SELECT * FROM orders
-- WHERE status IN ('baru','diproses','siap_saji','belum_dibayar','hold')
-- ORDER BY opened_at;

-- Menu stok menipis / habis:
-- SELECT name, stock FROM products
-- WHERE is_active = 1 AND stock <= low_stock_threshold;

-- Kas seharusnya saat tutup shift (modal + tunai masuk + kas masuk - kas keluar):
-- SELECT s.opening_cash
--      + COALESCE((SELECT SUM(amount) FROM payments WHERE shift_id = s.id AND payment_method_id = 1),0)
--      + COALESCE((SELECT SUM(amount) FROM cash_movements WHERE shift_id = s.id AND type = 'in'),0)
--      - COALESCE((SELECT SUM(amount) FROM cash_movements WHERE shift_id = s.id AND type = 'out'),0)
--      AS expected_cash
-- FROM shifts s WHERE s.id = 1;
