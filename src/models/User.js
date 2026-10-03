const { query } = require('../database/connection');
const bcrypt = require('bcryptjs');

class User {
  static async findAll() {
    const result = await query("SELECT id, username, nama, role, is_active, created_at, updated_at FROM users");
    return result.rows;
  }

  static async findById(id) {
    const result = await query("SELECT id, username, nama, role, is_active, created_at, updated_at FROM users WHERE id = $1", [id]);
    return result.rows[0];
  }

  static async findByUsername(username) {
    const result = await query("SELECT * FROM users WHERE username = $1", [username]);
    return result.rows[0];
  }

  static async create({ username, password, nama, role }) {
    const hash = bcrypt.hashSync(password, 10);
    const result = await query(
      "INSERT INTO users (username, password_hash, nama, role) VALUES ($1, $2, $3, $4) RETURNING id",
      [username, hash, nama, role]
    );
    return result.rows[0].id;
  }

  static async update(id, { username, nama, role, is_active }) {
    await query(
      "UPDATE users SET username = $1, nama = $2, role = $3, is_active = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5",
      [username, nama, role, is_active, id]
    );
  }

  static async updatePassword(id, password) {
    const hash = bcrypt.hashSync(password, 10);
    await query(
      "UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [hash, id]
    );
  }

  static async delete(id) {
    await query("DELETE FROM users WHERE id = $1", [id]);
  }

  static async getActiveAdminsCount() {
    const result = await query("SELECT COUNT(*) as count FROM users WHERE role = 'ADMIN' AND is_active = 1");
    return parseInt(result.rows[0].count, 10);
  }
}

module.exports = User;
