// Menjalankan semua file di database/migrations/*.sql secara berurutan.
// File migrasi memakai CREATE TABLE IF NOT EXISTS, jadi aman dijalankan berulang kali.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function main() {
  const dir = path.join(__dirname, 'database', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'kasir_restoran',
    multipleStatements: true
  });

  try {
    for (const file of files) {
      await conn.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      console.log(`✅ ${file}`);
    }
    console.log(`Selesai: ${files.length} migrasi dijalankan.`);
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error('❌ Migrasi gagal:', err.message);
  process.exit(1);
});
