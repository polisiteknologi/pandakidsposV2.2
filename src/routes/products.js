const express = require('express');
const router = express.Router();
const Product = require('../models/Product');

// GET /products — Halaman daftar produk
router.get('/', (req, res) => {
  const search = req.query.search || '';
  const products = search ? Product.search(search) : Product.findAll();
  res.render('products/index', {
    title: 'Produk — PandaKids POS',
    products,
    search
  });
});

// GET /products/create — Form tambah produk
router.get('/create', (req, res) => {
  res.render('products/form', {
    title: 'Tambah Produk — PandaKids POS',
    product: null,
    error: null
  });
});

// POST /products — Simpan produk baru
router.post('/', (req, res) => {
  const { sku, name, category, base_price, stock } = req.body;

  // Validasi
  const error = validateProduct({ sku, name, base_price, stock });
  if (error) {
    return res.render('products/form', {
      title: 'Tambah Produk — PandaKids POS',
      product: { sku, name, category, base_price, stock },
      error
    });
  }

  // Cek SKU unik
  const existing = Product.findBySku(sku);
  if (existing) {
    return res.render('products/form', {
      title: 'Tambah Produk — PandaKids POS',
      product: { sku, name, category, base_price, stock },
      error: 'Kode produk sudah digunakan.'
    });
  }

  Product.create({
    sku,
    name: name.trim(),
    category: category ? category.trim() : 'Umum',
    base_price: parseInt(base_price, 10),
    stock: parseInt(stock, 10) || 0
  });

  res.redirect('/products?success=added');
});

// ── Import ──────────────────────────────────────────────
const multer = require('multer');
const upload = multer({ dest: require('os').tmpdir() });
const fs = require('fs');
const csv = require('csv-parser');
const xlsx = require('xlsx');

// GET /products/import — Halaman Import
router.get('/import', (req, res) => {
  res.render('products/import', {
    title: 'Import Produk — PandaKids POS'
  });
});

// GET /products/import/template — Download template
router.get('/import/template', (req, res) => {
  const template = 'kode_produk,nama_produk,kategori,harga_modal,stok\nB001,Baju Anak A,Baju,50000,10\nB002,Celana Anak B,Celana,40000,15\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=template_import_produk.csv');
  res.send(template);
});

// POST /products/import/preview — Proses file dan tampilkan preview
router.post('/import/preview', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.render('products/import', {
      title: 'Import Produk — PandaKids POS',
      error: 'Harap pilih file (CSV atau XLSX).'
    });
  }

  const filePath = req.file.path;
  const ext = req.file.originalname.split('.').pop().toLowerCase();
  
  const processData = (data) => {
    // Validasi data
    const preview = [];
    let hasError = false;

    data.forEach((row, index) => {
      const rowNum = index + 2; // Assuming header is row 1
      const item = {
        rowNum,
        kode: row.kode_produk ? String(row.kode_produk).trim() : '',
        nama: row.nama_produk ? String(row.nama_produk).trim() : '',
        kategori: row.kategori ? String(row.kategori).trim() : 'Umum',
        harga_modal: row.harga_modal ? parseInt(row.harga_modal, 10) : NaN,
        stok: row.stok ? parseInt(row.stok, 10) : NaN,
        errors: [],
        existing: false
      };

      if (!item.kode) item.errors.push('Kode produk wajib diisi.');
      if (!item.nama) item.errors.push('Nama produk wajib diisi.');
      if (isNaN(item.harga_modal) || item.harga_modal < 0) item.errors.push('Harga modal harus angka >= 0.');
      if (isNaN(item.stok) || item.stok < 0) item.errors.push('Stok harus angka >= 0.');

      if (item.kode) {
        const existing = Product.findBySku(item.kode);
        if (existing) {
          item.existing = true;
          item.errors.push('Produk sudah ada di database (akan dilewati).');
        }
      }

      if (item.errors.length > 0 && !item.existing) hasError = true;
      preview.push(item);
    });

    // Check duplicate SKU in file
    const skusInFile = new Set();
    preview.forEach(item => {
      if (item.kode) {
        if (skusInFile.has(item.kode)) {
          item.errors.push('Kode produk duplikat di dalam file.');
          hasError = true;
        } else {
          skusInFile.add(item.kode);
        }
      }
    });

    // Save temporary data in session or hidden form field? 
    // We can just render the preview and encode the valid data as base64 hidden field
    // so we don't have to save state in session.
    const validData = preview.filter(p => p.errors.length === 0 || (p.errors.length === 1 && p.existing));
    const importData = validData.filter(p => !p.existing).map(p => ({
      sku: p.kode,
      name: p.nama,
      category: p.kategori,
      base_price: p.harga_modal,
      stock: p.stok
    }));

    res.render('products/preview', {
      title: 'Preview Import — PandaKids POS',
      preview,
      hasError,
      validDataEncoded: Buffer.from(JSON.stringify(importData)).toString('base64')
    });
  };

  try {
    if (ext === 'csv') {
      const results = [];
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', () => {
          fs.unlinkSync(filePath);
          processData(results);
        });
    } else if (ext === 'xlsx' || ext === 'xls') {
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const results = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
      fs.unlinkSync(filePath);
      processData(results);
    } else {
      fs.unlinkSync(filePath);
      return res.render('products/import', {
        title: 'Import Produk — PandaKids POS',
        error: 'Format file tidak didukung. Gunakan CSV atau XLSX.'
      });
    }
  } catch (err) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return res.render('products/import', {
      title: 'Import Produk — PandaKids POS',
      error: 'Gagal membaca file: ' + err.message
    });
  }
});

// POST /products/import/confirm — Simpan ke database
router.post('/import/confirm', (req, res) => {
  const { dataEncoded } = req.body;
  if (!dataEncoded) return res.redirect('/products/import');

  try {
    const products = JSON.parse(Buffer.from(dataEncoded, 'base64').toString('utf-8'));
    const importedCount = Product.importMany(products);
    res.redirect(`/products?success=imported&count=${importedCount}`);
  } catch (err) {
    console.error(err);
    res.redirect('/products?error=Gagal+menyimpan+data+import');
  }
});

// GET /products/:id/edit — Form edit produk
router.get('/:id/edit', (req, res) => {
  const product = Product.findById(req.params.id);
  if (!product) return res.redirect('/products');

  res.render('products/form', {
    title: 'Edit Produk — PandaKids POS',
    product,
    error: null
  });
});

// POST /products/:id — Update produk
router.post('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { sku, name, category, base_price, stock } = req.body;

  const product = Product.findById(id);
  if (!product) return res.redirect('/products');

  // Validasi
  const error = validateProduct({ sku, name, base_price, stock });
  if (error) {
    return res.render('products/form', {
      title: 'Edit Produk — PandaKids POS',
      product: { id, sku, name, category, base_price, stock },
      error
    });
  }

  // Cek SKU unik (kecuali milik sendiri)
  const existing = Product.findBySku(sku);
  if (existing && existing.id !== id) {
    return res.render('products/form', {
      title: 'Edit Produk — PandaKids POS',
      product: { id, sku, name, category, base_price, stock },
      error: 'Kode produk sudah digunakan oleh produk lain.'
    });
  }

  Product.update(id, {
    sku,
    name: name.trim(),
    category: category ? category.trim() : 'Umum',
    base_price: parseInt(base_price, 10),
    stock: parseInt(stock, 10) || 0
  });

  res.redirect('/products?success=updated');
});

// POST /products/:id/delete — Hapus produk
router.post('/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    Product.delete(id);
    res.redirect('/products?success=deleted');
  } catch (err) {
    // Gagal hapus jika produk sudah pernah dipakai di transaksi (FK RESTRICT)
    res.redirect('/products?error=Produk+tidak+dapat+dihapus+karena+sudah+digunakan+dalam+transaksi');
  }
});

// ── Validasi ───────────────────────────────────────────
function validateProduct({ sku, name, base_price, stock }) {
  if (!sku || !sku.trim()) return 'Kode produk wajib diisi.';
  if (!name || !name.trim()) return 'Nama produk wajib diisi.';

  const priceNum = parseInt(base_price, 10);
  if (isNaN(priceNum) || priceNum < 0) return 'Harga harus angka dan tidak boleh negatif.';

  const stockNum = parseInt(stock, 10);
  if (isNaN(stockNum) || stockNum < 0) return 'Stok harus angka dan tidak boleh negatif.';

  return null;
}

module.exports = router;
