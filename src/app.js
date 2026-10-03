require('dotenv').config();
const express = require('express');
const path = require('path');
const { initializeDatabase } = require('./database/schema');
const { closeDb } = require('./database/connection');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ── View Engine ────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const session = require('express-session');
app.use(session({
  secret: 'pandakids-pos-secret-key-v2', // in production use env var
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 12 * 60 * 60 * 1000 } // 12 hours
}));

// Middleware to expose session and currentPath to templates
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.currentPath = req.originalUrl || req.path || '';
  next();
});

// Middleware for protecting routes
const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/auth/login');
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/auth/login');
  }
  if (req.session.user.role !== 'ADMIN') {
    return res.status(403).send('Akses Ditolak: Membutuhkan role ADMIN');
  }
  next();
};

// ── Inisialisasi Database ──────────────────────────────
initializeDatabase();

const Product = require('./models/Product');
const Transaction = require('./models/Transaction');

// ── Routes ─────────────────────────────────────────────
// Auth
const authRouter = require('./routes/auth');
app.use('/auth', authRouter);

// Halaman utama
app.get('/', requireAuth, (req, res) => {
  try {
    const totalProducts = Product.getTotalCount();
    const todayStats = Transaction.getTodayStats();
    const recentTransactions = Transaction.getRecent(5);

    res.render('index', {
      title: 'PandaKids POS - Dashboard',
      totalProducts,
      todayStats,
      recentTransactions,
      user: req.session.user
    });
  } catch (error) {
    console.error('Error loading dashboard:', error);
    res.render('index', {
      title: 'PandaKids POS - Dashboard',
      totalProducts: 0,
      todayStats: { count: 0, total: 0 },
      recentTransactions: [],
      error: 'Gagal memuat data dashboard.',
      user: req.session.user
    });
  }
});

// Produk
const productsRouter = require('./routes/products');
app.use('/products', requireAdmin, productsRouter);

// Kasir (Kasir and Admin can access)
const cashierRouter = require('./routes/cashier');
app.use('/cashier', requireAuth, cashierRouter);

// Riwayat Transaksi (Admin only)
const transactionsRouter = require('./routes/transactions');
app.use('/transactions', requireAdmin, transactionsRouter);

// Laporan Penjualan (Admin only)
const reportsRouter = require('./routes/reports');
app.use('/reports', requireAdmin, reportsRouter);

// Users Management (Admin only)
const usersRouter = require('./routes/users');
app.use('/users', requireAdmin, usersRouter);

// Pengaturan (Backup & Restore) (Admin only)
const settingsRouter = require('./routes/settings');
app.use('/settings', requireAdmin, settingsRouter);

// API health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'PandaKids POS',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ── Start Server ───────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n🐼 PandaKids POS berjalan di http://localhost:${PORT}\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Menutup server...');
  closeDb();
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  closeDb();
  server.close(() => {
    process.exit(0);
  });
});

module.exports = app;
