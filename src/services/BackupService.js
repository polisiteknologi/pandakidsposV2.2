const fs = require('fs');
const path = require('path');
const os = require('os');
const { query, getClient } = require('../database/connection');

class BackupService {
  static getBackupDir() {
    // Gunakan temporary directory OS agar compatible dengan Vercel/Serverless
    const dir = path.join(os.tmpdir(), 'pandakids_backups');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  // Create a backup object
  static async generateBackupData() {
    // Metadata
    const metadata = {
      application_name: 'PandaKids POS',
      backup_version: 1,
      app_version: 'V2',
      schema_version: 2, // 2 for PostgreSQL
      created_at: new Date().toISOString()
    };

    // Fetch all tables data
    const users = (await query('SELECT * FROM users')).rows;
    const products = (await query('SELECT * FROM products')).rows;
    const transactions = (await query('SELECT * FROM transactions')).rows;
    const transaction_items = (await query('SELECT * FROM transaction_items')).rows;
    const transaction_payments = (await query('SELECT * FROM transaction_payments')).rows;

    return {
      metadata,
      data: {
        users,
        products,
        transactions,
        transaction_items,
        transaction_payments
      }
    };
  }

  static async createManualBackup() {
    const data = await this.generateBackupData();
    return JSON.stringify(data);
  }

  static async createAutoBackup(prefix = 'PreRestore') {
    try {
      const backupData = await this.generateBackupData();
      const dataStr = JSON.stringify(backupData);
      const dateStr = new Date().toISOString().replace(/T/, '_').replace(/:/g, '').split('.')[0];
      const filename = `PandaKids_${prefix}_Backup_${dateStr}.pandabackup`;
      const filepath = path.join(this.getBackupDir(), filename);
      fs.writeFileSync(filepath, dataStr, 'utf-8');
      return filename;
    } catch (err) {
      console.error('Auto backup failed:', err);
      return null;
    }
  }

  static validateBackup(fileContent) {
    try {
      const parsed = JSON.parse(fileContent);
      
      if (!parsed.metadata || parsed.metadata.application_name !== 'PandaKids POS') {
        throw new Error('File bukan backup PandaKids POS.');
      }
      
      if (!parsed.data || !parsed.data.products || !parsed.data.transactions) {
        throw new Error('Struktur data backup tidak lengkap.');
      }

      return {
        isValid: true,
        summary: {
          created_at: parsed.metadata.created_at,
          app_version: parsed.metadata.app_version,
          products_count: parsed.data.products.length,
          transactions_count: parsed.data.transactions.length,
          users_count: (parsed.data.users || []).length
        },
        parsedData: parsed
      };
    } catch (error) {
      return {
        isValid: false,
        error: 'File backup tidak valid atau rusak.'
      };
    }
  }

  static async restoreBackup(parsedData) {
    const data = parsedData.data;
    const client = await getClient();
    
    try {
      await client.query('BEGIN');

      // 1. Clear existing data
      await client.query('TRUNCATE TABLE transaction_payments, transaction_items, transactions, products, users RESTART IDENTITY CASCADE');

      // 2. Insert Users
      if (data.users && data.users.length > 0) {
        for (const u of data.users) {
          await client.query(`
            INSERT INTO users (id, username, password_hash, nama, role, is_active, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `, [u.id, u.username, u.password_hash, u.nama, u.role, u.is_active, u.created_at, u.updated_at]);
        }
        // Update sequence
        await client.query(`SELECT setval('users_id_seq', (SELECT MAX(id) FROM users))`);
      }

      // 3. Insert Products
      if (data.products && data.products.length > 0) {
        for (const p of data.products) {
          await client.query(`
            INSERT INTO products (id, name, sku, category, price, base_price, stock, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `, [p.id, p.name, p.sku, p.category, p.price, p.base_price, p.stock, p.created_at, p.updated_at]);
        }
        await client.query(`SELECT setval('products_id_seq', (SELECT MAX(id) FROM products))`);
      }

      // 4. Insert Transactions
      if (data.transactions && data.transactions.length > 0) {
        for (const t of data.transactions) {
          await client.query(`
            INSERT INTO transactions (id, invoice_number, total_amount, rounding_amount, payment_amount, change_amount, status, user_id, jumlah_dibayar, selisih_pembayaran, jenis_selisih, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `, [t.id, t.invoice_number, t.total_amount, t.rounding_amount || 0, t.payment_amount, t.change_amount, t.status || 'paid', t.user_id || null, t.jumlah_dibayar || t.payment_amount, t.selisih_pembayaran || 0, t.jenis_selisih || 'PAS', t.created_at]);
        }
        await client.query(`SELECT setval('transactions_id_seq', (SELECT MAX(id) FROM transactions))`);
      }

      // 5. Insert Transaction Items
      if (data.transaction_items && data.transaction_items.length > 0) {
        for (const ti of data.transaction_items) {
          await client.query(`
            INSERT INTO transaction_items (id, transaction_id, product_id, product_name, price, original_price, discount_percent, discount_amount, quantity, subtotal, base_price, profit)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `, [ti.id, ti.transaction_id, ti.product_id, ti.product_name, ti.price, ti.original_price || ti.price, ti.discount_percent || 0, ti.discount_amount || 0, ti.quantity, ti.subtotal, ti.base_price || 0, ti.profit || 0]);
        }
        await client.query(`SELECT setval('transaction_items_id_seq', (SELECT MAX(id) FROM transaction_items))`);
      }

      // 6. Insert Transaction Payments
      if (data.transaction_payments && data.transaction_payments.length > 0) {
        for (const tp of data.transaction_payments) {
          await client.query(`
            INSERT INTO transaction_payments (id, transaction_id, payment_method, amount, payment_status, reference_number, cash_received, change_amount, rounding_amount, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [tp.id, tp.transaction_id, tp.payment_method, tp.amount, tp.payment_status || 'paid', tp.reference_number || null, tp.cash_received || null, tp.change_amount || 0, tp.rounding_amount || 0, tp.created_at]);
        }
        await client.query(`SELECT setval('transaction_payments_id_seq', (SELECT MAX(id) FROM transaction_payments))`);
      }

      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Restore transaction failed:', err);
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = BackupService;
