import { queryOne } from '../db.js';

let cached = { value: null, at: 0 };
const TTL = 60 * 1000;

/** Admin aktif pertama yang memiliki nomor WhatsApp — tujuan semua pesanan. */
export async function getAdminContact() {
  if (cached.value && Date.now() - cached.at < TTL) return cached.value;
  const contact = await queryOne(
    `SELECT name, phone FROM users
     WHERE role = 'admin' AND is_active = 1 AND phone IS NOT NULL AND phone <> ''
     ORDER BY id ASC LIMIT 1`,
  );
  cached = { value: contact, at: Date.now() };
  return contact;
}

/** Middleware: sediakan kontak admin untuk footer dan tautan WhatsApp. */
export async function attachAdminContact(req, res, next) {
  try {
    res.locals.adminContact = await getAdminContact();
    next();
  } catch (error) {
    next(error);
  }
}
