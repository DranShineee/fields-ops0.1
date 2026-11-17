import express from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne, transaction } from '../db.js';
import { ah, setFlash, verifyCsrf } from '../middleware/web.js';
import { requireRole, requireApprovedTechnician } from '../middleware/auth.js';
import { logAudit, logStatus } from '../utils/audit.js';
import { notify } from '../utils/notify.js';
import { uploadPrivate } from '../utils/uploads.js';
import { recalcBookingStatus } from '../utils/bookings.js';
import { DAY_LABELS } from '../utils/format.js';

const router = express.Router();
const techOnly = requireRole('technician');

router.use(techOnly);

function parseAvailability(body) {
  const days = body.day ? (Array.isArray(body.day) ? body.day : [body.day]) : [];
  return days
    .map((day) => Number(day))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .map((day) => ({
      day,
      start: /^\d{2}:\d{2}$/.test(body[`start_${day}`]) ? body[`start_${day}`] : '08:00',
      end: /^\d{2}:\d{2}$/.test(body[`end_${day}`]) ? body[`end_${day}`] : '17:00',
    }))
    .filter((slot) => slot.start < slot.end);
}

router.get(
  '/',
  ah(async (req, res) => {
    const profile = req.technician;
    const techId = req.session.user.id;

    if (!profile || profile.status !== 'approved') {
      return res.redirect('/teknisi/pengajuan');
    }

    const stats = await queryOne(
      `SELECT
        (SELECT COUNT(*) FROM assignments WHERE technician_id = ? AND status = 'offered') AS offers,
        (SELECT COUNT(*) FROM service_orders WHERE technician_id = ? AND status IN ('assigned','in_progress')) AS active_jobs,
        (SELECT COUNT(*) FROM service_orders WHERE technician_id = ? AND status = 'completed') AS completed_jobs,
        (SELECT ROUND(AVG(rating), 1) FROM reviews WHERE technician_id = ? AND is_hidden = 0) AS rating,
        (SELECT COUNT(*) FROM reviews WHERE technician_id = ? AND is_hidden = 0) AS review_count,
        (SELECT COALESCE(SUM(technician_earning), 0) FROM commissions
          WHERE technician_id = ? AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')) AS month_earnings,
        (SELECT COALESCE(SUM(technician_earning), 0) FROM commissions WHERE technician_id = ?) AS total_earnings`,
      [techId, techId, techId, techId, techId, techId, techId],
    );

    const offers = await query(
      `SELECT a.id AS assignment_id, a.created_at AS offered_at, so.*, b.code, b.city, b.scheduled_date, b.scheduled_time
       FROM assignments a
       JOIN service_orders so ON so.id = a.service_order_id
       JOIN bookings b ON b.id = so.booking_id
       WHERE a.technician_id = ? AND a.status = 'offered'
       ORDER BY b.scheduled_date, b.scheduled_time LIMIT 5`,
      [techId],
    );

    const jobs = await query(
      `SELECT so.*, b.code, b.city, b.scheduled_date, b.scheduled_time, wo.status AS work_status
       FROM service_orders so
       JOIN bookings b ON b.id = so.booking_id
       LEFT JOIN work_orders wo ON wo.service_order_id = so.id
       WHERE so.technician_id = ? AND so.status IN ('assigned','in_progress','needs_reschedule')
       ORDER BY b.scheduled_date, b.scheduled_time LIMIT 5`,
      [techId],
    );

    const earnings = await query(
      `SELECT cm.*, so.service_name, b.code FROM commissions cm
       JOIN service_orders so ON so.id = cm.service_order_id
       JOIN bookings b ON b.id = cm.booking_id
       WHERE cm.technician_id = ? ORDER BY cm.created_at DESC LIMIT 4`,
      [techId],
    );

    const competencyCount = await queryOne(
      `SELECT COUNT(*) AS total FROM technician_competencies WHERE technician_id = ? AND status = 'approved'`,
      [techId],
    );

    const today = await queryOne(
      `SELECT COUNT(*) AS total FROM availability WHERE technician_id = ? AND day_of_week = ? AND is_active = 1`,
      [techId, new Date().getDay()],
    );

    res.render('teknisi/dashboard', {
      title: 'Dasbor teknisi',
      profile,
      stats: stats || {},
      offers,
      jobs,
      earnings,
      competencyCount: Number(competencyCount?.total || 0),
      availableToday: Number(today?.total || 0) > 0,
    });
  }),
);

router.get(
  '/pengajuan',
  ah(async (req, res) => {
    const profile = req.technician;
    const history = await query(
      `SELECT * FROM status_history WHERE entity_type = 'technician' AND entity_id = ?
       ORDER BY created_at DESC LIMIT 10`,
      [req.session.user.id],
    );
    const categories = await query('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order');
    const competencies = await query(
      `SELECT tc.*, c.name FROM technician_competencies tc JOIN categories c ON c.id = tc.category_id
       WHERE tc.technician_id = ?`,
      [req.session.user.id],
    );
    res.render('teknisi/pengajuan', {
      title: 'Pengajuan kemitraan',
      profile,
      history,
      categories,
      competencies,
      errors: {},
    });
  }),
);

router.post(
  '/pengajuan',
  uploadPrivate.single('document'),
  verifyCsrf,
  ah(async (req, res) => {
    const profile = req.technician;
    if (profile?.status === 'approved') {
      setFlash(req, 'info', 'Kemitraan Anda sudah disetujui.');
      return res.redirect('/teknisi');
    }

    const bio = String(req.body.bio || '').trim();
    const experience = Number(req.body.experience_years);
    const area = String(req.body.service_area || '').trim();
    const ktp = String(req.body.ktp_number || '').replace(/\D/g, '');
    const errors = {};

    if (bio.length < 30) errors.bio = 'Ceritakan pengalaman Anda minimal 30 karakter.';
    if (!Number.isInteger(experience) || experience < 0 || experience > 60) errors.experience = 'Isi pengalaman 0–60 tahun.';
    if (area.length < 3) errors.area = 'Area kerja wajib diisi.';
    if (!/^\d{16}$/.test(ktp)) errors.ktp = 'Nomor KTP harus 16 angka.';
    if (!req.file && !profile?.document_url) errors.document = 'Unggah scan KTP atau sertifikat (JPG/PNG/PDF).';

    if (Object.keys(errors).length > 0) {
      const categories = await query('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order');
      const competencies = await query(
        `SELECT tc.*, c.name FROM technician_competencies tc JOIN categories c ON c.id = tc.category_id
         WHERE tc.technician_id = ?`,
        [req.session.user.id],
      );
      return res.status(422).render('teknisi/pengajuan', {
        title: 'Pengajuan kemitraan',
        profile: { ...profile, ...{ bio, experience_years: experience, service_area: area, ktp_number: ktp } },
        history: [],
        categories,
        competencies,
        errors,
      });
    }

    const documentUrl = req.file ? `/berkas/dokumen/${req.file.filename}` : profile.document_url;
    const previous = profile?.status || null;

    await query(
      `UPDATE technician_profiles
       SET bio = ?, experience_years = ?, service_area = ?, ktp_number = ?, document_url = ?,
           status = 'under_review', review_note = NULL, submitted_at = NOW()
       WHERE user_id = ?`,
      [bio, experience, area, ktp, documentUrl, req.session.user.id],
    );
    await logStatus(req, {
      entityType: 'technician',
      entityId: req.session.user.id,
      fromStatus: previous,
      toStatus: 'under_review',
      note: 'Teknisi mengirim pengajuan kemitraan',
    });
    await logAudit(req, {
      action: 'technician.application_submitted',
      entity: 'technician',
      entityId: req.session.user.id,
      description: 'Pengajuan kemitraan dikirim untuk diverifikasi',
    });

    const admins = await query("SELECT id FROM users WHERE role = 'admin' AND is_active = 1");
    for (const admin of admins) {
      await notify(admin.id, 'Pengajuan teknisi masuk', `${req.session.user.name} mengirim pengajuan kemitraan.`, '/admin/verifikasi');
    }

    setFlash(req, 'success', 'Pengajuan terkirim. Admin akan meninjau dokumen Anda.');
    res.redirect('/teknisi/pengajuan');
  }),
);

router.get(
  '/profil',
  ah(async (req, res) => {
    const profile = req.technician;
    res.render('teknisi/profil', {
      title: 'Profil teknisi',
      profile,
      form: { name: req.session.user.name, phone: req.session.user.phone, ...profile },
      errors: {},
    });
  }),
);

router.post(
  '/profil',
  ah(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const bio = String(req.body.bio || '').trim();
    const area = String(req.body.service_area || '').trim();
    const experience = Number(req.body.experience_years);
    const errors = {};

    if (name.length < 3) errors.name = 'Nama minimal 3 karakter.';
    if (!/^[0-9+\-\s()]{8,24}$/.test(phone)) errors.phone = 'Nomor WhatsApp tidak valid.';
    if (bio.length > 400) errors.bio = 'Bio maksimal 400 karakter.';
    if (!Number.isInteger(experience) || experience < 0 || experience > 60) errors.experience = 'Pengalaman 0–60 tahun.';

    if (Object.keys(errors).length > 0) {
      return res.status(422).render('teknisi/profil', {
        title: 'Profil teknisi',
        profile: req.technician,
        form: { name, phone, bio, service_area: area, experience_years: experience },
        errors,
      });
    }

    await query('UPDATE users SET name = ?, phone = ? WHERE id = ?', [name, phone, req.session.user.id]);
    await query(
      'UPDATE technician_profiles SET bio = ?, service_area = ?, experience_years = ? WHERE user_id = ?',
      [bio || null, area || null, experience, req.session.user.id],
    );
    req.session.user.name = name;
    req.session.user.phone = phone;
    await logAudit(req, {
      action: 'technician.profile_updated',
      entity: 'technician',
      entityId: req.session.user.id,
      description: 'Teknisi memperbarui profil',
    });
    setFlash(req, 'success', 'Profil diperbarui.');
    res.redirect('/teknisi/profil');
  }),
);

router.get(
  '/kompetensi',
  ah(async (req, res) => {
    const categories = await query('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order');
    const competencies = await query(
      `SELECT tc.*, c.name, c.description FROM technician_competencies tc
       JOIN categories c ON c.id = tc.category_id WHERE tc.technician_id = ? ORDER BY c.sort_order`,
      [req.session.user.id],
    );
    res.render('teknisi/kompetensi', { title: 'Kompetensi', categories, competencies });
  }),
);

router.post(
  '/kompetensi',
  ah(async (req, res) => {
    const categoryId = Number(req.body.category_id);
    const category = await queryOne('SELECT * FROM categories WHERE id = ? AND is_active = 1', [categoryId]);
    if (!category) {
      setFlash(req, 'error', 'Kategori tidak ditemukan.');
      return res.redirect('/teknisi/kompetensi');
    }
    const existing = await queryOne(
      'SELECT * FROM technician_competencies WHERE technician_id = ? AND category_id = ?',
      [req.session.user.id, categoryId],
    );
    if (existing) {
      setFlash(req, 'info', `Kompetensi ${category.name} sudah ada (${existing.status}).`);
      return res.redirect('/teknisi/kompetensi');
    }

    await query(
      `INSERT INTO technician_competencies (technician_id, category_id, status) VALUES (?, ?, 'pending')`,
      [req.session.user.id, categoryId],
    );
    const admins = await query("SELECT id FROM users WHERE role = 'admin' AND is_active = 1");
    for (const admin of admins) {
      await notify(admin.id, 'Kompetensi baru diajukan', `${req.session.user.name} mengajukan kategori ${category.name}.`, '/admin/verifikasi');
    }
    await logAudit(req, {
      action: 'competency.requested',
      entity: 'technician',
      entityId: req.session.user.id,
      description: `Mengajukan kompetensi ${category.name}`,
    });
    setFlash(req, 'success', `Kompetensi ${category.name} diajukan. Menunggu persetujuan admin.`);
    res.redirect('/teknisi/kompetensi');
  }),
);

router.post(
  '/kompetensi/:id/hapus',
  ah(async (req, res) => {
    const row = await queryOne(
      'SELECT * FROM technician_competencies WHERE id = ? AND technician_id = ?',
      [req.params.id, req.session.user.id],
    );
    if (!row) {
      setFlash(req, 'error', 'Kompetensi tidak ditemukan.');
      return res.redirect('/teknisi/kompetensi');
    }
    if (row.status === 'approved') {
      setFlash(req, 'error', 'Kompetensi yang sudah disetujui tidak bisa dihapus sendiri. Hubungi admin.');
      return res.redirect('/teknisi/kompetensi');
    }
    await query('DELETE FROM technician_competencies WHERE id = ?', [row.id]);
    setFlash(req, 'success', 'Pengajuan kompetensi dibatalkan.');
    res.redirect('/teknisi/kompetensi');
  }),
);

router.get(
  '/ketersediaan',
  ah(async (req, res) => {
    const slots = await query('SELECT * FROM availability WHERE technician_id = ? ORDER BY day_of_week', [req.session.user.id]);
    res.render('teknisi/ketersediaan', { title: 'Ketersediaan', slots, days: DAY_LABELS });
  }),
);

router.post(
  '/ketersediaan',
  ah(async (req, res) => {
    const slots = parseAvailability(req.body);
    await transaction(async (connection) => {
      await connection.execute('DELETE FROM availability WHERE technician_id = ?', [req.session.user.id]);
      for (const slot of slots) {
        await connection.execute(
          'INSERT INTO availability (technician_id, day_of_week, start_time, end_time, is_active) VALUES (?, ?, ?, ?, 1)',
          [req.session.user.id, slot.day, `${slot.start}:00`, `${slot.end}:00`],
        );
      }
    });
    await query('UPDATE technician_profiles SET is_available = ? WHERE user_id = ?', [slots.length > 0 ? 1 : 0, req.session.user.id]);
    await logAudit(req, {
      action: 'availability.updated',
      entity: 'technician',
      entityId: req.session.user.id,
      description: `Ketersediaan diperbarui (${slots.length} hari)`,
    });
    setFlash(req, 'success', 'Ketersediaan disimpan.');
    res.redirect('/teknisi/ketersediaan');
  }),
);

router.get(
  '/penugasan',
  requireApprovedTechnician,
  ah(async (req, res) => {
    const offers = await query(
      `SELECT a.id AS assignment_id, a.created_at AS offered_at, so.*, b.code, b.city, b.address,
              b.scheduled_date, b.scheduled_time, b.notes
       FROM assignments a
       JOIN service_orders so ON so.id = a.service_order_id
       JOIN bookings b ON b.id = so.booking_id
       WHERE a.technician_id = ? AND a.status = 'offered'
       ORDER BY b.scheduled_date, b.scheduled_time`,
      [req.session.user.id],
    );
    const history = await query(
      `SELECT a.*, so.service_name, b.code FROM assignments a
       JOIN service_orders so ON so.id = a.service_order_id
       JOIN bookings b ON b.id = so.booking_id
       WHERE a.technician_id = ? AND a.status <> 'offered'
       ORDER BY a.created_at DESC LIMIT 10`,
      [req.session.user.id],
    );
    res.render('teknisi/penugasan', { title: 'Penugasan masuk', offers, history });
  }),
);

router.post(
  '/penugasan/:id/terima',
  requireApprovedTechnician,
  ah(async (req, res) => {
    const assignment = await queryOne(
      `SELECT a.*, so.booking_id, so.service_name FROM assignments a
       JOIN service_orders so ON so.id = a.service_order_id
       WHERE a.id = ? AND a.technician_id = ? AND a.status = 'offered'`,
      [req.params.id, req.session.user.id],
    );
    if (!assignment) {
      setFlash(req, 'error', 'Penawaran tidak ditemukan atau sudah diproses.');
      return res.redirect('/teknisi/penugasan');
    }

    await transaction(async (connection) => {
      await connection.execute(
        `UPDATE assignments SET status = 'accepted', responded_at = NOW() WHERE id = ?`,
        [assignment.id],
      );
      await connection.execute(`UPDATE service_orders SET status = 'assigned' WHERE id = ?`, [assignment.service_order_id]);
      await connection.execute(
        `INSERT INTO work_orders (service_order_id, technician_id, instructions, status)
         VALUES (?, ?, ?, 'assigned')
         ON DUPLICATE KEY UPDATE technician_id = VALUES(technician_id)`,
        [assignment.service_order_id, req.session.user.id, 'Kerjakan sesuai cakupan layanan.'],
      );
    });

    await recalcBookingStatus(assignment.booking_id);
    await logStatus(req, {
      entityType: 'service_order',
      entityId: assignment.service_order_id,
      fromStatus: 'awaiting_assignment',
      toStatus: 'assigned',
      note: 'Teknisi menerima penugasan',
    });
    await logAudit(req, {
      action: 'assignment.accepted',
      entity: 'assignment',
      entityId: assignment.id,
      description: `Menerima penugasan ${assignment.service_name}`,
    });

    const customer = await queryOne(
      'SELECT b.customer_id, b.code FROM bookings b WHERE b.id = ?',
      [assignment.booking_id],
    );
    await notify(customer.customer_id, 'Teknisi sudah ditugaskan', `${req.session.user.name} akan mengerjakan ${assignment.service_name}.`, `/booking/${customer.code}`);
    const admins = await query("SELECT id FROM users WHERE role = 'admin' AND is_active = 1");
    for (const admin of admins) {
      await notify(admin.id, 'Penugasan diterima', `${req.session.user.name} menerima ${assignment.service_name}.`, '/admin/penugasan');
    }

    setFlash(req, 'success', 'Penugasan diterima. Cek detail pekerjaan sebelum berangkat.');
    res.redirect('/teknisi/pekerjaan');
  }),
);

router.post(
  '/penugasan/:id/tolak',
  requireApprovedTechnician,
  ah(async (req, res) => {
    const assignment = await queryOne(
      `SELECT a.*, so.booking_id, so.service_name FROM assignments a
       JOIN service_orders so ON so.id = a.service_order_id
       WHERE a.id = ? AND a.technician_id = ? AND a.status = 'offered'`,
      [req.params.id, req.session.user.id],
    );
    const reason = String(req.body.reason || '').trim();
    if (!assignment) {
      setFlash(req, 'error', 'Penawaran tidak ditemukan atau sudah diproses.');
      return res.redirect('/teknisi/penugasan');
    }
    if (reason.length < 5) {
      setFlash(req, 'error', 'Tuliskan alasan penolakan minimal 5 karakter.');
      return res.redirect('/teknisi/penugasan');
    }

    await transaction(async (connection) => {
      await connection.execute(
        `UPDATE assignments SET status = 'rejected', reason = ?, responded_at = NOW() WHERE id = ?`,
        [reason.slice(0, 300), assignment.id],
      );
      await connection.execute(
        `UPDATE service_orders SET status = 'awaiting_assignment', technician_id = NULL WHERE id = ?`,
        [assignment.service_order_id],
      );
      await connection.execute('DELETE FROM work_orders WHERE service_order_id = ?', [assignment.service_order_id]);
    });
    await recalcBookingStatus(assignment.booking_id);
    await logAudit(req, {
      action: 'assignment.rejected',
      entity: 'assignment',
      entityId: assignment.id,
      description: `Menolak penugasan ${assignment.service_name}: ${reason.slice(0, 150)}`,
    });

    const admins = await query("SELECT id FROM users WHERE role = 'admin' AND is_active = 1");
    for (const admin of admins) {
      await notify(admin.id, 'Penugasan ditolak', `${req.session.user.name} menolak ${assignment.service_name}.`, '/admin/penugasan');
    }

    setFlash(req, 'info', 'Penugasan ditolak. Admin akan mencari teknisi lain.');
    res.redirect('/teknisi/penugasan');
  }),
);

router.get(
  '/pekerjaan',
  requireApprovedTechnician,
  ah(async (req, res) => {
    const jobs = await query(
      `SELECT so.*, b.code, b.city, b.address, b.scheduled_date, b.scheduled_time, b.notes,
              wo.id AS work_order_id, wo.status AS work_status, wo.evidence_url
       FROM service_orders so
       JOIN bookings b ON b.id = so.booking_id
       LEFT JOIN work_orders wo ON wo.service_order_id = so.id
       WHERE so.technician_id = ? AND so.status IN ('assigned','in_progress','needs_reschedule')
       ORDER BY b.scheduled_date, b.scheduled_time`,
      [req.session.user.id],
    );
    const submitted = await query(
      `SELECT so.*, b.code, wo.status AS work_status FROM service_orders so
       JOIN bookings b ON b.id = so.booking_id
       JOIN work_orders wo ON wo.service_order_id = so.id
       WHERE so.technician_id = ? AND wo.status = 'submitted_for_review'
       ORDER BY so.updated_at DESC LIMIT 10`,
      [req.session.user.id],
    );
    res.render('teknisi/pekerjaan', { title: 'Pekerjaan aktif', jobs, submitted });
  }),
);

router.get(
  '/pekerjaan/:id',
  requireApprovedTechnician,
  ah(async (req, res) => {
    const job = await queryOne(
      `SELECT so.*, b.id AS booking_id, b.code, b.customer_id, b.address, b.city, b.postal_code,
              b.scheduled_date, b.scheduled_time, b.notes, b.payment_method, b.payment_status,
              u.name AS customer_name, u.phone AS customer_phone
       FROM service_orders so
       JOIN bookings b ON b.id = so.booking_id
       JOIN users u ON u.id = b.customer_id
       WHERE so.id = ? AND so.technician_id = ? LIMIT 1`,
      [req.params.id, req.session.user.id],
    );
    if (!job) {
      return res.status(404).render('error', {
        title: 'Pekerjaan tidak ditemukan',
        status: 404,
        message: 'Pekerjaan ini bukan milik Anda atau sudah dialihkan.',
      });
    }

    const work = await queryOne('SELECT * FROM work_orders WHERE service_order_id = ?', [job.id]);
    const history = await query(
      `SELECT sh.*, u.name AS actor_name FROM status_history sh LEFT JOIN users u ON u.id = sh.actor_id
       WHERE (sh.entity_type = 'service_order' AND sh.entity_id = ?)
          OR (sh.entity_type = 'work_order' AND sh.entity_id = ?)
       ORDER BY sh.created_at`,
      [job.id, work?.id || 0],
    );

    res.render('teknisi/pekerjaan-detail', {
      title: `Pekerjaan ${job.service_name}`,
      job,
      work,
      history,
      canEdit: job.status !== 'completed' && job.status !== 'cancelled',
    });
  }),
);

router.post(
  '/pekerjaan/:id/status',
  requireApprovedTechnician,
  ah(async (req, res) => {
    const action = String(req.body.action || '');
    const job = await queryOne(
      `SELECT so.*, b.id AS booking_id, b.code, b.customer_id FROM service_orders so
       JOIN bookings b ON b.id = so.booking_id
       WHERE so.id = ? AND so.technician_id = ? LIMIT 1`,
      [req.params.id, req.session.user.id],
    );
    const work = job ? await queryOne('SELECT * FROM work_orders WHERE service_order_id = ?', [job.id]) : null;
    if (!job || !work) {
      setFlash(req, 'error', 'Pekerjaan tidak ditemukan.');
      return res.redirect('/teknisi/pekerjaan');
    }
    if (job.status === 'completed') {
      setFlash(req, 'info', 'Pekerjaan ini sudah selesai.');
      return res.redirect(`/teknisi/pekerjaan/${job.id}`);
    }

    const note = String(req.body.note || '').trim();

    if (action === 'terima') {
      await query(`UPDATE work_orders SET status = 'accepted' WHERE id = ?`, [work.id]);
      await logStatus(req, { entityType: 'work_order', entityId: work.id, fromStatus: work.status, toStatus: 'accepted', note: 'Teknisi menerima work order' });
      setFlash(req, 'success', 'Work order diterima.');
    } else if (action === 'mulai') {
      await query(`UPDATE work_orders SET status = 'in_progress', started_at = COALESCE(started_at, NOW()) WHERE id = ?`, [work.id]);
      await query(`UPDATE service_orders SET status = 'in_progress' WHERE id = ?`, [job.id]);
      await recalcBookingStatus(job.booking_id);
      await logStatus(req, { entityType: 'work_order', entityId: work.id, fromStatus: work.status, toStatus: 'in_progress', note: 'Pekerjaan dimulai' });
      await logStatus(req, { entityType: 'service_order', entityId: job.id, fromStatus: job.status, toStatus: 'in_progress', note: 'Teknisi mulai bekerja' });
      await notify(job.customer_id, 'Pekerjaan dimulai', `${req.session.user.name} mulai mengerjakan ${job.service_name}.`, `/booking/${job.code}`);
      await logAudit(req, { action: 'work_order.started', entity: 'work_order', entityId: work.id, description: `Memulai ${job.service_name}` });
      setFlash(req, 'success', 'Pekerjaan ditandai berjalan.');
    } else if (action === 'terhambat') {
      if (note.length < 10) {
        setFlash(req, 'error', 'Jelaskan hambatan minimal 10 karakter agar admin bisa membantu.');
        return res.redirect(`/teknisi/pekerjaan/${job.id}`);
      }
      await query(`UPDATE work_orders SET status = 'blocked', findings = ? WHERE id = ?`, [note.slice(0, 600), work.id]);
      await logStatus(req, { entityType: 'work_order', entityId: work.id, fromStatus: work.status, toStatus: 'blocked', note: note.slice(0, 200) });
      const admins = await query("SELECT id FROM users WHERE role = 'admin' AND is_active = 1");
      for (const admin of admins) {
        await notify(admin.id, 'Pekerjaan terhambat', `${job.service_name} (${job.code}): ${note.slice(0, 120)}`, `/admin/work-order`);
      }
      setFlash(req, 'info', 'Hambatan dilaporkan ke admin.');
    } else if (action === 'ajukan') {
      const actions = String(req.body.actions_taken || '').trim();
      const findings = String(req.body.findings || '').trim();
      if (actions.length < 10) {
        setFlash(req, 'error', 'Tuliskan tindakan yang sudah dilakukan minimal 10 karakter.');
        return res.redirect(`/teknisi/pekerjaan/${job.id}`);
      }
      await query(
        `UPDATE work_orders SET status = 'submitted_for_review', actions_taken = ?, findings = ?, completed_at = NOW() WHERE id = ?`,
        [actions.slice(0, 600), findings.slice(0, 600) || null, work.id],
      );
      await logStatus(req, { entityType: 'work_order', entityId: work.id, fromStatus: work.status, toStatus: 'submitted_for_review', note: 'Teknisi mengajukan hasil pekerjaan' });
      const admins = await query("SELECT id FROM users WHERE role = 'admin' AND is_active = 1");
      for (const admin of admins) {
        await notify(admin.id, 'Hasil pekerjaan menunggu tinjauan', `${job.service_name} (${job.code}) diajukan teknisi.`, `/admin/work-order`);
      }
      await logAudit(req, { action: 'work_order.submitted', entity: 'work_order', entityId: work.id, description: `Mengajukan hasil ${job.service_name}` });
      setFlash(req, 'success', 'Hasil pekerjaan dikirim ke admin untuk ditinjau.');
    } else {
      setFlash(req, 'error', 'Aksi tidak dikenali.');
    }

    res.redirect(`/teknisi/pekerjaan/${job.id}`);
  }),
);

router.post(
  '/pekerjaan/:id/bukti',
  requireApprovedTechnician,
  (req, res, next) => {
    req.uploadKind = 'pekerjaan';
    next();
  },
  uploadPrivate.single('evidence'),
  verifyCsrf,
  ah(async (req, res) => {
    const job = await queryOne(
      'SELECT so.*, b.code FROM service_orders so JOIN bookings b ON b.id = so.booking_id WHERE so.id = ? AND so.technician_id = ?',
      [req.params.id, req.session.user.id],
    );
    const work = job ? await queryOne('SELECT * FROM work_orders WHERE service_order_id = ?', [job.id]) : null;
    if (!job || !work) {
      setFlash(req, 'error', 'Pekerjaan tidak ditemukan.');
      return res.redirect('/teknisi/pekerjaan');
    }
    if (!req.file) {
      setFlash(req, 'error', 'Pilih berkas bukti pekerjaan (JPG/PNG/PDF, maks 3 MB).');
      return res.redirect(`/teknisi/pekerjaan/${job.id}`);
    }

    await query('UPDATE work_orders SET evidence_url = ? WHERE id = ?', [`/berkas/pekerjaan/${req.file.filename}`, work.id]);
    await logAudit(req, {
      action: 'work_order.evidence_uploaded',
      entity: 'work_order',
      entityId: work.id,
      description: `Bukti pekerjaan diunggah untuk ${job.service_name}`,
    });
    await notify(job.customer_id, 'Bukti pekerjaan diunggah', `Teknisi menambahkan foto/bukti untuk ${job.service_name}.`, `/booking/${job.code}`);
    setFlash(req, 'success', 'Bukti pekerjaan diunggah.');
    res.redirect(`/teknisi/pekerjaan/${job.id}`);
  }),
);

router.get(
  '/riwayat',
  ah(async (req, res) => {
    const jobs = await query(
      `SELECT so.*, b.code, b.scheduled_date, b.city, r.rating, r.comment, cm.technician_earning
       FROM service_orders so
       JOIN bookings b ON b.id = so.booking_id
       LEFT JOIN reviews r ON r.service_order_id = so.id
       LEFT JOIN commissions cm ON cm.service_order_id = so.id
       WHERE so.technician_id = ? AND so.status = 'completed'
       ORDER BY so.updated_at DESC LIMIT 50`,
      [req.session.user.id],
    );
    res.render('teknisi/riwayat', { title: 'Riwayat pekerjaan', jobs });
  }),
);

router.get(
  '/pendapatan',
  ah(async (req, res) => {
    const techId = req.session.user.id;
    const summary = await queryOne(
      `SELECT COALESCE(SUM(technician_earning), 0) AS total,
              COALESCE(SUM(CASE WHEN created_at >= DATE_FORMAT(NOW(), '%Y-%m-01') THEN technician_earning END), 0) AS this_month,
              COALESCE(SUM(platform_fee), 0) AS fees,
              COUNT(*) AS jobs
       FROM commissions WHERE technician_id = ?`,
      [techId],
    );
    const rows = await query(
      `SELECT cm.*, so.service_name, b.code, b.scheduled_date
       FROM commissions cm
       JOIN service_orders so ON so.id = cm.service_order_id
       JOIN bookings b ON b.id = cm.booking_id
       WHERE cm.technician_id = ? ORDER BY cm.created_at DESC LIMIT 100`,
      [techId],
    );
    const monthly = await query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') AS period, SUM(technician_earning) AS amount, COUNT(*) AS jobs
       FROM commissions WHERE technician_id = ? GROUP BY period ORDER BY period DESC LIMIT 6`,
      [techId],
    );
    res.render('teknisi/pendapatan', { title: 'Pendapatan', summary: summary || {}, rows, monthly });
  }),
);

router.get(
  '/pengaturan',
  ah(async (req, res) => {
    res.render('teknisi/pengaturan', { title: 'Pengaturan akun' });
  }),
);

router.post(
  '/pengaturan',
  ah(async (req, res) => {
    const user = await queryOne('SELECT password_hash FROM users WHERE id = ?', [req.session.user.id]);
    const current = String(req.body.current_password || '');
    const next = String(req.body.new_password || '');
    const confirm = String(req.body.confirm_password || '');

    if (!(await bcrypt.compare(current, user.password_hash))) {
      setFlash(req, 'error', 'Kata sandi saat ini tidak cocok.');
      return res.redirect('/teknisi/pengaturan');
    }
    if (next.length < 8 || !/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) {
      setFlash(req, 'error', 'Kata sandi baru minimal 8 karakter dan mengandung huruf serta angka.');
      return res.redirect('/teknisi/pengaturan');
    }
    if (next !== confirm) {
      setFlash(req, 'error', 'Konfirmasi kata sandi baru tidak sama.');
      return res.redirect('/teknisi/pengaturan');
    }

    await query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(next, 12), req.session.user.id]);
    await logAudit(req, { action: 'password.changed', entity: 'user', entityId: req.session.user.id, description: 'Teknisi mengganti kata sandi' });
    setFlash(req, 'success', 'Kata sandi diperbarui.');
    res.redirect('/teknisi/pengaturan');
  }),
);

export default router;
