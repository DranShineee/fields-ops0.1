import path from 'node:path';
import express from 'express';
import { queryOne } from '../db.js';
import { ah } from '../middleware/web.js';
import { requireAuth } from '../middleware/auth.js';
import { privateDir } from '../utils/uploads.js';

const router = express.Router();
const KINDS = new Set(['dokumen', 'bukti', 'pekerjaan']);

/**
 * Berkas privat: dokumen identitas hanya untuk admin & pemilik, bukti bayar
 * untuk customer terkait & admin, bukti pekerjaan untuk teknisi/customer terkait.
 */
router.get(
  '/berkas/:kind/:name',
  requireAuth,
  ah(async (req, res) => {
    const { kind, name } = req.params;
    if (!KINDS.has(kind) || !/^[A-Za-z0-9._-]+$/.test(name)) {
      return res.status(404).render('error', { title: 'Berkas tidak ditemukan', status: 404, message: 'Berkas tidak tersedia.' });
    }

    const user = req.session.user;
    const rel = `/berkas/${kind}/${name}`;
    let allowed = user.role === 'admin';

    if (!allowed && kind === 'dokumen') {
      const row = await queryOne('SELECT user_id FROM technician_profiles WHERE document_url = ? LIMIT 1', [rel]);
      allowed = Boolean(row && row.user_id === user.id);
    }

    if (!allowed && kind === 'bukti') {
      const row = await queryOne(
        'SELECT b.customer_id FROM transactions t JOIN bookings b ON b.id = t.booking_id WHERE t.proof_url = ? LIMIT 1',
        [rel],
      );
      allowed = Boolean(row && row.customer_id === user.id);
    }

    if (!allowed && kind === 'pekerjaan') {
      const row = await queryOne(
        `SELECT wo.technician_id, b.customer_id FROM work_orders wo
         JOIN service_orders so ON so.id = wo.service_order_id
         JOIN bookings b ON b.id = so.booking_id
         WHERE wo.evidence_url = ? LIMIT 1`,
        [rel],
      );
      allowed = Boolean(row && (row.technician_id === user.id || row.customer_id === user.id));
    }

    if (!allowed) {
      return res.status(403).render('error', {
        title: 'Akses ditolak',
        status: 403,
        message: 'Berkas ini bukan milik akun Anda.',
      });
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(path.join(privateDir, kind, name), { dotfiles: 'deny' });
  }),
);

export default router;
