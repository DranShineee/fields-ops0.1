import express from 'express';
import { query, queryOne } from '../db.js';
import { ah } from '../middleware/web.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { formatRupiah } from '../utils/format.js';
import { paginate, pageCount } from '../utils/pagination.js';

const router = express.Router();

const sortOptions = {
  relevan: 'c.is_active DESC, s.is_featured DESC, s.id ASC',
  termurah: 's.price ASC',
  termahal: 's.price DESC',
  terbaru: 's.created_at DESC',
};

router.get(
  '/',
  ah(async (req, res) => {
    const categories = await query(
      `SELECT c.*, COUNT(s.id) AS service_count,
              MIN(CASE WHEN s.is_active = 1 THEN s.price END) AS min_price
       FROM categories c
       LEFT JOIN services s ON s.category_id = c.id
       WHERE c.is_active = 1
       GROUP BY c.id
       ORDER BY c.sort_order, c.name`,
    );

    const featured = await query(
      `SELECT s.*, c.name AS category_name, c.slug AS category_slug,
              (SELECT ROUND(AVG(r.rating), 1) FROM reviews r
                JOIN service_orders so ON so.id = r.service_order_id
                WHERE so.service_id = s.id AND r.is_hidden = 0) AS rating,
              (SELECT COUNT(*) FROM reviews r
                JOIN service_orders so ON so.id = r.service_order_id
                WHERE so.service_id = s.id AND r.is_hidden = 0) AS review_count
       FROM services s JOIN categories c ON c.id = s.category_id
       WHERE s.is_active = 1 AND s.is_featured = 1
       ORDER BY c.sort_order, s.id
       LIMIT 6`,
    );

    const stats = await queryOne(
      `SELECT
        (SELECT COUNT(*) FROM users u JOIN technician_profiles tp ON tp.user_id = u.id
          WHERE u.role = 'technician' AND tp.status = 'approved' AND u.is_active = 1) AS technicians,
        (SELECT COUNT(*) FROM services WHERE is_active = 1) AS services,
        (SELECT COUNT(*) FROM service_orders WHERE status = 'completed') AS jobs,
        (SELECT ROUND(AVG(rating), 1) FROM reviews WHERE is_hidden = 0) AS rating,
        (SELECT COUNT(*) FROM reviews WHERE is_hidden = 0) AS reviews`,
    );

    const reviews = await query(
      `SELECT r.rating, r.comment, r.created_at, u.name AS customer_name,
              t.name AS technician_name, so.service_name
       FROM reviews r
       JOIN service_orders so ON so.id = r.service_order_id
       JOIN users u ON u.id = r.customer_id
       JOIN users t ON t.id = r.technician_id
       WHERE r.is_hidden = 0
       ORDER BY r.created_at DESC
       LIMIT 3`,
    );

    res.render('home', {
      title: 'Teknisi untuk AC, motor, laptop, dan sepeda',
      categories,
      featured,
      stats,
      reviews,
      formatRupiah,
    });
  }),
);

router.get(
  '/layanan',
  ah(async (req, res) => {
    const { page, per, offset } = paginate(req.query, { defaultPer: 9 });
    const filters = {
      q: String(req.query.q || '').trim(),
      kategori: String(req.query.kategori || '').trim(),
      maks: Number(req.query.maks) || 0,
      sort: sortOptions[req.query.sort] ? req.query.sort : 'relevan',
    };

    const where = ['s.is_active = 1'];
    const params = [];
    if (filters.q) {
      where.push('(s.name LIKE ? OR s.description LIKE ? OR c.name LIKE ?)');
      const like = `%${filters.q}%`;
      params.push(like, like, like);
    }
    if (filters.kategori) {
      where.push('c.slug = ?');
      params.push(filters.kategori);
    }
    if (filters.maks > 0) {
      where.push('s.price <= ?');
      params.push(filters.maks);
    }
    const whereSql = where.join(' AND ');

    const totalRow = await queryOne(
      `SELECT COUNT(*) AS total FROM services s JOIN categories c ON c.id = s.category_id WHERE ${whereSql}`,
      params,
    );
    const total = Number(totalRow?.total || 0);

    const services = await query(
      `SELECT s.*, c.name AS category_name, c.slug AS category_slug,
              (SELECT ROUND(AVG(r.rating), 1) FROM reviews r
                JOIN service_orders so ON so.id = r.service_order_id
                WHERE so.service_id = s.id AND r.is_hidden = 0) AS rating,
              (SELECT COUNT(*) FROM reviews r
                JOIN service_orders so ON so.id = r.service_order_id
                WHERE so.service_id = s.id AND r.is_hidden = 0) AS review_count
       FROM services s JOIN categories c ON c.id = s.category_id
       WHERE ${whereSql}
       ORDER BY ${sortOptions[filters.sort]}
       LIMIT ${per} OFFSET ${offset}`,
      params,
    );

    const categories = await query('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order, name');
    const activeCategory = categories.find((cat) => cat.slug === filters.kategori) || null;

    res.render('services', {
      title: activeCategory ? `Layanan ${activeCategory.name}` : 'Semua layanan',
      services,
      categories,
      filters,
      activeCategory,
      total,
      page,
      per,
      pages: pageCount(total, per),
      formatRupiah,
    });
  }),
);

router.get(
  '/kategori',
  ah(async (req, res) => {
    const categories = await query(
      `SELECT c.*, COUNT(s.id) AS service_count, MIN(s.price) AS min_price
       FROM categories c LEFT JOIN services s ON s.category_id = c.id AND s.is_active = 1
       WHERE c.is_active = 1 GROUP BY c.id ORDER BY c.sort_order, c.name`,
    );
    res.render('categories', { title: 'Kategori layanan', categories, formatRupiah });
  }),
);

router.get(
  '/layanan/:slug',
  ah(async (req, res) => {
    const service = await queryOne(
      `SELECT s.*, c.name AS category_name, c.slug AS category_slug, c.id AS category_id,
              (SELECT ROUND(AVG(r.rating), 1) FROM reviews r
                JOIN service_orders so ON so.id = r.service_order_id
                WHERE so.service_id = s.id AND r.is_hidden = 0) AS rating,
              (SELECT COUNT(*) FROM reviews r
                JOIN service_orders so ON so.id = r.service_order_id
                WHERE so.service_id = s.id AND r.is_hidden = 0) AS review_count
       FROM services s JOIN categories c ON c.id = s.category_id
       WHERE s.slug = ? AND s.is_active = 1 LIMIT 1`,
      [req.params.slug],
    );

    if (!service) {
      return res.status(404).render('error', {
        title: 'Layanan tidak ditemukan',
        status: 404,
        message: 'Layanan ini sudah tidak aktif. Coba telusuri kategori lain.',
      });
    }

    const extras = await query(
      `SELECT id, name, price, price_type FROM services
       WHERE category_id = ? AND id <> ? AND is_active = 1 ORDER BY price ASC LIMIT 4`,
      [service.category_id, service.id],
    );

    const reviews = await query(
      `SELECT r.rating, r.comment, r.created_at, u.name AS customer_name, t.name AS technician_name
       FROM reviews r
       JOIN service_orders so ON so.id = r.service_order_id
       JOIN users u ON u.id = r.customer_id
       JOIN users t ON t.id = r.technician_id
       WHERE so.service_id = ? AND r.is_hidden = 0
       ORDER BY r.created_at DESC LIMIT 5`,
      [service.id],
    );

    const techCount = await queryOne(
      `SELECT COUNT(DISTINCT tp.user_id) AS total FROM technician_profiles tp
       JOIN technician_competencies tc ON tc.technician_id = tp.user_id
       JOIN users u ON u.id = tp.user_id
       WHERE tp.status = 'approved' AND tc.status = 'approved' AND tc.category_id = ? AND u.is_active = 1`,
      [service.category_id],
    );

    const ratings = await queryOne(
      `SELECT COUNT(*) AS total, ROUND(AVG(r.rating), 1) AS average FROM reviews r
       JOIN service_orders so ON so.id = r.service_order_id
       WHERE so.service_id = ? AND r.is_hidden = 0`,
      [service.id],
    );

    const related = await query(
      `SELECT s.id, s.name, s.slug, s.price, s.price_type, c.name AS category_name
       FROM services s JOIN categories c ON c.id = s.category_id
       WHERE s.category_id = ? AND s.id <> ? AND s.is_active = 1 ORDER BY s.is_featured DESC LIMIT 3`,
      [service.category_id, service.id],
    );

    const address = req.session.user
      ? await queryOne(
          'SELECT address, city, postal_code FROM customer_profiles WHERE user_id = ? LIMIT 1',
          [req.session.user.id],
        )
      : null;

    res.render('service-detail', {
      title: service.name,
      service,
      extras,
      reviews,
      related,
      techCount: Number(techCount?.total || 0),
      ratings,
      address,
      today: new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10),
      formatRupiah,
      slots: ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'],
      errors: {},
      values: {},
    });
  }),
);

/** Langkah konfirmasi sebelum booking dibuat (CUS-PG-005). */
router.post(
  '/booking/konfirmasi',
  requireRole('customer'),
  ah(async (req, res) => {
    const { validateBookingInput, TIME_SLOTS } = await import('../utils/bookings.js');
    const { errors, data } = validateBookingInput(req.body);

    const placeholders = data.serviceIds.map(() => '?').join(',');
    const services = data.serviceIds.length
      ? await query(
          `SELECT s.*, c.name AS category_name FROM services s
           JOIN categories c ON c.id = s.category_id
           WHERE s.is_active = 1 AND s.id IN (${placeholders})`,
          data.serviceIds,
        )
      : [];

    if (services.length !== data.serviceIds.length) {
      errors.service = 'Salah satu layanan tidak tersedia. Pilih ulang layanan.';
    }

    const total = services.reduce((sum, item) => sum + Number(item.price), 0);
    if (Object.keys(errors).length > 0) {
      const primary = services[0] || (await queryOne(
        `SELECT s.*, c.name AS category_name, c.slug AS category_slug, c.id AS category_id
         FROM services s JOIN categories c ON c.id = s.category_id WHERE s.id = ? AND s.is_active = 1`,
        [data.serviceIds[0] || 0],
      ));
      if (!primary) {
        req.session.flash = { type: 'error', message: 'Layanan tidak ditemukan.' };
        return res.redirect('/layanan');
      }
      const extras = await query(
        `SELECT id, name, price FROM services WHERE category_id = ? AND id <> ? AND is_active = 1 ORDER BY price LIMIT 4`,
        [primary.category_id, primary.id],
      );
      req.session.flash = { type: 'error', message: Object.values(errors)[0] };
      return res.status(422).render('service-detail', {
        title: primary.name,
        service: { ...primary, slug: primary.slug || req.params.slug },
        extras,
        reviews: [],
        related: [],
        techCount: 0,
        ratings: { total: 0, average: null },
        address: null,
        today: new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10),
        formatRupiah,
        slots: TIME_SLOTS,
        errors,
        values: { ...req.body, extra: data.serviceIds.slice(1).map(String) },
      });
    }

    res.render('booking/confirm', {
      title: 'Konfirmasi booking',
      services,
      data,
      total,
      formatRupiah,
    });
  }),
);

export default router;
