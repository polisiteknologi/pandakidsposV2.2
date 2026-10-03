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
  secret: process.env.SESSION_SECRET || 'pandakids-pos-secret-key-v2', // in production use env var
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

// ── Inisialisasi Database & Start Server (async) ───────
const Product = require('./models/Product');
const Transaction = require('./models/Transaction');

// ── Routes ─────────────────────────────────────────────
// Auth
const authRouter = require('./routes/auth');
app.use('/auth', authRouter);

// Halaman utama
app.get('/', requireAuth, async (req, res) => {
  try {
    const totalProducts = await Product.getTotalCount();
    const todayStats = await Transaction.getTodayStats();
    const recentTransactions = await Transaction.getRecent(5);

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

// ── Start Server (async bootstrap) ────────────────────
async function startServer() {
  try {
    await initializeDatabase();
  } catch (err) {
    console.error('\n❌ Gagal menginisialisasi database:', err.message);
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`\n🐼 PandaKids POS berjalan di http://localhost:${PORT}\n`);
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n🛑 Menerima ${signal}, menutup server...`);
    await closeDb();
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer();

module.exports = app;
