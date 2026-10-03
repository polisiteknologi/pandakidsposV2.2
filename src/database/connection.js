const Database = require('better-sqlite3');

const dbPath = process.env.DATABASE_PATH || 'data/pandakids.db';

const db = new Database(dbPath);

module.exports = db;

function getDb() {
  if (!db) {
    // Pastikan folder data ada
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(DB_PATH);

    // Aktifkan WAL mode untuk performa lebih baik
    db.pragma('journal_mode = WAL');
    // Aktifkan foreign keys
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb };
