require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey_restoran_2026';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- HELPER FUNCTIONS ----------

// Recalculates order subtotal, discount, tax, service charge, and total
function calculateOrderTotals(items, discountPercent = 0, orderType = 'dine_in') {
  const subtotal = items.reduce((sum, item) => sum + (Number(item.price) * Number(item.qty)), 0);
  const discPercent = Math.max(0, Math.min(100, Number(discountPercent) || 0));
  const discountAmount = Math.round((subtotal * discPercent) / 100);
  const taxable = Math.max(0, subtotal - discountAmount);
  const taxAmount = Math.round(taxable * 0.10);
  const serviceAmount = orderType === 'dine_in' ? Math.round(taxable * 0.05) : 0;
  const total = Math.round(taxable + taxAmount + serviceAmount);

  return {
    subtotal,
    discount_percent: discPercent,
    discount_amount: discountAmount,
    tax_amount: taxAmount,
    service_amount: serviceAmount,
    total
  };
}

// Generates sequential zero-padded invoice number: INV-0001
async function generateOrderNo(conn) {
  const [rows] = await conn.query('SELECT id, order_no FROM orders ORDER BY id DESC LIMIT 1 FOR UPDATE');
  let nextSeq = 1;
  if (rows.length > 0 && rows[0].order_no) {
    const match = rows[0].order_no.match(/INV-(\d+)/);
    if (match) {
      nextSeq = parseInt(match[1], 10) + 1;
    } else {
      nextSeq = rows[0].id + 1;
    }
  }
  return `INV-${String(nextSeq).padStart(4, '0')}`;
}

// ---------- AUTH & MIDDLEWARE ----------

// JWT Verification Middleware
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token otentikasi tidak ditemukan' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token tidak valid atau kedaluwarsa' });
  }
}

// POST /api/login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username dan password wajib diisi' });
    }

    const [users] = await db.query(
      'SELECT id, name, username, password_hash, role, is_active FROM users WHERE username = ?',
      [username]
    );

    if (users.length === 0 || !users[0].is_active) {
      return res.status(401).json({ error: 'Username atau password salah' });
    }

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Username atau password salah' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All subsequent /api routes require valid JWT
app.use('/api', authMiddleware);

// POST /api/verify-pin { pin }
app.post('/api/verify-pin', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) {
      return res.status(400).json({ ok: false, error: 'PIN wajib diisi' });
    }

    const [spvs] = await db.query(
      'SELECT id, name, pin_hash FROM users WHERE role IN ("supervisor", "admin") AND pin_hash IS NOT NULL AND is_active = 1'
    );

    for (const spv of spvs) {
      const match = await bcrypt.compare(String(pin), spv.pin_hash);
      if (match) {
        return res.json({ ok: true, authorized_by: spv.id, supervisor_name: spv.name });
      }
    }

    return res.status(400).json({ ok: false, error: 'PIN supervisor salah' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- MASTER DATA ----------

// GET /api/categories
app.get('/api/categories', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, name, sort_order FROM categories ORDER BY sort_order ASC, id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/products (?category_id=&q=)
app.get('/api/products', async (req, res) => {
  try {
    const { category_id, q } = req.query;
    let sql = `
      SELECT p.id, p.category_id, c.name AS category_name, p.name, p.price, p.image_url,
             p.stock, p.low_stock_threshold, p.is_available, p.is_active,
             CASE
               WHEN p.stock = 0 OR p.is_available = 0 THEN 'habis'
               WHEN p.stock <= p.low_stock_threshold THEN 'menipis'
               ELSE 'ok'
             END AS stock_status
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE p.is_active = 1
    `;
    const params = [];

    if (category_id) {
      sql += ' AND p.category_id = ?';
      params.push(category_id);
    }
    if (q) {
      sql += ' AND p.name LIKE ?';
      params.push(`%${q}%`);
    }

    sql += ' ORDER BY c.sort_order ASC, p.id ASC';

    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/products/:id/availability { is_available }
app.patch('/api/products/:id/availability', async (req, res) => {
  try {
    const { id } = req.params;
    const is_available = req.body.is_available ? 1 : 0;
    await db.query('UPDATE products SET is_available = ? WHERE id = ?', [is_available, id]);
    res.json({ ok: true, id: Number(id), is_available });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tables
app.get('/api/tables', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT t.id, t.code, t.capacity, t.area, t.status,
             o.id AS active_order_id, o.order_no AS active_order_no, o.total AS active_order_total
      FROM restaurant_tables t
      LEFT JOIN (
        SELECT id, order_no, table_id, total
        FROM orders
        WHERE status IN ('baru', 'diproses', 'siap_saji', 'belum_dibayar', 'hold')
      ) o ON o.table_id = t.id
      ORDER BY t.id ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payment-methods
app.get('/api/payment-methods', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, name, is_active FROM payment_methods WHERE is_active = 1 ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- ORDERS ----------

// GET /api/orders?status=active
app.get('/api/orders', async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `
      SELECT o.*, t.code AS table_code, u.name AS cashier_name
      FROM orders o
      LEFT JOIN restaurant_tables t ON t.id = o.table_id
      LEFT JOIN users u ON u.id = o.cashier_id
    `;
    const params = [];

    if (status === 'active') {
      sql += ' WHERE o.status IN ("baru", "diproses", "siap_saji", "belum_dibayar", "hold")';
    } else if (status) {
      sql += ' WHERE o.status = ?';
      params.push(status);
    }

    sql += ' ORDER BY o.opened_at DESC';

    const [orders] = await db.query(sql, params);

    if (orders.length > 0) {
      const orderIds = orders.map(o => o.id);
      const [items] = await db.query(
        'SELECT * FROM order_items WHERE order_id IN (?) ORDER BY id ASC',
        [orderIds]
      );

      const itemsMap = {};
      items.forEach(it => {
        if (!itemsMap[it.order_id]) itemsMap[it.order_id] = [];
        itemsMap[it.order_id].push(it);
      });

      orders.forEach(o => {
        o.items = itemsMap[o.id] || [];
      });
    }

    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/:id
app.get('/api/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [orders] = await db.query(`
      SELECT o.*, t.code AS table_code, u.name AS cashier_name
      FROM orders o
      LEFT JOIN restaurant_tables t ON t.id = o.table_id
      LEFT JOIN users u ON u.id = o.cashier_id
      WHERE o.id = ?
    `, [id]);

    if (orders.length === 0) {
      return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    }

    const order = orders[0];
    const [items] = await db.query('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [id]);
    const [payments] = await db.query(`
      SELECT p.*, pm.name AS payment_method_name
      FROM payments p
      JOIN payment_methods pm ON pm.id = p.payment_method_id
      WHERE p.order_id = ?
      ORDER BY p.id ASC
    `, [id]);

    order.items = items;
    order.payments = payments;
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders { order_type, table_id?, platform?, customer_name?, items: [{product_id, qty, note?}] }
app.post('/api/orders', async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const { order_type = 'dine_in', table_id, platform, customer_name, items = [], discount_percent = 0 } = req.body;

    if (!items || items.length === 0) {
      throw new Error('Pesanan harus memiliki minimal 1 item');
    }

    // Check open shift for logged-in cashier
    const [shifts] = await conn.query(
      'SELECT id FROM shifts WHERE cashier_id = ? AND status = "open" LIMIT 1 FOR UPDATE',
      [req.user.id]
    );

    if (shifts.length === 0) {
      throw new Error('Shift belum dibuka untuk kasir ini');
    }
    const shiftId = shifts[0].id;

    // Snapshot products and calculate totals
    const productIds = items.map(i => i.product_id);
    const [products] = await conn.query(
      'SELECT id, name, price, stock, is_available FROM products WHERE id IN (?)',
      [productIds]
    );
    const prodMap = new Map(products.map(p => [p.id, p]));

    const orderItemsData = [];
    for (const item of items) {
      const prod = prodMap.get(Number(item.product_id));
      if (!prod) throw new Error(`Produk ID ${item.product_id} tidak ditemukan`);
      if (prod.stock < item.qty) {
        throw new Error(`Stok ${prod.name} tidak mencukupi (sisa ${prod.stock})`);
      }
      orderItemsData.push({
        product_id: prod.id,
        product_name: prod.name,
        price: prod.price,
        qty: Number(item.qty) || 1,
        note: item.note || null
      });
    }

    const totals = calculateOrderTotals(orderItemsData, discount_percent, order_type);
    const orderNo = await generateOrderNo(conn);

    const [orderResult] = await conn.query(`
      INSERT INTO orders (
        order_no, order_type, table_id, platform, customer_name,
        cashier_id, shift_id, status, subtotal, discount_percent,
        discount_amount, tax_amount, service_amount, total, opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'baru', ?, ?, ?, ?, ?, ?, NOW())
    `, [
      orderNo,
      order_type,
      table_id || null,
      platform || null,
      customer_name || null,
      req.user.id,
      shiftId,
      totals.subtotal,
      totals.discount_percent,
      totals.discount_amount,
      totals.tax_amount,
      totals.service_amount,
      totals.total
    ]);

    const orderId = orderResult.insertId;

    for (const it of orderItemsData) {
      await conn.query(`
        INSERT INTO order_items (order_id, product_id, product_name, price, qty, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [orderId, it.product_id, it.product_name, it.price, it.qty, it.note]);
    }

    // Set table to 'terisi' if dine_in
    if (order_type === 'dine_in' && table_id) {
      await conn.query('UPDATE restaurant_tables SET status = "terisi" WHERE id = ?', [table_id]);
    }

    await conn.commit();

    // Return created order
    const [newOrder] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    newOrder[0].items = orderItemsData;
    res.status(201).json(newOrder[0]);
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// POST /api/orders/:id/items { product_id, qty, note? }
app.post('/api/orders/:id/items', async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const orderId = req.params.id;
    const { product_id, qty = 1, note } = req.body;

    const [orders] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (orders.length === 0) throw new Error('Pesanan tidak ditemukan');
    const order = orders[0];
    if (order.status === 'selesai' || order.status === 'void') {
      throw new Error('Pesanan sudah selesai atau dibatalkan');
    }

    const [products] = await conn.query('SELECT id, name, price, stock FROM products WHERE id = ?', [product_id]);
    if (products.length === 0) throw new Error('Produk tidak ditemukan');
    const prod = products[0];

    // Check if same item & note exists
    const [existing] = await conn.query(
      'SELECT id, qty FROM order_items WHERE order_id = ? AND product_id = ? AND COALESCE(note, "") = COALESCE(?, "")',
      [orderId, product_id, note || '']
    );

    if (existing.length > 0) {
      const newQty = existing[0].qty + Number(qty);
      await conn.query('UPDATE order_items SET qty = ? WHERE id = ?', [newQty, existing[0].id]);
    } else {
      await conn.query(`
        INSERT INTO order_items (order_id, product_id, product_name, price, qty, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [orderId, prod.id, prod.name, prod.price, Number(qty), note || null]);
    }

    // Recalculate totals
    const [allItems] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
    const totals = calculateOrderTotals(allItems, order.discount_percent, order.order_type);

    await conn.query(`
      UPDATE orders SET subtotal = ?, discount_amount = ?, tax_amount = ?, service_amount = ?, total = ?
      WHERE id = ?
    `, [totals.subtotal, totals.discount_amount, totals.tax_amount, totals.service_amount, totals.total, orderId]);

    await conn.commit();
    res.json({ ok: true, totals });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// PATCH /api/orders/:id/items/:itemId { qty }
app.patch('/api/orders/:id/items/:itemId', async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { id: orderId, itemId } = req.params;
    const qty = Number(req.body.qty);

    const [orders] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (orders.length === 0) throw new Error('Pesanan tidak ditemukan');
    const order = orders[0];
    if (order.status === 'selesai' || order.status === 'void') {
      throw new Error('Pesanan sudah selesai atau dibatalkan');
    }

    if (qty <= 0) {
      await conn.query('DELETE FROM order_items WHERE id = ? AND order_id = ?', [itemId, orderId]);
    } else {
      await conn.query('UPDATE order_items SET qty = ? WHERE id = ? AND order_id = ?', [qty, itemId, orderId]);
    }

    // Recalculate totals
    const [allItems] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
    const totals = calculateOrderTotals(allItems, order.discount_percent, order.order_type);

    await conn.query(`
      UPDATE orders SET subtotal = ?, discount_amount = ?, tax_amount = ?, service_amount = ?, total = ?
      WHERE id = ?
    `, [totals.subtotal, totals.discount_amount, totals.tax_amount, totals.service_amount, totals.total, orderId]);

    await conn.commit();
    res.json({ ok: true, totals });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// PATCH /api/orders/:id/status { status }
app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const validStatuses = ['baru', 'diproses', 'siap_saji', 'belum_dibayar', 'hold'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Status pesanan tidak valid' });
    }

    const [orders] = await db.query('SELECT table_id, order_type FROM orders WHERE id = ?', [id]);
    if (orders.length === 0) {
      return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    }
    const order = orders[0];

    // If dine_in order set to 'belum_dibayar', set table to 'menunggu_bayar'
    if (status === 'belum_dibayar' && order.order_type === 'dine_in' && order.table_id) {
      await db.query('UPDATE restaurant_tables SET status = "menunggu_bayar" WHERE id = ?', [order.table_id]);
    }

    await db.query('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
    res.json({ ok: true, id: Number(id), status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders/:id/pay { payments: [{ payment_method_id, amount, reference_no? }], discount_percent?, auth_pin? }
app.post('/api/orders/:id/pay', async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const orderId = req.params.id;
    const { payments = [], discount_percent, auth_pin } = req.body;

    // Get current cashier shift
    const [shifts] = await conn.query(
      'SELECT id FROM shifts WHERE cashier_id = ? AND status = "open" LIMIT 1 FOR UPDATE',
      [req.user.id]
    );
    if (shifts.length === 0) {
      throw new Error('Shift belum dibuka untuk kasir ini');
    }
    const currentShiftId = shifts[0].id;

    // Fetch order & items
    const [orders] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (orders.length === 0) throw new Error('Pesanan tidak ditemukan');
    const order = orders[0];
    if (order.status === 'selesai') throw new Error('Pesanan ini sudah dibayar');
    if (order.status === 'void') throw new Error('Pesanan ini telah dibatalkan');

    const [items] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
    if (items.length === 0) throw new Error('Pesanan belum memiliki item');

    // Discount check
    const finalDiscountPercent = discount_percent !== undefined ? Number(discount_percent) : Number(order.discount_percent);
    let authorizedBy = null;

    if (finalDiscountPercent > 20) {
      if (!auth_pin) {
        throw new Error('Diskon di atas 20% memerlukan PIN supervisor');
      }
      const [spvs] = await conn.query(
        'SELECT id, pin_hash FROM users WHERE role IN ("supervisor", "admin") AND pin_hash IS NOT NULL AND is_active = 1'
      );
      let pinValid = false;
      for (const spv of spvs) {
        if (await bcrypt.compare(String(auth_pin), spv.pin_hash)) {
          pinValid = true;
          authorizedBy = spv.id;
          break;
        }
      }
      if (!pinValid) {
        throw new Error('PIN supervisor salah untuk otorisasi diskon');
      }
    }

    // Server-side recalculation of totals
    const totals = calculateOrderTotals(items, finalDiscountPercent, order.order_type);

    // Validate payments
    const totalPayment = payments.reduce((sum, p) => sum + Number(p.amount), 0);
    if (totalPayment < totals.total) {
      throw new Error(`Nominal pembayaran kurang! Total: ${totals.total}, Dibayar: ${totalPayment}`);
    }
    const change = totalPayment - totals.total;

    // Insert payments into DB
    for (const pay of payments) {
      await conn.query(`
        INSERT INTO payments (order_id, payment_method_id, shift_id, amount, reference_no, paid_at)
        VALUES (?, ?, ?, ?, ?, NOW())
      `, [orderId, pay.payment_method_id, currentShiftId, pay.amount, pay.reference_no || null]);
    }

    // Update order
    await conn.query(`
      UPDATE orders SET
        status = 'selesai',
        closed_at = NOW(),
        shift_id = ?,
        subtotal = ?,
        discount_percent = ?,
        discount_amount = ?,
        tax_amount = ?,
        service_amount = ?,
        total = ?,
        authorized_by = COALESCE(?, authorized_by)
      WHERE id = ?
    `, [
      currentShiftId,
      totals.subtotal,
      totals.discount_percent,
      totals.discount_amount,
      totals.tax_amount,
      totals.service_amount,
      totals.total,
      authorizedBy,
      orderId
    ]);

    // Decrease product stock
    for (const it of items) {
      await conn.query(
        'UPDATE products SET stock = GREATEST(0, stock - ?) WHERE id = ?',
        [it.qty, it.product_id]
      );
    }

    // Free table if dine_in
    if (order.order_type === 'dine_in' && order.table_id) {
      await conn.query('UPDATE restaurant_tables SET status = "kosong" WHERE id = ?', [order.table_id]);
    }

    await conn.commit();
    res.json({
      ok: true,
      change,
      total: totals.total,
      total_paid: totalPayment
    });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// POST /api/orders/:id/void { reason, pin }
app.post('/api/orders/:id/void', async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const orderId = req.params.id;
    const { reason, pin } = req.body;

    if (!pin) throw new Error('PIN supervisor diperlukan untuk membatalkan transaksi');

    // Verify supervisor PIN
    const [spvs] = await conn.query(
      'SELECT id, pin_hash FROM users WHERE role IN ("supervisor", "admin") AND pin_hash IS NOT NULL AND is_active = 1'
    );
    let authorizedBy = null;
    for (const spv of spvs) {
      if (await bcrypt.compare(String(pin), spv.pin_hash)) {
        authorizedBy = spv.id;
        break;
      }
    }
    if (!authorizedBy) {
      throw new Error('PIN supervisor salah');
    }

    const [orders] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (orders.length === 0) throw new Error('Pesanan tidak ditemukan');
    const order = orders[0];
    if (order.status === 'void') throw new Error('Pesanan sudah berstatus void');

    const [items] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [orderId]);

    // If order was already paid ('selesai'), restore product stock
    if (order.status === 'selesai') {
      for (const it of items) {
        await conn.query('UPDATE products SET stock = stock + ? WHERE id = ?', [it.qty, it.product_id]);
      }
    }

    // Free table if dine_in
    if (order.order_type === 'dine_in' && order.table_id) {
      await conn.query('UPDATE restaurant_tables SET status = "kosong" WHERE id = ?', [order.table_id]);
    }

    await conn.query(`
      UPDATE orders SET status = 'void', void_reason = ?, authorized_by = ? WHERE id = ?
    `, [reason || 'Dibatalkan oleh kasir/supervisor', authorizedBy, orderId]);

    await conn.commit();
    res.json({ ok: true, message: 'Pesanan berhasil dibatalkan (void)' });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ---------- SHIFT ----------

// GET /api/shifts/current
app.get('/api/shifts/current', async (req, res) => {
  try {
    const [shifts] = await db.query(
      'SELECT * FROM shifts WHERE cashier_id = ? AND status = "open" ORDER BY id DESC LIMIT 1',
      [req.user.id]
    );

    if (shifts.length === 0) {
      return res.json({ shift: null });
    }

    const shift = shifts[0];

    // Live calculations:
    // Cash payments in current shift
    const [cashPayRows] = await db.query(`
      SELECT COALESCE(SUM(p.amount), 0) AS total_cash_pay
      FROM payments p
      JOIN payment_methods pm ON pm.id = p.payment_method_id
      WHERE p.shift_id = ? AND pm.name = 'Tunai'
    `, [shift.id]);
    const cashInPayments = Number(cashPayRows[0].total_cash_pay);

    // Cash movements
    const [movementRows] = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'in' THEN amount ELSE 0 END), 0) AS total_in,
        COALESCE(SUM(CASE WHEN type = 'out' THEN amount ELSE 0 END), 0) AS total_out
      FROM cash_movements
      WHERE shift_id = ?
    `, [shift.id]);
    const cashMoveIn = Number(movementRows[0].total_in);
    const cashMoveOut = Number(movementRows[0].total_out);

    const expectedCash = Math.round(Number(shift.opening_cash) + cashInPayments + cashMoveIn - cashMoveOut);

    const [movements] = await db.query(
      'SELECT id, type, amount, reason, created_at FROM cash_movements WHERE shift_id = ? ORDER BY id DESC',
      [shift.id]
    );

    res.json({
      shift: {
        ...shift,
        expected_cash: expectedCash,
        cash_in_payments: cashInPayments,
        cash_move_in: cashMoveIn,
        cash_move_out: cashMoveOut,
        movements
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/shifts/open { opening_cash }
app.post('/api/shifts/open', async (req, res) => {
  try {
    const opening_cash = Number(req.body.opening_cash) || 0;

    const [existing] = await db.query(
      'SELECT id FROM shifts WHERE cashier_id = ? AND status = "open"',
      [req.user.id]
    );
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Kasir sudah memiliki shift yang masih terbuka' });
    }

    const [result] = await db.query(
      'INSERT INTO shifts (cashier_id, opening_cash, status, opened_at) VALUES (?, ?, "open", NOW())',
      [req.user.id, opening_cash]
    );

    res.status(201).json({ ok: true, shift_id: result.insertId, opening_cash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/shifts/cash-movement { type: 'in'|'out', amount, reason }
app.post('/api/shifts/cash-movement', async (req, res) => {
  try {
    const { type, amount, reason } = req.body;
    if (!['in', 'out'].includes(type) || !amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Tipe gerakan (in/out) dan nominal harus valid' });
    }

    const [shifts] = await db.query(
      'SELECT id FROM shifts WHERE cashier_id = ? AND status = "open" LIMIT 1',
      [req.user.id]
    );
    if (shifts.length === 0) {
      return res.status(400).json({ error: 'Tidak ada shift kasir yang aktif' });
    }

    await db.query(
      'INSERT INTO cash_movements (shift_id, type, amount, reason, created_at) VALUES (?, ?, ?, ?, NOW())',
      [shifts[0].id, type, Number(amount), reason || null]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/shifts/close { actual_cash }
app.post('/api/shifts/close', async (req, res) => {
  try {
    const actual_cash = Number(req.body.actual_cash);
    if (isNaN(actual_cash)) {
      return res.status(400).json({ error: 'Nominal kas fisik aktual harus valid' });
    }

    const [shifts] = await db.query(
      'SELECT * FROM shifts WHERE cashier_id = ? AND status = "open" LIMIT 1',
      [req.user.id]
    );
    if (shifts.length === 0) {
      return res.status(400).json({ error: 'Tidak ada shift terbuka untuk kasir ini' });
    }

    const shift = shifts[0];

    const [cashPayRows] = await db.query(`
      SELECT COALESCE(SUM(p.amount), 0) AS total_cash_pay
      FROM payments p
      JOIN payment_methods pm ON pm.id = p.payment_method_id
      WHERE p.shift_id = ? AND pm.name = 'Tunai'
    `, [shift.id]);
    const cashInPayments = Number(cashPayRows[0].total_cash_pay);

    const [movementRows] = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'in' THEN amount ELSE 0 END), 0) AS total_in,
        COALESCE(SUM(CASE WHEN type = 'out' THEN amount ELSE 0 END), 0) AS total_out
      FROM cash_movements
      WHERE shift_id = ?
    `, [shift.id]);
    const cashMoveIn = Number(movementRows[0].total_in);
    const cashMoveOut = Number(movementRows[0].total_out);

    const expected_cash = Math.round(Number(shift.opening_cash) + cashInPayments + cashMoveIn - cashMoveOut);
    const difference = actual_cash - expected_cash;

    await db.query(`
      UPDATE shifts SET
        status = 'closed',
        closed_at = NOW(),
        expected_cash = ?,
        actual_cash = ?,
        difference = ?
      WHERE id = ?
    `, [expected_cash, actual_cash, difference, shift.id]);

    res.json({
      ok: true,
      shift_id: shift.id,
      expected_cash,
      actual_cash,
      difference
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- DASHBOARD SUMMARY (CURDATE()) ----------

// GET /api/dashboard/summary
app.get('/api/dashboard/summary', async (req, res) => {
  try {
    const [todayRows] = await db.query(`
      SELECT
        COALESCE(SUM(total), 0) AS total_sales,
        COUNT(*) AS transaction_count,
        COALESCE(AVG(total), 0) AS avg_per_transaction,
        COALESCE(SUM(tax_amount), 0) AS total_tax,
        COALESCE(SUM(service_amount), 0) AS total_service,
        COALESCE(SUM(discount_amount), 0) AS total_discount
      FROM orders
      WHERE status = 'selesai' AND DATE(closed_at) = CURDATE()
    `);

    const [yesterdayRows] = await db.query(`
      SELECT COALESCE(SUM(total), 0) AS yesterday_sales
      FROM orders
      WHERE status = 'selesai' AND DATE(closed_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
    `);

    const today = todayRows[0];
    const yesterdaySales = Number(yesterdayRows[0].yesterday_sales);
    const todaySales = Number(today.total_sales);

    let percentageChange = 0;
    if (yesterdaySales > 0) {
      percentageChange = ((todaySales - yesterdaySales) / yesterdaySales) * 100;
    } else if (todaySales > 0) {
      percentageChange = 100;
    }

    res.json({
      total_sales: Math.round(todaySales),
      percentage_change: Math.round(percentageChange * 10) / 10,
      transaction_count: Number(today.transaction_count),
      avg_per_transaction: Math.round(Number(today.avg_per_transaction)),
      total_tax: Math.round(Number(today.total_tax)),
      total_service: Math.round(Number(today.total_service)),
      total_discount: Math.round(Number(today.total_discount))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/payment-methods
app.get('/api/dashboard/payment-methods', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT pm.name, COALESCE(SUM(p.amount), 0) AS total
      FROM payment_methods pm
      LEFT JOIN payments p ON pm.id = p.payment_method_id AND DATE(p.paid_at) = CURDATE()
      WHERE pm.is_active = 1
      GROUP BY pm.id, pm.name
      ORDER BY pm.id ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/best-sellers
app.get('/api/dashboard/best-sellers', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT oi.product_id, oi.product_name AS name, c.name AS category,
             SUM(oi.qty) AS qty, SUM(oi.qty * oi.price) AS revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products pr ON pr.id = oi.product_id
      JOIN categories c ON c.id = pr.category_id
      WHERE o.status = 'selesai' AND DATE(o.closed_at) = CURDATE()
      GROUP BY oi.product_id, oi.product_name, c.name
      ORDER BY qty DESC
      LIMIT 5
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/hourly
app.get('/api/dashboard/hourly', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT HOUR(closed_at) AS jam, SUM(total) AS total
      FROM orders
      WHERE status = 'selesai' AND DATE(closed_at) = CURDATE()
      GROUP BY HOUR(closed_at)
      ORDER BY jam ASC
    `);

    const salesMap = {};
    rows.forEach(r => {
      salesMap[r.jam] = Number(r.total);
    });

    // Business hours 10:00 to 20:00 (matching dashboard)
    const hours = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    let maxVal = 0;
    const result = hours.map(h => {
      const val = salesMap[h] || 0;
      if (val > maxVal) maxVal = val;
      return {
        h: `${String(h).padStart(2, '0')}:00`,
        val
      };
    });

    result.forEach(item => {
      item.peak = maxVal > 0 && item.val === maxVal;
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/recent-transactions?limit=10
app.get('/api/dashboard/recent-transactions', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const [rows] = await db.query(`
      SELECT o.id, o.order_no, o.order_type, o.table_id, t.code AS table_code,
             o.platform, o.customer_name, o.status, o.total, o.subtotal, o.discount_percent,
             o.discount_amount, o.tax_amount, o.service_amount, o.opened_at, o.closed_at,
             COALESCE(
               (SELECT pm.name FROM payments p JOIN payment_methods pm ON pm.id = p.payment_method_id WHERE p.order_id = o.id LIMIT 1),
               '-'
             ) AS payment_method,
             (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS items_count
      FROM orders o
      LEFT JOIN restaurant_tables t ON t.id = o.table_id
      WHERE o.status IN ('selesai', 'void')
      ORDER BY COALESCE(o.closed_at, o.opened_at) DESC, o.id DESC
      LIMIT ?
    `, [limit]);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/alerts
app.get('/api/dashboard/alerts', async (req, res) => {
  try {
    // Low stock products
    const [lowStock] = await db.query(`
      SELECT id, name, stock, low_stock_threshold, is_available
      FROM products
      WHERE is_active = 1 AND (stock <= low_stock_threshold OR is_available = 0)
      ORDER BY stock ASC
    `);

    // Online delivery orders with status 'baru'
    const [onlineOrders] = await db.query(`
      SELECT id, order_no, order_type, platform, customer_name, total, opened_at
      FROM orders
      WHERE order_type = 'delivery' AND status = 'baru'
      ORDER BY opened_at DESC
    `);

    res.json({
      low_stock: lowStock,
      online_orders: onlineOrders
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve frontend fallback for any non-API GET request
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Express server
app.listen(PORT, () => {
  console.log(`🚀 Kasir Restoran server running on http://localhost:${PORT}`);
});
