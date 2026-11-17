import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../db.js';
import { ah } from '../middleware/web.js';
import { redirectByRole, safeNext } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { notify } from '../utils/notify.js';

const router = express.Router();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const attempts = new Map();

function throttleKey(req, email) {
  return `${req.ip}|${email.toLowerCase()}`;
}

function tooManyAttempts(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
}

const demoAccounts = () =>
  process.env.NODE_ENV === 'production'
    ? []
    : [
        { role: 'Admin', email: 'admin@fieldsops.id', password: 'Admin#2026' },
        { role: 'Customer', email: 'budi@fieldsops.id', password: 'Pembeli#2026' },
        { role: 'Technician', email: 'teknisi1@fieldsops.id', password: 'Teknisi#2026' },
      ];

router.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect(redirectByRole(req.session.user.role));
  res.render('auth/login', {
    title: 'Masuk',
    email: '',
    next: safeNext(req.query.next) || '',
    demoAccounts: demoAccounts(),
  });
});

router.post(
  '/login',
  ah(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const nextUrl = safeNext(req.body.next);
    const key = throttleKey(req, email);

    const renderError = (status, error) =>
      res.status(status).render('auth/login', {
        title: 'Masuk',
        email,
        next: nextUrl || '',
        error,
        demoAccounts: demoAccounts(),
      });

    if (tooManyAttempts(key)) return renderError(429, 'Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit.');
    if (!email || !password) return renderError(422, 'Email dan kata sandi wajib diisi.');

    const user = await queryOne('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
    const passwordOk = user ? await bcrypt.compare(password, user.password_hash) : false;

    if (!user || !passwordOk) {
      recordFailure(key);
      return renderError(401, 'Email atau kata sandi salah.');
    }

    if (!user.is_active) {
      return renderError(403, 'Akun ini sedang dinonaktifkan. Hubungi administrator.');
    }

    attempts.delete(key);
    const csrfToken = req.session.csrfToken;
    await new Promise((resolve, reject) =>
      req.session.regenerate((error) => (error ? reject(error) : resolve())),
    );
    req.session.csrfToken = csrfToken;
    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
    };
    req.session.flash = { type: 'success', message: `Selamat datang, ${user.name}.` };
    res.redirect(nextUrl || redirectByRole(user.role));
  }),
);

const activeCategories = () =>
  query('SELECT id, name FROM categories WHERE is_active = 1 ORDER BY sort_order, name');

function renderRegister(res, form, errors = {}, status = 200, categories = []) {
  res.status(status).render('auth/register', {
    title: 'Buat akun',
    form,
    errors,
    categories,
    demoActive: process.env.NODE_ENV !== 'production',
  });
}

router.get(
  '/register',
  ah(async (req, res) => {
    if (req.session?.user) return res.redirect(redirectByRole(req.session.user.role));
    const role = req.query.role === 'technician' ? 'technician' : 'customer';
    renderRegister(res, { role }, {}, 200, await activeCategories());
  }),
);

router.post(
  '/register',
  ah(async (req, res) => {
    if (req.session?.user) return res.redirect(redirectByRole(req.session.user.role));

    const categoryIds = [
      ...new Set([].concat(req.body.category_ids || []).map((id) => Number(id)).filter(Boolean)),
    ];
    const form = {
      name: String(req.body.name || '').trim(),
      email: String(req.body.email || '').trim().toLowerCase(),
      phone: String(req.body.phone || '').trim(),
      role: req.body.role === 'technician' ? 'technician' : 'customer',
      bio: String(req.body.bio || '').trim(),
      experience_years: String(req.body.experience_years || '').trim(),
      service_area: String(req.body.service_area || '').trim(),
      ktp_number: String(req.body.ktp_number || '').replace(/\s+/g, ''),
      category_ids: categoryIds,
    };
    const password = String(req.body.password || '');
    const confirm = String(req.body.confirm_password || '');
    const errors = {};
    const categories = form.role === 'technician' ? await activeCategories() : [];

    if (form.name.length < 3) errors.name = 'Nama minimal 3 karakter.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email)) errors.email = 'Format email tidak valid.';
    if (!/^[0-9+\-\s()]{8,24}$/.test(form.phone)) errors.phone = 'Nomor WhatsApp wajib diisi dengan format valid.';
    if (password.length < 8) errors.password = 'Kata sandi minimal 8 karakter.';
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) errors.password = 'Gunakan huruf dan angka.';
    if (password !== confirm) errors.confirm_password = 'Konfirmasi kata sandi tidak sama.';

    if (form.role === 'technician') {
      if (form.bio.length < 30) errors.bio = 'Ceritakan pengalaman dan keahlian minimal 30 karakter.';
      const years = Number(form.experience_years);
      if (!Number.isInteger(years) || years < 1 || years > 60) errors.experience = 'Isi pengalaman 1–60 tahun.';
      if (form.service_area.length < 3) errors.area = 'Area kerja wajib diisi, mis. Jakarta Selatan.';
      if (!/^\d{16}$/.test(form.ktp_number)) errors.ktp = 'Nomor KTP harus 16 angka.';
      const allowed = new Set(categories.map((category) => category.id));
      if (categoryIds.length === 0) errors.categories = 'Pilih minimal satu kategori keahlian.';
      else if (categoryIds.some((id) => !allowed.has(id))) errors.categories = 'Kategori keahlian tidak valid.';
    }

    if (!errors.email) {
      const existing = await queryOne('SELECT id FROM users WHERE email = ? LIMIT 1', [form.email]);
      if (existing) errors.email = 'Email sudah terdaftar.';
    }

    if (Object.keys(errors).length > 0) return renderRegister(res, form, errors, 422, categories);

    const hash = await bcrypt.hash(password, 12);
    const result = await query(
      `INSERT INTO users (name, email, phone, password_hash, role, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [form.name, form.email, form.phone, hash, form.role],
    );
    const userId = result.insertId;

    if (form.role === 'technician') {
      await query(
        `INSERT INTO technician_profiles (user_id, status, bio, experience_years, service_area, ktp_number, submitted_at)
         VALUES (?, 'pending', ?, ?, ?, ?, NULL)`,
        [userId, form.bio, Number(form.experience_years), form.service_area, form.ktp_number],
      );
      for (const categoryId of categoryIds) {
        await query(
          "INSERT INTO technician_competencies (technician_id, category_id, status) VALUES (?, ?, 'pending')",
          [userId, categoryId],
        );
      }
      await notify(
        userId,
        'Akun teknisi dibuat',
        'Lengkapi pengajuan kemitraan: pengalaman, area kerja, dan dokumen identitas.',
        '/teknisi/pengajuan',
      );
      const admins = await query("SELECT id FROM users WHERE role = 'admin' AND is_active = 1");
      for (const admin of admins) {
        await notify(admin.id, 'Pendaftaran teknisi baru', `${form.name} membuat akun teknisi.`, '/admin/verifikasi');
      }
      await logAudit(req, {
        action: 'technician.registered',
        entity: 'technician',
        entityId: userId,
        description: `Akun teknisi baru: ${form.name}`,
      });
    }

    req.session.flash = {
      type: 'success',
      message:
        form.role === 'technician'
          ? 'Akun teknisi dibuat. Lengkapi pengajuan kemitraan untuk diverifikasi admin.'
          : 'Akun berhasil dibuat. Silakan masuk.',
    };
    res.redirect('/login');
  }),
);

router.get('/lupa-sandi', (req, res) => {
  res.render('auth/forgot', { title: 'Lupa kata sandi', sent: false, resetLink: null, email: '' });
});

router.post(
  '/lupa-sandi',
  ah(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = await queryOne('SELECT id, name FROM users WHERE email = ? LIMIT 1', [email]);
    let resetLink = null;

    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await query(
        'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 45 MINUTE))',
        [user.id, tokenHash],
      );
      resetLink = `/reset-sandi/${token}`;
      await logAudit(req, {
        action: 'password.reset_requested',
        entity: 'user',
        entityId: user.id,
        description: `Permintaan reset kata sandi untuk ${email}`,
      });
    }

    res.render('auth/forgot', {
      title: 'Lupa kata sandi',
      sent: true,
      resetLink: process.env.NODE_ENV === 'production' ? null : resetLink,
      email,
    });
  }),
);

router.get(
  '/reset-sandi/:token',
  ah(async (req, res) => {
    const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const row = await queryOne(
      'SELECT id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1',
      [tokenHash],
    );
    if (!row) {
      return res.status(410).render('auth/reset', {
        title: 'Tautan kedaluwarsa',
        token: null,
        error: 'Tautan reset sudah tidak berlaku. Minta tautan baru dari halaman lupa kata sandi.',
      });
    }
    res.render('auth/reset', { title: 'Atur kata sandi baru', token: req.params.token, error: null });
  }),
);

router.post(
  '/reset-sandi/:token',
  ah(async (req, res) => {
    const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const row = await queryOne(
      'SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1',
      [tokenHash],
    );
    const password = String(req.body.password || '');
    const confirm = String(req.body.confirm_password || '');

    if (!row) {
      return res.status(410).render('auth/reset', {
        title: 'Tautan kedaluwarsa',
        token: null,
        error: 'Tautan reset sudah tidak berlaku. Minta tautan baru.',
      });
    }
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(422).render('auth/reset', {
        title: 'Atur kata sandi baru',
        token: req.params.token,
        error: 'Kata sandi minimal 8 karakter dan mengandung huruf serta angka.',
      });
    }
    if (password !== confirm) {
      return res.status(422).render('auth/reset', {
        title: 'Atur kata sandi baru',
        token: req.params.token,
        error: 'Konfirmasi kata sandi tidak sama.',
      });
    }

    const hash = await bcrypt.hash(password, 12);
    await query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, row.user_id]);
    await query('UPDATE password_resets SET used_at = NOW() WHERE id = ?', [row.id]);
    await query('DELETE FROM password_resets WHERE user_id = ? AND id <> ?', [row.user_id, row.id]);
    await logAudit(req, {
      action: 'password.reset_completed',
      entity: 'user',
      entityId: row.user_id,
      description: 'Kata sandi diatur ulang melalui tautan reset',
    });

    req.session.flash = { type: 'success', message: 'Kata sandi diperbarui. Silakan masuk dengan kata sandi baru.' };
    res.redirect('/login');
  }),
);

router.post('/logout', (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('fieldsops.sid');
    res.redirect('/');
  });
});

export default router;
