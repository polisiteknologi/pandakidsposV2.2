const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');
const { query } = require('../database/connection');

// GET /transactions — Halaman riwayat transaksi
router.get('/', async (req, res) => {
  const search = req.query.search || '';
  const transactions = search ? await Transaction.search(search) : await Transaction.findAll();
  
  res.render('transactions/index', {
    title: 'Riwayat Transaksi — PandaKids POS',
    transactions,
    search,
    req
  });
});

// GET /transactions/delete-period — Halaman Hapus Berdasarkan Periode
router.get('/delete-period', (req, res) => {
  res.render('transactions/delete_period', {
    title: 'Hapus Transaksi Berdasarkan Periode — PandaKids POS'
  });
});

// POST /transactions/delete-period — Konfirmasi Hapus Berdasarkan Periode
router.post('/delete-period', async (req, res) => {
  const { date_start, date_end, confirm } = req.body;
  
  if (!date_start || !date_end) {
    return res.redirect('/transactions?error=Periode tidak boleh kosong');
  }
  
  if (new Date(date_start) > new Date(date_end)) {
    return res.redirect('/transactions?error=Tanggal awal tidak boleh lebih besar dari tanggal akhir');
  }

  if (!confirm) {
    // Tampilkan preview jumlah yang akan dihapus
    const countDataRes = await query(`
      SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
      FROM transactions 
      WHERE DATE(created_at AT TIME ZONE 'Asia/Jakarta') BETWEEN $1::DATE AND $2::DATE
    `, [date_start, date_end]);
    
    const countData = countDataRes.rows[0];
    const count = parseInt(countData.count, 10);
    const total = parseInt(countData.total, 10);

    if (count === 0) {
      return res.redirect('/transactions?error=Tidak ada transaksi dalam periode tersebut');
    }

    return res.render('transactions/delete_period_confirm', {
      title: 'Konfirmasi Hapus Transaksi — PandaKids POS',
      date_start,
      date_end,
      count,
      total
    });
  }

  // Proses penghapusan
  try {
    const count = await Transaction.deleteByPeriod(date_start, date_end);
    res.redirect(`/transactions?success=deleted_period&count=${count}`);
  } catch (err) {
    res.redirect(`/transactions?error=${encodeURIComponent(err.message)}`);
  }
});

// GET /transactions/:id — Detail transaksi
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const transaction = await Transaction.findById(id);
  
  if (!transaction) {
    return res.redirect('/transactions');
  }

  res.render('transactions/show', {
    title: `Detail Transaksi ${transaction.invoice_number} — PandaKids POS`,
    transaction
  });
});

// POST /transactions/:id/delete — Hapus satu transaksi
router.post('/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    await Transaction.delete(id);
    res.redirect('/transactions?success=deleted');
  } catch (err) {
    res.redirect(`/transactions?error=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
