import 'dotenv/config';

function toInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value !== '' && value !== undefined && value !== null
    ? parsed
    : fallback;
}

const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';

export const config = {
  env,
  isProduction,
  port: toInt(process.env.PORT, 3000),
  sessionSecret: process.env.SESSION_SECRET || 'fieldsops-development-secret-change-me',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: toInt(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'fieldsops',
    connectionLimit: toInt(process.env.DB_POOL, 10),
  },
  uploads: {
    dir: process.env.UPLOAD_DIR || 'public/uploads',
    publicPath: '/uploads',
    maxBytes: toInt(process.env.UPLOAD_MAX_BYTES, 3 * 1024 * 1024),
  },
  /** Folder berkas privat (bukti bayar, dokumen, bukti pekerjaan). */
  privateStorage: process.env.STORAGE_DIR || 'storage/private',
  /** Vercel/Lambda: filesystem hanya bisa ditulis di /tmp dan bersifat sementara. */
  isServerless: Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME),
};

if (isProduction && config.sessionSecret === 'fieldsops-development-secret-change-me') {
  throw new Error('SESSION_SECRET wajib diisi saat NODE_ENV=production.');
}
