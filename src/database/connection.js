'use strict';

const { Pool } = require('pg');

// ── Validasi DATABASE_URL ──────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('\n❌ DATABASE_URL is not configured.');
  console.error('   Tambahkan DATABASE_URL ke file .env Anda.\n');
  process.exit(1);
}

// ── Pool Connection PostgreSQL ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

// ── Query helper: menjalankan query dan mengembalikan rows ─────────────────
async function query(text, params) {
  return pool.query(text, params);
}

// ── getClient: mendapatkan client dari pool (untuk transaksi manual) ───────
async function getClient() {
  return pool.connect();
}

// ── testConnection: validasi koneksi PostgreSQL ───────────────────────────
async function testConnection() {
  let client;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    console.log('✓ PostgreSQL connection: OK');
    return true;
  } catch (err) {
    console.error('✗ PostgreSQL connection: FAILED');
    console.error('  Periksa DATABASE_URL di file .env Anda.');
    return false;
  } finally {
    if (client) client.release();
  }
}

// ── closeDb: menutup semua koneksi pool (dipanggil saat SIGINT/SIGTERM) ───
async function closeDb() {
  try {
    await pool.end();
    console.log('✓ Database pool telah ditutup.');
  } catch (err) {
    console.error('Error menutup database pool:', err.message);
  }
}

// ── Tangani error koneksi yang tidak terduga ──────────────────────────────
pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

module.exports = { query, getClient, testConnection, closeDb };
