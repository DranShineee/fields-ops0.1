import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import session from 'express-session';
import mysqlStoreFactory from 'express-mysql-session';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool } from './db.js';
import {
  attachContext,
  csrfProtection,
  flashMessages,
  loadUser,
  viewLocals,
} from './middleware/web.js';
import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import customerRoutes from './routes/customer.js';
import technicianRoutes from './routes/technician.js';
import adminRoutes from './routes/admin.js';
import fileRoutes from './routes/files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const uploadDir = path.resolve(rootDir, config.uploads.dir);
const privateDir = path.resolve(rootDir, config.privateStorage);

/** FS serverless bisa read-only; folder dibuat best-effort saja. */
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    if (!config.isServerless) throw error;
    console.warn('[fieldsops] folder tidak bisa dibuat:', dir, error.code);
  }
}

for (const dir of ['dokumen', 'bukti', 'pekerjaan']) ensureDir(path.join(privateDir, dir));
ensureDir(uploadDir);

const app = express();
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.resolve(rootDir, 'views'));
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(
  express.static(path.resolve(rootDir, 'public'), {
    maxAge: config.isProduction ? '7d' : 0,
    etag: true,
  }),
);
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const MySQLStore = mysqlStoreFactory(session);
const sessionStore = new MySQLStore(
  {
    createDatabaseTable: true,
    schema: { tableName: 'sessions' },
    expiration: 7 * 24 * 60 * 60 * 1000,
    // Timer pembersihan tidak cocok untuk serverless (tidak ada proses panjang).
    clearExpired: !config.isServerless,
    checkExpirationInterval: config.isServerless ? 0 : 15 * 60 * 1000,
  },
  pool,
);

app.use(
  session({
    key: 'fieldsops.sid',
    secret: config.sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);

app.use(loadUser);
app.use(attachContext);
app.use(flashMessages);
app.use(viewLocals);
app.use(csrfProtection);

app.use(config.uploads.publicPath, express.static(uploadDir, { index: false, dotfiles: 'deny' }));

app.use(authRoutes);
app.use(fileRoutes);
app.use(catalogRoutes);
app.use(customerRoutes);
app.use('/teknisi', technicianRoutes);
app.use('/admin', adminRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), env: config.env });
});

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Halaman tidak ditemukan',
    status: 404,
    message: 'Alamat yang Anda buka tidak tersedia atau sudah dipindahkan.',
  });
});

app.use((error, req, res, next) => {
  console.error('[fieldsops]', error);
  if (res.headersSent) return next(error);
  const status = error.status || 500;
  if (status === 422) {
    req.session.flash = { type: 'error', message: error.message };
    return res.redirect(req.get('referer') || '/');
  }
  res.status(status).render('error', {
    title: 'Terjadi kesalahan',
    status,
    message:
      status === 500
        ? 'Permintaan tidak dapat diproses saat ini. Silakan coba beberapa saat lagi.'
        : error.message,
  });
});

export default app;
