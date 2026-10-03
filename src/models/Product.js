const { query, getClient } = require('../database/connection');

const Product = {
  // Helper untuk menghitung harga jual
  _mapProduct(p) {
    if (!p) return null;
    
    // Konversi string BIGINT ke Number
    const base_price = parseInt(p.base_price, 10) || 0;
    
    return {
      ...p,
      price: Math.round(base_price * 1.4),
      base_price: base_price,
      // pastikan ID dan stock tetap integer
      id: parseInt(p.id, 10),
      stock: parseInt(p.stock, 10)
    };
  },

  // Ambil semua produk
  async findAll() {
    const result = await query('SELECT * FROM products ORDER BY name ASC');
    return result.rows.map(p => this._mapProduct(p));
  },

  // Cari produk berdasarkan keyword (nama, sku, atau kategori)
  async search(keyword) {
    const like = `%${keyword}%`;
    const result = await query(
      'SELECT * FROM products WHERE name ILIKE $1 OR sku ILIKE $2 OR category ILIKE $3 ORDER BY name ASC',
      [like, like, like]
    );
    return result.rows.map(p => this._mapProduct(p));
  },

  // Cari produk berdasarkan ID
  async findById(id) {
    const result = await query('SELECT * FROM products WHERE id = $1', [id]);
    return this._mapProduct(result.rows[0]);
  },

  // Hitung total produk
  async getTotalCount() {
    const result = await query('SELECT COUNT(*) as count FROM products');
    return parseInt(result.rows[0].count, 10);
  },

  // Cari produk berdasarkan SKU
  async findBySku(sku) {
    const result = await query('SELECT * FROM products WHERE sku = $1', [sku]);
    return this._mapProduct(result.rows[0]);
  },

  // Buat produk baru
  async create({ name, sku, category, price, base_price, stock }) {
    const final_base_price = base_price !== undefined ? base_price : (price || 0);
    const final_price = Math.round(final_base_price * 1.4);
    
    const result = await query(
      `INSERT INTO products (name, sku, category, price, base_price, stock)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        name, 
        sku || null, 
        category || 'Umum', 
        final_price, 
        final_base_price, 
        stock || 0
      ]
    );
    
    return this.findById(result.rows[0].id);
  },

  // Update produk
  async update(id, { name, sku, category, price, base_price, stock }) {
    if (base_price !== undefined) {
      const final_price = Math.round(base_price * 1.4);
      await query(
        `UPDATE products 
         SET name = $1, sku = $2, category = $3, price = $4, base_price = $5, stock = $6, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $7`,
        [name, sku || null, category || 'Umum', final_price, base_price, stock, id]
      );
    } else {
      await query(
        `UPDATE products 
         SET name = $1, sku = $2, category = $3, stock = $4, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $5`,
        [name, sku || null, category || 'Umum', stock, id]
      );
    }
    
    return this.findById(id);
  },

  // Import banyak produk
  async importMany(products) {
    let importedCount = 0;
    const client = await getClient();
    
    try {
      await client.query('BEGIN');
      
      for (const item of products) {
        // Only insert if SKU doesn't exist
        const existing = await client.query('SELECT id FROM products WHERE sku = $1', [item.sku]);
        if (existing.rows.length === 0) {
          const final_price = Math.round(item.base_price * 1.4);
          await client.query(
            `INSERT INTO products (name, sku, category, price, base_price, stock)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              item.name,
              item.sku,
              item.category || 'Umum',
              final_price,
              item.base_price,
              item.stock || 0
            ]
          );
          importedCount++;
        }
      }
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    
    return importedCount;
  },

  // Hapus produk
  async delete(id) {
    await query('DELETE FROM products WHERE id = $1', [id]);
  },

  // Kurangi stok (saat transaksi)
  async decreaseStock(id, quantity) {
    await query(
      `UPDATE products SET stock = stock - $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND stock >= $1`,
      [quantity, id]
    );
  },

  // Tambah stok
  async increaseStock(id, quantity) {
    await query(
      `UPDATE products SET stock = stock + $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [quantity, id]
    );
  }
};

module.exports = Product;
