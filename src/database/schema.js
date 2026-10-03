'use strict';

const { query, testConnection } = require('./connection');

// ── initializeDatabase ─────────────────────────────────────────────────────
// Membuat semua tabel PostgreSQL jika belum ada.
// Menggunakan CREATE TABLE IF NOT EXISTS — aman dijalankan berulang kali.
// TIDAK melakukan DROP TABLE, TRUNCATE, atau memasukkan data dummy.
// ──────────────────────────────────────────────────────────────────────────
async function initializeDatabase() {
  // Uji koneksi dulu sebelum membuat tabel
  const connected = await testConnection();
  if (!connected) {
    throw new Error('Tidak dapat terhubung ke PostgreSQL. Pastikan DATABASE_URL sudah benar di .env');
  }

  // ── Tabel: users ──────────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id              SERIAL PRIMARY KEY,
      username        TEXT UNIQUE NOT NULL,
      password_hash   TEXT NOT NULL,
      nama            TEXT NOT NULL,
      role            TEXT NOT NULL CHECK (role IN ('ADMIN', 'KASIR')),
      is_active       INTEGER NOT NULL DEFAULT 1,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed admin awal jika tabel users masih kosong
  const userCount = await query('SELECT COUNT(*) AS count FROM users');
  if (parseInt(userCount.rows[0].count, 10) === 0) {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('admin123', 10);
    await query(
      `INSERT INTO users (username, password_hash, nama, role)
       VALUES ($1, $2, $3, $4)`,
      ['admin', hash, 'Administrator', 'ADMIN']
    );
    console.log('✓ Seed: Admin awal berhasil dibuat (username: admin, password: admin123)');
  }

  // ── Tabel: products ───────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      sku         TEXT UNIQUE,
      category    TEXT NOT NULL DEFAULT 'Umum',
      price       BIGINT NOT NULL DEFAULT 0,
      base_price  BIGINT NOT NULL DEFAULT 0,
      stock       INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── Tabel: transactions ───────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id                  SERIAL PRIMARY KEY,
      invoice_number      TEXT UNIQUE NOT NULL,
      total_amount        BIGINT NOT NULL DEFAULT 0,
      payment_amount      BIGINT NOT NULL DEFAULT 0,
      change_amount       BIGINT NOT NULL DEFAULT 0,
      status              TEXT NOT NULL DEFAULT 'paid',
      rounding_amount     BIGINT NOT NULL DEFAULT 0,
      user_id             INTEGER DEFAULT NULL,
      jumlah_dibayar      BIGINT NOT NULL DEFAULT 0,
      selisih_pembayaran  BIGINT NOT NULL DEFAULT 0,
      jenis_selisih       TEXT NOT NULL DEFAULT 'PAS',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_transactions_user
        FOREIGN KEY (user_id) REFERENCES users (id)
        ON DELETE SET NULL
    )
  `);

  // ── Tabel: transaction_items ──────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS transaction_items (
      id               SERIAL PRIMARY KEY,
      transaction_id   INTEGER NOT NULL,
      product_id       INTEGER NOT NULL,
      product_name     TEXT NOT NULL,
      price            BIGINT NOT NULL,
      original_price   BIGINT NOT NULL DEFAULT 0,
      discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
      discount_amount  BIGINT NOT NULL DEFAULT 0,
      quantity         INTEGER NOT NULL DEFAULT 1,
      subtotal         BIGINT NOT NULL DEFAULT 0,
      base_price       BIGINT NOT NULL DEFAULT 0,
      profit           BIGINT NOT NULL DEFAULT 0,
      CONSTRAINT fk_items_transaction
        FOREIGN KEY (transaction_id) REFERENCES transactions (id)
        ON DELETE CASCADE,
      CONSTRAINT fk_items_product
        FOREIGN KEY (product_id) REFERENCES products (id)
        ON DELETE RESTRICT
    )
  `);

  // ── Tabel: transaction_payments ───────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS transaction_payments (
      id               SERIAL PRIMARY KEY,
      transaction_id   INTEGER NOT NULL,
      payment_method   TEXT NOT NULL,
      amount           BIGINT NOT NULL DEFAULT 0,
      payment_status   TEXT NOT NULL DEFAULT 'paid',
      reference_number TEXT DEFAULT NULL,
      cash_received    BIGINT DEFAULT NULL,
      change_amount    BIGINT NOT NULL DEFAULT 0,
      rounding_amount  BIGINT NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_payments_transaction
        FOREIGN KEY (transaction_id) REFERENCES transactions (id)
        ON DELETE CASCADE
    )
  `);

  // ── Index untuk performa query ─────────────────────────────────────────────
  await query(`CREATE INDEX IF NOT EXISTS idx_transactions_created_at     ON transactions (created_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_transactions_invoice         ON transactions (invoice_number)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_transactions_user_id         ON transactions (user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_transaction_items_tx_id      ON transaction_items (transaction_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_transaction_payments_tx_id   ON transaction_payments (transaction_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_products_sku                 ON products (sku)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_products_category            ON products (category)`);

  console.log('✓ Database PostgreSQL berhasil diinisialisasi (semua tabel siap)');
}

module.exports = { initializeDatabase };
