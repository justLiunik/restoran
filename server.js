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
app.get('/dapur', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dapur.html')));

// ---------- HELPER FUNCTIONS ----------

// ---------- TAX & SERVICE ----------
// The rates (percent) for NEW orders live in app_settings. Every order stores the pair it was created with
// (orders.tax_rate / orders.service_rate) and is always calculated with its own pair, so changing the rates never moves
// a bill a customer has already seen, and an old receipt keeps showing the percentages that were charged.

// taxable x rate%, rounded to whole rupiah. The rate becomes whole hundredths of a percent first (7.5 -> 750), so the
// product is exact. The browser (orderAmounts) uses the very same expression.
function chargeAmount(taxable, ratePercent) {
  return Math.round(taxable * Math.round(Number(ratePercent) * 100) / 10000);
}

// The pair an order of this type is charged: service only applies to dine-in
function effectiveRates(orderType, settings) {
  return { tax_rate: settings.tax_rate, service_rate: orderType === 'dine_in' ? settings.service_rate : 0 };
}

// The pair an existing order was created with
function orderRates(order) {
  return { tax_rate: Number(order.tax_rate), service_rate: Number(order.service_rate) };
}

// Recalculates order subtotal, discount, tax, service charge, and total. rates = { tax_rate, service_rate } (percent)
function calculateOrderTotals(items, discountPercent = 0, rates) {
  if (!rates || !Number.isFinite(rates.tax_rate) || !Number.isFinite(rates.service_rate)) {
    throw new Error('Tarif pajak dan service pesanan tidak tersedia. Jalankan "npm run db:migrate".');
  }
  const subtotal = items.reduce((sum, item) => sum + (Number(item.price) * Number(item.qty)), 0);
  const discPercent = Math.max(0, Math.min(100, Number(discountPercent) || 0));
  const discountAmount = Math.round((subtotal * discPercent) / 100);
  const taxable = Math.max(0, subtotal - discountAmount);
  const taxAmount = chargeAmount(taxable, rates.tax_rate);
  const serviceAmount = chargeAmount(taxable, rates.service_rate);
  const total = Math.round(taxable + taxAmount + serviceAmount);

  return {
    subtotal,
    discount_percent: discPercent,
    discount_amount: discountAmount,
    tax_rate: rates.tax_rate,
    tax_amount: taxAmount,
    service_rate: rates.service_rate,
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
      return res.status(403).json({ error: 'Hanya admin atau supervisor yang dapat mengelola menu dan meja' });
    }
    next();
  };
}
const requireAdmin = requireRole(...ADMIN_ROLES);

// Roles that may run a shift and handle orders (create, edit, hold, pay). Everyone else (admin, supervisor) only watches
// and manages: they can read everything, void with a PIN and handle stock, but never create or change an order.
// To let supervisors take orders too, add 'supervisor' here (and in canHandleOrders() in public/index.html).
const ORDER_HANDLER_ROLES = ['kasir'];
const canHandleOrders = (user) => !!user && ORDER_HANDLER_ROLES.includes(user.role);
function requireOrderHandler(req, res, next) {
  if (canHandleOrders(req.user)) return next();
  res.status(403).json({ error: `Akun ${req.user ? req.user.role : 'ini'} tidak dapat membuat atau mengubah pesanan` });
}

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
// (the same lock "Atur Meja" takes before deactivating a table, so a booking can not slip in at that moment)
async function lockTable(conn, tableId, { requireActive = true } = {}) {
  const [rows] = await conn.query('SELECT id, code, is_active FROM restaurant_tables WHERE id = ? FOR UPDATE', [tableId]);
  if (rows.length === 0) throw new HttpError(400, 'Meja tidak ditemukan');
  if (requireActive && !rows[0].is_active) throw new HttpError(400, `Meja ${rows[0].code} tidak aktif`);
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

// ---------- KELOLA MEJA HELPERS ----------

// Validates the body of POST/PUT /api/admin/tables. Throws HttpError(400).
function parseTableInput(body) {
  const b = body || {};

  const code = typeof b.code === 'string' ? b.code.trim() : '';
  if (!code) throw new HttpError(400, 'Kode meja wajib diisi');
  if (code.length > 10) throw new HttpError(400, 'Kode meja maksimal 10 karakter');

  const capacity = parseWholeNumber(b.capacity);
  if (capacity === null || capacity < 1 || capacity > 50) throw new HttpError(400, 'Kapasitas harus bilangan bulat 1-50');

  let area = null;
  if (b.area !== undefined && b.area !== null) {
    if (typeof b.area !== 'string') throw new HttpError(400, 'Area tidak valid');
    area = b.area.trim() || null;
    if (area && area.length > 30) throw new HttpError(400, 'Area maksimal 30 karakter');
  }
  return { code, capacity, area };
}

const TABLE_FIELDS = 'id, code, capacity, area, is_active';

async function loadTable(conn, id) {
  const [rows] = await conn.query(`SELECT ${TABLE_FIELDS} FROM restaurant_tables WHERE id = ?`, [id]);
  return rows[0] || null;
}

// Table codes are unique (case-insensitive), inactive tables included
async function assertTableCodeFree(conn, code, exceptId = null) {
  const [rows] = await conn.query(
    'SELECT code, is_active FROM restaurant_tables WHERE LOWER(code) = LOWER(?) AND id <> ? LIMIT 1',
    [code, exceptId || 0]
  );
  if (rows.length === 0) return;
  throw new HttpError(409, rows[0].is_active
    ? `Kode meja ${rows[0].code} sudah dipakai`
    : `Kode meja ${rows[0].code} sudah dipakai meja nonaktif. Aktifkan kembali meja itu.`);
}

// Why a table can not be deactivated right now (null = free): active order, waiting reservation, or a seated guest
// who has not ordered yet. Callers run it inside the transaction that holds the table row lock.
async function tableBusyReason(conn, tableId, code) {
  const [orders] = await conn.query(
    'SELECT order_no FROM orders WHERE table_id = ? AND status IN (?) LIMIT 1', [tableId, ACTIVE_ORDER_STATUSES]
  );
  if (orders.length > 0) {
    return `Meja ${code} masih dipakai pesanan ${orders[0].order_no}. Selesaikan atau batalkan pesanan itu dulu.`;
  }
  const [waiting] = await conn.query(
    `SELECT customer_name, DATE_FORMAT(reserved_at, '%Y-%m-%d %H:%i') AS at
     FROM reservations WHERE table_id = ? AND status = 'menunggu' ORDER BY reserved_at ASC LIMIT 1`,
    [tableId]
  );
  if (waiting.length > 0) {
    const when = waiting[0].at.slice(0, 10) === nowWib().slice(0, 10) ? waiting[0].at.slice(11) : waiting[0].at;
    return `Meja ${code} masih punya reservasi yang menunggu (${when} atas nama ${waiting[0].customer_name}). Batalkan atau pindahkan reservasinya dulu.`;
  }
  const [seated] = await conn.query(
    "SELECT customer_name FROM reservations WHERE table_id = ? AND status = 'datang' AND order_id IS NULL LIMIT 1",
    [tableId]
  );
  if (seated.length > 0) {
    return `Meja ${code} sedang ditempati tamu ${seated[0].customer_name} yang belum memesan. Buka pesanannya atau batalkan reservasi itu dulu.`;
  }
  return null;
}

// codes are UNIQUE: two simultaneous saves of the same code end here as ER_DUP_ENTRY
function sendTableError(res, err) {
  if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Kode meja sudah dipakai' });
  res.status(err.status || 500).json({ error: err.message });
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

// The login token (8 hours) carries { id, ..., sv }. Every request checks it against the database: the user must exist and
// be active, `sv` must equal users.session_version (raised on password reset/change and on deactivation), and the ROLE
// always comes from the database, so deactivating or demoting someone takes effect immediately. Tokens issued before
// session_version existed carry no `sv` and count as 0.
function signUserToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, name: user.name, role: user.role, sv: user.session_version },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token otentikasi tidak ditemukan' });
  }

  let decoded;
  try {
    decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Token tidak valid atau kedaluwarsa' });
  }

  try {
    const [rows] = await db.query(
      'SELECT id, name, username, role, is_active, session_version FROM users WHERE id = ?',
      [decoded.id]
    );
    const user = rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Akun tidak aktif, silakan hubungi admin' });
    }
    if ((Number(decoded.sv) || 0) !== user.session_version) {
      return res.status(401).json({ error: 'Sesi berakhir, silakan login kembali' });
    }
    req.user = { id: user.id, name: user.name, username: user.username, role: user.role };
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      'SELECT id, name, username, password_hash, role, is_active, session_version FROM users WHERE username = ?',
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

    const token = signUserToken(user);

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
app.use('/api', restrictKitchenRole); // the kitchen account (role dapur) gets the kitchen screen only

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
      await lockTable(conn, tableId, { requireActive: tableId === input.table_id }); // only the target must be active
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

// ---------- KELOLA MEJA (admin / supervisor) ----------

// GET /api/admin/tables -> every table, active or not; in_use_reason says why it can not be deactivated (or null)
app.get('/api/admin/tables', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT ${TABLE_FIELDS} FROM restaurant_tables ORDER BY id ASC`);
    for (const t of rows) t.in_use_reason = t.is_active ? await tableBusyReason(db, t.id, t.code) : null;
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/tables { code, capacity, area? }
app.post('/api/admin/tables', requireAdmin, async (req, res) => {
  try {
    const input = parseTableInput(req.body);
    await assertTableCodeFree(db, input.code);
    const [ins] = await db.query(
      'INSERT INTO restaurant_tables (code, capacity, area) VALUES (?, ?, ?)', [input.code, input.capacity, input.area]
    );
    res.status(201).json({ ok: true, table: await loadTable(db, ins.insertId) });
  } catch (err) {
    sendTableError(res, err);
  }
});

// PUT /api/admin/tables/:id { code, capacity, area } -> allowed while the table is in use (old orders and
// reservations show the new code because they read it from the table)
app.put('/api/admin/tables/:id', requireAdmin, async (req, res) => {
  try {
    const input = parseTableInput(req.body);
    const found = await loadTable(db, req.params.id);
    if (!found) throw new HttpError(404, 'Meja tidak ditemukan');
    await assertTableCodeFree(db, input.code, found.id);
    await db.query('UPDATE restaurant_tables SET code = ?, capacity = ?, area = ? WHERE id = ?',
      [input.code, input.capacity, input.area, found.id]);
    res.json({ ok: true, table: await loadTable(db, found.id) });
  } catch (err) {
    sendTableError(res, err);
  }
});

// PATCH /api/admin/tables/:id/active { is_active: boolean } -> "delete" = deactivate (history stays); idempotent.
// Deactivating is refused (409) while the table is in use.
app.patch('/api/admin/tables/:id/active', requireAdmin, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const isActive = req.body && req.body.is_active;
    if (typeof isActive !== 'boolean') throw new HttpError(400, 'is_active harus true atau false');

    await conn.beginTransaction();
    // the row lock is shared with order and reservation creation, so none of them can slip in while we check
    const [rows] = await conn.query('SELECT id, code, is_active FROM restaurant_tables WHERE id = ? FOR UPDATE', [req.params.id]);
    if (rows.length === 0) throw new HttpError(404, 'Meja tidak ditemukan');
    if (!isActive && rows[0].is_active) {
      const reason = await tableBusyReason(conn, rows[0].id, rows[0].code);
      if (reason) throw new HttpError(409, reason);
    }
    await conn.query('UPDATE restaurant_tables SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, rows[0].id]);
    await conn.commit();
    res.json({ ok: true, table: await loadTable(db, rows[0].id) });
  } catch (err) {
    await conn.rollback();
    sendTableError(res, err);
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
      WHERE t.is_active = 1
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
app.post('/api/orders', requireOrderHandler, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const { order_type = 'dine_in', table_id, platform, customer_name, items = [], discount_percent = 0 } = req.body;

    if (!items || items.length === 0) {
      throw new Error('Pesanan harus memiliki minimal 1 item');
    }

    // A dine-in table can only have one active order, and only an active table can take one
    if (order_type === 'dine_in' && table_id) {
      // same row lock "Atur Meja" takes before deactivating, so the two can never both succeed
      const [tbl] = await conn.query('SELECT code, is_active FROM restaurant_tables WHERE id = ? FOR UPDATE', [table_id]);
      if (tbl.length === 0) throw new Error('Meja tidak ditemukan');
      if (!tbl[0].is_active) throw new Error(`Meja ${tbl[0].code} tidak aktif`);

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

    // Snapshot products and calculate totals. The shared lock keeps an admin from changing the rates halfway through:
    // this order gets one whole pair (old or new) and keeps it for its whole life.
    const orderItemsData = await buildOrderItems(conn, items);
    const rates = effectiveRates(order_type, await loadChargeSettings(conn, ' FOR SHARE'));

    const totals = calculateOrderTotals(orderItemsData, discount_percent, rates);
    const orderNo = await generateOrderNo(conn);

    const [orderResult] = await conn.query(`
      INSERT INTO orders (
        order_no, order_type, table_id, platform, customer_name,
        cashier_id, shift_id, status, subtotal, discount_percent,
        discount_amount, tax_rate, tax_amount, service_rate, service_amount, total, opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'baru', ?, ?, ?, ?, ?, ?, ?, ?, NOW())
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
      totals.tax_rate,
      totals.tax_amount,
      totals.service_rate,
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
    res.status(err.status || 400).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/orders/:id { items: [{product_id, qty, note?}], discount_percent? }
// Replaces the items of an unpaid order in one transaction ("Simpan Pesanan" on an existing order).
app.put('/api/orders/:id', requireOrderHandler, async (req, res) => {
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
    const totals = calculateOrderTotals(orderItemsData, discount, orderRates(order));

    const sigBefore = await itemsSignature(conn, orderId);
    await conn.query('DELETE FROM order_items WHERE order_id = ?', [orderId]);
    for (const it of orderItemsData) {
      await conn.query(`
        INSERT INTO order_items (order_id, product_id, product_name, price, qty, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [orderId, it.product_id, it.product_name, it.price, it.qty, it.note]);
    }
    await flagKitchenIfItemsChanged(conn, orderId, sigBefore); // saving the same items again must not alarm the kitchen

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
app.post('/api/orders/:id/items', requireOrderHandler, async (req, res) => {
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
    const sigBefore = await itemsSignature(conn, orderId);
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
    await flagKitchenIfItemsChanged(conn, orderId, sigBefore);

    // Recalculate totals
    const [allItems] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
    const totals = calculateOrderTotals(allItems, order.discount_percent, orderRates(order));

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
app.patch('/api/orders/:id/items/:itemId', requireOrderHandler, async (req, res) => {
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

    const sigBefore = await itemsSignature(conn, orderId);
    if (qty <= 0) {
      await conn.query('DELETE FROM order_items WHERE id = ? AND order_id = ?', [itemId, orderId]);
    } else {
      await conn.query('UPDATE order_items SET qty = ? WHERE id = ? AND order_id = ?', [qty, itemId, orderId]);
    }
    await flagKitchenIfItemsChanged(conn, orderId, sigBefore);

    // Recalculate totals
    const [allItems] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
    const totals = calculateOrderTotals(allItems, order.discount_percent, orderRates(order));

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
app.patch('/api/orders/:id/status', requireOrderHandler, async (req, res) => {
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
    // The cashier's list and the kitchen screen stay in step: "Dapur" starts the ticket, "Siap Saji" finishes it
    // (a pending DIUBAH mark is dropped, the cashier has taken it over). Other statuses do not touch the kitchen.
    if (status === 'diproses') {
      await db.query("UPDATE orders SET kitchen_status = 'diproses', kitchen_status_at = NOW() WHERE id = ? AND kitchen_status = 'baru'", [id]);
    } else if (status === 'siap_saji') {
      await db.query("UPDATE orders SET kitchen_status = 'siap', kitchen_status_at = NOW(), kitchen_alert = NULL WHERE id = ? AND kitchen_status IN ('baru', 'diproses')", [id]);
    }
    res.json({ ok: true, id: Number(id), status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders/:id/pay { payments: [{ payment_method_id, amount, reference_no? }], discount_percent?, auth_pin? }
app.post('/api/orders/:id/pay', requireOrderHandler, async (req, res) => {
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
    const totals = calculateOrderTotals(items, finalDiscountPercent, orderRates(order));

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

    // A ticket the kitchen may be working on is marked DIBATALKAN until they acknowledge it (a held order was never shown)
    const kitchenAlert = (order.status !== 'hold' && ['baru', 'diproses'].includes(order.kitchen_status)) ? 'dibatalkan' : null;
    await conn.query(`
      UPDATE orders SET status = 'void', void_reason = ?, authorized_by = ?, kitchen_alert = ? WHERE id = ?
    `, [reason || 'Dibatalkan oleh kasir/supervisor', authorizedBy, kitchenAlert, orderId]);

    await conn.commit();
    res.json({ ok: true, message: 'Pesanan berhasil dibatalkan (void)' });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ---------- LAYAR DAPUR ----------

const KITCHEN_ROLE = 'dapur';
const KITCHEN_WINDOW_HOURS = 12;   // a ticket older than this never shows (an order nobody closed must not pile up)
const KITCHEN_READY_MINUTES = 15;  // how long a finished ticket stays in the "Baru siap" strip, where it can be taken back
const KITCHEN_WARN_MINUTES = 10;   // the ticket timer turns yellow ...
const KITCHEN_LATE_MINUTES = 20;   // ... and red
const KITCHEN_TRANSITIONS = { baru: ['diproses', 'siap'], diproses: ['siap'], siap: ['diproses'] };

// The kitchen account may only open the kitchen screen. Runs after authentication, so req.user.role comes from the database.
const KITCHEN_ALLOWED = [
  ['GET', /^\/me$/],
  ['POST', /^\/me\/password$/],
  ['GET', /^\/kitchen\/orders$/],
  ['PATCH', /^\/kitchen\/orders\/\d+$/],
  ['POST', /^\/kitchen\/orders\/\d+\/ack$/]
];
function restrictKitchenRole(req, res, next) {
  if (!req.user || req.user.role !== KITCHEN_ROLE) return next();
  if (KITCHEN_ALLOWED.some(([method, re]) => method === req.method && re.test(req.path))) return next();
  res.status(403).json({ error: 'Akun dapur hanya dapat memakai layar dapur' });
}
const requireKitchenRole = (req, res, next) => (req.user && req.user.role === KITCHEN_ROLE)
  ? next()
  : res.status(403).json({ error: 'Hanya akun dapur yang dapat mengubah status di layar dapur' });

// What an order's items look like, to tell a real change from saving the same items again
async function itemsSignature(conn, orderId) {
  const [rows] = await conn.query(
    "SELECT product_id, qty, COALESCE(note, '') AS note FROM order_items WHERE order_id = ? ORDER BY product_id, note, qty",
    [orderId]
  );
  return JSON.stringify(rows.map(r => [r.product_id, Number(r.qty), r.note]));
}

// The items of an order really changed: if the kitchen already started it (or finished it) they must notice. An order they
// have not started ('baru') just shows the new items. A finished ticket goes back to 'diproses' because there is something
// new to cook. MySQL runs the assignments left to right, so every CASE below still sees the OLD kitchen_status.
async function flagKitchenIfItemsChanged(conn, orderId, sigBefore) {
  if (sigBefore === await itemsSignature(conn, orderId)) return;
  await conn.query(`
    UPDATE orders SET
      kitchen_alert = CASE WHEN kitchen_status IN ('diproses', 'siap') THEN 'diubah' ELSE kitchen_alert END,
      kitchen_status_at = CASE WHEN kitchen_status = 'siap' THEN NOW() ELSE kitchen_status_at END,
      kitchen_status = CASE WHEN kitchen_status = 'siap' THEN 'diproses' ELSE kitchen_status END
    WHERE id = ? AND status <> 'void'
  `, [orderId]);
}

// GET /api/kitchen/orders — every role may look; nothing about money is in the answer
app.get('/api/kitchen/orders', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT o.id, o.order_no, o.order_type, o.platform, o.customer_name, o.kitchen_status, o.kitchen_alert,
             t.code AS table_code, DATE_FORMAT(o.opened_at, '%H:%i') AS opened_hhmm,
             TIMESTAMPDIFF(SECOND, o.opened_at, NOW()) AS age_seconds,
             TIMESTAMPDIFF(SECOND, o.kitchen_status_at, NOW()) AS status_age_seconds
      FROM orders o
      LEFT JOIN restaurant_tables t ON t.id = o.table_id
      WHERE o.opened_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        AND (
          (o.status NOT IN ('hold', 'void') AND o.kitchen_status IN ('baru', 'diproses'))
          OR (o.status = 'void' AND o.kitchen_alert = 'dibatalkan')
          OR (o.status <> 'void' AND o.kitchen_status = 'siap' AND o.kitchen_status_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE))
        )
      ORDER BY o.opened_at ASC, o.id ASC
    `, [KITCHEN_WINDOW_HOURS, KITCHEN_READY_MINUTES]);

    const itemsByOrder = new Map();
    if (rows.length > 0) {
      const [items] = await db.query(
        'SELECT order_id, product_name, qty, note FROM order_items WHERE order_id IN (?) ORDER BY id ASC',
        [rows.map(r => r.id)]
      );
      for (const it of items) {
        if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
        itemsByOrder.get(it.order_id).push({ name: it.product_name, qty: Number(it.qty), note: it.note || null });
      }
    }

    const tickets = rows.map(r => ({
      id: r.id,
      order_no: r.order_no,
      order_type: r.order_type,
      platform: r.platform,
      customer_name: r.customer_name,
      table_code: r.table_code,
      kitchen_status: r.kitchen_status,
      alert: r.kitchen_alert,
      opened_hhmm: r.opened_hhmm,
      age_seconds: Number(r.age_seconds),
      status_age_seconds: r.status_age_seconds === null ? null : Number(r.status_age_seconds),
      items: itemsByOrder.get(r.id) || []
    }));

    res.json({
      queue: tickets.filter(t => t.kitchen_status !== 'siap' || t.alert === 'dibatalkan'),
      ready: tickets.filter(t => t.kitchen_status === 'siap' && t.alert !== 'dibatalkan')
        .sort((a, b) => (a.status_age_seconds ?? 0) - (b.status_age_seconds ?? 0)),
      config: {
        warn_minutes: KITCHEN_WARN_MINUTES,
        late_minutes: KITCHEN_LATE_MINUTES,
        ready_minutes: KITCHEN_READY_MINUTES
      },
      can_update: req.user.role === KITCHEN_ROLE
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/kitchen/orders/:id { kitchen_status: 'diproses' | 'siap' } — only the kitchen account
// baru -> diproses (Mulai Masak), baru/diproses -> siap (Siap Saji), siap -> diproses (Batalkan, within the ready window).
// The cashier's own status follows only where it makes sense; belum_dibayar, selesai and hold are never touched.
app.patch('/api/kitchen/orders/:id', requireKitchenRole, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const target = req.body && req.body.kitchen_status;
    if (!['diproses', 'siap'].includes(target)) throw new HttpError(400, 'Status dapur harus diproses atau siap');
    const id = Number(req.params.id);

    await conn.beginTransaction();
    const [rows] = await conn.query(
      'SELECT id, status, kitchen_status, TIMESTAMPDIFF(MINUTE, kitchen_status_at, NOW()) AS since_minutes FROM orders WHERE id = ? FOR UPDATE',
      [id]
    );
    if (rows.length === 0) throw new HttpError(404, 'Pesanan tidak ditemukan');
    const o = rows[0];
    if (o.status === 'void') throw new HttpError(409, 'Pesanan sudah dibatalkan');
    if (o.status === 'hold') throw new HttpError(409, 'Pesanan sedang di-hold dan belum masuk ke dapur');

    if (o.kitchen_status === target) {
      await conn.commit();
      return res.json({ ok: true, id, kitchen_status: target, changed: false });
    }
    if (!KITCHEN_TRANSITIONS[o.kitchen_status].includes(target)) {
      throw new HttpError(409, 'Perpindahan status dapur ini tidak diizinkan');
    }
    if (o.kitchen_status === 'siap' && !(o.since_minutes !== null && Number(o.since_minutes) <= KITCHEN_READY_MINUTES)) {
      throw new HttpError(409, 'Batas waktu untuk membatalkan Siap Saji sudah lewat');
    }

    await conn.query('UPDATE orders SET kitchen_status = ?, kitchen_status_at = NOW(), kitchen_alert = NULL WHERE id = ?', [target, id]);
    if (target === 'diproses') {
      await conn.query("UPDATE orders SET status = 'diproses' WHERE id = ? AND status IN ('baru', 'siap_saji')", [id]);
    } else {
      await conn.query("UPDATE orders SET status = 'siap_saji' WHERE id = ? AND status IN ('baru', 'diproses')", [id]);
    }
    await conn.commit();
    res.json({ ok: true, id, kitchen_status: target, changed: true });
  } catch (err) {
    await conn.rollback();
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// POST /api/kitchen/orders/:id/ack — "Sudah dilihat": clears DIUBAH, and closes a DIBATALKAN ticket
app.post('/api/kitchen/orders/:id/ack', requireKitchenRole, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const id = Number(req.params.id);
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT id, kitchen_alert FROM orders WHERE id = ? FOR UPDATE', [id]);
    if (rows.length === 0) throw new HttpError(404, 'Pesanan tidak ditemukan');
    const alert = rows[0].kitchen_alert;
    if (alert === 'dibatalkan') {
      await conn.query("UPDATE orders SET kitchen_alert = NULL, kitchen_status = 'siap', kitchen_status_at = NOW() WHERE id = ?", [id]);
    } else if (alert === 'diubah') {
      await conn.query('UPDATE orders SET kitchen_alert = NULL WHERE id = ?', [id]);
    }
    await conn.commit();
    res.json({ ok: true, id, changed: !!alert });
  } catch (err) {
    await conn.rollback();
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ---------- SHIFT ----------

// GET /api/shifts/current
// An account that does not run shifts (admin, supervisor) gets "no shift, hidden" instead of an error, so the browser
// shows no shift card and no "shift belum dibuka" message for them.
app.get('/api/shifts/current', async (req, res) => {
  try {
    if (!canHandleOrders(req.user)) return res.json({ shift: null, hidden: true });

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
    // cash that really stays in the drawer: what customers handed over minus the change given back
    const cashInPayments = await shiftNetCash(db, shift.id);

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
app.post('/api/shifts/open', requireOrderHandler, async (req, res) => {
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
app.post('/api/shifts/cash-movement', requireOrderHandler, async (req, res) => {
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
app.post('/api/shifts/close', requireOrderHandler, async (req, res) => {
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

    // cash that really stays in the drawer: what customers handed over minus the change given back
    const cashInPayments = await shiftNetCash(db, shift.id);

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

// ---------- USER MANAGEMENT ----------

const USER_ROLES = ['kasir', 'supervisor', 'admin', 'dapur'];
const PIN_ROLES = ['supervisor', 'admin']; // only these roles have a PIN (it authorises discounts above 20% and voids)
const noPinMessage = (role) => (role === 'dapur' ? 'Akun dapur tidak memiliki PIN' : 'Kasir tidak memiliki PIN');
const BCRYPT_ROUNDS = 10;

const onlyAdmin = (message) => (req, res, next) => (req.user && req.user.role === 'admin')
  ? next()
  : res.status(403).json({ error: message });
const requireOnlyAdmin = onlyAdmin('Hanya admin yang dapat mengelola user');

function parseUsername(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9._-]{3,30}$/.test(v)) {
    throw new HttpError(400, 'Username 3-30 karakter: huruf, angka, titik, garis bawah, atau strip');
  }
  return v;
}

function parsePassword(value, label = 'Password') {
  if (typeof value !== 'string' || value === '') throw new HttpError(400, `${label} wajib diisi`);
  if (value.length < 8) throw new HttpError(400, `${label} minimal 8 karakter`);
  if (value.length > 72) throw new HttpError(400, `${label} maksimal 72 karakter`); // bcrypt only reads 72 bytes
  return value;
}

function parsePin(value) {
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) throw new HttpError(400, 'PIN harus 4 digit angka');
  return value;
}

// POST/PUT /api/admin/users body. pin is only accepted for supervisor/admin and is required when CREATING one.
function parseUserInput(body, { creating }) {
  const b = body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) throw new HttpError(400, 'Nama wajib diisi');
  if (name.length > 100) throw new HttpError(400, 'Nama maksimal 100 karakter');
  const username = parseUsername(b.username);
  if (!USER_ROLES.includes(b.role)) throw new HttpError(400, 'Peran harus kasir, supervisor, admin, atau dapur');

  const out = { name, username, role: b.role };
  if (creating) out.password = parsePassword(b.password);
  const hasPin = b.pin !== undefined && b.pin !== null && b.pin !== '';
  if (hasPin) {
    if (!PIN_ROLES.includes(b.role)) throw new HttpError(400, noPinMessage(b.role));
    out.pin = parsePin(b.pin);
  } else if (creating && PIN_ROLES.includes(b.role)) {
    throw new HttpError(400, 'PIN 4 digit wajib untuk supervisor dan admin');
  }
  return out;
}

// Two active supervisors/admins must never share a PIN (the PIN is how we know WHO authorised a void or a discount).
// Check and save run under one server-wide named lock, so two admins can not save the same PIN at the same moment.
async function withPinLock(fn) {
  const conn = await db.getConnection();
  try {
    const [[lock]] = await conn.query("SELECT GET_LOCK('kasir_user_pin', 5) AS ok");
    if (lock.ok !== 1) throw new HttpError(503, 'Server sedang sibuk, coba lagi sebentar');
    try {
      return await fn();
    } finally {
      await conn.query("SELECT RELEASE_LOCK('kasir_user_pin')");
    }
  } finally {
    conn.release();
  }
}

async function assertPinUnique(pin, exceptUserId = null) {
  const [rows] = await db.query(
    'SELECT pin_hash FROM users WHERE role IN ("supervisor", "admin") AND is_active = 1 AND pin_hash IS NOT NULL AND id <> ?',
    [exceptUserId || 0]
  );
  for (const r of rows) {
    if (await bcrypt.compare(pin, r.pin_hash)) {
      throw new HttpError(409, 'PIN ini sudah dipakai pengguna lain. Pilih PIN yang berbeda.');
    }
  }
}

const USER_SELECT = `
  SELECT u.id, u.name, u.username, u.role, u.is_active, (u.pin_hash IS NOT NULL) AS has_pin, u.created_at,
         EXISTS(SELECT 1 FROM shifts s WHERE s.cashier_id = u.id AND s.status = 'open') AS has_open_shift
  FROM users u`;

// API shape of a user: never any hash
const shapeUser = (r) => ({
  id: r.id, name: r.name, username: r.username, role: r.role, is_active: r.is_active,
  has_pin: !!r.has_pin, created_at: r.created_at, has_open_shift: !!r.has_open_shift
});

async function loadUser(conn, id) {
  const [rows] = await conn.query(`${USER_SELECT} WHERE u.id = ?`, [id]);
  return rows.length ? shapeUser(rows[0]) : null;
}

async function assertUsernameFree(conn, username, exceptId = null) {
  const [rows] = await conn.query('SELECT id FROM users WHERE username = ? AND id <> ? LIMIT 1', [username, exceptId || 0]);
  if (rows.length > 0) throw new HttpError(409, `Username ${username} sudah dipakai`);
}

function sendUserError(res, err) {
  if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username sudah dipakai' });
  res.status(err.status || 500).json({ error: err.message });
}

// Runs `fn(conn)` in a transaction that first locks every active admin row, then re-checks that the ACTING admin still is
// one. That serialises changes that could leave no admin at all (two admins demoting each other at the same moment).
async function adminTransaction(actorId, fn) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("SELECT id FROM users WHERE role = 'admin' AND is_active = 1 FOR UPDATE");
    const [actor] = await conn.query('SELECT role, is_active FROM users WHERE id = ? FOR UPDATE', [actorId]);
    if (actor.length === 0 || actor[0].role !== 'admin' || !actor[0].is_active) {
      throw new HttpError(403, 'Hanya admin yang dapat mengelola user');
    }
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function otherActiveAdmins(conn, exceptId) {
  const [[row]] = await conn.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1 AND id <> ?", [exceptId]);
  return row.n;
}

// ---- own account (every role) ----

// GET /api/me -> the current name and role (the client re-reads it to follow changes made by an admin)
app.get('/api/me', (req, res) => {
  res.json({ id: req.user.id, name: req.user.name, username: req.user.username, role: req.user.role });
});

async function verifyOwnPassword(userId, password) {
  const [rows] = await db.query('SELECT password_hash FROM users WHERE id = ?', [userId]);
  if (rows.length === 0 || typeof password !== 'string' || !(await bcrypt.compare(password, rows[0].password_hash))) {
    // 400, not 401: a mistyped password must not look like an expired session (the client logs out on 401)
    throw new HttpError(400, 'Password lama salah');
  }
}

// POST /api/me/password { current_password, new_password } -> { ok, token }: every other session of this user ends,
// the one making the request continues with the returned token
app.post('/api/me/password', async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    const next = parsePassword(new_password, 'Password baru');
    await verifyOwnPassword(req.user.id, current_password);
    if (next === current_password) throw new HttpError(400, 'Password baru harus berbeda dari password lama');

    await db.query('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?',
      [await bcrypt.hash(next, BCRYPT_ROUNDS), req.user.id]);
    const [[user]] = await db.query('SELECT id, name, username, role, session_version FROM users WHERE id = ?', [req.user.id]);
    res.json({ ok: true, token: signUserToken(user), user: { id: user.id, name: user.name, username: user.username, role: user.role } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/me/pin { current_password, pin } -> supervisor / admin only; sessions stay valid
app.post('/api/me/pin', async (req, res) => {
  try {
    if (!PIN_ROLES.includes(req.user.role)) throw new HttpError(403, noPinMessage(req.user.role));
    const { current_password, pin } = req.body || {};
    const newPin = parsePin(pin);
    await verifyOwnPassword(req.user.id, current_password);
    await withPinLock(async () => {
      await assertPinUnique(newPin, req.user.id);
      await db.query('UPDATE users SET pin_hash = ? WHERE id = ?', [await bcrypt.hash(newPin, BCRYPT_ROUNDS), req.user.id]);
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- admin only ----

// GET /api/admin/users
app.get('/api/admin/users', requireOnlyAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(`${USER_SELECT} ORDER BY u.id ASC`);
    res.json(rows.map(shapeUser));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users { name, username, role, password, pin? } (pin required for supervisor / admin)
app.post('/api/admin/users', requireOnlyAdmin, async (req, res) => {
  try {
    const input = parseUserInput(req.body, { creating: true });
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const create = async () => {
      await assertUsernameFree(db, input.username);
      if (input.pin) await assertPinUnique(input.pin);
      const pinHash = input.pin ? await bcrypt.hash(input.pin, BCRYPT_ROUNDS) : null;
      const [ins] = await db.query(
        'INSERT INTO users (name, username, password_hash, pin_hash, role) VALUES (?, ?, ?, ?, ?)',
        [input.name, input.username, passwordHash, pinHash, input.role]
      );
      return ins.insertId;
    };
    const id = input.pin ? await withPinLock(create) : await create();
    res.status(201).json({ ok: true, user: await loadUser(db, id) });
  } catch (err) {
    sendUserError(res, err);
  }
});

// PUT /api/admin/users/:id { name, username, role, pin? }
//   kasir -> supervisor/admin needs a PIN; -> kasir removes the PIN; supervisor <-> admin keeps it.
//   You can not change your own role; the last active admin can not be demoted.
app.put('/api/admin/users/:id', requireOnlyAdmin, async (req, res) => {
  try {
    const input = parseUserInput(req.body, { creating: false });
    const id = Number(req.params.id);
    const update = () => adminTransaction(req.user.id, async (conn) => {
      const [rows] = await conn.query('SELECT id, role, is_active, pin_hash FROM users WHERE id = ? FOR UPDATE', [id]);
      if (rows.length === 0) throw new HttpError(404, 'User tidak ditemukan');
      const cur = rows[0];

      if (input.role !== cur.role) {
        if (cur.id === req.user.id) throw new HttpError(409, 'Anda tidak bisa mengubah peran akun sendiri');
        if (cur.role === 'admin' && cur.is_active && (await otherActiveAdmins(conn, cur.id)) === 0) {
          throw new HttpError(409, 'Tidak bisa menurunkan admin aktif terakhir');
        }
      }

      let pinHash = cur.pin_hash;
      if (!PIN_ROLES.includes(input.role)) {
        pinHash = null; // kasir and dapur have no PIN
      } else if (!PIN_ROLES.includes(cur.role) && !input.pin) {
        throw new HttpError(400, 'PIN 4 digit wajib saat menjadikan user supervisor atau admin');
      }
      if (input.pin) {
        await assertPinUnique(input.pin, cur.id);
        pinHash = await bcrypt.hash(input.pin, BCRYPT_ROUNDS);
      }

      await assertUsernameFree(conn, input.username, cur.id);
      await conn.query('UPDATE users SET name = ?, username = ?, role = ?, pin_hash = ? WHERE id = ?',
        [input.name, input.username, input.role, pinHash, cur.id]);
      return loadUser(conn, cur.id);
    });
    const user = input.pin ? await withPinLock(update) : await update();
    res.json({ ok: true, user });
  } catch (err) {
    sendUserError(res, err);
  }
});

// POST /api/admin/users/:id/password { password } -> reset; ends every session of that user
app.post('/api/admin/users/:id/password', requireOnlyAdmin, async (req, res) => {
  try {
    const password = parsePassword(req.body && req.body.password);
    const id = Number(req.params.id);
    if (id === req.user.id) throw new HttpError(409, 'Gunakan Akun Saya untuk mengganti password sendiri');
    const [found] = await db.query('SELECT id FROM users WHERE id = ?', [id]);
    if (found.length === 0) throw new HttpError(404, 'User tidak ditemukan');
    await db.query('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?',
      [await bcrypt.hash(password, BCRYPT_ROUNDS), id]);
    res.json({ ok: true, user: await loadUser(db, id) });
  } catch (err) {
    sendUserError(res, err);
  }
});

// PUT /api/admin/users/:id/pin { pin } -> supervisor / admin only
app.put('/api/admin/users/:id/pin', requireOnlyAdmin, async (req, res) => {
  try {
    const pin = parsePin(req.body && req.body.pin);
    const id = Number(req.params.id);
    const [found] = await db.query('SELECT id, role FROM users WHERE id = ?', [id]);
    if (found.length === 0) throw new HttpError(404, 'User tidak ditemukan');
    if (!PIN_ROLES.includes(found[0].role)) throw new HttpError(400, noPinMessage(found[0].role));
    await withPinLock(async () => {
      await assertPinUnique(pin, id);
      await db.query('UPDATE users SET pin_hash = ? WHERE id = ?', [await bcrypt.hash(pin, BCRYPT_ROUNDS), id]);
    });
    res.json({ ok: true, user: await loadUser(db, id) });
  } catch (err) {
    sendUserError(res, err);
  }
});

// PATCH /api/admin/users/:id/active { is_active } -> "delete" = deactivate; idempotent.
//   Not yourself, not the last active admin, not a user with an open shift. Any change ends that user's sessions, and
//   re-activating a supervisor / admin clears the old PIN (its uniqueness can not be re-checked), so an admin sets a new one.
app.patch('/api/admin/users/:id/active', requireOnlyAdmin, async (req, res) => {
  try {
    const isActive = req.body && req.body.is_active;
    if (typeof isActive !== 'boolean') throw new HttpError(400, 'is_active harus true atau false');
    const id = Number(req.params.id);
    const user = await adminTransaction(req.user.id, async (conn) => {
      const [rows] = await conn.query('SELECT id, name, role, is_active FROM users WHERE id = ? FOR UPDATE', [id]);
      if (rows.length === 0) throw new HttpError(404, 'User tidak ditemukan');
      const cur = rows[0];

      if (!isActive && cur.is_active) {
        if (cur.id === req.user.id) throw new HttpError(409, 'Anda tidak bisa menonaktifkan akun sendiri');
        if (cur.role === 'admin' && (await otherActiveAdmins(conn, cur.id)) === 0) {
          throw new HttpError(409, 'Tidak bisa menonaktifkan admin aktif terakhir');
        }
        const [open] = await conn.query("SELECT id FROM shifts WHERE cashier_id = ? AND status = 'open' LIMIT 1", [cur.id]);
        if (open.length > 0) throw new HttpError(409, `${cur.name} masih punya shift yang terbuka. Tutup shift itu dulu.`);
      }

      if (isActive !== !!cur.is_active) {
        const clearPin = isActive && PIN_ROLES.includes(cur.role);
        await conn.query(
          `UPDATE users SET is_active = ?, session_version = session_version + 1${clearPin ? ', pin_hash = NULL' : ''} WHERE id = ?`,
          [isActive ? 1 : 0, cur.id]
        );
      }
      return loadUser(conn, cur.id);
    });
    res.json({ ok: true, user });
  } catch (err) {
    sendUserError(res, err);
  }
});

// ---------- KELOLA PAJAK & SERVICE ----------

// A rate typed by an admin: a number, or text with a dot as the decimal point; 0-100 with at most 2 decimals
function parseRate(value, label) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    throw new HttpError(400, `${label} wajib diisi`);
  }
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) n = Number(value.trim());
  else throw new HttpError(400, `${label} harus berupa angka`);
  if (!Number.isFinite(n)) throw new HttpError(400, `${label} harus berupa angka`);
  if (n < 0 || n > 100) throw new HttpError(400, `${label} harus antara 0 dan 100`);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-7) throw new HttpError(400, `${label} maksimal 2 angka di belakang koma`);
  return Math.round(n * 100) / 100;
}

// The tax / service rates for new orders. `lock` is ' FOR SHARE' (an order being created) or ' FOR UPDATE' (an admin
// changing them): a fixed SQL suffix, never user input.
async function loadChargeSettings(conn, lock = '') {
  const incomplete = () => new HttpError(500, 'Pengaturan pajak dan service belum lengkap. Jalankan "npm run db:migrate".');
  let rows;
  try {
    [rows] = await conn.query(
      `SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('tax_rate', 'service_rate')${lock}`
    );
  } catch (err) {
    if (err && err.code === 'ER_NO_SUCH_TABLE') throw incomplete();
    throw err;
  }
  const out = {};
  for (const r of rows) {
    const n = Number(r.setting_value);
    if (Number.isFinite(n) && n >= 0 && n <= 100) out[r.setting_key] = n;
  }
  if (out.tax_rate === undefined || out.service_rate === undefined) throw incomplete();
  return out;
}

// What GET / PUT answer: both rates plus who changed them last and when (null while they never were changed)
async function chargeSettingsView(conn) {
  const rates = await loadChargeSettings(conn);
  const [meta] = await conn.query(
    `SELECT s.updated_at, u.name AS updated_by_name
     FROM app_settings s JOIN users u ON u.id = s.updated_by
     WHERE s.setting_key IN ('tax_rate', 'service_rate')
     ORDER BY s.updated_at DESC LIMIT 1`
  );
  return {
    tax_rate: rates.tax_rate,
    service_rate: rates.service_rate,
    updated_at: meta.length ? meta[0].updated_at : null,
    updated_by_name: meta.length ? meta[0].updated_by_name : null
  };
}

function sendChargeError(res, err) {
  res.status(err.status || 500).json({ error: err.message });
}

// GET /api/settings/charges — every role (the cashier's order panel needs the rates)
app.get('/api/settings/charges', async (req, res) => {
  try {
    res.json(await chargeSettingsView(db));
  } catch (err) {
    sendChargeError(res, err);
  }
});

// PUT /api/admin/settings/charges { tax_rate, service_rate } — admin only. Applies to NEW orders; orders that already
// exist keep the rates they were created with.
app.put('/api/admin/settings/charges', onlyAdmin('Hanya admin yang dapat mengubah pajak dan service'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const body = req.body || {};
    const next = {
      tax_rate: parseRate(body.tax_rate, 'Pajak'),
      service_rate: parseRate(body.service_rate, 'Service')
    };

    await conn.beginTransaction();
    const cur = await loadChargeSettings(conn, ' FOR UPDATE');
    for (const key of ['tax_rate', 'service_rate']) {
      if (cur[key] !== next[key]) {
        await conn.query('UPDATE app_settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?',
          [String(next[key]), req.user.id, key]);
      }
    }
    await conn.commit();

    res.json({ ok: true, settings: await chargeSettingsView(db) });
  } catch (err) {
    await conn.rollback();
    sendChargeError(res, err);
  } finally {
    conn.release();
  }
});

// ---------- LAPORAN PENJUALAN ----------

const REPORT_MAX_DAYS = 366;
const ORDER_TYPE_LABEL = {
  dine_in: 'Dine-in', take_away: 'Take Away', delivery: 'Delivery',
  gofood: 'GoFood', grabfood: 'GrabFood', shopeefood: 'ShopeeFood'
};
const round2 = (n) => Math.round(n * 100) / 100;

// payments.amount is what the customer HANDED OVER (cash can be more than the bill). This splits it into the part that
// is really sales: the change given back (paid - order total) is taken out of cash first (latest cash payment first),
// then out of any other payment. payments: [{ id, method, amount }] -> Map(id -> net amount)
function netPaymentAmounts(payments, orderTotal) {
  const net = new Map(payments.map(p => [p.id, Number(p.amount)]));
  let change = round2(payments.reduce((s, p) => s + Number(p.amount), 0) - Number(orderTotal));
  if (change <= 0) return net;
  const order = [...payments].sort((a, b) => ((a.method === 'Tunai' ? 0 : 1) - (b.method === 'Tunai' ? 0 : 1)) || (b.id - a.id));
  for (const p of order) {
    if (change <= 0) break;
    const cut = Math.min(change, net.get(p.id));
    net.set(p.id, round2(net.get(p.id) - cut));
    change = round2(change - cut);
  }
  return net;
}

// Groups payment rows { id, order_id, amount, method, total } by order and returns their net amounts as an array of
// { method, net } (all rows of an order must be present so the change can be split)
function netPaymentRows(rows) {
  const byOrder = new Map();
  for (const r of rows) {
    if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, { total: r.total, payments: [] });
    byOrder.get(r.order_id).payments.push(r);
  }
  const out = [];
  for (const { total, payments } of byOrder.values()) {
    const net = netPaymentAmounts(payments, total);
    for (const p of payments) out.push({ method: p.method, method_id: p.method_id, net: net.get(p.id) });
  }
  return out;
}

// Cash that really stays in the drawer for one shift: Σ net cash payments (tendered minus change given)
async function shiftNetCash(conn, shiftId) {
  const [rows] = await conn.query(
    `SELECT p.id, p.order_id, p.amount, pm.id AS method_id, pm.name AS method, o.total
     FROM payments p
     JOIN payment_methods pm ON pm.id = p.payment_method_id
     JOIN orders o ON o.id = p.order_id
     WHERE p.shift_id = ?
     ORDER BY p.order_id, p.id`,
    [shiftId]
  );
  return round2(netPaymentRows(rows).filter(r => r.method === 'Tunai').reduce((s, r) => s + r.net, 0));
}

const addDaysStr = (dateStr, n) => new Date(Date.parse(dateStr) + n * 86400000).toISOString().slice(0, 10);

function parseReportDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, `${label} harus berformat YYYY-MM-DD`);
  }
  const [y, m, d] = value.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new HttpError(400, `${label} bukan tanggal yang valid`);
  }
  return value;
}

// from / to both or neither (= today); real dates; from <= to; at most 366 days; a kasir may only see today.
// Boundaries are plain text, so no DATE() is needed on the (WIB) DATETIME columns.
function parseReportPeriod(query, user, today) {
  let from;
  let to;
  if (query.from === undefined && query.to === undefined) {
    from = to = today;
  } else {
    if (query.from === undefined || query.to === undefined) throw new HttpError(400, 'Isi tanggal dari dan sampai sekaligus');
    from = parseReportDate(query.from, 'Tanggal dari');
    to = parseReportDate(query.to, 'Tanggal sampai');
  }
  // role first: whatever period a kasir asks for, anything but today is refused (403, not a length/order error)
  if (user.role === 'kasir' && !(from === today && to === today)) {
    throw new HttpError(403, 'Laporan periode lain hanya untuk admin atau supervisor');
  }
  if (from > to) throw new HttpError(400, 'Tanggal dari tidak boleh setelah tanggal sampai');
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (days > REPORT_MAX_DAYS) throw new HttpError(400, `Periode paling lama ${REPORT_MAX_DAYS} hari`);
  return { from, to, days, fromTs: `${from} 00:00:00`, toTs: `${addDaysStr(to, 1)} 00:00:00` };
}

// "Today" the way MySQL stores times (NOW()), so it always matches closed_at
async function mysqlToday() {
  const [[row]] = await db.query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today");
  return row.today;
}

// CSV for Excel (Indonesian locale uses ";"): quotes cells that need it and defuses spreadsheet formulas
function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[;"\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}
const toCsv = (rows) => `﻿${rows.map(r => r.map(csvCell).join(';')).join('\r\n')}\r\n`;

async function buildSalesReport(p, today) {
  const range = [p.fromTs, p.toTs];
  const SOLD = "o.status = 'selesai' AND o.closed_at >= ? AND o.closed_at < ?";

  const [[sum]] = await db.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(o.total), 0) AS total, COALESCE(SUM(o.subtotal), 0) AS subtotal,
            COALESCE(SUM(o.discount_amount), 0) AS discount, COALESCE(SUM(o.tax_amount), 0) AS tax,
            COALESCE(SUM(o.service_amount), 0) AS service
     FROM orders o WHERE ${SOLD}`, range);
  const [[voids]] = await db.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(o.total), 0) AS total FROM orders o
     WHERE o.status = 'void' AND COALESCE(o.closed_at, o.opened_at) >= ? AND COALESCE(o.closed_at, o.opened_at) < ?`, range);

  const [dailyRows] = await db.query(
    `SELECT DATE_FORMAT(o.closed_at, '%Y-%m-%d') AS d, COUNT(*) AS n, SUM(o.total) AS total
     FROM orders o WHERE ${SOLD} GROUP BY d`, range);
  const dailyMap = new Map(dailyRows.map(r => [r.d, r]));
  const daily = [];
  for (let i = 0; i < p.days; i++) {
    const date = addDaysStr(p.from, i);
    const r = dailyMap.get(date);
    daily.push({ date, transactions: r ? Number(r.n) : 0, total: r ? round2(Number(r.total)) : 0 });
  }

  const [typeRows] = await db.query(
    `SELECT o.order_type, o.platform, COUNT(*) AS n, SUM(o.total) AS total
     FROM orders o WHERE ${SOLD} GROUP BY o.order_type, o.platform ORDER BY total DESC`, range);
  const order_types = typeRows.map(r => {
    const key = r.order_type === 'delivery' && r.platform ? r.platform : r.order_type;
    return { key, label: ORDER_TYPE_LABEL[key] || key, transactions: Number(r.n), total: round2(Number(r.total)) };
  });

  // "Per kasir" = the cashier who took the payment (the shift the order was paid in), not who opened the order
  const [cashierRows] = await db.query(
    `SELECT u.id, u.name, COUNT(*) AS n, SUM(o.total) AS total
     FROM orders o
     LEFT JOIN shifts s ON s.id = o.shift_id
     JOIN users u ON u.id = COALESCE(s.cashier_id, o.cashier_id)
     WHERE ${SOLD} GROUP BY u.id, u.name ORDER BY total DESC`, range);
  const cashiers = cashierRows.map(r => ({ id: r.id, name: r.name, transactions: Number(r.n), total: round2(Number(r.total)) }));

  const [productRows] = await db.query(
    `SELECT oi.product_id, pr.name, c.name AS category, SUM(oi.qty) AS qty, SUM(oi.qty * oi.price) AS revenue,
            pr.stock, ${stockStatusSql('pr')} AS stock_status
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN products pr ON pr.id = oi.product_id
     JOIN categories c ON c.id = pr.category_id
     WHERE ${SOLD}
     GROUP BY oi.product_id, pr.name, c.name, pr.stock, pr.low_stock_threshold, pr.is_available
     ORDER BY qty DESC, revenue DESC, pr.name ASC`, range);
  const products = productRows.map(r => ({
    product_id: r.product_id, name: r.name, category: r.category, qty: Number(r.qty), revenue: round2(Number(r.revenue)),
    stock: r.stock, stock_status: r.stock_status
  }));

  const [hourRows] = await db.query(
    `SELECT HOUR(o.closed_at) AS h, COUNT(*) AS n, SUM(o.total) AS total
     FROM orders o WHERE ${SOLD} GROUP BY h ORDER BY h`, range);
  const hourly = hourRows.map(r => ({ hour: r.h, transactions: Number(r.n), total: round2(Number(r.total)) }));

  // Net sales per payment method (change taken out); every active method is listed, even with 0
  const [payRows] = await db.query(
    `SELECT pay.id, pay.order_id, pay.amount, pm.id AS method_id, pm.name AS method, o.total
     FROM payments pay
     JOIN payment_methods pm ON pm.id = pay.payment_method_id
     JOIN orders o ON o.id = pay.order_id
     WHERE ${SOLD} ORDER BY pay.order_id, pay.id`, range);
  const [methods] = await db.query('SELECT id, name FROM payment_methods WHERE is_active = 1 ORDER BY id');
  const byMethod = new Map(methods.map(m => [m.id, { name: m.name, total: 0 }]));
  for (const r of netPaymentRows(payRows)) {
    if (!byMethod.has(r.method_id)) byMethod.set(r.method_id, { name: r.method, total: 0 }); // inactive method with sales
    byMethod.get(r.method_id).total += r.net;
  }
  const payment_methods = [...byMethod.values()].map(m => ({ name: m.name, total: round2(m.total) }));

  const transactions = Number(sum.n);
  const salesTotal = round2(Number(sum.total));
  return {
    period: { from: p.from, to: p.to, days: p.days, today },
    summary: {
      sales_total: salesTotal,
      transactions,
      average: transactions ? Math.round(salesTotal / transactions) : 0,
      subtotal: round2(Number(sum.subtotal)),
      discount: round2(Number(sum.discount)),
      tax: round2(Number(sum.tax)),
      service: round2(Number(sum.service)),
      void_count: Number(voids.n),
      void_total: round2(Number(voids.total))
    },
    daily, payment_methods, order_types, cashiers, products, hourly
  };
}

// GET /api/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD (no params = today). A kasir may only ask for today.
app.get('/api/reports/sales', async (req, res) => {
  try {
    const today = await mysqlToday();
    const period = parseReportPeriod(req.query, req.user, today);
    res.json(await buildSalesReport(period, today));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/reports/export?type=transactions|products&from&to -> CSV download (admin / supervisor)
app.get('/api/reports/export', requireAdmin, async (req, res) => {
  try {
    const type = req.query.type;
    if (type !== 'transactions' && type !== 'products') throw new HttpError(400, 'Jenis ekspor harus transactions atau products');
    const today = await mysqlToday();
    const p = parseReportPeriod(req.query, req.user, today);

    let rows;
    let filename;
    if (type === 'products') {
      const report = await buildSalesReport(p, today);
      rows = [['Menu', 'Kategori', 'Jumlah Terjual', 'Omzet']];
      report.products.forEach(x => rows.push([x.name, x.category, x.qty, Math.round(x.revenue)]));
      filename = `penjualan-menu_${p.from}_${p.to}.csv`;
    } else {
      const [orders] = await db.query(
        `SELECT o.order_no, o.status, o.order_type, o.platform, t.code AS table_code, o.customer_name, u.name AS cashier,
                DATE_FORMAT(COALESCE(o.closed_at, o.opened_at), '%Y-%m-%d %H:%i:%s') AS at,
                o.subtotal, o.discount_amount, o.tax_amount, o.service_amount, o.total, o.void_reason,
                (SELECT GROUP_CONCAT(pm.name ORDER BY pay.id SEPARATOR ' + ')
                 FROM payments pay JOIN payment_methods pm ON pm.id = pay.payment_method_id
                 WHERE pay.order_id = o.id) AS methods
         FROM orders o
         LEFT JOIN restaurant_tables t ON t.id = o.table_id
         LEFT JOIN shifts s ON s.id = o.shift_id
         LEFT JOIN users u ON u.id = COALESCE(s.cashier_id, o.cashier_id)
         WHERE (o.status = 'selesai' AND o.closed_at >= ? AND o.closed_at < ?)
            OR (o.status = 'void' AND COALESCE(o.closed_at, o.opened_at) >= ? AND COALESCE(o.closed_at, o.opened_at) < ?)
         ORDER BY COALESCE(o.closed_at, o.opened_at) ASC, o.id ASC`,
        [p.fromTs, p.toTs, p.fromTs, p.toTs]
      );
      rows = [['No. Transaksi', 'Waktu', 'Status', 'Tipe', 'Meja/Platform', 'Pelanggan', 'Kasir', 'Metode Bayar',
        'Subtotal', 'Diskon', 'Pajak', 'Service', 'Total', 'Alasan Void']];
      orders.forEach(o => rows.push([
        o.order_no, o.at, o.status === 'void' ? 'Void' : 'Selesai', ORDER_TYPE_LABEL[o.order_type] || o.order_type,
        o.order_type === 'dine_in' ? (o.table_code || '') : (o.platform ? ORDER_TYPE_LABEL[o.platform] : ''),
        o.customer_name || '', o.cashier || '', o.methods || '',
        Math.round(o.subtotal), Math.round(o.discount_amount), Math.round(o.tax_amount), Math.round(o.service_amount),
        Math.round(o.total), o.void_reason || ''
      ]));
      filename = `transaksi_${p.from}_${p.to}.csv`;
    }

    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(toCsv(rows));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
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
