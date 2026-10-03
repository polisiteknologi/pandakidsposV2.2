const express = require('express');
const router = express.Router();
const User = require('../models/User');

// GET /users - Daftar User
router.get('/', async (req, res) => {
  const users = await User.findAll();
  res.render('users/index', {
    title: 'Manajemen Pengguna - PandaKids POS',
    users,
    error: req.query.error,
    success: req.query.success
  });
});

// GET /users/create - Form Tambah User
router.get('/create', (req, res) => {
  res.render('users/form', {
    title: 'Tambah Pengguna - PandaKids POS',
    userItem: null,
    error: null
  });
});

// POST /users - Simpan User Baru
router.post('/', async (req, res) => {
  const { username, password, nama, role } = req.body;

  if (!username || !password || !nama || !role) {
    return res.render('users/form', {
      title: 'Tambah Pengguna - PandaKids POS',
      userItem: { username, nama, role },
      error: 'Semua kolom wajib diisi.'
    });
  }

  const existing = await User.findByUsername(username);
  if (existing) {
    return res.render('users/form', {
      title: 'Tambah Pengguna - PandaKids POS',
      userItem: { username, nama, role },
      error: 'Username sudah digunakan.'
    });
  }

  try {
    await User.create({ username, password, nama, role });
    res.redirect('/users?success=added');
  } catch (err) {
    res.render('users/form', {
      title: 'Tambah Pengguna - PandaKids POS',
      userItem: { username, nama, role },
      error: 'Gagal menambah pengguna.'
    });
  }
});

// GET /users/:id/edit - Form Edit User
router.get('/:id/edit', async (req, res) => {
  const userItem = await User.findById(req.params.id);
  if (!userItem) return res.redirect('/users');

  res.render('users/form', {
    title: 'Edit Pengguna - PandaKids POS',
    userItem,
    error: null
  });
});

// POST /users/:id - Update User
router.post('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { username, password, nama, role, is_active } = req.body;
  const isActiveNum = is_active ? 1 : 0;

  const userItem = await User.findById(id);
  if (!userItem) return res.redirect('/users');

  // Check unique username
  const existing = await User.findByUsername(username);
  if (existing && existing.id !== id) {
    return res.render('users/form', {
      title: 'Edit Pengguna - PandaKids POS',
      userItem: { id, username, nama, role, is_active: isActiveNum },
      error: 'Username sudah digunakan oleh user lain.'
    });
  }

  // Check last admin
  if (userItem.role === 'ADMIN' && (role !== 'ADMIN' || isActiveNum === 0)) {
    const adminCount = await User.getActiveAdminsCount();
    if (adminCount <= 1) {
      return res.render('users/form', {
        title: 'Edit Pengguna - PandaKids POS',
        userItem: { id, username, nama, role, is_active: isActiveNum },
        error: 'Tidak dapat menonaktifkan atau mengubah role Admin terakhir.'
      });
    }
  }

  try {
    await User.update(id, { username, nama, role, is_active: isActiveNum });
    if (password && password.trim() !== '') {
      await User.updatePassword(id, password);
    }
    res.redirect('/users?success=updated');
  } catch (err) {
    res.render('users/form', {
      title: 'Edit Pengguna - PandaKids POS',
      userItem: { id, username, nama, role, is_active: isActiveNum },
      error: 'Gagal mengubah pengguna.'
    });
  }
});

module.exports = router;
