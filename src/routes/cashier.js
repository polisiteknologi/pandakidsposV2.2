const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const Transaction = require('../models/Transaction');

// Halaman utama kasir
router.get('/', (req, res) => {
  res.render('cashier/index', {
    title: 'Kasir — PandaKids POS'
  });
});

// API endpoint untuk pencarian produk
router.get('/api/products', (req, res) => {
  try {
    const search = req.query.search || '';
    const products = search ? Product.search(search) : Product.findAll();
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint untuk checkout / bayar
router.post('/api/checkout', (req, res) => {
  try {
    const { items, payments, payment_amount, jumlah_dibayar } = req.body;
    const user_id = req.session.user ? req.session.user.id : null;
    
    // Validasi dasar
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Keranjang kosong.' });
    }
    
    if ((payment_amount === undefined || payment_amount === null || isNaN(payment_amount)) && (!payments || payments.length === 0) && !jumlah_dibayar) {
      return res.status(400).json({ error: 'Data pembayaran tidak valid.' });
    }

    // Proses transaksi (stok dicek dan dikurangi di model)
    const transaction = Transaction.create({ items, payments, payment_amount, user_id, jumlah_dibayar });
    
    res.json({ success: true, transaction });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
