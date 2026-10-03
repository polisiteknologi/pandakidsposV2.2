const { getDb } = require('../database/connection');

// Konstanta toleransi pembayaran — ubah di sini jika batas toleransi berubah di masa depan
const MAX_PAYMENT_TOLERANCE = 5000;

const Transaction = {
  // Generate nomor invoice: INV-YYYYMMDD-XXXX
  generateInvoiceNumber() {
    const db = getDb();
    const now = new Date();
    const dateStr = now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0');

    const prefix = `INV-${dateStr}-`;

    // Cari nomor terakhir hari ini
    const last = db.prepare(
      "SELECT invoice_number FROM transactions WHERE invoice_number LIKE ? ORDER BY id DESC LIMIT 1"
    ).get(prefix + '%');

    let seq = 1;
    if (last) {
      const lastSeq = parseInt(last.invoice_number.split('-').pop(), 10);
      seq = lastSeq + 1;
    }

    return prefix + String(seq).padStart(4, '0');
  },

  // Buat transaksi baru (dengan items)
  create({ items, payment_amount, payments, user_id, jumlah_dibayar: rawJumlahDibayar }) {
    const db = getDb();

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

    // ── SISTEM TOLERANSI PEMBAYARAN (menggantikan pembulatan otomatis) ──
    // Tidak ada pembulatan. Total transaksi digunakan apa adanya.
    const payable_total = original_total; // total = apa adanya, tanpa pembulatan
    const rounding_amount = 0;            // pembulatan tidak digunakan lagi

    // jumlah_dibayar = nominal aktual yang diterima dari pelanggan
    // Dikirim dari frontend (form toleransi pada modal pembayaran)
    const jumlahDibayar = parseInt(rawJumlahDibayar, 10) || 0;

    // Hitung selisih: positif = lebih bayar, negatif = kurang bayar
    const selisih_pembayaran = jumlahDibayar - original_total;
    const absSelisih = Math.abs(selisih_pembayaran);

    // Validasi toleransi
    if (absSelisih > MAX_PAYMENT_TOLERANCE) {
      const arah = selisih_pembayaran < 0 ? 'Kekurangan' : 'Kelebihan';
      throw new Error(
        `${arah} pembayaran Rp ${absSelisih.toLocaleString('id-ID')} melebihi batas toleransi Rp ${MAX_PAYMENT_TOLERANCE.toLocaleString('id-ID')}.`
      );
    }

    // Tentukan jenis selisih
    let jenis_selisih;
    if (selisih_pembayaran === 0) {
      jenis_selisih = 'PAS';
    } else if (selisih_pembayaran < 0) {
      jenis_selisih = 'KEKURANGAN';
    } else {
      jenis_selisih = 'KELEBIHAN';
    }

    // Backward compatibility if payments is not provided
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

    // Validate payments — total payment_amount harus mencakup original_total (dalam batas toleransi)
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
        pAmount = pCashReceived; // gunakan nominal aktual yang diterima
        pChange = 0;             // kembalian tidak dihitung (toleransi)
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

    // Total payment sudah divalidasi oleh toleransi di atas
    // jumlahDibayar adalah total nominal aktual pelanggan
    // Gunakan jumlahDibayar sebagai payment_amount yang disimpan
    const finalPaymentAmount = jumlahDibayar > 0 ? jumlahDibayar : totalPaid;
    const status = 'paid'; // jika lolos validasi toleransi, transaksi dianggap lunas

    const invoice_number = this.generateInvoiceNumber();

    // Gunakan transaction untuk atomicity
    const insertTransaction = db.transaction(() => {
      // Insert transaksi — total_amount = original_total, jumlah_dibayar = nominal aktual pelanggan
      const txResult = db.prepare(`
        INSERT INTO transactions (invoice_number, total_amount, rounding_amount, payment_amount, change_amount, status, user_id, jumlah_dibayar, selisih_pembayaran, jenis_selisih)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(invoice_number, original_total, rounding_amount, finalPaymentAmount, totalChange, status, user_id || null, finalPaymentAmount, selisih_pembayaran, jenis_selisih);

      const transactionId = txResult.lastInsertRowid;

      // Insert payments
      const insertPayment = db.prepare(`
        INSERT INTO transaction_payments (transaction_id, payment_method, amount, payment_status, reference_number, cash_received, change_amount, rounding_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const p of processedPayments) {
        insertPayment.run(
          transactionId,
          p.method,
          p.amount,
          'paid',
          p.reference_number || null,
          p.cash_received || null,
          p.change_amount || 0,
          p.rounding_amount || 0
        );
      }

      // Insert items dan kurangi stok
      const insertItem = db.prepare(`
        INSERT INTO transaction_items (transaction_id, product_id, product_name, price, original_price, discount_percent, discount_amount, quantity, subtotal, base_price, profit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const getProductBasePrice = db.prepare('SELECT base_price FROM products WHERE id = ?');

      const decreaseStock = db.prepare(`
        UPDATE products SET stock = stock - ?, updated_at = datetime('now', 'localtime')
        WHERE id = ? AND stock >= ?
      `);

      for (const item of processedItems) {
        // Ambil harga modal dari database untuk memastikan keamanan
        const productData = getProductBasePrice.get(item.product_id);
        const base_price = productData ? productData.base_price : 0;
        
        // Harga transaksi per unit = Harga Jual - Diskon per unit = item.final_price
        // Laba per unit = Harga transaksi - Harga Modal
        const profit_per_unit = item.final_price - base_price;
        // Laba item = Laba per unit * Quantity
        const profit_item = profit_per_unit * item.quantity;

        insertItem.run(
          transactionId, 
          item.product_id, 
          item.product_name, 
          item.final_price, // price becomes the final price
          item.original_price, 
          item.discount_percent, 
          item.discount_amount, 
          item.quantity, 
          item.subtotal,
          base_price,
          profit_item
        );

        const stockResult = decreaseStock.run(item.quantity, item.product_id, item.quantity);
        if (stockResult.changes === 0) {
          throw new Error(`Stok tidak cukup untuk produk: ${item.product_name}`);
        }
      }

      return transactionId;
    });

    const transactionId = insertTransaction();
    return this.findById(transactionId);
  },

  // Ambil transaksi berdasarkan ID (dengan items)
  findById(id) {
    const db = getDb();
    const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!transaction) return null;

    transaction.items = db.prepare(
      'SELECT * FROM transaction_items WHERE transaction_id = ?'
    ).all(id);

    transaction.payments = db.prepare(
      'SELECT * FROM transaction_payments WHERE transaction_id = ?'
    ).all(id);
    
    transaction.original_total = transaction.total_amount;
    transaction.rounding_amount = transaction.rounding_amount || 0;
    // payable_total = total transaksi apa adanya (tanpa pembulatan sejak fitur toleransi)
    transaction.payable_total = transaction.total_amount;
    transaction.remaining = 0; // dengan sistem toleransi, selalu dianggap lunas jika lolos validasi

    // Data toleransi pembayaran
    transaction.jumlah_dibayar = transaction.jumlah_dibayar || transaction.payment_amount || 0;
    transaction.selisih_pembayaran = transaction.selisih_pembayaran || 0;
    transaction.jenis_selisih = transaction.jenis_selisih || 'PAS';

    // Hitung total laba
    transaction.total_profit = transaction.items.reduce((sum, item) => sum + (item.profit || 0), 0);

    return transaction;
  },

  // Ambil semua transaksi (tanpa items, untuk list)
  findAll({ limit = 50, offset = 0 } = {}) {
    const db = getDb();
    return db.prepare(
      'SELECT * FROM transactions ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset);
  },

  // Ambil transaksi terbaru (tanpa pagination)
  getRecent(limit = 5) {
    const db = getDb();
    return db.prepare(
      'SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
  },

  // Dapatkan statistik hari ini
  getTodayStats() {
    const db = getDb();
    const result = db.prepare(`
      SELECT 
        COUNT(*) as count, 
        COALESCE(SUM(total_amount), 0) as total
      FROM transactions 
      WHERE DATE(created_at) = DATE('now', 'localtime')
    `).get();
    
    return {
      count: result.count,
      total: result.total
    };
  },

  // Dapatkan statistik berdasarkan periode (today, week, month, all)
  getStatsByPeriod(period) {
    const db = getDb();
    let dateCondition = '';
    
    if (period === 'today') {
      dateCondition = "DATE(created_at) = DATE('now', 'localtime')";
    } else if (period === 'week') {
      dateCondition = "DATE(created_at) >= DATE('now', 'localtime', '-7 days')";
    } else if (period === 'month') {
      dateCondition = "DATE(created_at) >= DATE('now', 'localtime', 'start of month')";
    } else {
      dateCondition = "1=1"; // all time
    }

    const result = db.prepare(`
      SELECT 
        COUNT(*) as count, 
        COALESCE(SUM(total_amount), 0) as total
      FROM transactions 
      WHERE ${dateCondition}
    `).get();
    
    return {
      count: result.count,
      total: result.total
    };
  },

  // Cari transaksi berdasarkan nomor invoice
  search(query, { limit = 50, offset = 0 } = {}) {
    const db = getDb();
    const likeQuery = `%${query}%`;
    return db.prepare(
      'SELECT * FROM transactions WHERE invoice_number LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(likeQuery, limit, offset);
  },

  // Laporan penjualan per tanggal
  getSalesReport(dateFrom, dateTo) {
    const db = getDb();
    return db.prepare(`
      SELECT
        DATE(created_at) as tanggal,
        COUNT(*) as jumlah_transaksi,
        SUM(total_amount) as total_penjualan,
        SUM(CASE WHEN jenis_selisih != 'PAS' AND ABS(selisih_pembayaran) <= 5000 THEN 1 ELSE 0 END) as tol_count,
        SUM(CASE WHEN jenis_selisih = 'KEKURANGAN' AND ABS(selisih_pembayaran) <= 5000 THEN ABS(selisih_pembayaran) ELSE 0 END) as tol_kurang,
        SUM(CASE WHEN jenis_selisih = 'KELEBIHAN' AND ABS(selisih_pembayaran) <= 5000 THEN selisih_pembayaran ELSE 0 END) as tol_lebih
      FROM transactions
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at)
      ORDER BY tanggal DESC
    `).all(dateFrom, dateTo);
  },

  // Laporan Bulanan (Ringkasan dan Detail)
  getMonthlyReport(year, month) {
    const db = getDb();
    const paddedMonth = String(month).padStart(2, '0');
    // Start of the month, formatted as YYYY-MM-01 00:00:00
    const startOfMonth = `${year}-${paddedMonth}-01 00:00:00`;
    
    // Calculate end of the month by adding 1 month and subtracting 1 second
    const endOfMonthResult = db.prepare("SELECT datetime(?, '+1 month', '-1 second') as eom").get(startOfMonth);
    const endOfMonth = endOfMonthResult.eom;

    // Get summary
    const summary = db.prepare(`
      SELECT 
        COUNT(DISTINCT t.id) as jumlah_transaksi,
        COALESCE(SUM(ti.quantity), 0) as jumlah_produk_terjual,
        COALESCE(SUM(ti.base_price * ti.quantity), 0) as total_harga_modal,
        COALESCE(SUM(ti.subtotal), 0) as total_penjualan,
        COALESCE(SUM(ti.discount_amount * ti.quantity), 0) as total_diskon,
        COALESCE(SUM(ti.profit), 0) as total_laba
      FROM transactions t
      LEFT JOIN transaction_items ti ON t.id = ti.transaction_id
      WHERE t.created_at BETWEEN ? AND ?
    `).get(startOfMonth, endOfMonth);

    // Get tolerance summary
    const tolSummary = db.prepare(`
      SELECT
        SUM(CASE WHEN jenis_selisih != 'PAS' AND ABS(selisih_pembayaran) <= 5000 THEN 1 ELSE 0 END) as tol_count,
        SUM(CASE WHEN jenis_selisih = 'KEKURANGAN' AND ABS(selisih_pembayaran) <= 5000 THEN ABS(selisih_pembayaran) ELSE 0 END) as tol_kurang,
        SUM(CASE WHEN jenis_selisih = 'KELEBIHAN' AND ABS(selisih_pembayaran) <= 5000 THEN selisih_pembayaran ELSE 0 END) as tol_lebih
      FROM transactions
      WHERE created_at BETWEEN ? AND ?
    `).get(startOfMonth, endOfMonth);

    summary.tol_count = tolSummary.tol_count || 0;
    summary.tol_kurang = tolSummary.tol_kurang || 0;
    summary.tol_lebih = tolSummary.tol_lebih || 0;

    // Get details for excel
    const details = db.prepare(`
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
      WHERE t.created_at BETWEEN ? AND ?
      ORDER BY t.created_at DESC, t.invoice_number
    `).all(startOfMonth, endOfMonth);

    // Get payment method summary
    const paymentSummary = db.prepare(`
      SELECT 
        tp.payment_method,
        COALESCE(SUM(tp.amount), 0) as total_amount
      FROM transaction_payments tp
      JOIN transactions t ON tp.transaction_id = t.id
      WHERE t.created_at BETWEEN ? AND ?
      GROUP BY tp.payment_method
    `).all(startOfMonth, endOfMonth);

    return { summary, details, paymentSummary };
  },

  // Hapus satu transaksi
  delete(id) {
    const BackupService = require('../services/BackupService');
    BackupService.createAutoBackup('PreDelete');

    const db = getDb();
    const deleteTx = db.transaction(() => {
      const txDetail = this.findById(id);
      if (!txDetail) throw new Error('Transaksi tidak ditemukan');
      
      const increaseStock = db.prepare(`
        UPDATE products SET stock = stock + ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `);
      
      for (const item of txDetail.items) {
        const product = db.prepare('SELECT id FROM products WHERE id = ?').get(item.product_id);
        if (!product) {
          throw new Error(`Produk dengan ID ${item.product_id} (${item.product_name}) tidak ditemukan. Penghapusan dibatalkan demi menjaga integritas data.`);
        }
        increaseStock.run(item.quantity, item.product_id);
      }
      
      db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
      return true;
    });
    
    return deleteTx();
  },

  // Hapus transaksi berdasarkan periode
  deleteByPeriod(dateFrom, dateTo) {
    const BackupService = require('../services/BackupService');
    BackupService.createAutoBackup('PreDelete');

    const db = getDb();
    const deleteTx = db.transaction(() => {
      const transactions = db.prepare(`
        SELECT id FROM transactions WHERE DATE(created_at) BETWEEN ? AND ?
      `).all(dateFrom, dateTo);
      
      const increaseStock = db.prepare(`
        UPDATE products SET stock = stock + ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `);

      for (const t of transactions) {
        const txDetail = this.findById(t.id);
        if (txDetail) {
          for (const item of txDetail.items) {
            const product = db.prepare('SELECT id FROM products WHERE id = ?').get(item.product_id);
            if (!product) {
              throw new Error(`Produk dengan ID ${item.product_id} (${item.product_name}) pada transaksi ${txDetail.invoice_number} tidak ditemukan. Penghapusan dibatalkan.`);
            }
            increaseStock.run(item.quantity, item.product_id);
          }
          db.prepare('DELETE FROM transactions WHERE id = ?').run(t.id);
        }
      }
      return transactions.length;
    });
    
    return deleteTx();
  }
};

module.exports = Transaction;
