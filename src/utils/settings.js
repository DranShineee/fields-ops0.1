import { query } from '../db.js';

let cache = { value: null, at: 0 };
const TTL = 30 * 1000;

const DEFAULTS = {
  platform_name: 'FieldsOps',
  support_email: 'bantuan@fieldsops.id',
  support_whatsapp: '6281234567890',
  operational_area: 'Jakarta, Bandung, Yogyakarta',
  commission_percent: '15',
  cancellation_hours: '6',
  cod_note: 'Bayar tunai setelah pekerjaan selesai dan dicek bersama teknisi.',
};

/** Semua pengaturan platform sebagai objek (cached 30 detik). */
export async function getSettings(force = false) {
  if (!force && cache.value && Date.now() - cache.at < TTL) return cache.value;
  const rows = await query('SELECT setting_key, setting_value FROM settings');
  const value = { ...DEFAULTS };
  for (const row of rows) value[row.setting_key] = row.setting_value;
  cache = { value, at: Date.now() };
  return value;
}

export async function saveSettings(entries) {
  for (const [key, value] of Object.entries(entries)) {
    await query(
      `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [key, String(value)],
    );
  }
  cache = { value: null, at: 0 };
}

export function clearSettingsCache() {
  cache = { value: null, at: 0 };
}
