require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');

async function seedUsers() {
  try {
    const saltRounds = 10;
    const defaultPassword = 'admin123';
    const defaultPin = '1234';

    const passwordHash = await bcrypt.hash(defaultPassword, saltRounds);
    const pinHash = await bcrypt.hash(defaultPin, saltRounds);

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
    console.log('ℹ️ Default password: "admin123" (all users)');
    console.log('ℹ️ Default PIN: "1234" (supervisor/admin)');
    console.log('⚠️ [DEV ONLY] Reminder: Ganti password & PIN default ini di production!');
  } catch (err) {
    console.error('❌ Failed seeding users:', err.message);
  } finally {
    process.exit(0);
  }
}

seedUsers();
