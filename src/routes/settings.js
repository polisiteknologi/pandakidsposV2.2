const express = require('express');
const router = express.Router();
const multer = require('multer');
const BackupService = require('../services/BackupService');
const fs = require('fs');

// Gunakan memory storage untuk file upload
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});

// GET /settings/backup-restore
router.get('/backup-restore', (req, res) => {
  // Ambil data backup terakhir jika ada
  let lastBackupDate = 'Belum ada backup otomatis';
  try {
    const dir = BackupService.getBackupDir();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.pandabackup'));
    if (files.length > 0) {
      files.sort();
      const lastFile = files[files.length - 1];
      const stats = fs.statSync(require('path').join(dir, lastFile));
      lastBackupDate = new Date(stats.mtime).toLocaleString('id-ID');
    }
  } catch (err) {
    // Ignore error
  }

  res.render('settings/backup', {
    title: 'Backup & Restore — PandaKids POS',
    lastBackupDate,
    req
  });
});

// POST /settings/backup-restore/create
router.post('/backup-restore/create', (req, res) => {
  try {
    const backupData = BackupService.createManualBackup();
    const dateStr = new Date().toISOString().replace(/T/, '_').replace(/:/g, '').split('.')[0];
    const filename = `PandaKids_Backup_${dateStr}.pandabackup`;
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(backupData);
  } catch (err) {
    console.error('Backup error:', err);
    res.redirect('/settings/backup-restore?error=Backup gagal dibuat');
  }
});

// POST /settings/backup-restore/upload
router.post('/backup-restore/upload', upload.single('backup_file'), (req, res) => {
  if (!req.file) {
    return res.redirect('/settings/backup-restore?error=Pilih file backup terlebih dahulu');
  }

  try {
    const fileContent = req.file.buffer.toString('utf-8');
    const validation = BackupService.validateBackup(fileContent);

    if (!validation.isValid) {
      return res.redirect(`/settings/backup-restore?error=${encodeURIComponent(validation.error)}`);
    }

    // Save parsed data temporarily in session
    req.session.pendingRestore = validation.parsedData;
    req.session.pendingRestoreSummary = validation.summary;

    res.render('settings/restore_confirm', {
      title: 'Konfirmasi Restore — PandaKids POS',
      summary: validation.summary
    });
  } catch (err) {
    console.error('Upload backup error:', err);
    res.redirect('/settings/backup-restore?error=File backup tidak valid');
  }
});

// POST /settings/backup-restore/restore
router.post('/backup-restore/restore', (req, res) => {
  const parsedData = req.session.pendingRestore;
  
  if (!parsedData) {
    return res.redirect('/settings/backup-restore?error=Sesi restore kadaluarsa. Silakan upload ulang.');
  }

  try {
    // 1. Create Pre-Restore Backup
    const backupFilename = BackupService.createAutoBackup('PreRestore');
    if (!backupFilename) {
      throw new Error('Restore dibatalkan karena backup pengaman gagal dibuat.');
    }

    // 2. Perform Restore
    BackupService.restoreBackup(parsedData);
    
    // Clear session
    delete req.session.pendingRestore;
    delete req.session.pendingRestoreSummary;

    // Sukses, redirect ke login atau dashboard
    res.redirect('/settings/backup-restore?success=Restore berhasil.');
  } catch (err) {
    console.error('Restore error:', err);
    // Clear session
    delete req.session.pendingRestore;
    delete req.session.pendingRestoreSummary;
    res.redirect(`/settings/backup-restore?error=${encodeURIComponent(err.message || 'Restore gagal. Data aplikasi saat ini dipertahankan.')}`);
  }
});

// POST /settings/backup-restore/cancel
router.post('/backup-restore/cancel', (req, res) => {
  delete req.session.pendingRestore;
  delete req.session.pendingRestoreSummary;
  res.redirect('/settings/backup-restore');
});

module.exports = router;
