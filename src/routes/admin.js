import express from 'express';
import { query, queryOne, transaction } from '../db.js';
import { ah, setFlash } from '../middleware/web.js';
import { requireRole } from '../middleware/auth.js';
import { logAudit, logStatus } from '../utils/audit.js';
import { notify } from '../utils/notify.js';
import { commissionFor } from '../utils/pricing.js';
import { recalcBookingStatus, loadBookingDetail } from '../utils/bookings.js';
import { paginate, pageCount } from '../utils/pagination.js';
import { getSettings, saveSettings, clearSettingsCache } from '../utils/settings.js';

const router = express.Router();
router.use(requireRole('admin'));

function adminIds() {
  return query("SELECT id FROM users WHERE role = 'admin' AND is_active = 1");
}

async function pendingCounts() {
  return queryOne(
    `SELECT
      (SELECT COUNT(*) FROM technician_profiles WHERE status IN ('pending','under_review')) AS verifications,
      (SELECT COUNT(*) FROM transactions WHERE status = 'pending_verification') AS payments,
      (SELECT COUNT(*) FROM complaints WHERE status IN ('open','in_review')) AS complaints,
      (SELECT COUNT(*) FROM service_orders WHERE status = 'awaiting_assignment') AS unassigned,
      (SELECT COUNT(*) FROM work_orders WHERE status = 'submitted_for_review') AS reviews`,
  );
}

router.get(
  '/',
  ah(async (req, res) => {
    const counts = await pendingCounts();
    const revenue = await queryOne(
      `SELECT COALESCE(SUM(amount), 0) AS paid,
              COALESCE(SUM(CASE WHEN created_at >= DATE_FORMAT(NOW(), '%Y-%m-01') THEN amount END), 0) AS this_month
       FROM transactions WHERE status = 'paid'`,
    );
    const bookingStats = await queryOne(
      `SELECT COUNT(*) AS total,
              SUM(status = 'submitted') AS submitted,
              SUM(status = 'processing') AS processing,
              SUM(status = 'in_progress') AS in_progress,
              SUM(status = 'completed') AS completed,
              SUM(status = 'cancelled') AS cancelled
       FROM bookings`,
    );
    const recentBookings = await query(
      `SELECT b.*, u.name AS customer_name,
              (SELECT COUNT(*) FROM service_orders so WHERE so.booking_id = b.id) AS item_count
       FROM bookings b JOIN users u ON u.id = b.customer_id
       ORDER BY b.created_at DESC LIMIT 6`,
    );
    const topTechs = await query(
      `SELECT u.name, tp.status, COUNT(so.id) AS jobs,
              COALESCE(ROUND(AVG(r.rating), 1), 0) AS rating
       FROM users u JOIN technician_profiles tp ON tp.user_id = u.id
       LEFT JOIN service_orders so ON so.technician_id = u.id AND so.status = 'completed'
       LEFT JOIN reviews r ON r.technician_id = u.id AND r.is_hidden = 0
       WHERE u.role = 'technician' AND tp.status = 'approved'
       GROUP BY u.id ORDER BY jobs DESC LIMIT 5`,
    );
    const pending = await query(
      `SELECT so.*, b.code, c.name AS category_name
       FROM service_orders so
       JOIN bookings b ON b.id = so.booking_id
       JOIN services s ON s.id = so.service_id
       JOIN categories c ON c.id = s.category_id
       WHERE so.status = 'awaiting_assignment'
       ORDER BY b.scheduled_date LIMIT 5`,
    );
    const recentAudit = await query(
      `SELECT a.*, u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       ORDER BY a.created_at DESC LIMIT 6`,
    );

    res.render('admin/dashboard', {
      title: 'Dasbor admin',
      counts,
      revenue: revenue || {},
      bookingStats: bookingStats || {},
      recentBookings,
      topTechs,
      pending,
      recentAudit,
    });
  }),
);

router.get(
  '/pengguna',
  ah(async (req, res) => {
    const { page, per, offset } = paginate(req.query, { defaultPer: 12 });
    const filters = {
      q: String(req.query.q || '').trim(),
      role: ['customer', 'technician', 'admin'].includes(req.query.role) ? req.query.role : '',
      status: req.query.status === 'aktif' ? 'aktif' : req.query.status === 'nonaktif' ? 'nonaktif' : '',
    };
    const where = ['1 = 1'];
    const params = [];
    if (filters.q) {
      where.push('(u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)');
      const like = `%${filters.q}%`;
      params.push(like, like, like);
    }
    if (filters.role) {
      where.push('u.role = ?');
      params.push(filters.role);
    }
    if (filters.status) {
      where.push('u.is_active = ?');
      params.push(filters.status === 'aktif' ? 1 : 0);
    }
    const whereSql = where.join(' AND ');

    const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM users u WHERE ${whereSql}`, params);
    const total = Number(totalRow?.total || 0);
    const users = await query(
      `SELECT u.*, tp.status AS tech_status, tp.service_area,
              (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = u.id) AS booking_count,
              (SELECT COUNT(*) FROM service_orders so WHERE so.technician_id = u.id AND so.status = 'completed') AS job_count
       FROM users u LEFT JOIN technician_profiles tp ON tp.user_id = u.id
       WHERE ${whereSql}
       ORDER BY u.created_at DESC LIMIT ${per} OFFSET ${offset}`,
      params,
    );

    res.render('admin/users', {
      title: 'Kelola pengguna',
      users,
      filters,
      page,
      per,
      total,
      pages: pageCount(total, per),
    });
  }),
);

router.post(
  '/pengguna/:id/status',
  ah(async (req, res) => {
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      setFlash(req, 'error', 'Pengguna tidak ditemukan.');
      return res.redirect('/admin/pengguna');
    }
    if (user.id === req.session.user.id) {
      setFlash(req, 'error', 'Anda tidak bisa menonaktifkan akun sendiri.');
      return res.redirect('/admin/pengguna');
    }
    if (user.role === 'admin' && user.is_active) {
      const activeAdmins = await queryOne("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND is_active = 1");
      if (Number(activeAdmins.total) <= 1) {
        setFlash(req, 'error', 'Minimal harus ada satu admin aktif.');
        return res.redirect('/admin/pengguna');
      }
    }

    const next = user.is_active ? 0 : 1;
    await query('UPDATE users SET is_active = ? WHERE id = ?', [next, user.id]);
    if (!next) await query('DELETE FROM sessions WHERE data LIKE ?', [`%${user.id}%`]);
    await notify(user.id, next ? 'Akun diaktifkan' : 'Akun dinonaktifkan', next ? 'Anda bisa masuk kembali.' : 'Hubungi admin bila ini keliru.', '/login');
    await logAudit(req, {
      action: next ? 'user.activated' : 'user.deactivated',
      entity: 'user',
      entityId: user.id,
      description: `${next ? 'Mengaktifkan' : 'Menonaktifkan'} akun ${user.email}`,
    });
    setFlash(req, 'success', `Akun ${user.name} ${next ? 'diaktifkan' : 'dinonaktifkan'}.`);
    res.redirect('/admin/pengguna');
  }),
);

router.get(
  '/verifikasi',
  ah(async (req, res) => {
    const profiles = await query(
      `SELECT tp.*, u.name, u.email, u.phone, u.created_at AS registered_at,
              (SELECT COUNT(*) FROM technician_competencies tc WHERE tc.technician_id = tp.user_id AND tc.status = 'approved') AS approved_competencies
       FROM technician_profiles tp JOIN users u ON u.id = tp.user_id
       WHERE tp.status IN ('pending','under_review','revision_required','rejected')
       ORDER BY FIELD(tp.status, 'under_review', 'pending', 'revision_required', 'rejected'), tp.updated_at DESC`,
    );
    const competencies = await query(
      `SELECT tc.*, u.name, c.name AS category_name FROM technician_competencies tc
       JOIN users u ON u.id = tc.technician_id
       JOIN categories c ON c.id = tc.category_id
       WHERE tc.status = 'pending' ORDER BY tc.created_at`,
    );
    const allCompetencies = await query(
      `SELECT tc.technician_id, c.name, tc.status FROM technician_competencies tc
       JOIN categories c ON c.id = tc.category_id
       WHERE tc.technician_id IN (SELECT user_id FROM technician_profiles WHERE status IN ('pending','under_review','revision_required','rejected'))`,
    );
    const grouped = {};
    for (const row of allCompetencies) {
      grouped[row.technician_id] = grouped[row.technician_id] || [];
      grouped[row.technician_id].push(row);
    }
    const counts = await pendingCounts();

    res.render('admin/verifications', {
      title: 'Verifikasi teknisi',
      profiles,
      competencies,
      grouped,
      counts,
    });
  }),
);

router.post(
  '/verifikasi/:id',
  ah(async (req, res) => {
    const action = req.body.action;
    const note = String(req.body.note || '').trim();
    const technician = await queryOne(
      `SELECT tp.*, u.name, u.email FROM technician_profiles tp JOIN users u ON u.id = tp.user_id WHERE tp.user_id = ?`,
      [req.params.id],
    );
    if (!technician) {
      setFlash(req, 'error', 'Profil teknisi tidak ditemukan.');
      return res.redirect('/admin/verifikasi');
    }

    const map = { setujui: 'approved', revisi: 'revision_required', tolak: 'rejected', tangguhkan: 'suspended' };
    const next = map[action];
    if (!next) {
      setFlash(req, 'error', 'Aksi verifikasi tidak dikenali.');
      return res.redirect('/admin/verifikasi');
    }
    if ((next === 'revision_required' || next === 'rejected') && note.length < 10) {
      setFlash(req, 'error', 'Tuliskan catatan minimal 10 karakter agar teknisi tahu yang harus diperbaiki.');
      return res.redirect('/admin/verifikasi');
    }

    await query(
      `UPDATE technician_profiles SET status = ?, review_note = ?, reviewed_at = NOW(), reviewed_by = ? WHERE user_id = ?`,
      [next, note || null, req.session.user.id, technician.user_id],
    );
    await logStatus(req, {
      entityType: 'technician',
      entityId: technician.user_id,
      fromStatus: technician.status,
      toStatus: next,
      note: note || null,
    });
    await logAudit(req, {
      action: `technician.${next}`,
      entity: 'technician',
      entityId: technician.user_id,
      description: `Status kemitraan ${technician.name} → ${next}`,
      meta: { note },
    });

    const messages = {
      approved: ['Kemitraan disetujui', 'Akun Anda aktif. Anda akan menerima penawaran pekerjaan sesuai kompetensi.', '/teknisi'],
      revision_required: ['Pengajuan perlu revisi', note, '/teknisi/pengajuan'],
      rejected: ['Pengajuan ditolak', note, '/teknisi/pengajuan'],
      suspended: ['Kemitraan ditangguhkan', note || 'Hubungi admin untuk informasi lebih lanjut.', '/teknisi/pengajuan'],
    };
    const [title, body, link] = messages[next];
    await notify(technician.user_id, title, body, link);

    setFlash(req, 'success', `Status ${technician.name} diperbarui menjadi ${next}.`);
    res.redirect('/admin/verifikasi');
  }),
);

router.post(
  '/verifikasi/kompetensi/:id',
  ah(async (req, res) => {
    const row = await queryOne(
      `SELECT tc.*, c.name AS category_name, u.name FROM technician_competencies tc
       JOIN categories c ON c.id = tc.category_id JOIN users u ON u.id = tc.technician_id WHERE tc.id = ?`,
      [req.params.id],
    );
    if (!row) {
      setFlash(req, 'error', 'Kompetensi tidak ditemukan.');
      return res.redirect('/admin/verifikasi');
    }
    const approve = req.body.action === 'setujui';
    await query(
      'UPDATE technician_competencies SET status = ?, note = ? WHERE id = ?',
      [approve ? 'approved' : 'rejected', String(req.body.note || '').slice(0, 240) || null, row.id],
    );
    await notify(
      row.technician_id,
      approve ? 'Kompetensi disetujui' : 'Kompetensi ditolak',
      `${row.category_name}: ${approve ? 'Anda bisa menerima pekerjaan kategori ini.' : String(req.body.note || 'Hubungi admin untuk detail.')}`,
      '/teknisi/kompetensi',
    );
    await logAudit(req, {
      action: approve ? 'competency.approved' : 'competency.rejected',
      entity: 'technician',
      entityId: row.technician_id,
      description: `${approve ? 'Menyetujui' : 'Menolak'} kompetensi ${row.category_name} untuk ${row.name}`,
    });
    setFlash(req, 'success', `Kompetensi ${row.category_name} ${approve ? 'disetujui' : 'ditolak'}.`);
    res.redirect('/admin/verifikasi');
  }),
);

router.get(
  '/teknisi',
  ah(async (req, res) => {
    const technicians = await query(
      `SELECT u.id, u.name, u.email, u.phone, u.is_active, tp.status, tp.service_area, tp.experience_years,
              tp.is_available,
              (SELECT COUNT(*) FROM service_orders so WHERE so.technician_id = u.id AND so.status IN ('assigned','in_progress')) AS active_jobs,
              (SELECT COUNT(*) FROM service_orders so WHERE so.technician_id = u.id AND so.status = 'completed') AS completed_jobs,
              (SELECT COALESCE(ROUND(AVG(r.rating), 1), 0) FROM reviews r WHERE r.technician_id = u.id AND r.is_hidden = 0) AS rating,
              (SELECT COALESCE(SUM(cm.technician_earning), 0) FROM commissions cm WHERE cm.technician_id = u.id) AS earnings,
              (SELECT GROUP_CONCAT(DISTINCT c.name ORDER BY c.name SEPARATOR ', ')
                FROM technician_competencies tc JOIN categories c ON c.id = tc.category_id
                WHERE tc.technician_id = u.id AND tc.status = 'approved') AS categories
       FROM users u JOIN technician_profiles tp ON tp.user_id = u.id
       WHERE u.role = 'technician'
       ORDER BY FIELD(tp.status, 'approved', 'under_review', 'pending', 'revision_required', 'rejected', 'suspended'), u.name`,
    );
    const availability = await query(
      `SELECT technician_id, day_of_week, start_time, end_time FROM availability WHERE is_active = 1 ORDER BY day_of_week`,
    );
    const schedule = {};
    for (const row of availability) {
      schedule[row.technician_id] = schedule[row.technician_id] || [];
      schedule[row.technician_id].push(row);
    }
    res.render('admin/technicians', { title: 'Data teknisi', technicians, schedule });
  }),
);

router.post(
  '/teknisi/:id/tangguhkan',
  ah(async (req, res) => {
    const profile = await queryOne(
      `SELECT tp.*, u.name FROM technician_profiles tp JOIN users u ON u.id = tp.user_id WHERE tp.user_id = ?`,
      [req.params.id],
    );
    if (!profile) {
      setFlash(req, 'error', 'Teknisi tidak ditemukan.');
      return res.redirect('/admin/teknisi');
    }
    const next = profile.status === 'suspended' ? 'approved' : 'suspended';
    const note = String(req.body.note || '').trim();
    if (next === 'suspended' && note.length < 10) {
      setFlash(req, 'error', 'Alasan penangguhan minimal 10 karakter.');
      return res.redirect('/admin/teknisi');
    }
    await query(
      'UPDATE technician_profiles SET status = ?, review_note = ?, reviewed_at = NOW(), reviewed_by = ? WHERE user_id = ?',
      [next, note || null, req.session.user.id, profile.user_id],
    );
    await notify(
      profile.user_id,
      next === 'suspended' ? 'Kemitraan ditangguhkan' : 'Kemitraan aktif kembali',
      next === 'suspended' ? note : 'Anda bisa menerima penugasan lagi.',
      '/teknisi/pengajuan',
    );
    await logStatus(req, { entityType: 'technician', entityId: profile.user_id, fromStatus: profile.status, toStatus: next, note: note || null });
    await logAudit(req, {
      action: next === 'suspended' ? 'technician.suspended' : 'technician.reactivated',
      entity: 'technician',
      entityId: profile.user_id,
      description: `${profile.name} → ${next}`,
      meta: { note },
    });
    setFlash(req, 'success', `Status ${profile.name} diperbarui.`);
    res.redirect('/admin/teknisi');
  }),
);

router.get(
  '/kategori',
  ah(async (req, res) => {
    const categories = await query(
      `SELECT c.*, COUNT(s.id) AS service_count FROM categories c
       LEFT JOIN services s ON s.category_id = c.id GROUP BY c.id ORDER BY c.sort_order, c.name`,
    );
    res.render('admin/categories', { title: 'Kategori layanan', categories, editing: null, errors: {} });
  }),
);

router.get(
  '/kategori/:id/edit',
  ah(async (req, res) => {
    const categories = await query(
      `SELECT c.*, COUNT(s.id) AS service_count FROM categories c
       LEFT JOIN services s ON s.category_id = c.id GROUP BY c.id ORDER BY c.sort_order, c.name`,
    );
    const editing = await queryOne('SELECT * FROM categories WHERE id = ?', [req.params.id]);
    if (!editing) {
      setFlash(req, 'error', 'Kategori tidak ditemukan.');
      return res.redirect('/admin/kategori');
    }
    res.render('admin/categories', { title: 'Kategori layanan', categories, editing, errors: {} });
  }),
);

function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 88);
}

router.post(
  '/kategori',
  ah(async (req, res) => {
    const id = Number(req.body.id) || null;
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim();
    const icon = ['ac', 'motor', 'laptop', 'bike', 'wrench'].includes(req.body.icon) ? req.body.icon : 'wrench';
    const sortOrder = Number(req.body.sort_order) || 0;
    const isActive = req.body.is_active ? 1 : 0;

    if (name.length < 2) {
      setFlash(req, 'error', 'Nama kategori minimal 2 karakter.');
      return res.redirect('/admin/kategori');
    }
    const slug = slugify(name);

    try {
      if (id) {
        await query(
          'UPDATE categories SET name = ?, slug = ?, description = ?, icon = ?, sort_order = ?, is_active = ? WHERE id = ?',
          [name, slug, description || null, icon, sortOrder, isActive, id],
        );
        await logAudit(req, { action: 'category.updated', entity: 'category', entityId: id, description: `Kategori ${name} diperbarui` });
        setFlash(req, 'success', 'Kategori diperbarui.');
      } else {
        const result = await query(
          'INSERT INTO categories (name, slug, description, icon, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?)',
          [name, slug, description || null, icon, sortOrder, isActive],
        );
        await logAudit(req, { action: 'category.created', entity: 'category', entityId: result.insertId, description: `Kategori ${name} dibuat` });
        setFlash(req, 'success', 'Kategori dibuat.');
      }
    } catch (error) {
      setFlash(req, 'error', error.code === 'ER_DUP_ENTRY' ? 'Nama kategori sudah dipakai.' : 'Kategori gagal disimpan.');
    }
    res.redirect('/admin/kategori');
  }),
);

router.get(
  '/layanan',
  ah(async (req, res) => {
    const { page, per, offset } = paginate(req.query, { defaultPer: 12 });
    const filters = {
      q: String(req.query.q || '').trim(),
      kategori: Number(req.query.kategori) || 0,
      status: ['aktif', 'nonaktif'].includes(req.query.status) ? req.query.status : '',
    };
    const where = ['1 = 1'];
    const params = [];
    if (filters.q) {
      where.push('(s.name LIKE ? OR c.name LIKE ?)');
      params.push(`%${filters.q}%`, `%${filters.q}%`);
    }
    if (filters.kategori) {
      where.push('s.category_id = ?');
      params.push(filters.kategori);
    }
    if (filters.status) {
      where.push('s.is_active = ?');
      params.push(filters.status === 'aktif' ? 1 : 0);
    }
    const whereSql = where.join(' AND ');
    const totalRow = await queryOne(
      `SELECT COUNT(*) AS total FROM services s JOIN categories c ON c.id = s.category_id WHERE ${whereSql}`,
      params,
    );
    const total = Number(totalRow?.total || 0);
    const services = await query(
      `SELECT s.*, c.name AS category_name, c.icon FROM services s JOIN categories c ON c.id = s.category_id
       WHERE ${whereSql} ORDER BY c.sort_order, s.name LIMIT ${per} OFFSET ${offset}`,
      params,
    );
    const categories = await query('SELECT * FROM categories ORDER BY sort_order, name');
    res.render('admin/services', {
      title: 'Kelola layanan',
      services,
      categories,
      filters,
      page,
      per,
      total,
      pages: pageCount(total, per),
    });
  }),
);

router.get(
  '/layanan/baru',
  ah(async (req, res) => {
    const categories = await query('SELECT * FROM categories ORDER BY sort_order');
    res.render('admin/service-form', {
      title: 'Layanan baru',
      categories,
      service: { price_type: 'fixed', duration_minutes: 90, is_active: 1, is_featured: 0 },
      errors: {},
    });
  }),
);

router.get(
  '/layanan/:id/edit',
  ah(async (req, res) => {
    const service = await queryOne('SELECT * FROM services WHERE id = ?', [req.params.id]);
    if (!service) {
      setFlash(req, 'error', 'Layanan tidak ditemukan.');
      return res.redirect('/admin/layanan');
    }
    const categories = await query('SELECT * FROM categories ORDER BY sort_order');
    res.render('admin/service-form', { title: 'Edit layanan', categories, service, errors: {} });
  }),
);

router.post(
  '/layanan',
  ah(async (req, res) => {
    const id = Number(req.body.id) || null;
    const service = {
      category_id: Number(req.body.category_id) || 0,
      name: String(req.body.name || '').trim(),
      description: String(req.body.description || '').trim(),
      scope: String(req.body.scope || '').trim(),
      requirements: String(req.body.requirements || '').trim(),
      price_type: req.body.price_type === 'estimate' ? 'estimate' : 'fixed',
      price: Number(req.body.price) || 0,
      duration_minutes: Number(req.body.duration_minutes) || 90,
      service_area: String(req.body.service_area || '').trim(),
      image_url: String(req.body.image_url || '/img/svc-ac.svg').trim(),
      is_active: req.body.is_active ? 1 : 0,
      is_featured: req.body.is_featured ? 1 : 0,
    };
    const errors = {};
    if (service.name.length < 4) errors.name = 'Nama layanan minimal 4 karakter.';
    if (!service.category_id) errors.category_id = 'Pilih kategori.';
    if (service.price < 0) errors.price = 'Harga tidak boleh negatif.';
    if (service.duration_minutes < 15) errors.duration_minutes = 'Durasi minimal 15 menit.';

    if (Object.keys(errors).length > 0) {
      const categories = await query('SELECT * FROM categories ORDER BY sort_order');
      return res.status(422).render('admin/service-form', {
        title: id ? 'Edit layanan' : 'Layanan baru',
        categories,
        service: { ...service, id },
        errors,
      });
    }

    const slug = `${slugify(service.name)}${id ? '' : `-${Date.now().toString(36).slice(-3)}`}`;
    try {
      if (id) {
        await query(
          `UPDATE services SET category_id = ?, name = ?, description = ?, scope = ?, requirements = ?,
             price_type = ?, price = ?, duration_minutes = ?, service_area = ?, image_url = ?,
             is_active = ?, is_featured = ? WHERE id = ?`,
          [service.category_id, service.name, service.description || null, service.scope || null,
           service.requirements || null, service.price_type, service.price, service.duration_minutes,
           service.service_area || null, service.image_url, service.is_active, service.is_featured, id],
        );
        await logAudit(req, { action: 'service.updated', entity: 'service', entityId: id, description: `Layanan ${service.name} diperbarui` });
        setFlash(req, 'success', 'Layanan diperbarui.');
      } else {
        const result = await query(
          `INSERT INTO services (category_id, name, slug, description, scope, requirements, price_type, price,
             duration_minutes, service_area, image_url, is_active, is_featured)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [service.category_id, service.name, slug, service.description || null, service.scope || null,
           service.requirements || null, service.price_type, service.price, service.duration_minutes,
           service.service_area || null, service.image_url, service.is_active, service.is_featured],
        );
        await logAudit(req, { action: 'service.created', entity: 'service', entityId: result.insertId, description: `Layanan ${service.name} dibuat` });
        setFlash(req, 'success', 'Layanan dibuat.');
      }
    } catch (error) {
      setFlash(req, 'error', error.code === 'ER_DUP_ENTRY' ? 'Nama layanan sudah dipakai.' : 'Layanan gagal disimpan.');
    }
    res.redirect('/admin/layanan');
  }),
);

router.post(
  '/layanan/:id/toggle',
  ah(async (req, res) => {
    const service = await queryOne('SELECT * FROM services WHERE id = ?', [req.params.id]);
    if (!service) {
      setFlash(req, 'error', 'Layanan tidak ditemukan.');
      return res.redirect('/admin/layanan');
    }
    await query('UPDATE services SET is_active = ? WHERE id = ?', [service.is_active ? 0 : 1, service.id]);
    await logAudit(req, {
      action: 'service.toggled',
      entity: 'service',
      entityId: service.id,
      description: `${service.is_active ? 'Menonaktifkan' : 'Mengaktifkan'} layanan ${service.name}`,
    });
    setFlash(req, 'success', `Layanan ${service.name} ${service.is_active ? 'dinonaktifkan' : 'diaktifkan'}.`);
    res.redirect('/admin/layanan');
  }),
);

router.get(
  '/booking',
  ah(async (req, res) => {
    const { page, per, offset } = paginate(req.query, { defaultPer: 12 });
    const filters = {
      q: String(req.query.q || '').trim(),
      status: ['submitted', 'processing', 'in_progress', 'completed', 'cancelled'].includes(req.query.status) ? req.query.status : '',
      bayar: ['unpaid', 'pending_verification', 'paid', 'refunded'].includes(req.query.bayar) ? req.query.bayar : '',
    };
    const where = ['1 = 1'];
    const params = [];
    if (filters.q) {
      where.push('(b.code LIKE ? OR u.name LIKE ? OR u.email LIKE ?)');
      const like = `%${filters.q}%`;
      params.push(like, like, like);
    }
    if (filters.status) {
      where.push('b.status = ?');
      params.push(filters.status);
    }
    if (filters.bayar) {
      where.push('b.payment_status = ?');
      params.push(filters.bayar);
    }
    const whereSql = where.join(' AND ');
    const totalRow = await queryOne(
      `SELECT COUNT(*) AS total FROM bookings b JOIN users u ON u.id = b.customer_id WHERE ${whereSql}`,
      params,
    );
    const total = Number(totalRow?.total || 0);
    const bookings = await query(
      `SELECT b.*, u.name AS customer_name,
              (SELECT COUNT(*) FROM service_orders so WHERE so.booking_id = b.id) AS item_count
       FROM bookings b JOIN users u ON u.id = b.customer_id
       WHERE ${whereSql} ORDER BY b.created_at DESC LIMIT ${per} OFFSET ${offset}`,
      params,
    );
    res.render('admin/bookings', {
      title: 'Booking',
      bookings,
      filters,
      page,
      per,
      total,
      pages: pageCount(total, per),
    });
  }),
);

router.get(
  '/booking/:code',
  ah(async (req, res) => {
    const booking = await queryOne(
      `SELECT b.*, u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
       FROM bookings b JOIN users u ON u.id = b.customer_id WHERE b.code = ? LIMIT 1`,
      [req.params.code],
    );
    if (!booking) {
      return res.status(404).render('error', {
        title: 'Booking tidak ditemukan',
        status: 404,
        message: 'Kode booking tidak ada.',
      });
    }
    const detail = await loadBookingDetail(booking.id);
    const candidates = await query(
      `SELECT u.id, u.name, tp.service_area,
              (SELECT COUNT(*) FROM service_orders so2 WHERE so2.technician_id = u.id AND so2.status IN ('assigned','in_progress')) AS active_jobs,
              (SELECT COALESCE(ROUND(AVG(r.rating), 1), 0) FROM reviews r WHERE r.technician_id = u.id) AS rating
       FROM users u JOIN technician_profiles tp ON tp.user_id = u.id
       WHERE u.role = 'technician' AND u.is_active = 1 AND tp.status = 'approved'
       ORDER BY active_jobs ASC, rating DESC`,
    );
    const qualified = {};
    for (const candidate of candidates) {
      const cats = await query(
        'SELECT category_id FROM technician_competencies WHERE technician_id = ? AND status = ?',
        [candidate.id, 'approved'],
      );
      candidate.categories = cats.map((row) => row.category_id);
      qualified[candidate.id] = candidate;
    }

    const orderCategories = await query(
      `SELECT so.id, c.id AS category_id FROM service_orders so
       LEFT JOIN services s ON s.id = so.service_id
       LEFT JOIN categories c ON c.id = s.category_id WHERE so.booking_id = ?`,
      [booking.id],
    );
    const categoryByOrder = {};
    for (const row of orderCategories) categoryByOrder[row.id] = row.category_id;

    const timeline = await query(
      `SELECT sh.*, u.name AS actor_name FROM status_history sh LEFT JOIN users u ON u.id = sh.actor_id
       WHERE (sh.entity_type = 'booking' AND sh.entity_id = ?)
          OR (sh.entity_type = 'service_order' AND sh.entity_id IN (SELECT id FROM service_orders WHERE booking_id = ?))
          OR (sh.entity_type = 'work_order' AND sh.entity_id IN (
                SELECT wo.id FROM work_orders wo JOIN service_orders so ON so.id = wo.service_order_id WHERE so.booking_id = ?))
       ORDER BY sh.created_at, sh.id`,
      [booking.id, booking.id, booking.id],
    );

    res.render('admin/booking-detail', {
      title: `Booking ${booking.code}`,
      booking,
      ...detail,
      candidates,
      qualified: Object.values(qualified),
      categoryByOrder,
      timeline,
    });
  }),
);

router.post(
  '/booking/:code/proses',
  ah(async (req, res) => {
    const booking = await queryOne('SELECT * FROM bookings WHERE code = ?', [req.params.code]);
    if (!booking) {
      setFlash(req, 'error', 'Booking tidak ditemukan.');
      return res.redirect('/admin/booking');
    }
    if (booking.status !== 'submitted') {
      setFlash(req, 'info', 'Booking ini sudah diproses sebelumnya.');
      return res.redirect(`/admin/booking/${booking.code}`);
    }

    await query(`UPDATE service_orders SET status = 'awaiting_assignment' WHERE booking_id = ? AND status = 'submitted'`, [booking.id]);
    await query(`UPDATE bookings SET status = 'processing' WHERE id = ?`, [booking.id]);
    await notify(booking.customer_id, 'Booking diproses', `Admin sedang mencari teknisi untuk ${booking.code}.`, `/booking/${booking.code}`);
    await logStatus(req, { entityType: 'booking', entityId: booking.id, fromStatus: 'submitted', toStatus: 'processing', note: 'Admin memproses booking' });
    await logAudit(req, { action: 'booking.processed', entity: 'booking', entityId: booking.id, description: `Booking ${booking.code} diproses` });
    setFlash(req, 'success', 'Booking diproses. Sekarang tugaskan teknisi untuk setiap layanan.');
    res.redirect(`/admin/booking/${booking.code}`);
  }),
);

router.post(
  '/booking/:code/batal',
  ah(async (req, res) => {
    const booking = await queryOne('SELECT * FROM bookings WHERE code = ?', [req.params.code]);
    const reason = String(req.body.reason || '').trim();
    if (!booking) {
      setFlash(req, 'error', 'Booking tidak ditemukan.');
      return res.redirect('/admin/booking');
    }
    if (reason.length < 5) {
      setFlash(req, 'error', 'Alasan pembatalan minimal 5 karakter.');
      return res.redirect(`/admin/booking/${booking.code}`);
    }
    if (booking.status === 'completed') {
      setFlash(req, 'error', 'Booking yang sudah selesai tidak bisa dibatalkan. Gunakan mekanisme refund.');
      return res.redirect(`/admin/booking/${booking.code}`);
    }

    const techniciansBeforeCancel = await query(
      'SELECT DISTINCT technician_id FROM service_orders WHERE booking_id = ? AND technician_id IS NOT NULL',
      [booking.id],
    );

    await transaction(async (connection) => {
      await connection.execute('UPDATE bookings SET status = ?, cancel_reason = ? WHERE id = ?', ['cancelled', reason.slice(0, 300), booking.id]);
      await connection.execute(
        `UPDATE service_orders SET status = 'cancelled', technician_id = NULL
         WHERE booking_id = ? AND status NOT IN ('completed','cancelled')`,
        [booking.id],
      );
      await connection.execute(
        `UPDATE assignments SET status = 'cancelled', reason = COALESCE(reason, 'Booking dibatalkan admin'), responded_at = NOW()
         WHERE status IN ('offered','accepted')
           AND service_order_id IN (SELECT id FROM service_orders WHERE booking_id = ?)`,
        [booking.id],
      );
      await connection.execute(
        `DELETE FROM work_orders WHERE service_order_id IN (SELECT id FROM service_orders WHERE booking_id = ?)`,
        [booking.id],
      );
    });
    await notify(booking.customer_id, 'Booking dibatalkan admin', `${booking.code}: ${reason.slice(0, 160)}`, `/booking/${booking.code}`);
    for (const row of techniciansBeforeCancel) {
      await notify(row.technician_id, 'Booking dibatalkan admin', `${booking.code} dibatalkan.`, '/teknisi/penugasan');
    }
    await logStatus(req, { entityType: 'booking', entityId: booking.id, fromStatus: booking.status, toStatus: 'cancelled', note: reason.slice(0, 200) });
    await logAudit(req, { action: 'booking.cancelled_by_admin', entity: 'booking', entityId: booking.id, description: `Admin membatalkan ${booking.code}: ${reason.slice(0, 160)}` });
    setFlash(req, 'success', 'Booking dibatalkan.');
    res.redirect(`/admin/booking/${booking.code}`);
  }),
);

router.post(
  '/service-order/:id/tugaskan',
  ah(async (req, res) => {
    const order = await queryOne(
      `SELECT so.*, b.code, b.customer_id FROM service_orders so JOIN bookings b ON b.id = so.booking_id WHERE so.id = ?`,
      [req.params.id],
    );
    const technicianId = Number(req.body.technician_id);
    const reason = String(req.body.reason || '').trim();
    if (!order) {
      setFlash(req, 'error', 'Service order tidak ditemukan.');
      return res.redirect('/admin/booking');
    }
    if (!['awaiting_assignment', 'needs_reschedule', 'assigned'].includes(order.status)) {
      setFlash(req, 'error', 'Service order ini tidak dalam status yang bisa ditugaskan.');
      return res.redirect(`/admin/booking/${order.code}`);
    }
    if (order.status === 'assigned' && reason.length < 5) {
      setFlash(req, 'error', 'Untuk mengganti teknisi, tuliskan alasan penugasan ulang.');
      return res.redirect(`/admin/booking/${order.code}`);
    }

    const technician = await queryOne(
      `SELECT u.id, u.name, tp.status FROM users u JOIN technician_profiles tp ON tp.user_id = u.id
       WHERE u.id = ? AND u.role = 'technician' AND u.is_active = 1`,
      [technicianId],
    );
    if (!technician || technician.status !== 'approved') {
      setFlash(req, 'error', 'Pilih teknisi yang sudah disetujui dan aktif.');
      return res.redirect(`/admin/booking/${order.code}`);
    }

    const serviceRow = await queryOne(
      'SELECT category_id FROM services WHERE id = ?',
      [order.service_id],
    );
    const competent = serviceRow
      ? await queryOne(
          'SELECT id FROM technician_competencies WHERE technician_id = ? AND category_id = ? AND status = ?',
          [technicianId, serviceRow.category_id, 'approved'],
        )
      : null;
    if (!competent) {
      setFlash(req, 'error', 'Teknisi belum punya kompetensi yang disetujui untuk kategori layanan ini.');
      return res.redirect(`/admin/booking/${order.code}`);
    }

    await transaction(async (connection) => {
      if (order.status === 'assigned' && order.technician_id) {
        await connection.execute(
          `UPDATE assignments SET status = 'reassigned', reason = ? WHERE service_order_id = ? AND status IN ('offered','accepted')`,
          [reason.slice(0, 300), order.id],
        );
        await connection.execute('DELETE FROM work_orders WHERE service_order_id = ?', [order.id]);
      }
      await connection.execute(
        `INSERT INTO assignments (service_order_id, technician_id, status, assigned_by) VALUES (?, ?, 'offered', ?)`,
        [order.id, technicianId, req.session.user.id],
      );
      await connection.execute(
        `UPDATE service_orders SET technician_id = ?, status = 'assigned' WHERE id = ?`,
        [technicianId, order.id],
      );
      await connection.execute(
        `INSERT INTO work_orders (service_order_id, technician_id, instructions, status) VALUES (?, ?, ?, 'assigned')`,
        [order.id, technicianId, String(req.body.instructions || 'Kerjakan sesuai cakupan layanan.').slice(0, 600)],
      );
      await connection.execute('UPDATE bookings SET status = ? WHERE id = ? AND status = ?', ['processing', order.booking_id, 'submitted']);
    });

    await recalcBookingStatus(order.booking_id);
    await notify(technicianId, 'Penawaran pekerjaan baru', `${order.service_name} · ${order.code}`, '/teknisi/penugasan');
    await notify(order.customer_id, 'Teknisi ditugaskan', `${technician.name} ditugaskan untuk ${order.service_name}.`, `/booking/${order.code}`);
    await logStatus(req, {
      entityType: 'service_order',
      entityId: order.id,
      fromStatus: order.status,
      toStatus: 'assigned',
      note: `Ditugaskan ke ${technician.name}${reason ? ` (${reason.slice(0, 120)})` : ''}`,
    });
    await logAudit(req, {
      action: 'assignment.created',
      entity: 'service_order',
      entityId: order.id,
      description: `Menugaskan ${technician.name} ke ${order.service_name} (${order.code})`,
      meta: { reason },
    });
    setFlash(req, 'success', `Penawaran dikirim ke ${technician.name}.`);
    res.redirect(`/admin/booking/${order.code}`);
  }),
);

router.get(
  '/service-order',
  ah(async (req, res) => {
    const { page, per, offset } = paginate(req.query, { defaultPer: 12 });
    const filters = {
      status: String(req.query.status || ''),
      q: String(req.query.q || '').trim(),
    };
    const where = ['1 = 1'];
    const params = [];
    if (filters.status) {
      where.push('so.status = ?');
      params.push(filters.status);
    }
    if (filters.q) {
      where.push('(so.service_name LIKE ? OR b.code LIKE ? OR u.name LIKE ?)');
      const like = `%${filters.q}%`;
      params.push(like, like, like);
    }
    const whereSql = where.join(' AND ');
    const totalRow = await queryOne(
      `SELECT COUNT(*) AS total FROM service_orders so JOIN bookings b ON b.id = so.booking_id
       LEFT JOIN users u ON u.id = so.technician_id WHERE ${whereSql}`,
      params,
    );
    const total = Number(totalRow?.total || 0);
    const orders = await query(
      `SELECT so.*, b.code, b.scheduled_date, b.city, u.name AS technician_name,
              wo.status AS work_status
       FROM service_orders so JOIN bookings b ON b.id = so.booking_id
       LEFT JOIN users u ON u.id = so.technician_id
       LEFT JOIN work_orders wo ON wo.service_order_id = so.id
       WHERE ${whereSql} ORDER BY so.created_at DESC LIMIT ${per} OFFSET ${offset}`,
      params,
    );
    res.render('admin/service-orders', {
      title: 'Service order',
      orders,
      filters,
      page,
      per,
      total,
      pages: pageCount(total, per),
    });
  }),
);

router.get(
  '/penugasan',
  ah(async (req, res) => {
    const { page, per, offset } = paginate(req.query, { defaultPer: 12 });
    const filters = { status: String(req.query.status || '') };
    const where = ['1 = 1'];
    const params = [];
    if (filters.status) {
      where.push('a.status = ?');
      params.push(filters.status);
    }
    const whereSql = where.join(' AND ');
    const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM assignments a WHERE ${whereSql}`, params);
    const total = Number(totalRow?.total || 0);
    const assignments = await query(
      `SELECT a.*, so.service_name, so.status AS order_status, b.code, b.scheduled_date, b.city,
              u.name AS technician_name, admin.name AS assigned_by_name
       FROM assignments a
       JOIN service_orders so ON so.id = a.service_order_id
       JOIN bookings b ON b.id = so.booking_id
       JOIN users u ON u.id = a.technician_id
       LEFT JOIN users admin ON admin.id = a.assigned_by
       WHERE ${whereSql} ORDER BY a.created_at DESC LIMIT ${per} OFFSET ${offset}`,
      params,
    );
    res.render('admin/assignments', {
      title: 'Penugasan',
      assignments,
      filters,
      page,
      per,
      total,
      pages: pageCount(total, per),
    });
  }),
);

router.get(
  '/work-order',
  ah(async (req, res) => {
    const filters = { status: String(req.query.status || '') };
    const where = ['1 = 1'];
    const params = [];
    if (filters.status) {
      where.push('wo.status = ?');
      params.push(filters.status);
    }
    const workOrders = await query(
      `SELECT wo.*, so.service_name, so.status AS order_status, so.id AS service_order_id,
              b.code, b.customer_id, u.name AS technician_name, so.price
       FROM work_orders wo
       JOIN service_orders so ON so.id = wo.service_order_id
       JOIN bookings b ON b.id = so.booking_id
       JOIN users u ON u.id = wo.technician_id
       WHERE ${where.join(' AND ')}
       ORDER BY FIELD(wo.status, 'submitted_for_review', 'blocked', 'in_progress', 'accepted', 'assigned', 'completed'), wo.updated_at DESC`,
      params,
    );
    res.render('admin/work-orders', { title: 'Work order', workOrders, filters });
  }),
);

router.post(
  '/work-order/:id/selesai',
  ah(async (req, res) => {
    const work = await queryOne(
      `SELECT wo.*, so.booking_id, so.price, so.service_name, so.status AS order_status, b.code, b.customer_id
       FROM work_orders wo
       JOIN service_orders so ON so.id = wo.service_order_id
       JOIN bookings b ON b.id = so.booking_id
       WHERE wo.id = ?`,
      [req.params.id],
    );
    if (!work) {
      setFlash(req, 'error', 'Work order tidak ditemukan.');
      return res.redirect('/admin/work-order');
    }
    if (work.status !== 'submitted_for_review' && work.status !== 'in_progress') {
      setFlash(req, 'info', 'Work order ini belum bisa diselesaikan.');
      return res.redirect('/admin/work-order');
    }

    const rule = await queryOne(
      'SELECT percent FROM commission_rules WHERE effective_from <= CURDATE() ORDER BY effective_from DESC, id DESC LIMIT 1',
    );
    const percent = rule ? Number(rule.percent) : Number((await getSettings()).commission_percent || 15);
    const gross = Number(work.price);
    const commission = commissionFor(gross, percent);

    await transaction(async (connection) => {
      await connection.execute(
        `UPDATE work_orders SET status = 'completed', completed_at = NOW() WHERE id = ?`,
        [work.id],
      );
      await connection.execute(`UPDATE service_orders SET status = 'completed' WHERE id = ?`, [work.service_order_id]);
      await connection.execute(
        `INSERT INTO commissions (service_order_id, booking_id, technician_id, gross_amount, percent, platform_fee, technician_earning)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE gross_amount = VALUES(gross_amount), percent = VALUES(percent),
           platform_fee = VALUES(platform_fee), technician_earning = VALUES(technician_earning)`,
        [work.service_order_id, work.booking_id, work.technician_id, gross, percent, commission.platformFee, commission.technicianEarning],
      );
    });

    const bookingStatus = await recalcBookingStatus(work.booking_id);
    await logStatus(req, {
      entityType: 'service_order',
      entityId: work.service_order_id,
      fromStatus: work.order_status,
      toStatus: 'completed',
      note: 'Admin menyelesaikan pekerjaan',
    });
    await logStatus(req, {
      entityType: 'work_order',
      entityId: work.id,
      fromStatus: work.status,
      toStatus: 'completed',
      note: 'Work order diselesaikan',
    });
    await notify(work.customer_id, 'Pekerjaan selesai', `${work.service_name} sudah selesai. Beri ulasan untuk teknisi.`, `/booking/${work.code}`);
    await notify(work.technician_id, 'Pekerjaan disetujui', `${work.service_name} selesai. Pendapatan Rp ${commission.technicianEarning.toLocaleString('id-ID')} masuk ke saldo Anda.`, '/teknisi/pendapatan');
    await logAudit(req, {
      action: 'work_order.completed',
      entity: 'work_order',
      entityId: work.id,
      description: `Menyelesaikan ${work.service_name} (${work.code}); komisi ${percent}%`,
      meta: { platformFee: commission.platformFee, technicianEarning: commission.technicianEarning },
    });

    setFlash(
      req,
      'success',
      `Pekerjaan diselesaikan. Komisi ${percent}% = Rp ${commission.platformFee.toLocaleString('id-ID')}.`,
    );
    res.redirect(bookingStatus === 'completed' ? `/admin/booking/${work.code}` : '/admin/work-order');
  }),
);

router.get(
  '/transaksi',
  ah(async (req, res) => {
    const { page, per, offset } = paginate(req.query, { defaultPer: 12 });
    const filters = { status: String(req.query.status || '') };
    const where = ['1 = 1'];
    const params = [];
    if (filters.status) {
      where.push('t.status = ?');
      params.push(filters.status);
    }
    const whereSql = where.join(' AND ');
    const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM transactions t WHERE ${whereSql}`, params);
    const total = Number(totalRow?.total || 0);
    const transactions = await query(
      `SELECT t.*, b.code, b.payment_method, u.name AS customer_name, b.id AS booking_id
       FROM transactions t JOIN bookings b ON b.id = t.booking_id
       JOIN users u ON u.id = b.customer_id
       WHERE ${whereSql}
       ORDER BY FIELD(t.status, 'pending_verification', 'unpaid', 'paid', 'failed', 'refunded'), t.created_at DESC
       LIMIT ${per} OFFSET ${offset}`,
      params,
    );
    const summary = await queryOne(
      `SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount END), 0) AS paid,
              COALESCE(SUM(CASE WHEN status = 'pending_verification' THEN amount END), 0) AS pending,
              COUNT(*) AS total
       FROM transactions`,
    );
    res.render('admin/transactions', {
      title: 'Transaksi',
      transactions,
      filters,
      summary: summary || {},
      page,
      per,
      total,
      pages: pageCount(total, per),
    });
  }),
);

router.post(
  '/transaksi/:id',
  ah(async (req, res) => {
    const action = String(req.body.action || '');
    const row = await queryOne(
      `SELECT t.*, b.code, b.customer_id FROM transactions t JOIN bookings b ON b.id = t.booking_id WHERE t.id = ?`,
      [req.params.id],
    );
    if (!row) {
      setFlash(req, 'error', 'Transaksi tidak ditemukan.');
      return res.redirect('/admin/transaksi');
    }

    if (action === 'verifikasi') {
      await query('UPDATE transactions SET status = ?, verified_by = ?, verified_at = NOW() WHERE id = ?', ['paid', req.session.user.id, row.id]);
      await query('UPDATE bookings SET payment_status = ? WHERE id = ?', ['paid', row.booking_id]);
      await notify(row.customer_id, 'Pembayaran diverifikasi', `Pembayaran ${row.code} sudah lunas.`, `/booking/${row.code}`);
      await logAudit(req, { action: 'payment.verified', entity: 'transaction', entityId: row.id, description: `Verifikasi pembayaran ${row.code}` });
      setFlash(req, 'success', `Pembayaran ${row.code} ditandai lunas.`);
    } else if (action === 'tolak') {
      await query('UPDATE transactions SET status = ?, proof_url = NULL WHERE id = ?', ['failed', row.id]);
      await query('UPDATE bookings SET payment_status = ? WHERE id = ?', ['unpaid', row.booking_id]);
      await notify(row.customer_id, 'Bukti pembayaran ditolak', `Bukti untuk ${row.code} tidak valid. Unggah ulang bukti transfer.`, `/booking/${row.code}/bayar`);
      await logAudit(req, { action: 'payment.rejected', entity: 'transaction', entityId: row.id, description: `Menolak bukti pembayaran ${row.code}` });
      setFlash(req, 'info', 'Bukti pembayaran ditolak, customer diminta unggah ulang.');
    } else if (action === 'refund') {
      if (row.status !== 'paid') {
        setFlash(req, 'error', 'Hanya transaksi lunas yang bisa dikembalikan.');
        return res.redirect('/admin/transaksi');
      }
      const reason = String(req.body.reason || '').trim();
      if (reason.length < 5) {
        setFlash(req, 'error', 'Alasan refund minimal 5 karakter.');
        return res.redirect('/admin/transaksi');
      }
      await query('UPDATE transactions SET status = ?, refund_reason = ? WHERE id = ?', ['refunded', reason.slice(0, 300), row.id]);
      await query('UPDATE bookings SET payment_status = ? WHERE id = ?', ['refunded', row.booking_id]);
      await notify(row.customer_id, 'Dana dikembalikan', `${row.code}: ${reason.slice(0, 160)}`, `/booking/${row.code}`);
      await logAudit(req, {
        action: 'payment.refunded',
        entity: 'transaction',
        entityId: row.id,
        description: `Refund ${row.code}: ${reason.slice(0, 160)}`,
      });
      setFlash(req, 'success', 'Refund dicatat.');
    } else {
      setFlash(req, 'error', 'Aksi tidak dikenali.');
    }

    res.redirect('/admin/transaksi');
  }),
);

router.get(
  '/komisi',
  ah(async (req, res) => {
    const rules = await query(
      `SELECT cr.*, u.name AS created_by_name FROM commission_rules cr
       LEFT JOIN users u ON u.id = cr.created_by ORDER BY cr.effective_from DESC, cr.id DESC LIMIT 10`,
    );
    const summary = await queryOne(
      `SELECT COALESCE(SUM(platform_fee), 0) AS fees, COALESCE(SUM(technician_earning), 0) AS payouts,
              COUNT(*) AS jobs FROM commissions`,
    );
    const rows = await query(
      `SELECT cm.*, so.service_name, b.code, u.name AS technician_name
       FROM commissions cm
       JOIN service_orders so ON so.id = cm.service_order_id
       JOIN bookings b ON b.id = cm.booking_id
       JOIN users u ON u.id = cm.technician_id
       ORDER BY cm.created_at DESC LIMIT 50`,
    );
    const settings = await getSettings();
    res.render('admin/commissions', { title: 'Komisi', rules, summary: summary || {}, rows, settings });
  }),
);

router.post(
  '/komisi',
  ah(async (req, res) => {
    const percent = Number(req.body.percent);
    if (!(percent >= 0 && percent <= 90)) {
      setFlash(req, 'error', 'Persentase komisi harus antara 0 dan 90.');
      return res.redirect('/admin/komisi');
    }
    await query('INSERT INTO commission_rules (percent, effective_from, created_by) VALUES (?, CURDATE(), ?)', [percent, req.session.user.id]);
    await saveSettings({ commission_percent: percent });
    clearSettingsCache();
    await logAudit(req, {
      action: 'commission.rule_changed',
      entity: 'settings',
      description: `Aturan komisi baru ${percent}% berlaku hari ini`,
    });
    setFlash(req, 'success', `Komisi ${percent}% berlaku untuk pekerjaan yang selesai mulai hari ini.`);
    res.redirect('/admin/komisi');
  }),
);

router.get(
  '/ulasan',
  ah(async (req, res) => {
    const { page, per, offset } = paginate(req.query, { defaultPer: 12 });
    const filters = { rating: Number(req.query.rating) || 0, hidden: req.query.hidden === '1' };
    const where = ['1 = 1'];
    const params = [];
    if (filters.rating) {
      where.push('r.rating = ?');
      params.push(filters.rating);
    }
    if (filters.hidden) where.push('r.is_hidden = 1');
    const whereSql = where.join(' AND ');
    const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM reviews r WHERE ${whereSql}`, params);
    const total = Number(totalRow?.total || 0);
    const reviews = await query(
      `SELECT r.*, so.service_name, b.code, c.name AS customer_name, t.name AS technician_name
       FROM reviews r
       JOIN service_orders so ON so.id = r.service_order_id
       JOIN bookings b ON b.id = r.booking_id
       JOIN users c ON c.id = r.customer_id
       JOIN users t ON t.id = r.technician_id
       WHERE ${whereSql} ORDER BY r.created_at DESC LIMIT ${per} OFFSET ${offset}`,
      params,
    );
    const summary = await queryOne(
      `SELECT COUNT(*) AS total, ROUND(AVG(rating), 1) AS average,
              SUM(rating <= 2) AS low FROM reviews`,
    );
    res.render('admin/reviews', {
      title: 'Ulasan',
      reviews,
      filters,
      summary: summary || {},
      page,
      per,
      total,
      pages: pageCount(total, per),
    });
  }),
);

router.post(
  '/ulasan/:id/sembunyi',
  ah(async (req, res) => {
    const review = await queryOne('SELECT * FROM reviews WHERE id = ?', [req.params.id]);
    if (!review) {
      setFlash(req, 'error', 'Ulasan tidak ditemukan.');
      return res.redirect('/admin/ulasan');
    }
    await query('UPDATE reviews SET is_hidden = ? WHERE id = ?', [review.is_hidden ? 0 : 1, review.id]);
    await logAudit(req, {
      action: review.is_hidden ? 'review.unhidden' : 'review.hidden',
      entity: 'review',
      entityId: review.id,
      description: `${review.is_hidden ? 'Menampilkan' : 'Menyembunyikan'} ulasan #${review.id}`,
    });
    setFlash(req, 'success', review.is_hidden ? 'Ulasan ditampilkan kembali.' : 'Ulasan disembunyikan dari publik.');
    res.redirect('/admin/ulasan');
  }),
);

router.get(
  '/keluhan',
  ah(async (req, res) => {
    const { page, per, offset } = paginate(req.query, { defaultPer: 10 });
    const filters = { status: String(req.query.status || '') };
    const where = ['1 = 1'];
    const params = [];
    if (filters.status) {
      where.push('c.status = ?');
      params.push(filters.status);
    }
    const whereSql = where.join(' AND ');
    const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM complaints c WHERE ${whereSql}`, params);
    const total = Number(totalRow?.total || 0);
    const complaints = await query(
      `SELECT c.*, u.name AS customer_name, u.email AS customer_email, b.code AS booking_code
       FROM complaints c JOIN users u ON u.id = c.user_id
       LEFT JOIN bookings b ON b.id = c.booking_id
       WHERE ${whereSql} ORDER BY FIELD(c.status, 'open', 'in_review', 'resolved', 'rejected'), c.created_at DESC
       LIMIT ${per} OFFSET ${offset}`,
      params,
    );
    res.render('admin/complaints', {
      title: 'Ulasan & keluhan',
      complaints,
      filters,
      page,
      per,
      total,
      pages: pageCount(total, per),
    });
  }),
);

router.post(
  '/keluhan/:id',
  ah(async (req, res) => {
    const complaint = await queryOne('SELECT * FROM complaints WHERE id = ?', [req.params.id]);
    const status = ['in_review', 'resolved', 'rejected'].includes(req.body.status) ? req.body.status : null;
    const response = String(req.body.response || '').trim();
    if (!complaint || !status) {
      setFlash(req, 'error', 'Keluhan atau status tidak valid.');
      return res.redirect('/admin/keluhan');
    }
    if (status !== 'in_review' && response.length < 10) {
      setFlash(req, 'error', 'Tuliskan tanggapan minimal 10 karakter sebelum menutup keluhan.');
      return res.redirect('/admin/keluhan');
    }

    await query(
      'UPDATE complaints SET status = ?, response = ?, handled_by = ? WHERE id = ?',
      [status, response || null, req.session.user.id, complaint.id],
    );
    await notify(
      complaint.user_id,
      status === 'resolved' ? 'Keluhan selesai' : status === 'rejected' ? 'Keluhan ditolak' : 'Keluhan sedang ditinjau',
      response || 'Admin sedang memeriksa keluhan Anda.',
      '/keluhan',
    );
    await logAudit(req, {
      action: `complaint.${status}`,
      entity: 'complaint',
      entityId: complaint.id,
      description: `Keluhan ${complaint.code} → ${status}`,
    });
    setFlash(req, 'success', 'Keluhan diperbarui dan customer diberi notifikasi.');
    res.redirect('/admin/keluhan');
  }),
);

router.get(
  '/laporan',
  ah(async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : `${today.slice(0, 7)}-01`;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;

    const summary = await queryOne(
      `SELECT
        (SELECT COUNT(*) FROM bookings WHERE DATE(created_at) BETWEEN ? AND ?) AS bookings,
        (SELECT COUNT(*) FROM bookings WHERE status = 'completed' AND DATE(created_at) BETWEEN ? AND ?) AS completed,
        (SELECT COUNT(*) FROM bookings WHERE status = 'cancelled' AND DATE(created_at) BETWEEN ? AND ?) AS cancelled,
        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE status = 'paid' AND DATE(created_at) BETWEEN ? AND ?) AS revenue,
        (SELECT COALESCE(SUM(platform_fee), 0) FROM commissions WHERE DATE(created_at) BETWEEN ? AND ?) AS fees,
        (SELECT COALESCE(SUM(technician_earning), 0) FROM commissions WHERE DATE(created_at) BETWEEN ? AND ?) AS payouts,
        (SELECT ROUND(AVG(rating), 1) FROM reviews WHERE DATE(created_at) BETWEEN ? AND ?) AS rating`,
      [from, to, from, to, from, to, from, to, from, to, from, to, from, to],
    );

    const byStatus = await query(
      `SELECT status, COUNT(*) AS total FROM bookings WHERE DATE(created_at) BETWEEN ? AND ? GROUP BY status`,
      [from, to],
    );
    const byCategory = await query(
      `SELECT so.category_name AS name, COUNT(*) AS total, SUM(so.price) AS value
       FROM service_orders so JOIN bookings b ON b.id = so.booking_id
       WHERE DATE(b.created_at) BETWEEN ? AND ? GROUP BY so.category_name ORDER BY total DESC`,
      [from, to],
    );
    const topServices = await query(
      `SELECT so.service_name AS name, COUNT(*) AS total, SUM(so.price) AS value
       FROM service_orders so JOIN bookings b ON b.id = so.booking_id
       WHERE DATE(b.created_at) BETWEEN ? AND ? GROUP BY so.service_name ORDER BY total DESC LIMIT 6`,
      [from, to],
    );
    const topTechs = await query(
      `SELECT u.name, COUNT(so.id) AS jobs, COALESCE(SUM(so.price), 0) AS value,
              COALESCE(ROUND(AVG(r.rating), 1), 0) AS rating
       FROM service_orders so
       JOIN users u ON u.id = so.technician_id
       JOIN bookings b ON b.id = so.booking_id
       LEFT JOIN reviews r ON r.service_order_id = so.id
       WHERE so.status = 'completed' AND DATE(b.created_at) BETWEEN ? AND ?
       GROUP BY u.id ORDER BY jobs DESC LIMIT 6`,
      [from, to],
    );
    const daily = await query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS total FROM bookings
       WHERE DATE(created_at) BETWEEN ? AND ? GROUP BY day ORDER BY day`,
      [from, to],
    );

    res.render('admin/reports', {
      title: 'Laporan',
      from,
      to,
      summary: summary || {},
      byStatus,
      byCategory,
      topServices,
      topTechs,
      daily,
    });
  }),
);

router.get(
  '/audit',
  ah(async (req, res) => {
    const { page, per, offset } = paginate(req.query, { defaultPer: 20 });
    const filters = { q: String(req.query.q || '').trim(), entity: String(req.query.entity || '').trim() };
    const where = ['1 = 1'];
    const params = [];
    if (filters.q) {
      where.push('(a.description LIKE ? OR a.action LIKE ? OR u.name LIKE ?)');
      const like = `%${filters.q}%`;
      params.push(like, like, like);
    }
    if (filters.entity) {
      where.push('a.entity = ?');
      params.push(filters.entity);
    }
    const whereSql = where.join(' AND ');
    const totalRow = await queryOne(
      `SELECT COUNT(*) AS total FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE ${whereSql}`,
      params,
    );
    const total = Number(totalRow?.total || 0);
    const logs = await query(
      `SELECT a.*, u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       WHERE ${whereSql} ORDER BY a.created_at DESC, a.id DESC LIMIT ${per} OFFSET ${offset}`,
      params,
    );
    const entities = await query('SELECT DISTINCT entity FROM audit_logs ORDER BY entity');
    res.render('admin/audit', {
      title: 'Audit log',
      logs,
      entities,
      filters,
      page,
      per,
      total,
      pages: pageCount(total, per),
    });
  }),
);

router.get(
  '/pengaturan',
  ah(async (req, res) => {
    const settings = await getSettings(true);
    res.render('admin/settings', { title: 'Pengaturan platform', settings });
  }),
);

router.post(
  '/pengaturan',
  ah(async (req, res) => {
    const names = {
      platform_name: String(req.body.platform_name || '').trim(),
      support_email: String(req.body.support_email || '').trim(),
      support_whatsapp: String(req.body.support_whatsapp || '').trim(),
      operational_area: String(req.body.operational_area || '').trim(),
      cancellation_hours: String(Number(req.body.cancellation_hours) || 6),
      cod_note: String(req.body.cod_note || '').trim(),
    };
    if (names.platform_name.length < 3) {
      setFlash(req, 'error', 'Nama platform minimal 3 karakter.');
      return res.redirect('/admin/pengaturan');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(names.support_email)) {
      setFlash(req, 'error', 'Email bantuan tidak valid.');
      return res.redirect('/admin/pengaturan');
    }
    await saveSettings(names);
    await logAudit(req, { action: 'settings.updated', entity: 'settings', description: 'Pengaturan platform diperbarui' });
    setFlash(req, 'success', 'Pengaturan disimpan.');
    res.redirect('/admin/pengaturan');
  }),
);

export default router;
