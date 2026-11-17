import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, '..');
export const privateDir = path.resolve(rootDir, '..', config.privateStorage);

export const UPLOAD_KINDS = {
  dokumen: 'dokumen',
  bukti: 'bukti',
  pekerjaan: 'pekerjaan',
};

for (const kind of ['dokumen', 'bukti', 'pekerjaan']) {
  try {
    fs.mkdirSync(path.join(privateDir, kind), { recursive: true });
  } catch (error) {
    if (!config.isServerless) throw error;
    console.warn('[fieldsops] folder unggahan tidak bisa dibuat:', kind, error.code);
  }
}

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const requested = req.uploadKind || req.params.kind;
    const kind = UPLOAD_KINDS[requested] || UPLOAD_KINDS.dokumen;
    cb(null, path.join(privateDir, kind));
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
    const random = Math.random().toString(36).slice(2, 10);
    cb(null, `${Date.now()}-${random}${ext}`);
  },
});

export const uploadPrivate = multer({
  storage,
  limits: { fileSize: config.uploads.maxBytes, files: 1 },
  fileFilter(req, file, cb) {
    if (!ALLOWED.has(file.mimetype)) {
      const error = new Error('Format berkas harus JPG, PNG, WebP, atau PDF.');
      error.status = 422;
      return cb(error);
    }
    cb(null, true);
  },
});
