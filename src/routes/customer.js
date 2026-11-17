import express from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne, transaction } from '../db.js';
import { ah, setFlash, verifyCsrf } from '../middleware/web.js';
import { requireRole } from '../middleware/auth.js';
import { logAudit, logStatus } from '../utils/audit.js';
import { notify } from '../utils/notify.js';
import { uploadPrivate } from '../utils/uploads.js';
import {
  CANCELLABLE_BOOKING,
  generateCode,
  loadBookingDetail,
  recalcBookingStatus,
  validateBookingInput,
} from '../utils/bookings.js';
import { paginate, pageCount } from '../utils/pagination.js';

const router = express.Router();

async function ownBooking(code, userId) {
  return queryOne('SELECT * FROM bookings WHERE code = ? AND customer_id = ? LIMIT 1', [code, userId]);
}

router.get(
  '/akun',
  requireRole('customer'),
  ah(async (req, res) => {
    const userId = req.session.user.id;
    const profile = await queryOne('SELECT * FROM customer_profiles WHERE user_id = ? LIMIT 1', [userId]);
    const stats = await queryOne(
      `SELECT COUNT(*) AS total,
              SUM(status IN ('submitted','processing','in_progress')) AS active,
              SUM(status = 'completed') AS completed,
              SUM(CASE WHEN payment_status = 'paid' THEN total ELSE 0 END) AS spent
       FROM bookings WHERE customer_id = ?`,
      [userId],
    );
    const upcoming = await query(
      `SELECT b.*, (SELECT COUNT(*) FROM service_orders so WHERE so.booking_id = b.id) AS item_count
       FROM bookings b
       WHERE b.customer_id = ? AND b.status IN ('submitted','processing','in_progress')
       ORDER BY b.scheduled_date ASC, b.scheduled_time ASC LIMIT 3`,
      [userId],
    );
    const recent = await query(
      `SELECT b.*, (SELECT COUNT(*) FROM service_orders so WHERE so.booking_id = b.id) AS item_count
       FROM bookings b WHERE b.customer_id = ?
       ORDER BY b.created_at DESC LIMIT 4`,
      [userId],
    );
    const notifications = await query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 4',
      [userId],
    );

    res.render('customer/account', {
      title: 'Akun saya',
      profile,
      stats: stats || {},
      upcoming,
      recent,
      notifications,
    });
  }),
);

router.post(
  '/booking',
  requireRole('customer'),
  ah(async (req, res) => {
    const userId = req.session.user.id;
    const { errors, data } = validateBookingInput(req.body);
    if (Object.keys(errors).length > 0) {
      setFlash(req, 'error', Object.values(errors)[0]);
      return res.redirect(req.get('referer') || '/layanan');
    }

    const placeholders = data.serviceIds.map(() => '?').join(',');
    const services = await query(
      `SELECT s.*, c.name AS category_name FROM services s
       JOIN categories c ON c.id = s.category_id
       WHERE s.is_active = 1 AND s.id IN (${placeholders})`,
      data.serviceIds,
    );
    if (services.length !== data.serviceIds.length) {
      setFlash(req, 'error', 'Layanan tidak tersedia. Silakan pilih ulang.');
      return res.redirect('/layanan');
    }

    // Anti-duplikasi: booking aktif pada alamat & slot yang sama (SRS IX).
    const duplicate = await queryOne(
      `SELECT id FROM bookings
       WHERE customer_id = ? AND address = ? AND scheduled_date = ? AND scheduled_time = ?
         AND status <> 'cancelled' LIMIT 1`,
      [userId, data.address, data.date, data.time],
    );
    if (duplicate) {
      setFlash(req, 'error', 'Anda sudah punya booking aktif di alamat dan jam yang sama.');
      return res.redirect('/booking/' + (await queryOne('SELECT code FROM bookings WHERE id = ?', [duplicate.id])).code);
    }

    const total = services.reduce((sum, item) => sum + Number(item.price), 0);
    let code = generateCode('BK');
    for (let i = 0; i < 3; i += 1) {
      const exists = await queryOne('SELECT id FROM bookings WHERE code = ?', [code]);
      if (!exists) break;
      code = generateCode('BK');
    }

    const bookingId = await transaction(async (connection) => {
      const [bookingResult] = await connection.execute(
        `INSERT INTO bookings
          (code, customer_id, address, city, postal_code, scheduled_date, scheduled_time, notes,
           subtotal, total, status, payment_method, payment_channel, payment_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, 'unpaid')`,
        [
          code,
          userId,
          data.address,
          data.city,
          data.postalCode || null,
          data.date,
          data.time,
          data.notes || null,
          total,
          total,
          data.method,
          data.channel,
        ],
      );
      const id = bookingResult.insertId;

      for (const service of services) {
        await connection.execute(
          `INSERT INTO service_orders
            (booking_id, service_id, service_name, category_name, price_type, price, qty, status)
           VALUES (?, ?, ?, ?, ?, ?, 1, 'submitted')`,
          [id, service.id, service.name, service.category_name, service.price_type, service.price],
        );
      }

      await connection.execute(
        `INSERT INTO transactions (reference, booking_id, amount, method, channel, status)
         VALUES (?, ?, ?, ?, ?, 'unpaid')`,
        [`TRX-${code.slice(3)}`, id, total, data.method, data.channel],
      );

      await connection.execute(
        `INSERT INTO status_history (entity_type, entity_id, from_status, to_status, actor_id, note)
         VALUES ('booking', ?, NULL, 'submitted', ?, 'Booking dibuat customer')`,
        [id, userId],
      );

      return id;
    });

    await notify(
      userId,
      'Booking diterima',
      `Booking ${code} sudah masuk. Admin akan memproses dan menugaskan teknisi.`,
      `/booking/${code}`,
    );

    const admins = await query("SELECT id FROM users WHERE role = 'admin' AND is_active = 1");
    for (const admin of admins) {
      await notify(
        admin.id,
        'Booking baru masuk',
        `${code} · ${services.length} layanan · ${data.city}`,
        `/admin/booking/${code}`,
      );
    }

    await logAudit(req, {
      action: 'booking.created',
      entity: 'booking',
      entityId: bookingId,
      description: `Booking ${code} dibuat (${services.length} layanan, total ${total})`,
      meta: { method: data.method, channel: data.channel },
    });
    await logStatus(req, {
      entityType: 'booking',
      entityId: bookingId,
      fromStatus: null,
      toStatus: 'submitted',
      note: 'Booking dibuat customer',
    });

    setFlash(req, 'success', `Booking ${code} dibuat. Simpan kode ini untuk memantau pekerjaan.`);
    res.redirect(`/booking/${code}`);
  }),
);

router.get(
  '/booking/:code',
  requireRole('customer'),
  ah(async (req, res) => {
    const booking = await ownBooking(req.params.code, req.session.user.id);
    if (!booking) {
      return res.status(404).render('error', {
        title: 'Booking tidak ditemukan',
        status: 404,
        message: 'Kode booking tidak ada atau bukan milik akun Anda.',
      });
    }
    const detail = await loadBookingDetail(booking.id);
    const complaint = await queryOne('SELECT * FROM complaints WHERE booking_id = ? ORDER BY id DESC LIMIT 1', [booking.id]);

    res.render('booking/detail', {
      title: `Booking ${booking.code}`,
      ...detail,
      complaint,
      canCancel: CANCELLABLE_BOOKING.has(booking.status),
      reviewable: detail.orders.filter((order) => order.status === 'completed' && !order.review_id),
    });
  }),
);

router.post(
  '/booking/:code/batal',
  requireRole('customer'),
  ah(async (req, res) => {
    const booking = await ownBooking(req.params.code, req.session.user.id);
    if (!booking) return res.status(404).render('error', { title: 'Tidak ditemukan', status: 404, message: 'Booking bukan milik Anda.' });

    if (!CANCELLABLE_BOOKING.has(booking.status)) {
      setFlash(req, 'error', 'Booking yang sudah dikerjakan tidak bisa dibatalkan sendiri. Ajukan keluhan agar admin membantu.');
      return res.redirect(`/booking/${booking.code}`);
    }

    const reason = String(req.body.reason || '').trim();
    if (reason.length < 5) {
      setFlash(req, 'error', 'Sebutkan alasan pembatalan minimal 5 karakter.');
      return res.redirect(`/booking/${booking.code}`);
    }

    const techniciansBeforeCancel = await query(
      'SELECT DISTINCT technician_id FROM service_orders WHERE booking_id = ? AND technician_id IS NOT NULL',
      [booking.id],
    );

    await transaction(async (connection) => {
      await connection.execute(
        `UPDATE bookings SET status = 'cancelled', cancel_reason = ? WHERE id = ?`,
        [reason.slice(0, 300), booking.id],
      );
      await connection.execute(
        `UPDATE service_orders SET status = 'cancelled', technician_id = NULL
         WHERE booking_id = ? AND status NOT IN ('completed','cancelled')`,
        [booking.id],
      );
      // Lepaskan teknisi & hapus work order agar jadwalnya tidak terkunci
      // oleh booking yang sudah dibatalkan.
      await connection.execute(
        `UPDATE assignments SET status = 'cancelled', reason = COALESCE(reason, 'Booking dibatalkan customer'), responded_at = NOW()
         WHERE status IN ('offered','accepted')
           AND service_order_id IN (SELECT id FROM service_orders WHERE booking_id = ?)`,
        [booking.id],
      );
      await connection.execute(
        `DELETE FROM work_orders WHERE service_order_id IN (SELECT id FROM service_orders WHERE booking_id = ?)`,
        [booking.id],
      );
    });

    await logAudit(req, {
      action: 'booking.cancelled',
      entity: 'booking',
      entityId: booking.id,
      description: `Customer membatalkan ${booking.code}: ${reason.slice(0, 180)}`,
    });
    await logStatus(req, {
      entityType: 'booking',
      entityId: booking.id,
      fromStatus: booking.status,
      toStatus: 'cancelled',
      note: reason.slice(0, 200),
    });

    const admins = await query("SELECT id FROM users WHERE role = 'admin' AND is_active = 1");
    for (const admin of admins) {
      await notify(admin.id, 'Booking dibatalkan customer', `${booking.code} — ${reason.slice(0, 160)}`, `/admin/booking/${booking.code}`);
    }
    for (const order of techniciansBeforeCancel) {
      await notify(order.technician_id, 'Booking dibatalkan', `${booking.code} dibatalkan customer.`, '/teknisi/penugasan');
    }

    setFlash(req, 'info', 'Booking dibatalkan. Bila sudah ada pembayaran, admin akan memproses pengembalian.');
    res.redirect(`/booking/${booking.code}`);
  }),
);

router.get(
  '/booking/:code/bayar',
  requireRole('customer'),
  ah(async (req, res) => {
    const booking = await ownBooking(req.params.code, req.session.user.id);
    if (!booking) return res.status(404).render('error', { title: 'Tidak ditemukan', status: 404, message: 'Booking bukan milik Anda.' });
    const tx = await queryOne('SELECT * FROM transactions WHERE booking_id = ? ORDER BY id DESC LIMIT 1', [booking.id]);
    res.render('booking/payment', { title: `Pembayaran ${booking.code}`, booking, transaction: tx });
  }),
);

router.post(
  '/booking/:code/bayar',
  requireRole('customer'),
  uploadPrivate.single('proof'),
  verifyCsrf,
  ah(async (req, res) => {
    const booking = await ownBooking(req.params.code, req.session.user.id);
    if (!booking) return res.status(404).render('error', { title: 'Tidak ditemukan', status: 404, message: 'Booking bukan milik Anda.' });

    if (booking.status === 'cancelled') {
      setFlash(req, 'error', 'Booking sudah dibatalkan.');
      return res.redirect(`/booking/${booking.code}`);
    }
    if (booking.payment_method !== 'full') {
      setFlash(req, 'info', 'Booking ini memakai COD. Pembayaran dilakukan setelah pekerjaan selesai.');
      return res.redirect(`/booking/${booking.code}`);
    }
    if (booking.payment_status === 'paid') {
      setFlash(req, 'info', 'Pembayaran booking ini sudah lunas.');
      return res.redirect(`/booking/${booking.code}`);
    }
    if (!req.file) {
      setFlash(req, 'error', 'Unggah bukti transfer (JPG, PNG, atau PDF).');
      return res.redirect(`/booking/${booking.code}/bayar`);
    }

    const proofUrl = `/berkas/bukti/${req.file.filename}`;
    await query(
      `UPDATE transactions SET proof_url = ?, status = 'pending_verification' WHERE booking_id = ?`,
      [proofUrl, booking.id],
    );
    await query(`UPDATE bookings SET payment_status = 'pending_verification' WHERE id = ?`, [booking.id]);

    const admins = await query("SELECT id FROM users WHERE role = 'admin' AND is_active = 1");
    for (const admin of admins) {
      await notify(admin.id, 'Bukti pembayaran masuk', `${booking.code} menunggu verifikasi pembayaran.`, `/admin/transaksi`);
    }
    await logAudit(req, {
      action: 'payment.proof_uploaded',
      entity: 'booking',
      entityId: booking.id,
      description: `Bukti pembayaran diunggah untuk ${booking.code}`,
    });

    setFlash(req, 'success', 'Bukti pembayaran dikirim. Admin akan memverifikasi maksimal 1x24 jam.');
    res.redirect(`/booking/${booking.code}`);
  }),
);

router.get(
  '/booking/:code/ulasan/:orderId',
  requireRole('customer'),
  ah(async (req, res) => {
    const booking = await ownBooking(req.params.code, req.session.user.id);
    if (!booking) return res.status(404).render('error', { title: 'Tidak ditemukan', status: 404, message: 'Booking bukan milik Anda.' });
    const order = await queryOne(
      `SELECT so.*, wo.id AS work_order_id FROM service_orders so
       LEFT JOIN work_orders wo ON wo.service_order_id = so.id
       WHERE so.id = ? AND so.booking_id = ? LIMIT 1`,
      [req.params.orderId, booking.id],
    );
    if (!order) return res.status(404).render('error', { title: 'Layanan tidak ditemukan', status: 404, message: 'Item ini bukan bagian dari booking.' });

    const existing = await queryOne('SELECT id FROM reviews WHERE service_order_id = ?', [order.id]);
    if (order.status !== 'completed' || existing) {
      setFlash(req, 'info', 'Ulasan hanya bisa ditulis sekali setelah pekerjaan selesai.');
      return res.redirect(`/booking/${booking.code}`);
    }

    res.render('booking/review', { title: 'Beri ulasan', booking, order, error: null });
  }),
);

router.post(
  '/booking/:code/ulasan/:orderId',
  requireRole('customer'),
  ah(async (req, res) => {
    const booking = await ownBooking(req.params.code, req.session.user.id);
    if (!booking) return res.status(404).render('error', { title: 'Tidak ditemukan', status: 404, message: 'Booking bukan milik Anda.' });
    const order = await queryOne(
      `SELECT * FROM service_orders WHERE id = ? AND booking_id = ? AND status = 'completed' LIMIT 1`,
      [req.params.orderId, booking.id],
    );
    if (!order || !order.technician_id) {
      setFlash(req, 'error', 'Pekerjaan ini belum bisa diulas.');
      return res.redirect(`/booking/${booking.code}`);
    }

    const existing = await queryOne('SELECT id FROM reviews WHERE service_order_id = ?', [order.id]);
    const rating = Number(req.body.rating);
    const comment = String(req.body.comment || '').trim();

    if (existing) {
      setFlash(req, 'info', 'Ulasan untuk pekerjaan ini sudah ada.');
      return res.redirect(`/booking/${booking.code}`);
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(422).render('booking/review', {
        title: 'Beri ulasan',
        booking,
        order,
        error: 'Pilih rating 1 sampai 5 bintang.',
      });
    }

    await query(
      `INSERT INTO reviews (service_order_id, booking_id, customer_id, technician_id, rating, comment)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [order.id, booking.id, req.session.user.id, order.technician_id, rating, comment.slice(0, 600) || null],
    );
    await notify(
      order.technician_id,
      'Ulasan baru',
      `Anda mendapat ${rating} bintang untuk ${order.service_name}.`,
      '/teknisi/riwayat',
    );
    await logAudit(req, {
      action: 'review.created',
      entity: 'service_order',
      entityId: order.id,
      description: `Ulasan ${rating} bintang untuk ${order.service_name}`,
    });

    setFlash(req, 'success', 'Terima kasih. Ulasan Anda membantu customer lain memilih teknisi.');
    res.redirect(`/booking/${booking.code}`);
  }),
);

router.get(
  '/profil',
  requireRole('customer'),
  ah(async (req, res) => {
    const profile = await queryOne('SELECT * FROM customer_profiles WHERE user_id = ? LIMIT 1', [req.session.user.id]);
    res.render('customer/profile', {
      title: 'Profil & alamat',
      profile,
      errors: {},
      form: { name: req.session.user.name, phone: req.session.user.phone, ...profile },
    });
  }),
);

router.post(
  '/profil',
  requireRole('customer'),
  ah(async (req, res) => {
    const userId = req.session.user.id;
    const form = {
      name: String(req.body.name || '').trim(),
      phone: String(req.body.phone || '').trim(),
      address: String(req.body.address || '').trim(),
      city: String(req.body.city || '').trim(),
      postal_code: String(req.body.postal_code || '').trim(),
    };
    const errors = {};
    if (form.name.length < 3) errors.name = 'Nama minimal 3 karakter.';
    if (!/^[0-9+\-\s()]{8,24}$/.test(form.phone)) errors.phone = 'Nomor WhatsApp tidak valid.';
    if (form.postal_code && !/^\d{5}$/.test(form.postal_code)) errors.postal_code = 'Kode pos 5 angka.';

    if (Object.keys(errors).length > 0) {
      return res.status(422).render('customer/profile', {
        title: 'Profil & alamat',
        profile: form,
        errors,
        form,
      });
    }

    await query('UPDATE users SET name = ?, phone = ? WHERE id = ?', [form.name, form.phone, userId]);
    await query(
      `INSERT INTO customer_profiles (user_id, address, city, postal_code) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE address = VALUES(address), city = VALUES(city), postal_code = VALUES(postal_code)`,
      [userId, form.address || null, form.city || null, form.postal_code || null],
    );
    req.session.user.name = form.name;
    req.session.user.phone = form.phone;

    await logAudit(req, { action: 'profile.updated', entity: 'user', entityId: userId, description: 'Customer memperbarui profil & alamat' });
    setFlash(req, 'success', 'Profil diperbarui.');
    res.redirect('/profil');
  }),
);

router.post(
  '/profil/sandi',
  requireRole('customer'),
  ah(async (req, res) => {
    const user = await queryOne('SELECT password_hash FROM users WHERE id = ?', [req.session.user.id]);
    const current = String(req.body.current_password || '');
    const next = String(req.body.new_password || '');
    const confirm = String(req.body.confirm_password || '');

    if (!(await bcrypt.compare(current, user.password_hash))) {
      setFlash(req, 'error', 'Kata sandi saat ini tidak cocok.');
      return res.redirect('/profil');
    }
    if (next.length < 8 || !/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) {
      setFlash(req, 'error', 'Kata sandi baru minimal 8 karakter dan mengandung huruf serta angka.');
      return res.redirect('/profil');
    }
    if (next !== confirm) {
      setFlash(req, 'error', 'Konfirmasi kata sandi baru tidak sama.');
      return res.redirect('/profil');
    }

    await query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(next, 12), req.session.user.id]);
    await logAudit(req, { action: 'password.changed', entity: 'user', entityId: req.session.user.id, description: 'Customer mengganti kata sandi' });
    setFlash(req, 'success', 'Kata sandi diperbarui.');
    res.redirect('/profil');
  }),
);

router.get(
  '/keluhan',
  requireRole('customer'),
  ah(async (req, res) => {
    const { page, per, offset } = paginate(req.query, { defaultPer: 8 });
    const totalRow = await queryOne('SELECT COUNT(*) AS total FROM complaints WHERE user_id = ?', [req.session.user.id]);
    const total = Number(totalRow?.total || 0);
    const complaints = await query(
      `SELECT c.*, b.code AS booking_code FROM complaints c
       LEFT JOIN bookings b ON b.id = c.booking_id
       WHERE c.user_id = ? ORDER BY c.created_at DESC LIMIT ${per} OFFSET ${offset}`,
      [req.session.user.id],
    );
    const bookings = await query(
      `SELECT id, code, scheduled_date, status FROM bookings WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20`,
      [req.session.user.id],
    );
    res.render('customer/complaints', {
      title: 'Bantuan & keluhan',
      complaints,
      bookings,
      page,
      pages: pageCount(total, per),
      per,
      total,
    });
  }),
);

router.post(
  '/keluhan',
  requireRole('customer'),
  ah(async (req, res) => {
    const subject = String(req.body.subject || '').trim();
    const message = String(req.body.message || '').trim();
    const bookingId = Number(req.body.booking_id) || null;

    if (subject.length < 5 || message.length < 15) {
      setFlash(req, 'error', 'Subjek minimal 5 karakter dan pesan minimal 15 karakter.');
      return res.redirect('/keluhan');
    }
    if (bookingId) {
      const owned = await queryOne('SELECT id FROM bookings WHERE id = ? AND customer_id = ?', [bookingId, req.session.user.id]);
      if (!owned) {
        setFlash(req, 'error', 'Booking yang dipilih bukan milik Anda.');
        return res.redirect('/keluhan');
      }
    }

    let code = generateCode('KL');
    const exists = await queryOne('SELECT id FROM complaints WHERE code = ?', [code]);
    if (exists) code = generateCode('KL');

    const result = await query(
      `INSERT INTO complaints (code, user_id, booking_id, subject, message, status)
       VALUES (?, ?, ?, ?, ?, 'open')`,
      [code, req.session.user.id, bookingId, subject.slice(0, 160), message.slice(0, 800)],
    );

    const admins = await query("SELECT id FROM users WHERE role = 'admin' AND is_active = 1");
    for (const admin of admins) {
      await notify(admin.id, 'Keluhan baru', `${code} — ${subject.slice(0, 100)}`, '/admin/keluhan');
    }
    await logAudit(req, {
      action: 'complaint.created',
      entity: 'complaint',
      entityId: result.insertId,
      description: `Keluhan ${code}: ${subject.slice(0, 160)}`,
    });

    setFlash(req, 'success', `Keluhan ${code} terkirim. Admin akan menindaklanjuti.`);
    res.redirect('/keluhan');
  }),
);

router.get(
  '/notifikasi',
  ah(async (req, res) => {
    if (!req.session?.user) return res.redirect('/login?next=/notifikasi');
    const { page, per, offset } = paginate(req.query, { defaultPer: 12 });
    const totalRow = await queryOne('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ?', [req.session.user.id]);
    const total = Number(totalRow?.total || 0);
    const notifications = await query(
      `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ${per} OFFSET ${offset}`,
      [req.session.user.id],
    );
    res.render('notifications', {
      title: 'Notifikasi',
      notifications,
      page,
      pages: pageCount(total, per),
      per,
      total,
    });
  }),
);

router.post(
  '/notifikasi/:id/baca',
  requireRole('customer', 'technician', 'admin'),
  ah(async (req, res) => {
    const row = await queryOne('SELECT * FROM notifications WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    if (!row) {
      setFlash(req, 'error', 'Notifikasi tidak ditemukan.');
      return res.redirect('/notifikasi');
    }
    await query('UPDATE notifications SET is_read = 1 WHERE id = ?', [row.id]);
    res.redirect(row.link && row.link.startsWith('/') ? row.link : '/notifikasi');
  }),
);

router.post(
  '/notifikasi/baca-semua',
  requireRole('customer', 'technician', 'admin'),
  ah(async (req, res) => {
    await query('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.session.user.id]);
    setFlash(req, 'success', 'Semua notifikasi ditandai sudah dibaca.');
    res.redirect('/notifikasi');
  }),
);

export default router;
