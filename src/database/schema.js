const { getDb } = require('./connection');

function initializeDatabase() {
  const db = getDb();

  // Buat tabel products
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sku TEXT UNIQUE,
      category TEXT DEFAULT 'Umum',
      price INTEGER NOT NULL DEFAULT 0,
      base_price INTEGER NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  // Migration for V2: Add base_price to products if it doesn't exist
  try {
    const tableInfo = db.prepare("PRAGMA table_info(products)").all();
    const hasBasePrice = tableInfo.some(col => col.name === 'base_price');
    if (!hasBasePrice) {
      // Use existing price as base_price for older data
      db.exec("ALTER TABLE products ADD COLUMN base_price INTEGER NOT NULL DEFAULT 0");
      db.exec("UPDATE products SET base_price = price");
      console.log('✓ Migration: Added base_price column to products table');
    }
  } catch (err) {
    console.error('Migration error:', err);
  }

  // Buat tabel transactions
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT UNIQUE NOT NULL,
      total_amount INTEGER NOT NULL DEFAULT 0,
      payment_amount INTEGER NOT NULL DEFAULT 0,
      change_amount INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  // Buat tabel transaction_items
  db.exec(`
    CREATE TABLE IF NOT EXISTS transaction_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      price INTEGER NOT NULL,
      original_price INTEGER NOT NULL DEFAULT 0,
      discount_percent REAL NOT NULL DEFAULT 0,
      discount_amount INTEGER NOT NULL DEFAULT 0,
      quantity INTEGER NOT NULL DEFAULT 1,
      subtotal INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
    )
  `);

  // Migration for V2 Tahap 3: Add discount columns to transaction_items if they don't exist
  try {
    const tiInfo = db.prepare("PRAGMA table_info(transaction_items)").all();
    const hasDiscount = tiInfo.some(col => col.name === 'discount_percent');
    if (!hasDiscount) {
      db.exec("ALTER TABLE transaction_items ADD COLUMN original_price INTEGER NOT NULL DEFAULT 0");
      db.exec("ALTER TABLE transaction_items ADD COLUMN discount_percent REAL NOT NULL DEFAULT 0");
      db.exec("ALTER TABLE transaction_items ADD COLUMN discount_amount INTEGER NOT NULL DEFAULT 0");
      // Set original_price to price for old data
      db.exec("UPDATE transaction_items SET original_price = price");
      console.log('✓ Migration: Added discount columns to transaction_items table');
    }
  } catch (err) {
    console.error('Migration error transaction_items:', err);
  }

  // Migration for V2 Tahap 4: Add base_price and profit to transaction_items
  try {
    const tiInfo = db.prepare("PRAGMA table_info(transaction_items)").all();
    const hasBasePrice = tiInfo.some(col => col.name === 'base_price');
    if (!hasBasePrice) {
      db.exec("ALTER TABLE transaction_items ADD COLUMN base_price INTEGER NOT NULL DEFAULT 0");
      db.exec("ALTER TABLE transaction_items ADD COLUMN profit INTEGER NOT NULL DEFAULT 0");
      console.log('✓ Migration: Added base_price and profit columns to transaction_items table');
    }
  } catch (err) {
    console.error('Migration error transaction_items Tahap 4:', err);
  }

  // Migration for V2 Tahap 4 Revisi: Payments
  try {
    // Add status to transactions if it doesn't exist
    const tInfo = db.prepare("PRAGMA table_info(transactions)").all();
    const hasStatus = tInfo.some(col => col.name === 'status');
    if (!hasStatus) {
      db.exec("ALTER TABLE transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'paid'");
      console.log('✓ Migration: Added status column to transactions table');
    }

    // Add rounding_amount to transactions if it doesn't exist
    const hasRounding = tInfo.some(col => col.name === 'rounding_amount');
    if (!hasRounding) {
      db.exec("ALTER TABLE transactions ADD COLUMN rounding_amount INTEGER NOT NULL DEFAULT 0");
      console.log('✓ Migration: Added rounding_amount column to transactions table');
    }

    // Create transaction_payments table
    db.exec(`
      CREATE TABLE IF NOT EXISTS transaction_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER NOT NULL,
        payment_method TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        payment_status TEXT NOT NULL DEFAULT 'paid',
        reference_number TEXT,
        cash_received INTEGER,
        change_amount INTEGER,
        rounding_amount INTEGER,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
      )
    `);
    
    // Migrate existing payments
    db.exec(`
      INSERT INTO transaction_payments (transaction_id, payment_method, amount, cash_received, change_amount, rounding_amount)
      SELECT id, 'cash', total_amount, payment_amount, change_amount, 0
      FROM transactions
      WHERE id NOT IN (SELECT transaction_id FROM transaction_payments)
    `);

    db.exec("CREATE INDEX IF NOT EXISTS idx_transaction_payments_tx_id ON transaction_payments(transaction_id);");

    console.log('✓ Migration: Created transaction_payments table');
  } catch (err) {
    console.error('Migration error transaction_payments:', err);
  }

  // Migration for V2 Revisi Role: Users
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        nama TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('ADMIN', 'KASIR')),
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `);

    // Seed initial admin if no users exist
    const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get().count;
    if (userCount === 0) {
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync('admin123', 10);
      db.prepare("INSERT INTO users (username, password_hash, nama, role) VALUES (?, ?, ?, ?)").run(
        'admin', hash, 'Administrator', 'ADMIN'
      );
      console.log('✓ Migration: Seeded initial admin user (username: admin, password: admin123)');
    }

    // Add user_id to transactions if it doesn't exist
    const tInfo2 = db.prepare("PRAGMA table_info(transactions)").all();
    const hasUserId = tInfo2.some(col => col.name === 'user_id');
    if (!hasUserId) {
      db.exec("ALTER TABLE transactions ADD COLUMN user_id INTEGER DEFAULT NULL");
      // Add index
      db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);");
      console.log('✓ Migration: Added user_id column to transactions table');
    }
  } catch (err) {
    console.error('Migration error users:', err);
  }

  // Migration: Toleransi Pembayaran (gantikan pembulatan)
  try {
    const tInfo3 = db.prepare("PRAGMA table_info(transactions)").all();
    const hasJumlahDibayar = tInfo3.some(col => col.name === 'jumlah_dibayar');
    if (!hasJumlahDibayar) {
      // jumlah_dibayar: nominal aktual yang diterima dari pelanggan
      db.exec("ALTER TABLE transactions ADD COLUMN jumlah_dibayar INTEGER NOT NULL DEFAULT 0");
      // selisih_pembayaran: jumlah_dibayar - total_amount (bisa negatif)
      db.exec("ALTER TABLE transactions ADD COLUMN selisih_pembayaran INTEGER NOT NULL DEFAULT 0");
      // jenis_selisih: PAS | KEKURANGAN | KELEBIHAN
      db.exec("ALTER TABLE transactions ADD COLUMN jenis_selisih TEXT NOT NULL DEFAULT 'PAS'");
      // Migrasi data lama: set jumlah_dibayar = payment_amount (total yg sudah dibayar)
      db.exec("UPDATE transactions SET jumlah_dibayar = payment_amount, selisih_pembayaran = 0, jenis_selisih = 'PAS'");
      console.log('\u2713 Migration: Added payment tolerance columns (jumlah_dibayar, selisih_pembayaran, jenis_selisih) to transactions table');
    }
  } catch (err) {
    console.error('Migration error payment tolerance:', err);
  }

  // Index untuk performa query
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_invoice ON transactions(invoice_number);
    CREATE INDEX IF NOT EXISTS idx_transaction_items_transaction_id ON transaction_items(transaction_id);
    CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
  `);

  console.log('✓ Database berhasil diinisialisasi');
}

module.exports = { initializeDatabase };
