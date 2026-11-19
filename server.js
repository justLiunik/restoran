require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32 || JWT_SECRET === 'change-this-secret') {
  console.error('❌ JWT_SECRET belum diatur atau terlalu lemah (minimal 32 karakter).');
  console.error('   Buat dengan: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  console.error('   lalu simpan di file .env sebagai JWT_SECRET=<hasilnya>');
  process.exit(1);
}

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

// Normalizes a free-text item note: collapse whitespace, trim, max 255 chars (column limit). Empty -> null.
function cleanNote(note) {
  const s = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 255);
  return s || null;
}

// Validates requested items and snapshots product data.
// Lines are merged by product + note (same product with a different note stays a separate line).
// Stock is checked against the total quantity requested per product.
async function buildOrderItems(conn, items, priceSnapshot = new Map()) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Pesanan harus memiliki minimal 1 item');
  }

  const merged = new Map();
  for (const it of items) {
    const productId = Number(it.product_id);
    const qty = Math.floor(Number(it.qty));
    if (!productId || !(qty >= 1)) throw new Error('Item pesanan tidak valid');
    const note = cleanNote(it.note);
    const key = `${productId}|${(note || '').toLowerCase()}`;
    const prev = merged.get(key);
    if (prev) prev.qty += qty;
    else merged.set(key, { product_id: productId, qty, note });
  }
  const lines = [...merged.values()];

  const productIds = [...new Set(lines.map(l => l.product_id))];
  const [products] = await conn.query(
    'SELECT id, name, price, stock, is_available, is_active FROM products WHERE id IN (?)',
    [productIds]
  );
  const prodMap = new Map(products.map(p => [p.id, p]));

  const qtyByProduct = new Map();
  for (const l of lines) qtyByProduct.set(l.product_id, (qtyByProduct.get(l.product_id) || 0) + l.qty);
  for (const [productId, totalQty] of qtyByProduct) {
    const prod = prodMap.get(productId);
    if (!prod) throw new Error(`Produk ID ${productId} tidak ditemukan`);
    // A menu deactivated in "Kelola Menu" can not be newly added. A line that is already on this order
    // (it has a price snapshot) stays valid, so held/open orders can still be resumed and paid.
    if (!prod.is_active && !priceSnapshot.has(productId)) throw new Error(`Menu ${prod.name} sudah dinonaktifkan`);
    if (prod.stock < totalQty) throw new Error(`Stok ${prod.name} tidak mencukupi (sisa ${prod.stock})`);
  }

  return lines.map(l => {
    const prod = prodMap.get(l.product_id);
    return {
      product_id: prod.id,
      product_name: prod.name,
      // keep the price already snapshotted on this order, if any
      price: priceSnapshot.has(prod.id) ? priceSnapshot.get(prod.id) : prod.price,
      qty: l.qty,
      note: l.note
    };
  });
}

const ACTIVE_ORDER_STATUSES = ['baru', 'diproses', 'siap_saji', 'belum_dibayar', 'hold'];

// ---------- STOCK HELPERS ----------

const MAX_STOCK_CHANGE = 100000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The ONE SQL definition of a product's stock status: 'habis' | 'menipis' | 'ok'
// (the frontend mirrors it in getStockStatus). `a` is the table alias of `products`.
function stockStatusSql(a = 'p') {
  return `CASE
    WHEN ${a}.stock <= 0 OR ${a}.is_available = 0 THEN 'habis'
    WHEN ${a}.stock <= ${a}.low_stock_threshold THEN 'menipis'
    ELSE 'ok'
  END`;
}

const PRODUCT_SELECT = `
  SELECT p.id, p.category_id, c.name AS category_name, p.name, p.price, p.image_url,
         p.stock, p.low_stock_threshold, p.is_available, p.is_active,
         ${stockStatusSql('p')} AS stock_status
  FROM products p
  JOIN categories c ON c.id = p.category_id`;

// Whole number from a JSON number or a string of digits; anything else (decimals, "abc", null) -> null
function parseWholeNumber(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return null;
}

// Returns the supervisor/admin whose PIN matches, or null
async function findSupervisorByPin(conn, pin) {
  if (!pin) return null;
  const [spvs] = await conn.query(
    'SELECT id, name, pin_hash FROM users WHERE role IN ("supervisor", "admin") AND pin_hash IS NOT NULL AND is_active = 1'
  );
  for (const spv of spvs) {
    if (await bcrypt.compare(String(pin), spv.pin_hash)) return spv;
  }
  return null;
}

async function insertStockMovement(conn, { productId, type, qtyChange, stockAfter, note, orderId, userId }) {
  await conn.query(
    `INSERT INTO stock_movements (product_id, type, qty_change, stock_after, note, order_id, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [productId, type, qtyChange, stockAfter, note ? String(note).slice(0, 255) : null, orderId || null, userId]
  );
}

// Decreases (sale, direction -1) or restores (void, direction +1) stock for the items of an order and records a
// stock_movements row per product. Runs inside the caller's transaction.
// Returns the products that ended at or below their low-stock threshold after a sale.
async function applyOrderStock(conn, items, direction, { orderId, userId, note }) {
  const qtyByProduct = new Map();
  items.forEach(it => qtyByProduct.set(it.product_id, (qtyByProduct.get(it.product_id) || 0) + Number(it.qty)));

  const lowStock = [];
  // fixed order (by id) so concurrent orders lock rows in the same order
  for (const productId of [...qtyByProduct.keys()].sort((a, b) => a - b)) {
    const [rows] = await conn.query(
      'SELECT id, name, stock, low_stock_threshold FROM products WHERE id = ? FOR UPDATE',
      [productId]
    );
    if (rows.length === 0) continue;
    const prod = rows[0];

    const newStock = Math.max(0, prod.stock + qtyByProduct.get(productId) * direction);
    const change = newStock - prod.stock;
    if (change === 0) continue;

    await conn.query('UPDATE products SET stock = ? WHERE id = ?', [newStock, productId]);
    await insertStockMovement(conn, {
      productId,
      type: direction < 0 ? 'sale' : 'void_restore',
      qtyChange: change,
      stockAfter: newStock,
      note,
      orderId,
      userId
    });

    if (direction < 0 && newStock <= prod.low_stock_threshold) {
      lowStock.push({ id: prod.id, name: prod.name, stock: newStock, low_stock_threshold: prod.low_stock_threshold });
    }
  }
  return lowStock;
}

// ---------- MENU ADMIN HELPERS ----------

const ADMIN_ROLES = ['admin', 'supervisor'];
const MAX_PRICE = 100000000;
const MAX_LOW_STOCK_THRESHOLD = 1000;

// Route guard: only the given roles (read from the JWT in req.user) may pass
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Hanya admin atau supervisor yang dapat mengelola menu' });
    }
    next();
  };
}
const requireAdmin = requireRole(...ADMIN_ROLES);

// Validates and normalises the body of POST/PUT /api/admin/products. Throws HttpError(400).
// image_url: undefined = not provided (edit keeps the current one), null = clear it, string = new link.
// low_stock_threshold: null = not provided (create uses 5, edit keeps the current one).
function parseProductInput(body, { creating }) {
  const b = body || {};

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) throw new HttpError(400, 'Nama menu wajib diisi');
  if (name.length > 100) throw new HttpError(400, 'Nama menu maksimal 100 karakter');

  const categoryId = parseWholeNumber(b.category_id);
  if (categoryId === null || categoryId < 1) throw new HttpError(400, 'Kategori wajib dipilih');

  const price = parseWholeNumber(b.price);
  if (price === null) throw new HttpError(400, 'Harga harus berupa bilangan bulat rupiah');
  if (price < 1) throw new HttpError(400, 'Harga minimal Rp 1');
  if (price > MAX_PRICE) throw new HttpError(400, 'Harga terlalu besar (maksimal Rp 100.000.000)');

  let imageUrl;
  if (b.image_url !== undefined) {
    if (b.image_url !== null && typeof b.image_url !== 'string') throw new HttpError(400, 'Link foto tidak valid');
    const link = (b.image_url || '').trim();
    if (link.length > 500) throw new HttpError(400, 'Link foto maksimal 500 karakter');
    if (link && !/^https?:\/\/\S+$/i.test(link)) throw new HttpError(400, 'Link foto harus diawali http:// atau https://');
    imageUrl = link || null;
  }

  let threshold = null;
  if (b.low_stock_threshold !== undefined && b.low_stock_threshold !== null && b.low_stock_threshold !== '') {
    threshold = parseWholeNumber(b.low_stock_threshold);
    if (threshold === null || threshold < 0 || threshold > MAX_LOW_STOCK_THRESHOLD) {
      throw new HttpError(400, `Batas stok menipis harus bilangan bulat 0-${MAX_LOW_STOCK_THRESHOLD}`);
    }
  }

  const result = { name, category_id: categoryId, price, image_url: imageUrl, low_stock_threshold: threshold };

  if (creating) {
    let stock = 0;
    if (b.stock !== undefined && b.stock !== null && b.stock !== '') {
      stock = parseWholeNumber(b.stock);
      if (stock === null || stock < 0 || stock > MAX_STOCK_CHANGE) {
        throw new HttpError(400, `Stok awal harus bilangan bulat 0-${MAX_STOCK_CHANGE.toLocaleString('id-ID')}`);
      }
    }
    result.stock = stock;
  }
  return result;
}

// Locks the category row (so two admins can not race on the same name check) and makes sure it exists
async function lockCategory(conn, categoryId) {
  const [rows] = await conn.query('SELECT id FROM categories WHERE id = ? FOR UPDATE', [categoryId]);
  if (rows.length === 0) throw new HttpError(400, 'Kategori tidak ditemukan');
}

// A menu name may appear only once per category (case-insensitive, inactive menus count too)
async function assertUniqueProductName(conn, categoryId, name, exceptId = null) {
  const [rows] = await conn.query(
    'SELECT id, is_active FROM products WHERE category_id = ? AND LOWER(name) = LOWER(?) AND id <> ? LIMIT 1',
    [categoryId, name, exceptId || 0]
  );
  if (rows.length === 0) return;
  throw new HttpError(409, rows[0].is_active
    ? `Menu "${name}" sudah ada di kategori ini`
    : `Menu "${name}" sudah ada tetapi nonaktif. Aktifkan kembali menu tersebut.`);
}

// ---------- RESERVASI HELPERS ----------

const RESERVATION = {
  REMINDER_MINUTES: 30,        // meja tampil biru + pengingat muncul sejak sekian menit sebelum jam booking
  GRACE_MINUTES: 15,           // "Tidak Datang" baru boleh setelah jam booking + masa tenggang ini
  SLOT_MINUTES: 120,           // dua reservasi "menunggu" di meja yang sama harus berjarak minimal ini
  MAX_ADVANCE_DAYS: 60,
  PAST_TOLERANCE_MINUTES: 5    // booking yang baru saja lewat boleh masih dicatat
};

// All reservation times are WALL-CLOCK WIB strings ('YYYY-MM-DD HH:mm:ss'), compared in Node as text/UTC math.
// Never NOW()/CURDATE() in reservation SQL: the MySQL server may run in another time zone than this app.
function nowWib() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}
const wallMs = (s) => Date.parse(s.replace(' ', 'T') + 'Z');
function shiftWall(s, minutes) {
  return new Date(wallMs(s) + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
}
const secondsUntilWall = (reservedFull, now) => Math.round((wallMs(reservedFull) - wallMs(now)) / 1000);

// 'later' (> 30 min), 'soon' (within 30 min), 'now' (booking time reached, inside the grace period), 'late' (grace over)
function reservationPhase(secondsUntil) {
  if (secondsUntil > RESERVATION.REMINDER_MINUTES * 60) return 'later';
  if (secondsUntil > 0) return 'soon';
  if (secondsUntil > -RESERVATION.GRACE_MINUTES * 60) return 'now';
  return 'late';
}

// 'YYYY-MM-DD HH:mm' (strict, real calendar date) -> 'YYYY-MM-DD HH:mm:00'
function parseReservedAt(value) {
  const m = typeof value === 'string' ? value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/) : null;
  if (!m) throw new HttpError(400, 'Tanggal dan jam harus berformat YYYY-MM-DD HH:mm');
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const check = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (h > 23 || mi > 59 || check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new HttpError(400, 'Tanggal atau jam tidak valid');
  }
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:00`;
}

// Not in the past (small tolerance) and not too far ahead
function assertReservationTime(reservedAt) {
  const diffMinutes = (wallMs(reservedAt) - wallMs(nowWib())) / 60000;
  if (diffMinutes < -RESERVATION.PAST_TOLERANCE_MINUTES) throw new HttpError(400, 'Waktu reservasi sudah lewat');
  if (diffMinutes > RESERVATION.MAX_ADVANCE_DAYS * 24 * 60) {
    throw new HttpError(400, `Reservasi paling jauh ${RESERVATION.MAX_ADVANCE_DAYS} hari ke depan`);
  }
}

// Validates the body of POST/PUT /api/reservations. Throws HttpError(400).
function parseReservationInput(body) {
  const b = body || {};

  const name = typeof b.customer_name === 'string' ? b.customer_name.trim() : '';
  if (!name) throw new HttpError(400, 'Nama tamu wajib diisi');
  if (name.length > 100) throw new HttpError(400, 'Nama tamu maksimal 100 karakter');

  let phone = null;
  if (b.phone !== undefined && b.phone !== null) {
    if (typeof b.phone !== 'string') throw new HttpError(400, 'Nomor telepon tidak valid');
    phone = b.phone.trim() || null;
    if (phone && phone.length > 30) throw new HttpError(400, 'Nomor telepon maksimal 30 karakter');
    if (phone && !/^[0-9+\-()\s]+$/.test(phone)) throw new HttpError(400, 'Nomor telepon hanya boleh berisi angka, spasi, +, - dan tanda kurung');
  }

  const partySize = parseWholeNumber(b.party_size);
  if (partySize === null || partySize < 1 || partySize > 50) throw new HttpError(400, 'Jumlah tamu harus bilangan bulat 1-50');

  const tableId = parseWholeNumber(b.table_id);
  if (tableId === null || tableId < 1) throw new HttpError(400, 'Meja wajib dipilih');

  let note = null;
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== 'string') throw new HttpError(400, 'Catatan tidak valid');
    note = b.note.trim() || null;
    if (note && note.length > 255) throw new HttpError(400, 'Catatan maksimal 255 karakter');
  }

  return {
    customer_name: name, phone, party_size: partySize, table_id: tableId,
    reserved_at: parseReservedAt(b.reserved_at), note
  };
}

const RESERVATION_SELECT = `
  SELECT r.id, r.customer_name, r.phone, r.party_size, r.table_id,
         t.code AS table_code, t.capacity AS table_capacity,
         DATE_FORMAT(r.reserved_at, '%Y-%m-%d %H:%i:%s') AS reserved_full,
         r.note, r.status, r.order_id, o.order_no,
         DATE_FORMAT(r.arrived_at, '%Y-%m-%d %H:%i') AS arrived_at
  FROM reservations r
  JOIN restaurant_tables t ON t.id = r.table_id
  LEFT JOIN orders o ON o.id = r.order_id`;

// API shape of a reservation row: reserved_at as 'YYYY-MM-DD HH:mm', minutes_until, phase (only while "menunggu")
function shapeReservation(row, now = nowWib()) {
  const { reserved_full, ...rest } = row;
  const seconds = secondsUntilWall(reserved_full, now);
  return {
    ...rest,
    reserved_at: reserved_full.slice(0, 16),
    minutes_until: Math.ceil(seconds / 60),
    phase: row.status === 'menunggu' ? reservationPhase(seconds) : null
  };
}

async function loadReservation(conn, id) {
  const [rows] = await conn.query(`${RESERVATION_SELECT} WHERE r.id = ?`, [id]);
  return rows.length ? shapeReservation(rows[0]) : null;
}

// Locks the table row so two staff members can not book / seat the same table at the same moment
async function lockTable(conn, tableId) {
  const [rows] = await conn.query('SELECT id, code FROM restaurant_tables WHERE id = ? FOR UPDATE', [tableId]);
  if (rows.length === 0) throw new HttpError(400, 'Meja tidak ditemukan');
  return rows[0];
}

// Only "menunggu" reservations hold a slot: another one on this table closer than SLOT_MINUTES is a clash
async function assertSlotFree(conn, tableId, reservedAt, exceptId = null) {
  const [rows] = await conn.query(
    `SELECT r.customer_name, t.code,
            DATE_FORMAT(r.reserved_at, '%H:%i') AS hhmm, DATE_FORMAT(r.reserved_at, '%Y-%m-%d') AS day
     FROM reservations r JOIN restaurant_tables t ON t.id = r.table_id
     WHERE r.table_id = ? AND r.status = 'menunggu' AND r.id <> ? AND r.reserved_at > ? AND r.reserved_at < ?
     ORDER BY r.reserved_at ASC LIMIT 1`,
    [tableId, exceptId || 0, shiftWall(reservedAt, -RESERVATION.SLOT_MINUTES), shiftWall(reservedAt, RESERVATION.SLOT_MINUTES)]
  );
  if (rows.length === 0) return;
  const c = rows[0];
  const when = c.day === reservedAt.slice(0, 10) ? c.hhmm : `${c.day} ${c.hhmm}`;
  throw new HttpError(409, `Meja ${c.code} sudah direservasi pukul ${when} atas nama ${c.customer_name}. Pilih jam atau meja lain.`);
}

const RESERVATION_STATUS_LABEL = { menunggu: 'Menunggu', datang: 'Datang', tidak_datang: 'Tidak Datang', batal: 'Batal' };

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
    let sql = `${PRODUCT_SELECT}
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

// GET /api/products/stock-summary -> { ok, menipis, habis, total }
app.get('/api/products/stock-summary', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT ${stockStatusSql('p')} AS status, COUNT(*) AS n
      FROM products p
      WHERE p.is_active = 1
      GROUP BY status
    `);
    const summary = { ok: 0, menipis: 0, habis: 0, total: 0 };
    rows.forEach(r => {
      summary[r.status] = Number(r.n);
      summary.total += Number(r.n);
    });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/products/:id/availability { is_available }
// Idempotent; an item with stock 0 can not be marked sold out (it already is).
app.patch('/api/products/:id/availability', async (req, res) => {
  const conn = await db.getConnection();
  try {
    const raw = req.body.is_available;
    let target = null;
    if (raw === 0 || raw === false || raw === '0' || raw === 'false') target = 0;
    if (raw === 1 || raw === true || raw === '1' || raw === 'true') target = 1;
    if (target === null) throw new HttpError(400, 'is_available harus 0 atau 1');

    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT id, stock, is_available FROM products WHERE id = ? FOR UPDATE', [req.params.id]);
    if (rows.length === 0) throw new HttpError(404, 'Produk tidak ditemukan');
    const prod = rows[0];

    if (Number(prod.is_available) === target) {
      await conn.commit();
      return res.json({ ok: true, id: prod.id, is_available: target, changed: false });
    }
    if (target === 0 && prod.stock <= 0) throw new HttpError(400, 'Stok sudah 0');

    await conn.query('UPDATE products SET is_available = ? WHERE id = ?', [target, prod.id]);
    await conn.commit();
    res.json({ ok: true, id: prod.id, is_available: target, changed: true });
  } catch (err) {
    await conn.rollback();
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// POST /api/products/:id/stock { qty, note? } -> restock (adds qty, makes the product available again)
app.post('/api/products/:id/stock', async (req, res) => {
  const conn = await db.getConnection();
  try {
    const qty = parseWholeNumber(req.body.qty);
    if (qty === null || qty < 1) throw new HttpError(400, 'Jumlah harus bilangan bulat positif (minimal 1)');
    if (qty > MAX_STOCK_CHANGE) throw new HttpError(400, `Jumlah terlalu besar (maksimal ${MAX_STOCK_CHANGE})`);
    const note = cleanNote(req.body.note);

    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT id, stock FROM products WHERE id = ? AND is_active = 1 FOR UPDATE', [req.params.id]);
    if (rows.length === 0) throw new HttpError(404, 'Produk tidak ditemukan');
    const prod = rows[0];

    const newStock = prod.stock + qty;
    await conn.query('UPDATE products SET stock = ?, is_available = 1 WHERE id = ?', [newStock, prod.id]);
    await insertStockMovement(conn, {
      productId: prod.id, type: 'restock', qtyChange: qty, stockAfter: newStock, note, userId: req.user.id
    });
    await conn.commit();

    const [updated] = await db.query(`${PRODUCT_SELECT} WHERE p.id = ?`, [prod.id]);
    res.json({ ok: true, qty, product: updated[0] });
  } catch (err) {
    await conn.rollback();
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// POST /api/products/:id/stock/correct { new_stock, reason, pin } -> stock-taking correction (supervisor/admin PIN)
app.post('/api/products/:id/stock/correct', async (req, res) => {
  const conn = await db.getConnection();
  try {
    const newStock = parseWholeNumber(req.body.new_stock);
    if (newStock === null || newStock < 0) throw new HttpError(400, 'Stok baru harus bilangan bulat 0 atau lebih');
    if (newStock > MAX_STOCK_CHANGE) throw new HttpError(400, `Stok terlalu besar (maksimal ${MAX_STOCK_CHANGE})`);
    const reason = cleanNote(req.body.reason);
    if (!reason) throw new HttpError(400, 'Alasan koreksi wajib diisi');
    if (!req.body.pin) throw new HttpError(400, 'PIN supervisor wajib diisi');

    const supervisor = await findSupervisorByPin(db, req.body.pin);
    if (!supervisor) throw new HttpError(403, 'PIN supervisor salah');

    await conn.beginTransaction();
    const [rows] = await conn.query(
      'SELECT id, name, stock, low_stock_threshold FROM products WHERE id = ? AND is_active = 1 FOR UPDATE',
      [req.params.id]
    );
    if (rows.length === 0) throw new HttpError(404, 'Produk tidak ditemukan');
    const prod = rows[0];

    const change = newStock - prod.stock;
    if (change === 0) throw new HttpError(400, 'Stok baru sama dengan stok saat ini');

    await conn.query('UPDATE products SET stock = ? WHERE id = ?', [newStock, prod.id]);
    await insertStockMovement(conn, {
      productId: prod.id,
      type: 'correction',
      qtyChange: change,
      stockAfter: newStock,
      note: `${reason} (otorisasi: ${supervisor.name})`,
      userId: req.user.id
    });
    await conn.commit();

    const [updated] = await db.query(`${PRODUCT_SELECT} WHERE p.id = ?`, [prod.id]);
    const low = newStock <= prod.low_stock_threshold
      ? [{ id: prod.id, name: prod.name, stock: newStock, low_stock_threshold: prod.low_stock_threshold }]
      : [];
    res.json({ ok: true, qty_change: change, product: updated[0], low_stock: low });
  } catch (err) {
    await conn.rollback();
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// GET /api/products/:id/stock-movements?limit=20
app.get('/api/products/:id/stock-movements', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseWholeNumber(req.query.limit) || 20));
    const [prods] = await db.query('SELECT id, name, stock FROM products WHERE id = ?', [req.params.id]);
    if (prods.length === 0) throw new HttpError(404, 'Produk tidak ditemukan');

    const [rows] = await db.query(`
      SELECT m.id, m.type, m.qty_change, m.stock_after, m.note, m.order_id, o.order_no,
             m.user_id, u.name AS user_name, m.created_at
      FROM stock_movements m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN orders o ON o.id = m.order_id
      WHERE m.product_id = ?
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?
    `, [req.params.id, limit]);
    res.json({ product: prods[0], movements: rows });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------- KELOLA MENU (admin / supervisor) ----------

// GET /api/admin/products -> every product, active or not
app.get('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(`${PRODUCT_SELECT} ORDER BY c.sort_order ASC, c.id ASC, p.name ASC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/products { name, category_id, price, image_url?, low_stock_threshold?, stock? }
// An initial stock above 0 is written to the stock history as a "restock" named "Stok awal".
app.post('/api/admin/products', requireAdmin, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const input = parseProductInput(req.body, { creating: true });
    await conn.beginTransaction();
    await lockCategory(conn, input.category_id);
    await assertUniqueProductName(conn, input.category_id, input.name);

    const [ins] = await conn.query(
      `INSERT INTO products (category_id, name, price, image_url, stock, low_stock_threshold)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.category_id, input.name, input.price, input.image_url || null, input.stock, input.low_stock_threshold ?? 5]
    );
    if (input.stock > 0) {
      await insertStockMovement(conn, {
        productId: ins.insertId, type: 'restock', qtyChange: input.stock, stockAfter: input.stock,
        note: 'Stok awal', userId: req.user.id
      });
    }
    await conn.commit();

    const [rows] = await db.query(`${PRODUCT_SELECT} WHERE p.id = ?`, [ins.insertId]);
    res.status(201).json({ ok: true, product: rows[0] });
  } catch (err) {
    await conn.rollback();
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/admin/products/:id { name, category_id, price, image_url, low_stock_threshold }
// Never touches stock / is_available / is_active. Old orders keep their own name/price snapshot.
app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const input = parseProductInput(req.body, { creating: false });
    await conn.beginTransaction();
    const [cur] = await conn.query(
      'SELECT id, image_url, low_stock_threshold FROM products WHERE id = ? FOR UPDATE', [req.params.id]
    );
    if (cur.length === 0) throw new HttpError(404, 'Menu tidak ditemukan');
    await lockCategory(conn, input.category_id);
    await assertUniqueProductName(conn, input.category_id, input.name, cur[0].id);

    await conn.query(
      `UPDATE products SET name = ?, category_id = ?, price = ?, image_url = ?, low_stock_threshold = ? WHERE id = ?`,
      [
        input.name, input.category_id, input.price,
        input.image_url === undefined ? cur[0].image_url : input.image_url,
        input.low_stock_threshold ?? cur[0].low_stock_threshold,
        cur[0].id
      ]
    );
    await conn.commit();

    const [rows] = await db.query(`${PRODUCT_SELECT} WHERE p.id = ?`, [cur[0].id]);
    res.json({ ok: true, product: rows[0] });
  } catch (err) {
    await conn.rollback();
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// PATCH /api/admin/products/:id/active { is_active: boolean } -> "delete" = deactivate, idempotent
app.patch('/api/admin/products/:id/active', requireAdmin, async (req, res) => {
  try {
    const isActive = req.body && req.body.is_active;
    if (typeof isActive !== 'boolean') throw new HttpError(400, 'is_active harus true atau false');
    const [found] = await db.query('SELECT id FROM products WHERE id = ?', [req.params.id]);
    if (found.length === 0) throw new HttpError(404, 'Menu tidak ditemukan');

    await db.query('UPDATE products SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, found[0].id]);
    const [rows] = await db.query(`${PRODUCT_SELECT} WHERE p.id = ?`, [found[0].id]);
    res.json({ ok: true, product: rows[0] });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- categories ----

function parseCategoryName(body) {
  const name = body && typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new HttpError(400, 'Nama kategori wajib diisi');
  if (name.length > 50) throw new HttpError(400, 'Nama kategori maksimal 50 karakter');
  return name;
}

// categories.name is UNIQUE (case-insensitive collation): a clash surfaces as ER_DUP_ENTRY
function sendCategoryError(res, err) {
  if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Nama kategori sudah dipakai' });
  res.status(err.status || 500).json({ error: err.message });
}

// POST /api/admin/categories { name } -> appended after the last category
app.post('/api/admin/categories', requireAdmin, async (req, res) => {
  try {
    const name = parseCategoryName(req.body);
    const [[last]] = await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM categories');
    const [ins] = await db.query('INSERT INTO categories (name, sort_order) VALUES (?, ?)', [name, last.next]);
    res.status(201).json({ ok: true, category: { id: ins.insertId, name, sort_order: last.next } });
  } catch (err) {
    sendCategoryError(res, err);
  }
});

// PUT /api/admin/categories/order { ids: [...] } -> new order; must list every category exactly once.
// (Registered before /:id so "order" is not read as an id.)
app.put('/api/admin/categories/order', requireAdmin, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const raw = req.body && req.body.ids;
    if (!Array.isArray(raw) || raw.length === 0) throw new HttpError(400, 'Daftar urutan kategori tidak valid');
    const ids = raw.map(parseWholeNumber);
    if (ids.some(id => id === null)) throw new HttpError(400, 'Daftar urutan kategori tidak valid');

    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT id FROM categories FOR UPDATE');
    const existing = new Set(rows.map(r => r.id));
    if (ids.length !== existing.size || new Set(ids).size !== ids.length || ids.some(id => !existing.has(id))) {
      throw new HttpError(400, 'Urutan harus memuat semua kategori tepat satu kali');
    }
    for (let i = 0; i < ids.length; i++) {
      await conn.query('UPDATE categories SET sort_order = ? WHERE id = ?', [i + 1, ids[i]]);
    }
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    sendCategoryError(res, err);
  } finally {
    conn.release();
  }
});

// PUT /api/admin/categories/:id { name }
app.put('/api/admin/categories/:id', requireAdmin, async (req, res) => {
  try {
    const name = parseCategoryName(req.body);
    const [found] = await db.query('SELECT id, sort_order FROM categories WHERE id = ?', [req.params.id]);
    if (found.length === 0) throw new HttpError(404, 'Kategori tidak ditemukan');
    await db.query('UPDATE categories SET name = ? WHERE id = ?', [name, found[0].id]);
    res.json({ ok: true, category: { id: found[0].id, name, sort_order: found[0].sort_order } });
  } catch (err) {
    sendCategoryError(res, err);
  }
});

// DELETE /api/admin/categories/:id -> only when it holds no menu at all (inactive menus count)
app.delete('/api/admin/categories/:id', requireAdmin, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    // same lock that menu create/edit takes, so a menu can not be added while we count
    const [found] = await conn.query('SELECT id FROM categories WHERE id = ? FOR UPDATE', [req.params.id]);
    if (found.length === 0) throw new HttpError(404, 'Kategori tidak ditemukan');
    const [[count]] = await conn.query('SELECT COUNT(*) AS n FROM products WHERE category_id = ?', [found[0].id]);
    if (count.n > 0) throw new HttpError(409, `Kategori masih berisi ${count.n} menu`);
    await conn.query('DELETE FROM categories WHERE id = ?', [found[0].id]);
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    sendCategoryError(res, err);
  } finally {
    conn.release();
  }
});

// ---------- RESERVASI ----------

// GET /api/reservations -> last 7 days and everything ahead, plus any reservation still unresolved (menunggu, or
// seated without an order) however old, so no table can stay blocked by a reservation nobody can see.
app.get('/api/reservations', async (req, res) => {
  try {
    const now = nowWib();
    const since = `${shiftWall(now, -7 * 24 * 60).slice(0, 10)} 00:00:00`;
    const [rows] = await db.query(
      `${RESERVATION_SELECT}
       WHERE r.reserved_at >= ? OR r.status = 'menunggu' OR (r.status = 'datang' AND r.order_id IS NULL)
       ORDER BY r.reserved_at ASC, r.id ASC LIMIT 500`,
      [since]
    );
    res.json({
      config: {
        reminder_minutes: RESERVATION.REMINDER_MINUTES,
        grace_minutes: RESERVATION.GRACE_MINUTES,
        slot_minutes: RESERVATION.SLOT_MINUTES
      },
      now: now.slice(0, 16),
      reservations: rows.map(r => shapeReservation(r, now))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reservations { customer_name, party_size, table_id, reserved_at: 'YYYY-MM-DD HH:mm', phone?, note? }
app.post('/api/reservations', async (req, res) => {
  const conn = await db.getConnection();
  try {
    const input = parseReservationInput(req.body);
    assertReservationTime(input.reserved_at);

    await conn.beginTransaction();
    await lockTable(conn, input.table_id);
    await assertSlotFree(conn, input.table_id, input.reserved_at);
    const [ins] = await conn.query(
      `INSERT INTO reservations (customer_name, phone, party_size, table_id, reserved_at, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.customer_name, input.phone, input.party_size, input.table_id, input.reserved_at, input.note, req.user.id]
    );
    await conn.commit();
    res.status(201).json({ ok: true, reservation: await loadReservation(db, ins.insertId) });
  } catch (err) {
    await conn.rollback();
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/reservations/:id (same body as POST) -> only while "menunggu"
app.put('/api/reservations/:id', async (req, res) => {
  const conn = await db.getConnection();
  try {
    const input = parseReservationInput(req.body);

    await conn.beginTransaction();
    const [cur] = await conn.query(
      `SELECT id, status, table_id, DATE_FORMAT(reserved_at, '%Y-%m-%d %H:%i:00') AS reserved_at
       FROM reservations WHERE id = ? FOR UPDATE`,
      [req.params.id]
    );
    if (cur.length === 0) throw new HttpError(404, 'Reservasi tidak ditemukan');
    if (cur[0].status !== 'menunggu') {
      throw new HttpError(409, `Reservasi yang sudah ${RESERVATION_STATUS_LABEL[cur[0].status]} tidak bisa diubah`);
    }
    if (input.reserved_at !== cur[0].reserved_at) assertReservationTime(input.reserved_at);

    // lock in a fixed order (by table id) so two edits can not deadlock
    for (const tableId of [...new Set([cur[0].table_id, input.table_id])].sort((a, b) => a - b)) {
      await lockTable(conn, tableId);
    }
    await assertSlotFree(conn, input.table_id, input.reserved_at, cur[0].id);

    await conn.query(
      `UPDATE reservations SET customer_name = ?, phone = ?, party_size = ?, table_id = ?, reserved_at = ?, note = ?
       WHERE id = ?`,
      [input.customer_name, input.phone, input.party_size, input.table_id, input.reserved_at, input.note, cur[0].id]
    );
    await conn.commit();
    res.json({ ok: true, reservation: await loadReservation(db, cur[0].id) });
  } catch (err) {
    await conn.rollback();
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// Reads one reservation row inside a transaction (FOR UPDATE); throws 404
async function lockReservation(conn, id) {
  const [rows] = await conn.query(
    `SELECT id, status, table_id, order_id, DATE_FORMAT(reserved_at, '%Y-%m-%d %H:%i:%s') AS reserved_full
     FROM reservations WHERE id = ? FOR UPDATE`,
    [id]
  );
  if (rows.length === 0) throw new HttpError(404, 'Reservasi tidak ditemukan');
  return rows[0];
}

const finishedMessage = (status) => `Reservasi ini sudah ditandai ${RESERVATION_STATUS_LABEL[status]}`;

// POST /api/reservations/:id/arrive -> "Tamu Datang": reservation becomes "datang"; the table then shows as terisi
// (the new order is created by the client; saving it links the order to this reservation, see POST /api/orders)
app.post('/api/reservations/:id/arrive', async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const cur = await lockReservation(conn, req.params.id);
    if (cur.status !== 'menunggu') throw new HttpError(409, finishedMessage(cur.status));

    const table = await lockTable(conn, cur.table_id);
    const [busy] = await conn.query(
      'SELECT order_no FROM orders WHERE table_id = ? AND status IN (?) LIMIT 1', [table.id, ACTIVE_ORDER_STATUSES]
    );
    if (busy.length > 0) {
      throw new HttpError(409, `Meja ${table.code} masih terisi pesanan ${busy[0].order_no}. Ubah meja reservasi atau tunggu pesanan selesai.`);
    }
    const [seated] = await conn.query(
      "SELECT customer_name FROM reservations WHERE table_id = ? AND status = 'datang' AND order_id IS NULL AND id <> ? LIMIT 1",
      [table.id, cur.id]
    );
    if (seated.length > 0) {
      throw new HttpError(409, `Meja ${table.code} sedang ditempati tamu ${seated[0].customer_name} yang belum memesan. Ubah meja reservasi.`);
    }

    await conn.query("UPDATE reservations SET status = 'datang', arrived_at = ? WHERE id = ?", [nowWib(), cur.id]);
    await conn.commit();
    res.json({ ok: true, reservation: await loadReservation(db, cur.id), table: { id: table.id, code: table.code } });
  } catch (err) {
    await conn.rollback();
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// POST /api/reservations/:id/no-show -> only after booking time + grace period
app.post('/api/reservations/:id/no-show', async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const cur = await lockReservation(conn, req.params.id);
    if (cur.status !== 'menunggu') throw new HttpError(409, finishedMessage(cur.status));

    const now = nowWib();
    const graceEnd = shiftWall(cur.reserved_full, RESERVATION.GRACE_MINUTES);
    if (now < graceEnd) {
      const when = graceEnd.slice(0, 10) === now.slice(0, 10) ? graceEnd.slice(11, 16) : `${graceEnd.slice(0, 10)} ${graceEnd.slice(11, 16)}`;
      throw new HttpError(400, `Baru bisa ditandai Tidak Datang setelah ${when}`);
    }

    await conn.query("UPDATE reservations SET status = 'tidak_datang' WHERE id = ?", [cur.id]);
    await conn.commit();
    res.json({ ok: true, reservation: await loadReservation(db, cur.id) });
  } catch (err) {
    await conn.rollback();
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// POST /api/reservations/:id/cancel -> "menunggu", or "datang" that has not ordered yet (guest left)
app.post('/api/reservations/:id/cancel', async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const cur = await lockReservation(conn, req.params.id);
    if (cur.status === 'datang' && cur.order_id) {
      throw new HttpError(409, 'Tamu sudah memesan, reservasi tidak bisa dibatalkan. Selesaikan atau batalkan pesanannya.');
    }
    if (cur.status !== 'menunggu' && cur.status !== 'datang') throw new HttpError(409, finishedMessage(cur.status));

    await conn.query("UPDATE reservations SET status = 'batal' WHERE id = ?", [cur.id]);
    await conn.commit();
    res.json({ ok: true, reservation: await loadReservation(db, cur.id) });
  } catch (err) {
    await conn.rollback();
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    conn.release();
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

    // The status shown on the floor plan is DERIVED (restaurant_tables.status is only written by the order flow):
    //   1. active order on the table        -> its stored status (terisi / menunggu_bayar)
    //   2. guest seated, not ordered yet    -> terisi   (+ seated_reservation)
    //   3. waiting reservation within 30 min of its time, or past it until resolved -> reservasi (+ reservation)
    //   4. otherwise                        -> stored status (kosong)
    const now = nowWib();
    const windowEnd = shiftWall(now, RESERVATION.REMINDER_MINUTES);
    const [resv] = await db.query(
      `SELECT r.id, r.table_id, r.customer_name, r.party_size, r.status,
              DATE_FORMAT(r.reserved_at, '%Y-%m-%d %H:%i:%s') AS reserved_full
       FROM reservations r
       WHERE (r.status = 'menunggu' AND r.reserved_at <= ?) OR (r.status = 'datang' AND r.order_id IS NULL)
       ORDER BY r.reserved_at ASC, r.id ASC`,
      [`${now.slice(0, 10)} 23:59:59`]
    );
    const byTable = new Map();
    for (const r of resv) {
      const info = byTable.get(r.table_id) || {};
      if (r.status === 'datang') {
        info.seated = info.seated || r;
      } else if (r.reserved_full <= windowEnd) {
        info.inWindow = info.inWindow || r;
      } else {
        info.next = info.next || r;
      }
      byTable.set(r.table_id, info);
    }

    res.json(rows.map(t => {
      const info = byTable.get(t.id) || {};
      let status = t.status === 'reservasi' ? 'kosong' : t.status; // a leftover stored value has no reservation behind it
      let reservation = null;
      let seated = null;
      if (!t.active_order_id) {
        if (info.seated) {
          status = 'terisi';
          seated = { id: info.seated.id, customer_name: info.seated.customer_name };
        } else if (info.inWindow) {
          const r = info.inWindow;
          status = 'reservasi';
          reservation = {
            id: r.id, customer_name: r.customer_name, party_size: r.party_size,
            reserved_at: r.reserved_full.slice(11, 16), reserved_at_full: r.reserved_full.slice(0, 16),
            phase: reservationPhase(secondsUntilWall(r.reserved_full, now))
          };
        }
      }
      return {
        ...t,
        status,
        reservation,
        seated_reservation: seated,
        next_reservation_at: info.next ? info.next.reserved_full.slice(11, 16) : null
      };
    }));
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

    // A dine-in table can only have one active order
    if (order_type === 'dine_in' && table_id) {
      const [busy] = await conn.query(
        'SELECT order_no FROM orders WHERE table_id = ? AND status IN (?) LIMIT 1 FOR UPDATE',
        [table_id, ACTIVE_ORDER_STATUSES]
      );
      if (busy.length > 0) {
        throw new Error(`Meja sudah terisi oleh pesanan ${busy[0].order_no}`);
      }
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
    const orderItemsData = await buildOrderItems(conn, items);

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
      // A guest seated from a reservation ("Tamu Datang") and not ordered yet: this order is theirs
      await conn.query(
        "UPDATE reservations SET order_id = ? WHERE table_id = ? AND status = 'datang' AND order_id IS NULL",
        [orderId, table_id]
      );
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

// PUT /api/orders/:id { items: [{product_id, qty, note?}], discount_percent? }
// Replaces the items of an unpaid order in one transaction ("Simpan Pesanan" on an existing order).
app.put('/api/orders/:id', async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const orderId = req.params.id;

    const [orders] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (orders.length === 0) throw new Error('Pesanan tidak ditemukan');
    const order = orders[0];
    if (order.status === 'selesai' || order.status === 'void') {
      throw new Error('Pesanan sudah selesai atau dibatalkan');
    }

    const [oldItems] = await conn.query('SELECT product_id, price FROM order_items WHERE order_id = ? ORDER BY id ASC', [orderId]);
    const priceSnapshot = new Map();
    oldItems.forEach(it => { if (!priceSnapshot.has(it.product_id)) priceSnapshot.set(it.product_id, it.price); });

    const orderItemsData = await buildOrderItems(conn, req.body.items, priceSnapshot);
    const discount = req.body.discount_percent !== undefined ? req.body.discount_percent : order.discount_percent;
    const totals = calculateOrderTotals(orderItemsData, discount, order.order_type);

    await conn.query('DELETE FROM order_items WHERE order_id = ?', [orderId]);
    for (const it of orderItemsData) {
      await conn.query(`
        INSERT INTO order_items (order_id, product_id, product_name, price, qty, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [orderId, it.product_id, it.product_name, it.price, it.qty, it.note]);
    }

    await conn.query(`
      UPDATE orders SET subtotal = ?, discount_percent = ?, discount_amount = ?, tax_amount = ?, service_amount = ?, total = ?
      WHERE id = ?
    `, [totals.subtotal, totals.discount_percent, totals.discount_amount, totals.tax_amount, totals.service_amount, totals.total, orderId]);

    await conn.commit();
    res.json({ ok: true, id: order.id, order_no: order.order_no, totals });
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

    const [products] = await conn.query('SELECT id, name, price, stock, is_active FROM products WHERE id = ?', [product_id]);
    if (products.length === 0) throw new Error('Produk tidak ditemukan');
    const prod = products[0];

    // Same rule as buildOrderItems: a deactivated menu can only be topped up if it is already on this order
    if (!prod.is_active) {
      const [onOrder] = await conn.query('SELECT id FROM order_items WHERE order_id = ? AND product_id = ? LIMIT 1', [orderId, prod.id]);
      if (onOrder.length === 0) throw new Error(`Menu ${prod.name} sudah dinonaktifkan`);
    }

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

    // Dine-in table follows the order: 'belum_dibayar' -> menunggu_bayar, any other active status -> terisi
    if (order.order_type === 'dine_in' && order.table_id) {
      await db.query(
        'UPDATE restaurant_tables SET status = ? WHERE id = ?',
        [status === 'belum_dibayar' ? 'menunggu_bayar' : 'terisi', order.table_id]
      );
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

    // Decrease product stock (+ 'sale' rows in stock_movements, same transaction)
    const lowStock = await applyOrderStock(conn, items, -1, {
      orderId: order.id,
      userId: req.user.id,
      note: order.order_no
    });

    // Free table if dine_in
    if (order.order_type === 'dine_in' && order.table_id) {
      await conn.query('UPDATE restaurant_tables SET status = "kosong" WHERE id = ?', [order.table_id]);
    }

    await conn.commit();
    res.json({
      ok: true,
      change,
      total: totals.total,
      total_paid: totalPayment,
      low_stock: lowStock
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

    // If order was already paid ('selesai'), restore product stock (+ 'void_restore' rows in stock_movements)
    if (order.status === 'selesai') {
      await applyOrderStock(conn, items, +1, {
        orderId: order.id,
        userId: req.user.id,
        note: `Void ${order.order_no}`
      });
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
             SUM(oi.qty) AS qty, SUM(oi.qty * oi.price) AS revenue,
             pr.stock, pr.low_stock_threshold, pr.is_available
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products pr ON pr.id = oi.product_id
      JOIN categories c ON c.id = pr.category_id
      WHERE o.status = 'selesai' AND DATE(o.closed_at) = CURDATE()
      GROUP BY oi.product_id, oi.product_name, c.name, pr.stock, pr.low_stock_threshold, pr.is_available
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
      SELECT p.id, p.name, p.stock, p.low_stock_threshold, p.is_available,
             ${stockStatusSql('p')} AS stock_status
      FROM products p
      WHERE p.is_active = 1 AND ${stockStatusSql('p')} <> 'ok'
      ORDER BY p.stock ASC
    `);

    // Online delivery orders with status 'baru'
    const [onlineOrders] = await db.query(`
      SELECT id, order_no, order_type, platform, customer_name, total, opened_at
      FROM orders
      WHERE order_type = 'delivery' AND status = 'baru'
      ORDER BY opened_at DESC
    `);

    // Reservations to remind about: waiting ones within 30 minutes of their time, or already past it
    const now = nowWib();
    const [dueRows] = await db.query(
      `${RESERVATION_SELECT} WHERE r.status = 'menunggu' AND r.reserved_at <= ? ORDER BY r.reserved_at ASC, r.id ASC`,
      [shiftWall(now, RESERVATION.REMINDER_MINUTES)]
    );
    const reservations = dueRows.map(row => {
      const r = shapeReservation(row, now);
      return {
        id: r.id, customer_name: r.customer_name, table_code: r.table_code, party_size: r.party_size,
        reserved_at: r.reserved_at.slice(11, 16), reserved_at_full: r.reserved_at,
        minutes_until: r.minutes_until, phase: r.phase
      };
    });

    res.json({
      low_stock: lowStock,
      online_orders: onlineOrders,
      reservations
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
