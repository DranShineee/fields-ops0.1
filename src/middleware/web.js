import crypto from 'node:crypto';
import { query, queryOne } from '../db.js';
import { getSettings } from '../utils/settings.js';
import * as format from '../utils/format.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const ah = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

/** Muat ulang user dari database agar perubahan peran/status langsung berlaku. */
export async function loadUser(req, res, next) {
  try {
    if (req.session?.user?.id) {
      const user = await queryOne(
        'SELECT id, name, email, phone, role, is_active FROM users WHERE id = ? LIMIT 1',
        [req.session.user.id],
      );
      if (!user || !user.is_active) {
        req.session.destroy(() => {});
        res.locals.currentUser = null;
        return next();
      }
      req.session.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      };
      req.user = req.session.user;
    }
    res.locals.currentUser = req.user || null;
    next();
  } catch (error) {
    next(error);
  }
}

/** Konteks bersama: pengaturan platform, kategori nav, notifikasi, profil teknisi. */
export async function attachContext(req, res, next) {
  try {
    const settings = await getSettings();
    res.locals.settings = settings;
    res.locals.navCategories = await query(
      'SELECT id, name, slug, icon FROM categories WHERE is_active = 1 ORDER BY sort_order, name',
    );
    res.locals.unreadCount = 0;
    res.locals.technician = null;

    if (req.session?.user) {
      const row = await queryOne(
        'SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND is_read = 0',
        [req.session.user.id],
      );
      res.locals.unreadCount = Number(row?.total || 0);

      if (req.session.user.role === 'technician') {
        const profile = await queryOne('SELECT * FROM technician_profiles WHERE user_id = ? LIMIT 1', [
          req.session.user.id,
        ]);
        req.technician = profile;
        res.locals.technician = profile;
      }
    }

    res.locals.adminContact = {
      email: settings.support_email,
      phone: settings.support_whatsapp,
    };
    next();
  } catch (error) {
    next(error);
  }
}

function hasValidCsrfToken(req) {
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  const expected = req.session.csrfToken || '';
  return (
    typeof token === 'string' &&
    token.length === expected.length &&
    token.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  );
}

function rejectCsrf(res) {
  return res.status(403).render('error', {
    title: 'Sesi kedaluwarsa',
    status: 403,
    message: 'Token keamanan tidak valid. Muat ulang halaman lalu coba lagi.',
  });
}

/**
 * Token CSRF per sesi. Request multipart belum memiliki body pada tahap ini,
 * sehingga verifikasinya dilakukan setelah multer lewat `verifyCsrf`.
 */
export function csrfProtection(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (SAFE_METHODS.has(req.method)) return next();
  if (req.is('multipart/form-data')) return next();
  if (!hasValidCsrfToken(req)) return rejectCsrf(res);
  next();
}

export function verifyCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!hasValidCsrfToken(req)) return rejectCsrf(res);
  next();
}

export function flashMessages(req, res, next) {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.notice = req.session.notice || null;
  delete req.session.notice;
  next();
}

export function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

export function viewLocals(req, res, next) {
  res.locals.currentPath = req.path;
  res.locals.currentUrl = req.originalUrl;
  res.locals.currentYear = new Date().getFullYear();
  res.locals.appName = 'FieldsOps';
  res.locals.formatters = format;
  res.locals.f = format;
  /* Sejumlah template memanggil formatRupiah secara langsung. */
  res.locals.formatRupiah = format.formatRupiah;
  res.locals.statusBadge = format.statusBadge;
  res.locals.label = format.label;
  res.locals.isProduction = process.env.NODE_ENV === 'production';
  res.locals.bodyClass = '';
  next();
}
