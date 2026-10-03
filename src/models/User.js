const { getDb } = require('../database/connection');
const bcrypt = require('bcryptjs');

class User {
  static findAll() {
    return getDb().prepare("SELECT id, username, nama, role, is_active, created_at, updated_at FROM users").all();
  }

  static findById(id) {
    return getDb().prepare("SELECT id, username, nama, role, is_active, created_at, updated_at FROM users WHERE id = ?").get(id);
  }

  static findByUsername(username) {
    return getDb().prepare("SELECT * FROM users WHERE username = ?").get(username);
  }

  static create({ username, password, nama, role }) {
    const hash = bcrypt.hashSync(password, 10);
    const result = getDb().prepare(
      "INSERT INTO users (username, password_hash, nama, role) VALUES (?, ?, ?, ?)"
    ).run(username, hash, nama, role);
    return result.lastInsertRowid;
  }

  static update(id, { username, nama, role, is_active }) {
    return getDb().prepare(
      "UPDATE users SET username = ?, nama = ?, role = ?, is_active = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"
    ).run(username, nama, role, is_active, id);
  }

  static updatePassword(id, password) {
    const hash = bcrypt.hashSync(password, 10);
    return getDb().prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now', 'localtime') WHERE id = ?").run(hash, id);
  }

  static delete(id) {
    return getDb().prepare("DELETE FROM users WHERE id = ?").run(id);
  }

  static getActiveAdminsCount() {
    return getDb().prepare("SELECT COUNT(*) as count FROM users WHERE role = 'ADMIN' AND is_active = 1").get().count;
  }
}

module.exports = User;
