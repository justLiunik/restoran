require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

// Dump awal menyimpan hash palsu ini sampai password/PIN diisi.
const PLACEHOLDER = 'GANTI_DENGAN_HASH_BCRYPT';

// Bawaan: hanya mengisi user yang password/PIN-nya MASIH placeholder, jadi password yang sudah diganti lewat aplikasi
// (Kelola User / Akun Saya) tidak ikut tertimpa. Untuk menimpa SEMUA user: npm run db:seed -- --all  (atau SEED_ALL=1).
const overwriteAll = process.argv.includes('--all') || process.env.SEED_ALL === '1';

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

    if (overwriteAll) {
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

      // End every existing login session (column exists after npm run db:migrate)
      try {
        await db.query('UPDATE users SET session_version = session_version + 1');
      } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
      }

      console.log('✅ Password dan PIN SEMUA user ditimpa (mode --all).');
    } else {
      const [pwRes] = await db.query(
        'UPDATE users SET password_hash = ? WHERE password_hash = ?',
        [passwordHash, PLACEHOLDER]
      );
      const [pinRes] = await db.query(
        'UPDATE users SET pin_hash = ? WHERE role IN ("supervisor", "admin") AND pin_hash = ?',
        [pinHash, PLACEHOLDER]
      );

      if (pwRes.affectedRows === 0 && pinRes.affectedRows === 0) {
        console.log('ℹ️ Tidak ada user yang perlu diisi: semua user sudah punya password dan PIN sungguhan.');
        console.log('   Untuk menimpa password dan PIN semua user, jalankan: npm run db:seed -- --all');
        return;
      }
      console.log(`✅ User hashes successfully seeded! (password: ${pwRes.affectedRows} user, PIN: ${pinRes.affectedRows} user; user lain tidak diubah)`);
    }

    if (!process.env.SEED_PASSWORD) {
      console.log(`ℹ️ Password (user yang diisi): ${password}`);
    }
    if (!process.env.SEED_PIN) {
      console.log(`ℹ️ PIN (supervisor/admin yang diisi): ${pin}`);
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
