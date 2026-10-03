const { getDb } = require('../database/connection');

const Product = {
  // Helper untuk menghitung harga jual
  _mapProduct(p) {
    if (!p) return null;
    return {
      ...p,
      price: Math.round(p.base_price * 1.4)
    };
  },

  // Ambil semua produk
  findAll() {
    const db = getDb();
    const products = db.prepare('SELECT * FROM products ORDER BY name ASC').all();
    return products.map(p => this._mapProduct(p));
  },

  // Cari produk berdasarkan keyword (nama, sku, atau kategori)
  search(keyword) {
    const db = getDb();
    const like = `%${keyword}%`;
    const products = db.prepare(
      'SELECT * FROM products WHERE name LIKE ? OR sku LIKE ? OR category LIKE ? ORDER BY name ASC'
    ).all(like, like, like);
    return products.map(p => this._mapProduct(p));
  },


  // Cari produk berdasarkan ID
  findById(id) {
    const db = getDb();
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    return this._mapProduct(p);
  },

  // Hitung total produk
  getTotalCount() {
    const db = getDb();
    const result = db.prepare('SELECT COUNT(*) as count FROM products').get();
    return result.count;
  },

  // Cari produk berdasarkan SKU
  findBySku(sku) {
    const db = getDb();
    const p = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
    return this._mapProduct(p);
  },

  // Buat produk baru
  create({ name, sku, category, price, base_price, stock }) {
    const db = getDb();
    const final_base_price = base_price !== undefined ? base_price : (price || 0);
    const final_price = Math.round(final_base_price * 1.4);
    const stmt = db.prepare(`
      INSERT INTO products (name, sku, category, price, base_price, stock)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      name, 
      sku || null, 
      category || 'Umum', 
      final_price, 
      final_base_price, 
      stock || 0
    );
    return this.findById(result.lastInsertRowid);
  },

  // Update produk
  update(id, { name, sku, category, price, base_price, stock }) {
    const db = getDb();
    
    if (base_price !== undefined) {
      const final_price = Math.round(base_price * 1.4);
      db.prepare(
        'UPDATE products SET name = ?, sku = ?, category = ?, price = ?, base_price = ?, stock = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?'
      ).run(name, sku || null, category || 'Umum', final_price, base_price, stock, id);
    } else {
      db.prepare(
        'UPDATE products SET name = ?, sku = ?, category = ?, stock = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?'
      ).run(name, sku || null, category || 'Umum', stock, id);
    }
    
    return this.findById(id);
  },

  // Import banyak produk
  importMany(products) {
    const db = getDb();
    let importedCount = 0;
    
    const importTransaction = db.transaction((items) => {
      const stmt = db.prepare(`
        INSERT INTO products (name, sku, category, price, base_price, stock)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      for (const item of items) {
        // Only insert if SKU doesn't exist
        const existing = db.prepare('SELECT id FROM products WHERE sku = ?').get(item.sku);
        if (!existing) {
          const final_price = Math.round(item.base_price * 1.4);
          stmt.run(
            item.name,
            item.sku,
            item.category || 'Umum',
            final_price,
            item.base_price,
            item.stock || 0
          );
          importedCount++;
        }
      }
    });
    
    importTransaction(products);
    return importedCount;
  },

  // Hapus produk
  delete(id) {
    const db = getDb();
    return db.prepare('DELETE FROM products WHERE id = ?').run(id);
  },

  // Kurangi stok (saat transaksi)
  decreaseStock(id, quantity) {
    const db = getDb();
    return db.prepare(`
      UPDATE products SET stock = stock - ?, updated_at = datetime('now', 'localtime')
      WHERE id = ? AND stock >= ?
    `).run(quantity, id, quantity);
  },

  // Tambah stok
  increaseStock(id, quantity) {
    const db = getDb();
    return db.prepare(`
      UPDATE products SET stock = stock + ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(quantity, id);
  }
};

module.exports = Product;
