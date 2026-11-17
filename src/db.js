import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  queueLimit: 0,
  charset: 'utf8mb4_unicode_ci',
  decimalNumbers: true,
  dateStrings: false,
  supportBigNumbers: true,
  // Serverless (Vercel) membuat banyak instance singkat: batasi koneksi idle,
  // jaga keep-alive, dan lepaskan koneksi yang menganggur lebih cepat.
  maxIdle: Math.max(1, Math.min(2, config.db.connectionLimit)),
  idleTimeout: 60_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
});

/** Jalankan query dan kembalikan baris hasil. */
export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** Kembalikan satu baris pertama atau null. */
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/** Jalankan beberapa operasi tulis dalam satu transaksi. */
export async function transaction(handler) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await handler(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
