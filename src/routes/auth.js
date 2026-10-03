const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcryptjs');

// GET /auth/login - Form Login
router.get('/login', (req, res) => {
  // If already logged in
  if (req.session.user) {
    if (req.session.user.role === 'KASIR') {
      return res.redirect('/cashier');
    }
    return res.redirect('/');
  }

  res.render('auth/login', {
    title: 'Login - PandaKids POS',
    error: null,
    layout: false // if you use a specific layout or just render complete HTML in this view
  });
});

// POST /auth/login - Proses Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.render('auth/login', {
      title: 'Login - PandaKids POS',
      error: 'Username dan Password harus diisi'
    });
  }

  const user = await User.findByUsername(username);

  if (!user || !user.is_active) {
    return res.render('auth/login', {
      title: 'Login - PandaKids POS',
      error: 'Username atau Password salah' // generic error message
    });
  }

  const isValid = bcrypt.compareSync(password, user.password_hash);
  if (!isValid) {
    return res.render('auth/login', {
      title: 'Login - PandaKids POS',
      error: 'Username atau Password salah'
    });
  }

  // Set session
  req.session.user = {
    id: user.id,
    username: user.username,
    nama: user.nama,
    role: user.role
  };

  if (user.role === 'KASIR') {
    res.redirect('/cashier');
  } else {
    res.redirect('/');
  }
});

// GET /auth/logout - Proses Logout
router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    res.redirect('/auth/login');
  });
});

module.exports = router;
