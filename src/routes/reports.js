const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');

// GET /reports — Halaman laporan penjualan
router.get('/', (req, res) => {
  const todayStats = Transaction.getStatsByPeriod('today');
  const weekStats = Transaction.getStatsByPeriod('week');
  const monthStats = Transaction.getStatsByPeriod('month');
  const totalStats = Transaction.getStatsByPeriod('all');

  // Laporan per tanggal untuk tabel (contoh: 30 hari terakhir)
  const db = require('../database/connection').getDb();
  const dateTo = db.prepare("SELECT DATE('now', 'localtime') as d").get().d;
  const dateFrom = db.prepare("SELECT DATE('now', 'localtime', '-30 days') as d").get().d;
  
  const dailyReport = Transaction.getSalesReport(dateFrom, dateTo);

  res.render('reports/index', {
    title: 'Laporan Penjualan — PandaKids POS',
    todayStats,
    weekStats,
    monthStats,
    totalStats,
    dailyReport
  });
});

// GET /reports/monthly - JSON endpoint for monthly summary
router.get('/monthly', (req, res) => {
  try {
    const { month, year } = req.query;
    if (!month || !year) {
      return res.status(400).json({ error: 'Bulan dan tahun harus diisi' });
    }
    const reportData = Transaction.getMonthlyReport(year, month);
    res.json({ success: true, summary: reportData.summary, paymentSummary: reportData.paymentSummary });
  } catch (err) {
    console.error('Error fetching monthly report:', err);
    res.status(500).json({ error: 'Terjadi kesalahan saat mengambil data laporan' });
  }
});

// GET /reports/export/monthly - Export to Excel
router.get('/export/monthly', (req, res) => {
  try {
    const { month, year } = req.query;
    if (!month || !year) {
      return res.status(400).send('Bulan dan tahun harus diisi');
    }
    
    const xlsx = require('xlsx');
    const reportData = Transaction.getMonthlyReport(year, month);
    
    // Create new workbook
    const wb = xlsx.utils.book_new();
    
    // Sheet 1: Ringkasan
    const summaryData = [
      ['Nama Toko', 'PandaKids'],
      ['Periode Laporan', `${month}-${year}`],
      [''],
      ['Jumlah Transaksi', reportData.summary.jumlah_transaksi],
      ['Jumlah Produk Terjual', reportData.summary.jumlah_produk_terjual],
      ['Total Harga Modal', reportData.summary.total_harga_modal],
      ['Total Penjualan', reportData.summary.total_penjualan],
      ['Total Diskon', reportData.summary.total_diskon],
      ['Total Laba', reportData.summary.total_laba]
    ];
    const wsSummary = xlsx.utils.aoa_to_sheet(summaryData);
    xlsx.utils.book_append_sheet(wb, wsSummary, 'Ringkasan');
    
    // Sheet 2: Detail Penjualan
    const detailsData = reportData.details.map(item => ({
      'Nomor Transaksi': item.invoice_number,
      'Tanggal': item.tanggal,
      'Kode Produk': item.kode_produk || '-',
      'Nama Produk': item.product_name,
      'Quantity': item.quantity,
      'Harga Modal': item.harga_modal,
      'Harga Jual': item.harga_jual,
      'Diskon %': item.diskon_persen + '%',
      'Nilai Diskon': item.nilai_diskon,
      'Harga Setelah Diskon': item.harga_setelah_diskon,
      'Subtotal Penjualan': item.subtotal,
      'Laba Per Unit': item.laba_per_unit,
      'Laba Item': item.laba_item
    }));
    
    const wsDetails = xlsx.utils.json_to_sheet(detailsData);
    xlsx.utils.book_append_sheet(wb, wsDetails, 'Detail Penjualan');
    
    // Send file
    const paddedMonth = String(month).padStart(2, '0');
    const fileName = `PandaKids_Laporan_Penjualan_${year}-${paddedMonth}.xlsx`;
    
    // Generate buffer and send
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
    
  } catch (err) {
    console.error('Error exporting monthly report:', err);
    res.status(500).send('Terjadi kesalahan saat export laporan');
  }
});

module.exports = router;
