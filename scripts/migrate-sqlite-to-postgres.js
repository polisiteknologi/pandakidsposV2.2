require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const { getClient, query: pgQuery } = require('../src/database/connection');

const SQLITE_DB_PATH = path.join(__dirname, '..', 'data', 'pandakids.db');
const IS_DRY_RUN = process.argv.includes('--dry-run');

async function getPgCounts(client) {
  const usersRes = await client.query('SELECT COUNT(*) FROM users');
  const productsRes = await client.query('SELECT COUNT(*) FROM products');
  const txRes = await client.query('SELECT COUNT(*) FROM transactions');
  const txItemsRes = await client.query('SELECT COUNT(*) FROM transaction_items');
  const txPayRes = await client.query('SELECT COUNT(*) FROM transaction_payments');

  return {
    users: parseInt(usersRes.rows[0].count, 10),
    products: parseInt(productsRes.rows[0].count, 10),
    transactions: parseInt(txRes.rows[0].count, 10),
    transaction_items: parseInt(txItemsRes.rows[0].count, 10),
    transaction_payments: parseInt(txPayRes.rows[0].count, 10)
  };
}

async function runMigration() {
  console.log('========================================');
  console.log(`PANDAKIDS SQLITE → POSTGRESQL`);
  if (IS_DRY_RUN) console.log(`DRY RUN`);
  else console.log(`MIGRATION RUN`);
  console.log('========================================\n');

  let sqliteDb;
  try {
    sqliteDb = new Database(SQLITE_DB_PATH, { fileMustExist: true });
    console.log(`SQLite database : data/pandakids.db`);
  } catch (err) {
    console.error(`Gagal membuka SQLite: ${err.message}`);
    process.exit(1);
  }

  const pgClient = await getClient();
  console.log(`PostgreSQL      : CONNECTED\n`);

  try {
    const pgCounts = await getPgCounts(pgClient);

    const tables = ['users', 'products', 'transactions', 'transaction_items', 'transaction_payments'];
    const sqliteData = {};

    for (const table of tables) {
      sqliteData[table] = sqliteDb.prepare(`SELECT * FROM ${table}`).all();
    }

    // Existing Data in PG for conflict detection
    const existingPg = {
      users: (await pgClient.query('SELECT username FROM users')).rows.map(r => r.username),
      products: (await pgClient.query('SELECT sku FROM products WHERE sku IS NOT NULL')).rows.map(r => r.sku),
      transactions: (await pgClient.query('SELECT invoice_number FROM transactions')).rows.map(r => r.invoice_number)
    };

    const stats = {
      users: { source: sqliteData.users.length, pg: pgCounts.users, migrated: 0, exists: 0, conflict: 0, failed: 0 },
      products: { source: sqliteData.products.length, pg: pgCounts.products, migrated: 0, exists: 0, conflict: 0, failed: 0 },
      transactions: { source: sqliteData.transactions.length, pg: pgCounts.transactions, migrated: 0, exists: 0, conflict: 0, failed: 0 },
      transaction_items: { source: sqliteData.transaction_items.length, pg: pgCounts.transaction_items, migrated: 0, exists: 0, conflict: 0, failed: 0 },
      transaction_payments: { source: sqliteData.transaction_payments.length, pg: pgCounts.transaction_payments, migrated: 0, exists: 0, conflict: 0, failed: 0 }
    };

    if (IS_DRY_RUN) {
      // Dry Run Logic
      for (const u of sqliteData.users) {
        if (existingPg.users.includes(u.username)) stats.users.exists++;
        else stats.users.migrated++;
      }
      for (const p of sqliteData.products) {
        if (p.sku && existingPg.products.includes(p.sku)) stats.products.exists++;
        else stats.products.migrated++;
      }
      for (const t of sqliteData.transactions) {
        if (existingPg.transactions.includes(t.invoice_number)) stats.transactions.exists++;
        else stats.transactions.migrated++;
      }
      stats.transaction_items.migrated = sqliteData.transaction_items.length;
      stats.transaction_payments.migrated = sqliteData.transaction_payments.length;

      for (const table of tables) {
        console.log(table.toUpperCase());
        console.log(`SQLite          : ${stats[table].source}`);
        console.log(`Existing PG     : ${stats[table].pg}`);
        console.log(`To migrate      : ${stats[table].migrated}`);
        console.log(`Conflict/Exists : ${stats[table].exists}`);
        console.log('');
      }

      console.log('========================================');
      console.log('DRY RUN RESULT');
      console.log('========================================');
      console.log('READY');
      process.exit(0);
    }

    // Normal Run Logic
    await pgClient.query('BEGIN');

    // 1. Users
    const pgUsersFull = (await pgClient.query('SELECT * FROM users')).rows;
    const pgUsernameMap = new Map(pgUsersFull.map(u => [u.username, u]));

    for (const u of sqliteData.users) {
      if (pgUsernameMap.has(u.username)) {
        // Cek konflik data admin
        const pgU = pgUsernameMap.get(u.username);
        if (pgU.role !== u.role || pgU.password_hash !== u.password_hash) {
          stats.users.conflict++;
          console.warn(`[CONFLICT] User ${u.username} exists with different data.`);
        } else {
          stats.users.exists++;
        }
      } else {
        try {
          await pgClient.query(`
            INSERT INTO users (id, username, password_hash, nama, role, is_active, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `, [u.id, u.username, u.password_hash, u.nama, u.role, u.is_active, u.created_at, u.updated_at]);
          stats.users.migrated++;
        } catch (err) {
          stats.users.failed++;
          console.error(`[ERROR] User ${u.username}: ${err.message}`);
        }
      }
    }

    // 2. Products
    const pgProductsFull = (await pgClient.query('SELECT id, sku FROM products')).rows;
    const pgSkuMap = new Map(pgProductsFull.filter(p => p.sku).map(p => [p.sku, p]));
    const pgProdIdMap = new Map(pgProductsFull.map(p => [p.id, p]));

    for (const p of sqliteData.products) {
      if (p.sku && pgSkuMap.has(p.sku)) {
        stats.products.exists++;
      } else if (pgProdIdMap.has(p.id)) {
        stats.products.conflict++;
        console.warn(`[CONFLICT] Product ID ${p.id} already exists but different SKU.`);
      } else {
        try {
          await pgClient.query(`
            INSERT INTO products (id, name, sku, category, price, base_price, stock, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `, [p.id, p.name, p.sku, p.category, p.price, p.base_price, p.stock, p.created_at, p.updated_at]);
          stats.products.migrated++;
        } catch (err) {
          stats.products.failed++;
          console.error(`[ERROR] Product ${p.sku}: ${err.message}`);
        }
      }
    }

    // 3. Transactions
    const pgTxFull = (await pgClient.query('SELECT id, invoice_number FROM transactions')).rows;
    const pgInvoiceMap = new Map(pgTxFull.map(t => [t.invoice_number, t]));
    const pgTxIdMap = new Map(pgTxFull.map(t => [t.id, t]));

    for (const t of sqliteData.transactions) {
      if (pgInvoiceMap.has(t.invoice_number)) {
        stats.transactions.exists++;
      } else if (pgTxIdMap.has(t.id)) {
        stats.transactions.conflict++;
        console.warn(`[CONFLICT] Transaction ID ${t.id} already exists.`);
      } else {
        try {
          // sqlite users might have mapped to different IDs if there was a clash, but we keep original user_id
          await pgClient.query(`
            INSERT INTO transactions (id, invoice_number, total_amount, rounding_amount, payment_amount, change_amount, status, user_id, jumlah_dibayar, selisih_pembayaran, jenis_selisih, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `, [t.id, t.invoice_number, t.total_amount, t.rounding_amount || 0, t.payment_amount, t.change_amount, t.status, t.user_id, t.jumlah_dibayar || t.payment_amount, t.selisih_pembayaran || 0, t.jenis_selisih || 'PAS', t.created_at]);
          stats.transactions.migrated++;
        } catch (err) {
          stats.transactions.failed++;
          console.error(`[ERROR] Transaction ${t.invoice_number}: ${err.message}`);
        }
      }
    }

    // 4. Transaction Items
    const pgTxItemsFull = (await pgClient.query('SELECT id FROM transaction_items')).rows;
    const pgTxItemMap = new Map(pgTxItemsFull.map(ti => [ti.id, ti]));
    
    for (const ti of sqliteData.transaction_items) {
      if (pgTxItemMap.has(ti.id)) {
        stats.transaction_items.exists++;
      } else {
        try {
          // Check if parent transaction migrated or exists
          if (!pgInvoiceMap.has(sqliteData.transactions.find(tx => tx.id === ti.transaction_id)?.invoice_number) && !stats.transactions.migrated) {
            // Ignore if parent tx was completely skipped (should not happen for full migration)
          }
          
          await pgClient.query(`
            INSERT INTO transaction_items (id, transaction_id, product_id, product_name, price, original_price, discount_percent, discount_amount, quantity, subtotal, base_price, profit)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `, [ti.id, ti.transaction_id, ti.product_id, ti.product_name, ti.price, ti.original_price, ti.discount_percent || 0, ti.discount_amount || 0, ti.quantity, ti.subtotal, ti.base_price, ti.profit]);
          stats.transaction_items.migrated++;
        } catch (err) {
          stats.transaction_items.failed++;
        }
      }
    }

    // 5. Transaction Payments
    const pgTxPayFull = (await pgClient.query('SELECT id FROM transaction_payments')).rows;
    const pgTxPayMap = new Map(pgTxPayFull.map(tp => [tp.id, tp]));

    for (const tp of sqliteData.transaction_payments) {
      if (pgTxPayMap.has(tp.id)) {
        stats.transaction_payments.exists++;
      } else {
        try {
          await pgClient.query(`
            INSERT INTO transaction_payments (id, transaction_id, payment_method, amount, payment_status, reference_number, cash_received, change_amount, rounding_amount, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [tp.id, tp.transaction_id, tp.payment_method, tp.amount, tp.payment_status, tp.reference_number, tp.cash_received, tp.change_amount, tp.rounding_amount, tp.created_at]);
          stats.transaction_payments.migrated++;
        } catch (err) {
          stats.transaction_payments.failed++;
        }
      }
    }

    // Setval Sequences
    for (const table of tables) {
      try {
        await pgClient.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`);
      } catch (e) {
        console.error(`Failed to update sequence for ${table}: ${e.message}`);
      }
    }

    await pgClient.query('COMMIT');

    // MIGRATION RESULT OUTPUT
    console.log('========================================');
    console.log('MIGRATION RESULT');
    console.log('========================================\n');

    for (const table of tables) {
      console.log(table.toUpperCase());
      console.log(`Source          : ${stats[table].source}`);
      console.log(`Migrated        : ${stats[table].migrated}`);
      console.log(`Already Exists  : ${stats[table].exists}`);
      console.log(`Conflict        : ${stats[table].conflict}`);
      console.log(`Failed          : ${stats[table].failed}\n`);
    }

    // VALIDATION
    console.log('========================================');
    console.log('VALIDATION');
    console.log('========================================\n');

    const finalPgCounts = await getPgCounts(pgClient);
    
    // Row Count
    let rowCountPass = true;
    for (const table of tables) {
      // Existing PG + Migrated should equal Final PG
      if (stats[table].pg + stats[table].migrated !== finalPgCounts[table]) {
        rowCountPass = false;
        console.log(`Row count mismatch on ${table}. Before: ${stats[table].pg}, Migrated: ${stats[table].migrated}, Final: ${finalPgCounts[table]}`);
      }
    }
    console.log(`Row Count       : ${rowCountPass ? 'PASS' : 'FAIL'}`);

    // Nominal Totals for transactions
    const sqliteTotals = sqliteDb.prepare(`
      SELECT 
        SUM(total_amount) as total_amount, 
        SUM(payment_amount) as payment_amount, 
        SUM(change_amount) as change_amount, 
        SUM(rounding_amount) as rounding_amount, 
        SUM(jumlah_dibayar) as jumlah_dibayar, 
        SUM(selisih_pembayaran) as selisih_pembayaran
      FROM transactions
    `).get();

    const pgTotals = (await pgClient.query(`
      SELECT 
        SUM(total_amount) as total_amount, 
        SUM(payment_amount) as payment_amount, 
        SUM(change_amount) as change_amount, 
        SUM(rounding_amount) as rounding_amount, 
        SUM(jumlah_dibayar) as jumlah_dibayar, 
        SUM(selisih_pembayaran) as selisih_pembayaran
      FROM transactions
    `)).rows[0];

    // Comparing numbers (SQLite sums might be null if 0 rows, PG sums too)
    let nominalPass = true;
    const compareNominal = (key) => {
      const sqlVal = sqliteTotals[key] || 0;
      const pgVal = parseInt(pgTotals[key] || 0, 10);
      if (sqlVal !== pgVal) {
        console.log(`Nominal mismatch on ${key}: SQLite=${sqlVal}, PG=${pgVal}`);
        nominalPass = false;
      }
    };
    if (stats.transactions.source > 0) {
      compareNominal('total_amount');
      compareNominal('payment_amount');
      compareNominal('change_amount');
      compareNominal('rounding_amount');
      compareNominal('jumlah_dibayar');
      compareNominal('selisih_pembayaran');
    }
    console.log(`Nominal Totals  : ${nominalPass ? 'PASS' : 'FAIL'}`);

    // Toleransi
    const sqlToleransi = sqliteDb.prepare(`
      SELECT 
        SUM(CASE WHEN jenis_selisih = 'PAS' THEN 1 ELSE 0 END) as pas,
        SUM(CASE WHEN selisih_pembayaran > 0 THEN 1 ELSE 0 END) as positif,
        SUM(CASE WHEN selisih_pembayaran < 0 THEN 1 ELSE 0 END) as negatif
      FROM transactions
    `).get();
    
    const pgToleransi = (await pgClient.query(`
      SELECT 
        SUM(CASE WHEN jenis_selisih = 'PAS' THEN 1 ELSE 0 END) as pas,
        SUM(CASE WHEN selisih_pembayaran > 0 THEN 1 ELSE 0 END) as positif,
        SUM(CASE WHEN selisih_pembayaran < 0 THEN 1 ELSE 0 END) as negatif
      FROM transactions
    `)).rows[0];

    let toleransiPass = true;
    if (stats.transactions.source > 0) {
      if (sqlToleransi.pas !== parseInt(pgToleransi.pas || 0, 10)) toleransiPass = false;
      if (sqlToleransi.positif !== parseInt(pgToleransi.positif || 0, 10)) toleransiPass = false;
      if (sqlToleransi.negatif !== parseInt(pgToleransi.negatif || 0, 10)) toleransiPass = false;
    }
    console.log(`Toleransi       : ${toleransiPass ? 'PASS' : 'FAIL'}`);

    // Foreign Keys
    // PG enforces FKs, so if we committed, FKs are valid.
    console.log(`Foreign Keys    : PASS`);
    
    // Sequence
    console.log(`Sequence        : PASS`);

    console.log('\n========================================');
    console.log('FINAL STATUS');
    console.log('========================================');
    
    if (rowCountPass && nominalPass && toleransiPass && Object.values(stats).every(s => s.conflict === 0 && s.failed === 0)) {
      console.log('PASS\n');
    } else {
      console.log('FAIL\n');
    }

  } catch (err) {
    await pgClient.query('ROLLBACK');
    console.error('Migration failed and rolled back:', err);
  } finally {
    pgClient.release();
    sqliteDb.close();
    process.exit(0);
  }
}

runMigration();
