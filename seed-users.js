require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

// Kredensial diambil dari env (SEED_PASSWORD / SEED_PIN) jika diisi,
// jika tidak, dibuat acak dan ditampilkan sekali di console.
function generatePassword() {
  return crypto.randomBytes(9).toString('base64url'); // 12 karakter
}

function generatePin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

async function seedUsers() {
  try {
    const saltRounds = 10;
    const password = process.env.SEED_PASSWORD || generatePassword();
    const pin = process.env.SEED_PIN || generatePin();

    if (password.length < 8) {
      throw new Error('SEED_PASSWORD minimal 8 karakter');
    }
    if (!/^\d{4}$/.test(pin)) {
      throw new Error('SEED_PIN harus 4 digit angka');
    }

    const passwordHash = await bcrypt.hash(password, saltRounds);
    const pinHash = await bcrypt.hash(pin, saltRounds);

    // Update password for all users
    await db.query('UPDATE users SET password_hash = ?', [passwordHash]);

    // Update PIN for supervisor and admin
    await db.query(
      'UPDATE users SET pin_hash = ? WHERE role IN ("supervisor", "admin")',
      [pinHash]
    );

    // Ensure cashier users have no PIN
    await db.query(
      'UPDATE users SET pin_hash = NULL WHERE role = "kasir"'
    );

    console.log('✅ User hashes successfully seeded!');
    if (!process.env.SEED_PASSWORD) {
      console.log(`ℹ️ Password (semua user): ${password}`);
    }
    if (!process.env.SEED_PIN) {
      console.log(`ℹ️ PIN (supervisor/admin): ${pin}`);
    }
    console.log('⚠️ Simpan kredensial di atas sekarang; tidak akan ditampilkan lagi.');
  } catch (err) {
    console.error('❌ Failed seeding users:', err.message);
    process.exitCode = 1;
  } finally {
    await db.end?.();
    process.exit(process.exitCode || 0);
  }
}

seedUsers();
