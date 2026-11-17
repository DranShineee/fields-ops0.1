import { query } from '../db.js';

/** Notifikasi in-app; hanya penerima yang dapat melihat (SRS 4.3.12). */
export async function notify(userId, title, body, link = null) {
  if (!userId) return;
  await query(
    'INSERT INTO notifications (user_id, title, body, link) VALUES (?, ?, ?, ?)',
    [userId, String(title).slice(0, 160), body ? String(body).slice(0, 400) : null, link],
  );
}
