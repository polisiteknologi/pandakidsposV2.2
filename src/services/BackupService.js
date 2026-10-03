const fs = require('fs');
const path = require('path');
const { getDb } = require('../database/connection');

class BackupService {
  static getBackupDir() {
    const dir = path.join(__dirname, '..', '..', 'data', 'backups');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  // Create a backup object
  static generateBackupData() {
    const db = getDb();
    
    // Metadata
    const metadata = {
      application_name: 'PandaKids POS',
      backup_version: 1,
      app_version: 'V2',
      schema_version: 1,
      created_at: new Date().toISOString()
    };

    // Fetch all tables data
    const users = db.prepare('SELECT * FROM users').all();
    const products = db.prepare('SELECT * FROM products').all();
    const transactions = db.prepare('SELECT * FROM transactions').all();
    const transaction_items = db.prepare('SELECT * FROM transaction_items').all();
    const transaction_payments = db.prepare('SELECT * FROM transaction_payments').all();

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

  static createManualBackup() {
    return JSON.stringify(this.generateBackupData());
  }

  static createAutoBackup(prefix = 'PreRestore') {
    try {
      const dataStr = JSON.stringify(this.generateBackupData());
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

  static restoreBackup(parsedData) {
    const db = getDb();
    const data = parsedData.data;
    
    const restoreTx = db.transaction(() => {
      // 1. Clear existing data
      // Disable foreign keys temporarily for clean wipe
      db.pragma('foreign_keys = OFF');
      db.prepare('DELETE FROM transaction_payments').run();
      db.prepare('DELETE FROM transaction_items').run();
      db.prepare('DELETE FROM transactions').run();
      db.prepare('DELETE FROM products').run();
      db.prepare('DELETE FROM users').run();

      // Reset sqlite sequence
      try {
        db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('transaction_payments', 'transaction_items', 'transactions', 'products', 'users')").run();
      } catch (e) {
        // Ignored if sqlite_sequence doesn't exist
      }

      // 2. Insert Users
      const insertUser = db.prepare(`
        INSERT INTO users (id, username, password_hash, nama, role, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      if (data.users) {
        for (const u of data.users) {
          insertUser.run(u.id, u.username, u.password_hash, u.nama, u.role, u.is_active, u.created_at, u.updated_at);
        }
      }

      // 3. Insert Products
      const insertProduct = db.prepare(`
        INSERT INTO products (id, name, sku, category, price, base_price, stock, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const p of data.products) {
        insertProduct.run(p.id, p.name, p.sku, p.category, p.price, p.base_price, p.stock, p.created_at, p.updated_at);
      }

      // 4. Insert Transactions
      const insertTx = db.prepare(`
        INSERT INTO transactions (id, invoice_number, total_amount, rounding_amount, payment_amount, change_amount, status, user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const t of data.transactions) {
        insertTx.run(t.id, t.invoice_number, t.total_amount, t.rounding_amount || 0, t.payment_amount, t.change_amount, t.status || 'paid', t.user_id || null, t.created_at);
      }

      // 5. Insert Transaction Items
      const insertItem = db.prepare(`
        INSERT INTO transaction_items (id, transaction_id, product_id, product_name, price, original_price, discount_percent, discount_amount, quantity, subtotal, base_price, profit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const ti of data.transaction_items) {
        insertItem.run(ti.id, ti.transaction_id, ti.product_id, ti.product_name, ti.price, ti.original_price || ti.price, ti.discount_percent || 0, ti.discount_amount || 0, ti.quantity, ti.subtotal, ti.base_price || 0, ti.profit || 0);
      }

      // 6. Insert Transaction Payments
      if (data.transaction_payments && data.transaction_payments.length > 0) {
        const insertPayment = db.prepare(`
          INSERT INTO transaction_payments (id, transaction_id, payment_method, amount, payment_status, reference_number, cash_received, change_amount, rounding_amount, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const tp of data.transaction_payments) {
          insertPayment.run(tp.id, tp.transaction_id, tp.payment_method, tp.amount, tp.payment_status || 'paid', tp.reference_number || null, tp.cash_received || null, tp.change_amount || 0, tp.rounding_amount || 0, tp.created_at);
        }
      }

      db.pragma('foreign_keys = ON');
      return true;
    });

    try {
      restoreTx();
      return true;
    } catch (err) {
      console.error('Restore transaction failed:', err);
      throw err;
    }
  }
}

module.exports = BackupService;
