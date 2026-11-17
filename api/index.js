/**
 * Entry point Vercel: setiap request diteruskan ke aplikasi Express.
 * Tidak ada proses yang terus berjalan — semua state ada di MySQL.
 */
import app from '../src/app.js';

export default function handler(req, res) {
  return app(req, res);
}
