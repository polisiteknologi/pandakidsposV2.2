const { query, getClient } = require('../database/connection');

// Konstanta toleransi pembayaran — ubah di sini jika batas toleransi berubah di masa depan
const MAX_PAYMENT_TOLERANCE = 5000;

const Transaction = {
  // Helper to parse integers from BIGINT
  _parseTx(tx) {
    if (!tx) return null;
    return {
      ...tx,
      id: parseInt(tx.id, 10),
      total_amount: parseInt(tx.total_amount, 10),
      payment_amount: parseInt(tx.payment_amount, 10),
      change_amount: parseInt(tx.change_amount, 10),
      rounding_amount: parseInt(tx.rounding_amount, 10),
      jumlah_dibayar: parseInt(tx.jumlah_dibayar, 10),
      selisih_pembayaran: parseInt(tx.selisih_pembayaran, 10)
    };
  },
  
  _parseItem(ti) {
    if (!ti) return null;
    return {
      ...ti,
      id: parseInt(ti.id, 10),
      price: parseInt(ti.price, 10),
      original_price: parseInt(ti.original_price, 10),
      discount_amount: parseInt(ti.discount_amount, 10),
      quantity: parseInt(ti.quantity, 10),
      subtotal: parseInt(ti.subtotal, 10),
      base_price: parseInt(ti.base_price, 10),
      profit: parseInt(ti.profit, 10)
    };
  },

  _parsePayment(tp) {
    if (!tp) return null;
    return {
      ...tp,
      id: parseInt(tp.id, 10),
      amount: parseInt(tp.amount, 10),
      cash_received: tp.cash_received != null ? parseInt(tp.cash_received, 10) : null,
      change_amount: parseInt(tp.change_amount, 10),
      rounding_amount: parseInt(tp.rounding_amount, 10)
    };
  },

  // Generate nomor invoice: INV-YYYYMMDD-XXXX
  async generateInvoiceNumber(client) {
    const now = new Date();
    const dateStr = now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0');

    const prefix = `INV-${dateStr}-`;

    // Cari nomor terakhir hari ini
    const lastResult = await client.query(
      "SELECT invoice_number FROM transactions WHERE invoice_number LIKE $1 ORDER BY id DESC LIMIT 1",
      [prefix + '%']
    );
    const last = lastResult.rows[0];

    let seq = 1;
    if (last) {
      const lastSeq = parseInt(last.invoice_number.split('-').pop(), 10);
      seq = lastSeq + 1;
    }

    return prefix + String(seq).padStart(4, '0');
  },

  // Buat transaksi baru (dengan items)
  async create({ items, payment_amount, payments, user_id, jumlah_dibayar: rawJumlahDibayar }) {
    // Validasi diskon dan hitung total asli
    let original_total = 0;
    const processedItems = items.map(item => {
      const discount_percent = item.discount_percent ? parseFloat(item.discount_percent) : 0;
      
      if (discount_percent < 0 || discount_percent > 20) {
        throw new Error('Diskon maksimal adalah 20%.');
      }

      const original_price = item.price; // Harga jual dari frontend
      const discount_amount = Math.round(original_price * (discount_percent / 100));
      const final_price = original_price - discount_amount;
      const subtotal = final_price * item.quantity;
      
      original_total += subtotal;
      
      return {
        ...item,
        original_price,
        discount_percent,
        discount_amount,
        final_price,
        subtotal
      };
    });

    // ── SISTEM TOLERANSI PEMBAYARAN ──
    const payable_total = original_total; 
    const rounding_amount = 0;            

    const jumlahDibayar = parseInt(rawJumlahDibayar, 10) || 0;
    const selisih_pembayaran = jumlahDibayar - original_total;
    const absSelisih = Math.abs(selisih_pembayaran);

    if (absSelisih > MAX_PAYMENT_TOLERANCE) {
      const arah = selisih_pembayaran < 0 ? 'Kekurangan' : 'Kelebihan';
      throw new Error(
        `${arah} pembayaran Rp ${absSelisih.toLocaleString('id-ID')} melebihi batas toleransi Rp ${MAX_PAYMENT_TOLERANCE.toLocaleString('id-ID')}.`
      );
    }

    let jenis_selisih;
    if (selisih_pembayaran === 0) {
      jenis_selisih = 'PAS';
    } else if (selisih_pembayaran < 0) {
      jenis_selisih = 'KEKURANGAN';
    } else {
      jenis_selisih = 'KELEBIHAN';
    }

    let rawPayments = [];
    if (payments && Array.isArray(payments) && payments.length > 0) {
      rawPayments = payments;
    } else {
      if (payment_amount === undefined || isNaN(payment_amount)) {
        throw new Error('Nominal pembayaran tidak valid.');
      }
      rawPayments = [{
        method: 'cash',
        amount: Math.min(payable_total, payment_amount),
        cash_received: payment_amount,
        change_amount: payment_amount > payable_total ? payment_amount - payable_total : 0,
        rounding_amount: 0
      }];
    }

    let totalPaid = 0;
    let totalChange = 0;
    let processedPayments = [];
    let remainingNeeded = payable_total;

    for (const p of rawPayments) {
      let pMethod = p.method || 'cash';
      let pAmount = parseInt(p.amount, 10) || 0;
      let pCashReceived = p.cash_received !== undefined && p.cash_received !== null ? parseInt(p.cash_received, 10) : pAmount;
      let pChange = 0;

      if (pMethod === 'qris' || pMethod === 'transfer') {
        totalPaid += pAmount;
        remainingNeeded = Math.max(0, payable_total - totalPaid);
        processedPayments.push({
          method: pMethod,
          amount: pAmount,
          reference_number: p.reference_number || null,
          cash_received: null,
          change_amount: 0,
          rounding_amount: 0
        });
      } else if (pMethod === 'cash') {
        pAmount = pCashReceived; 
        pChange = 0;             
        totalPaid += pAmount;
        remainingNeeded = Math.max(0, payable_total - totalPaid);
        processedPayments.push({
          method: 'cash',
          amount: pAmount,
          reference_number: null,
          cash_received: pCashReceived,
          change_amount: 0,
          rounding_amount: 0
        });
      }
    }

    const finalPaymentAmount = jumlahDibayar > 0 ? jumlahDibayar : totalPaid;
    const status = 'paid'; 

    const client = await getClient();
    try {
      await client.query('BEGIN');
      
      const invoice_number = await this.generateInvoiceNumber(client);

      const txResult = await client.query(`
        INSERT INTO transactions (invoice_number, total_amount, rounding_amount, payment_amount, change_amount, status, user_id, jumlah_dibayar, selisih_pembayaran, jenis_selisih)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id
      `, [invoice_number, original_total, rounding_amount, finalPaymentAmount, totalChange, status, user_id || null, finalPaymentAmount, selisih_pembayaran, jenis_selisih]);

      const transactionId = txResult.rows[0].id;

      for (const p of processedPayments) {
        await client.query(`
          INSERT INTO transaction_payments (transaction_id, payment_method, amount, payment_status, reference_number, cash_received, change_amount, rounding_amount)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          transactionId,
          p.method,
          p.amount,
          'paid',
          p.reference_number || null,
          p.cash_received || null,
          p.change_amount || 0,
          p.rounding_amount || 0
        ]);
      }

      for (const item of processedItems) {
        const productRes = await client.query('SELECT base_price, stock FROM products WHERE id = $1', [item.product_id]);
        if (productRes.rows.length === 0) {
          throw new Error(`Produk tidak ditemukan: ${item.product_name}`);
        }
        const productData = productRes.rows[0];
        const base_price = parseInt(productData.base_price, 10) || 0;
        const current_stock = parseInt(productData.stock, 10);
        
        const profit_per_unit = item.final_price - base_price;
        const profit_item = profit_per_unit * item.quantity;

        await client.query(`
          INSERT INTO transaction_items (transaction_id, product_id, product_name, price, original_price, discount_percent, discount_amount, quantity, subtotal, base_price, profit)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          transactionId, 
          item.product_id, 
          item.product_name, 
          item.final_price, 
          item.original_price, 
          item.discount_percent, 
          item.discount_amount, 
          item.quantity, 
          item.subtotal,
          base_price,
          profit_item
        ]);

        if (current_stock < item.quantity) {
           throw new Error(`Stok tidak cukup untuk produk: ${item.product_name}`);
        }

        const stockResult = await client.query(`
          UPDATE products SET stock = stock - $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND stock >= $1
        `, [item.quantity, item.product_id]);

        if (stockResult.rowCount === 0) {
          throw new Error(`Gagal memotong stok untuk produk: ${item.product_name}`);
        }
      }

      await client.query('COMMIT');
      return await this.findById(transactionId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  // Ambil transaksi berdasarkan ID (dengan items)
  async findById(id) {
    const txRes = await query('SELECT * FROM transactions WHERE id = $1', [id]);
    if (txRes.rows.length === 0) return null;
    const transaction = this._parseTx(txRes.rows[0]);

    const itemsRes = await query('SELECT * FROM transaction_items WHERE transaction_id = $1', [id]);
    transaction.items = itemsRes.rows.map(ti => this._parseItem(ti));

    const payRes = await query('SELECT * FROM transaction_payments WHERE transaction_id = $1', [id]);
    transaction.payments = payRes.rows.map(tp => this._parsePayment(tp));
    
    transaction.original_total = transaction.total_amount;
    transaction.rounding_amount = transaction.rounding_amount || 0;
    transaction.payable_total = transaction.total_amount;
    transaction.remaining = 0; 

    transaction.jumlah_dibayar = transaction.jumlah_dibayar || transaction.payment_amount || 0;
    transaction.selisih_pembayaran = transaction.selisih_pembayaran || 0;
    transaction.jenis_selisih = transaction.jenis_selisih || 'PAS';

    transaction.total_profit = transaction.items.reduce((sum, item) => sum + (item.profit || 0), 0);

    return transaction;
  },

  // Ambil semua transaksi (tanpa items, untuk list)
  async findAll({ limit = 50, offset = 0 } = {}) {
    const result = await query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
    return result.rows.map(tx => this._parseTx(tx));
  },

  // Ambil transaksi terbaru (tanpa pagination)
  async getRecent(limit = 5) {
    const result = await query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT $1', [limit]);
    return result.rows.map(tx => this._parseTx(tx));
  },

  // Dapatkan statistik hari ini
  async getTodayStats() {
    const result = await query(`
      SELECT 
        COUNT(*) as count, 
        COALESCE(SUM(total_amount), 0) as total
      FROM transactions 
      WHERE DATE(created_at AT TIME ZONE 'Asia/Jakarta') = CURRENT_DATE
    `);
    
    return {
      count: parseInt(result.rows[0].count, 10),
      total: parseInt(result.rows[0].total, 10)
    };
  },

  // Dapatkan statistik berdasarkan periode (today, week, month, all)
  async getStatsByPeriod(period) {
    let dateCondition = '';
    
    if (period === 'today') {
      dateCondition = "DATE(created_at AT TIME ZONE 'Asia/Jakarta') = CURRENT_DATE";
    } else if (period === 'week') {
      dateCondition = "DATE(created_at AT TIME ZONE 'Asia/Jakarta') >= CURRENT_DATE - INTERVAL '7 days'";
    } else if (period === 'month') {
      dateCondition = "DATE(created_at AT TIME ZONE 'Asia/Jakarta') >= date_trunc('month', CURRENT_DATE)";
    } else {
      dateCondition = "1=1"; // all time
    }

    const result = await query(`
      SELECT 
        COUNT(*) as count, 
        COALESCE(SUM(total_amount), 0) as total
      FROM transactions 
      WHERE ${dateCondition}
    `);
    
    return {
      count: parseInt(result.rows[0].count, 10),
      total: parseInt(result.rows[0].total, 10)
    };
  },

  // Cari transaksi berdasarkan nomor invoice
  async search(searchQuery, { limit = 50, offset = 0 } = {}) {
    const likeQuery = `%${searchQuery}%`;
    const result = await query(
      'SELECT * FROM transactions WHERE invoice_number ILIKE $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [likeQuery, limit, offset]
    );
    return result.rows.map(tx => this._parseTx(tx));
  },

  // Laporan penjualan per tanggal
  async getSalesReport(dateFrom, dateTo) {
    const result = await query(`
      SELECT
        DATE(created_at AT TIME ZONE 'Asia/Jakarta') as tanggal,
        COUNT(*) as jumlah_transaksi,
        COALESCE(SUM(total_amount), 0) as total_penjualan,
        COALESCE(SUM(CASE WHEN jenis_selisih != 'PAS' AND ABS(selisih_pembayaran) <= 5000 THEN 1 ELSE 0 END), 0) as tol_count,
        COALESCE(SUM(CASE WHEN jenis_selisih = 'KEKURANGAN' AND ABS(selisih_pembayaran) <= 5000 THEN ABS(selisih_pembayaran) ELSE 0 END), 0) as tol_kurang,
        COALESCE(SUM(CASE WHEN jenis_selisih = 'KELEBIHAN' AND ABS(selisih_pembayaran) <= 5000 THEN selisih_pembayaran ELSE 0 END), 0) as tol_lebih
      FROM transactions
      WHERE DATE(created_at AT TIME ZONE 'Asia/Jakarta') BETWEEN $1::DATE AND $2::DATE
      GROUP BY DATE(created_at AT TIME ZONE 'Asia/Jakarta')
      ORDER BY tanggal DESC
    `, [dateFrom, dateTo]);
    
    return result.rows.map(r => ({
      tanggal: r.tanggal,
      jumlah_transaksi: parseInt(r.jumlah_transaksi, 10),
      total_penjualan: parseInt(r.total_penjualan, 10),
      tol_count: parseInt(r.tol_count, 10),
      tol_kurang: parseInt(r.tol_kurang, 10),
      tol_lebih: parseInt(r.tol_lebih, 10)
    }));
  },

  // Laporan Bulanan (Ringkasan dan Detail)
  async getMonthlyReport(year, month) {
    const paddedMonth = String(month).padStart(2, '0');
    const startOfMonth = `${year}-${paddedMonth}-01 00:00:00`;
    
    const endOfMonthResult = await query("SELECT ($1::timestamp + INTERVAL '1 month' - INTERVAL '1 second') as eom", [startOfMonth]);
    const endOfMonth = endOfMonthResult.rows[0].eom;

    const summaryRes = await query(`
      SELECT 
        COUNT(DISTINCT t.id) as jumlah_transaksi,
        COALESCE(SUM(ti.quantity), 0) as jumlah_produk_terjual,
        COALESCE(SUM(ti.base_price * ti.quantity), 0) as total_harga_modal,
        COALESCE(SUM(ti.subtotal), 0) as total_penjualan,
        COALESCE(SUM(ti.discount_amount * ti.quantity), 0) as total_diskon,
        COALESCE(SUM(ti.profit), 0) as total_laba
      FROM transactions t
      LEFT JOIN transaction_items ti ON t.id = ti.transaction_id
      WHERE t.created_at BETWEEN $1 AND $2
    `, [startOfMonth, endOfMonth]);

    const tolSummaryRes = await query(`
      SELECT
        COALESCE(SUM(CASE WHEN jenis_selisih != 'PAS' AND ABS(selisih_pembayaran) <= 5000 THEN 1 ELSE 0 END), 0) as tol_count,
        COALESCE(SUM(CASE WHEN jenis_selisih = 'KEKURANGAN' AND ABS(selisih_pembayaran) <= 5000 THEN ABS(selisih_pembayaran) ELSE 0 END), 0) as tol_kurang,
        COALESCE(SUM(CASE WHEN jenis_selisih = 'KELEBIHAN' AND ABS(selisih_pembayaran) <= 5000 THEN selisih_pembayaran ELSE 0 END), 0) as tol_lebih
      FROM transactions
      WHERE created_at BETWEEN $1 AND $2
    `, [startOfMonth, endOfMonth]);

    const summary = {
      jumlah_transaksi: parseInt(summaryRes.rows[0].jumlah_transaksi, 10),
      jumlah_produk_terjual: parseInt(summaryRes.rows[0].jumlah_produk_terjual, 10),
      total_harga_modal: parseInt(summaryRes.rows[0].total_harga_modal, 10),
      total_penjualan: parseInt(summaryRes.rows[0].total_penjualan, 10),
      total_diskon: parseInt(summaryRes.rows[0].total_diskon, 10),
      total_laba: parseInt(summaryRes.rows[0].total_laba, 10),
      tol_count: parseInt(tolSummaryRes.rows[0].tol_count, 10),
      tol_kurang: parseInt(tolSummaryRes.rows[0].tol_kurang, 10),
      tol_lebih: parseInt(tolSummaryRes.rows[0].tol_lebih, 10)
    };

    const detailsRes = await query(`
      SELECT 
        t.invoice_number,
        t.created_at as tanggal,
        p.sku as kode_produk,
        ti.product_name,
        ti.quantity,
        ti.base_price as harga_modal,
        ti.original_price as harga_jual,
        ti.discount_percent as diskon_persen,
        ti.discount_amount as nilai_diskon,
        ti.price as harga_setelah_diskon,
        ti.subtotal,
        (ti.price - ti.base_price) as laba_per_unit,
        ti.profit as laba_item
      FROM transactions t
      JOIN transaction_items ti ON t.id = ti.transaction_id
      LEFT JOIN products p ON ti.product_id = p.id
      WHERE t.created_at BETWEEN $1 AND $2
      ORDER BY t.created_at DESC, t.invoice_number
    `, [startOfMonth, endOfMonth]);

    const details = detailsRes.rows.map(row => ({
      ...row,
      quantity: parseInt(row.quantity, 10),
      harga_modal: parseInt(row.harga_modal, 10),
      harga_jual: parseInt(row.harga_jual, 10),
      nilai_diskon: parseInt(row.nilai_diskon, 10),
      harga_setelah_diskon: parseInt(row.harga_setelah_diskon, 10),
      subtotal: parseInt(row.subtotal, 10),
      laba_per_unit: parseInt(row.laba_per_unit, 10),
      laba_item: parseInt(row.laba_item, 10)
    }));

    const paymentSummaryRes = await query(`
      SELECT 
        tp.payment_method,
        COALESCE(SUM(tp.amount), 0) as total_amount
      FROM transaction_payments tp
      JOIN transactions t ON tp.transaction_id = t.id
      WHERE t.created_at BETWEEN $1 AND $2
      GROUP BY tp.payment_method
    `, [startOfMonth, endOfMonth]);
    
    const paymentSummary = paymentSummaryRes.rows.map(row => ({
      payment_method: row.payment_method,
      total_amount: parseInt(row.total_amount, 10)
    }));

    return { summary, details, paymentSummary };
  },

  // Hapus satu transaksi
  async delete(id) {
    const BackupService = require('../services/BackupService');
    await BackupService.createAutoBackup('PreDelete');

    const client = await getClient();
    try {
      await client.query('BEGIN');
      
      const txDetail = await this.findById(id);
      if (!txDetail) throw new Error('Transaksi tidak ditemukan');
      
      for (const item of txDetail.items) {
        const productRes = await client.query('SELECT id FROM products WHERE id = $1', [item.product_id]);
        if (productRes.rows.length === 0) {
          throw new Error(`Produk dengan ID ${item.product_id} (${item.product_name}) tidak ditemukan. Penghapusan dibatalkan demi menjaga integritas data.`);
        }
        await client.query(`
          UPDATE products SET stock = stock + $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
        `, [item.quantity, item.product_id]);
      }
      
      await client.query('DELETE FROM transactions WHERE id = $1', [id]);
      
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // Hapus transaksi berdasarkan periode
  async deleteByPeriod(dateFrom, dateTo) {
    const BackupService = require('../services/BackupService');
    await BackupService.createAutoBackup('PreDelete');

    const client = await getClient();
    try {
      await client.query('BEGIN');
      
      const transactionsRes = await client.query(`
        SELECT id FROM transactions WHERE DATE(created_at AT TIME ZONE 'Asia/Jakarta') BETWEEN $1::DATE AND $2::DATE
      `, [dateFrom, dateTo]);
      
      const transactions = transactionsRes.rows;

      for (const t of transactions) {
        const txDetail = await this.findById(t.id);
        if (txDetail) {
          for (const item of txDetail.items) {
            const productRes = await client.query('SELECT id FROM products WHERE id = $1', [item.product_id]);
            if (productRes.rows.length === 0) {
              throw new Error(`Produk dengan ID ${item.product_id} (${item.product_name}) pada transaksi ${txDetail.invoice_number} tidak ditemukan. Penghapusan dibatalkan.`);
            }
            await client.query(`
              UPDATE products SET stock = stock + $1, updated_at = CURRENT_TIMESTAMP
              WHERE id = $2
            `, [item.quantity, item.product_id]);
          }
          await client.query('DELETE FROM transactions WHERE id = $1', [t.id]);
        }
      }
      
      await client.query('COMMIT');
      return transactions.length;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
};

module.exports = Transaction;
