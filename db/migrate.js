import 'dotenv/config';
import fs from 'node:fs/promises';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { config } from '../src/config.js';

const args = new Set(process.argv.slice(2));
const fresh = args.has('--fresh');
const forceSeed = args.has('--seed');
const database = config.db.database;

const PASSWORD = {
  admin: 'Admin#2026',
  customer: 'Pembeli#2026',
  technician: 'Teknisi#2026',
};

const USERS = [
  { name: 'Admin FieldsOps', email: 'admin@fieldsops.id', phone: '081200000001', role: 'admin', password: PASSWORD.admin },
  { name: 'Budi Santoso', email: 'budi@fieldsops.id', phone: '081211112222', role: 'customer', password: PASSWORD.customer, address: 'Jl. Tebet Raya No. 24, Tebet', city: 'Jakarta Selatan', postal_code: '12820' },
  { name: 'Sinta Dewi', email: 'sinta@example.com', phone: '081233334444', role: 'customer', password: PASSWORD.customer, address: 'Komp. Griya Asri Blok C7', city: 'Bandung', postal_code: '40286' },
  { name: 'Rizky Pratama', email: 'rizky@example.com', phone: '081255556666', role: 'customer', password: PASSWORD.customer, address: 'Jl. Kaliurang KM 8 No. 12', city: 'Yogyakarta', postal_code: '55581' },
  { name: 'Dedi Kurniawan', email: 'teknisi1@fieldsops.id', phone: '081377778881', role: 'technician', password: PASSWORD.technician, tech: { status: 'approved', bio: 'Spesialis AC split, cassette, dan kelistrikan rumah. Sudah 8 tahun kerja lapangan.', experience_years: 8, service_area: 'Jakarta Selatan, Jakarta Pusat, Depok' } },
  { name: 'Agus Setiawan', email: 'teknisi2@fieldsops.id', phone: '081377778882', role: 'technician', password: PASSWORD.technician, tech: { status: 'approved', bio: 'Servis laptop, PC, dan sepeda. Terbiasa kerja di kantor dan rumah.', experience_years: 5, service_area: 'Bandung, Cimahi' } },
  { name: 'Bayu Saputra', email: 'teknisi3@fieldsops.id', phone: '081377778883', role: 'technician', password: PASSWORD.technician, tech: { status: 'pending', bio: 'Teknisi AC dan kulkas, baru mulai sebagai mitra.', experience_years: 3, service_area: 'Jakarta Timur' } },
  { name: 'Hendra Wijaya', email: 'teknisi4@fieldsops.id', phone: '081377778884', role: 'technician', password: PASSWORD.technician, tech: { status: 'revision_required', bio: 'Perbaikan motor dan sepeda.', experience_years: 2, service_area: 'Tangerang', review_note: 'Foto KTP buram dan sertifikat belum diunggah. Mohon perbaiki lalu kirim ulang.' } },
];

const CATEGORIES = [
  { name: 'AC', slug: 'ac', description: 'Servis, perbaikan, dan pemasangan AC rumah maupun kantor.', icon: 'ac', sort_order: 1 },
  { name: 'Sepeda Motor', slug: 'sepeda-motor', description: 'Servis rutin sampai perbaikan mesin motor harian.', icon: 'motor', sort_order: 2 },
  { name: 'Komputer', slug: 'komputer', description: 'Laptop dan PC: instalasi, upgrade, sampai perbaikan mati total.', icon: 'laptop', sort_order: 3 },
  { name: 'Sepeda', slug: 'sepeda', description: 'Setel rem, gir, ban, dan servis lengkap sepeda.', icon: 'bike', sort_order: 4 },
];

const SERVICES = [
  { cat: 'ac', name: 'Servis AC Cuci & Isi Freon', price_type: 'fixed', price: 185000, duration: 90, featured: 1, image: '/img/svc-ac.svg', description: 'AC tidak dingin biasanya karena filter kotor dan freon berkurang. Kami cuci unit indoor/outdoor lalu isi freon sesuai tekanan pabrikan.', scope: 'Bongkar cover, cuci evaporator dan filter, cek tekanan, isi freon R32/R410a maksimal 300 gram.', requirements: 'Akses listrik 220V di lokasi. Unit indoor mudah dijangkau.' },
  { cat: 'ac', name: 'Perbaikan AC Tidak Dingin', price_type: 'estimate', price: 250000, duration: 120, featured: 1, image: '/img/svc-ac.svg', description: 'Pemeriksaan menyeluruh untuk AC yang menyala tapi tidak mendinginkan. Biaya akhir menyesuaikan temuan komponen.', scope: 'Diagnosa kompresor, kapasitor, PCB, dan kebocoran freon. Penggantian komponen ditagih terpisah.', requirements: 'Sebutkan merek dan kapasitas AC saat booking.' },
  { cat: 'ac', name: 'Pasang AC Baru (1 Unit)', price_type: 'fixed', price: 450000, duration: 180, image: '/img/svc-ac.svg', description: 'Pemasangan unit split baru termasuk bracket, pipa 3 meter, dan vakum jalur.', scope: 'Pemasangan indoor/outdoor, vakum, tes tekan, dan uji dingin.', requirements: 'Unit AC sudah tersedia. Jalur pipa di atas 3 meter dikenakan biaya tambahan.' },
  { cat: 'sepeda-motor', name: 'Servis Ringan Motor', price_type: 'fixed', price: 120000, duration: 60, featured: 1, image: '/img/svc-motor.svg', description: 'Untuk motor harian yang mulai berisik atau tarikan berat. Servis di tempat, tanpa perlu ke bengkel.', scope: 'Ganti oli mesin, cek busi, setel rantai, bersihkan filter udara.', requirements: 'Oli dan spare part standar sudah termasuk. Motor matic atau bebek.' },
  { cat: 'sepeda-motor', name: 'Ganti Oli & Tune Up', price_type: 'fixed', price: 165000, duration: 75, image: '/img/svc-motor.svg', description: 'Paket tune up untuk motor yang sudah lewat 4.000 km dari servis terakhir.', scope: 'Oli mesin, oli gardan, busi, setel klep, bersihkan karburator/injektor.', requirements: 'Sebutkan tipe motor dan tahun produksi.' },
  { cat: 'sepeda-motor', name: 'Perbaikan Mesin Motor', price_type: 'estimate', price: 400000, duration: 240, image: '/img/svc-motor.svg', description: 'Motor sulit distarter atau keluar asap putih? Diagnosa dulu, baru tentukan perbaikan.', scope: 'Bongkar mesin bagian atas, cek piston, ring, dan klep. Biaya part terpisah.', requirements: 'Motor bisa didorong ke area kerja teknisi.' },
  { cat: 'komputer', name: 'Instalasi Ulang OS & Driver', price_type: 'fixed', price: 150000, duration: 90, featured: 1, image: '/img/svc-komputer.svg', description: 'Laptop lemot karena sistem penuh? Instalasi ulang bersih dengan driver lengkap.', scope: 'Backup data di folder pengguna, instalasi Windows/Linux, driver, dan aplikasi dasar.', requirements: 'Siapkan lisensi OS bila diperlukan. Backup data penting tetap disarankan.' },
  { cat: 'komputer', name: 'Perbaikan Laptop Mati Total', price_type: 'estimate', price: 350000, duration: 180, image: '/img/svc-komputer.svg', description: 'Laptop tidak menyala sama sekali. Kami cek jalur power, IC charging, dan motherboard.', scope: 'Diagnosa power delivery, reball/replace komponen SMD bila diperlukan.', requirements: 'Bawa charger asli saat teknisi datang.' },
  { cat: 'komputer', name: 'Pembersihan & Upgrade RAM/SSD', price_type: 'fixed', price: 200000, duration: 60, image: '/img/svc-komputer.svg', description: 'Laptop panas dan lambat biasanya karena debu menumpuk dan disk lama.', scope: 'Bongkar heatsink, ganti thermal paste, pasang RAM/SSD baru, cloning sistem.', requirements: 'Part upgrade disediakan customer atau dibeli terpisah.' },
  { cat: 'sepeda', name: 'Servis Sepeda Lengkap', price_type: 'fixed', price: 95000, duration: 60, featured: 1, image: '/img/svc-sepeda.svg', description: 'Servis menyeluruh untuk sepeda harian maupun sepeda lipat yang lama tidak dipakai.', scope: 'Cuci rantai, setel rem dan gir, cek bearing, pelumasan.', requirements: 'Sepeda dalam kondisi bisa dikayuh.' },
  { cat: 'sepeda', name: 'Setel Rem & Gir', price_type: 'fixed', price: 75000, duration: 45, image: '/img/svc-sepeda.svg', description: 'Rem blong atau gigi loncat? Penyetelan ulang di tempat, cepat.', scope: 'Setel rem depan/belakang, indeks gir, cek kabel dan housing.', requirements: 'Sebutkan tipe sepeda (mtb, road, lipat).' },
  { cat: 'sepeda', name: 'Perbaikan Ban Tubeless', price_type: 'fixed', price: 60000, duration: 40, image: '/img/svc-sepeda.svg', description: 'Ban tubeless bocor halus yang sulit dilacak bisa ditambal tanpa bongkar roda.', scope: 'Cari kebocoran, tambal, isi ulang sealant, atur tekanan.', requirements: 'Ban masih layak pakai.' },
];

async function ensureDatabase(connection) {
  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await connection.changeUser({ database });
}

/**
 * Hapus komentar SQL tanpa merusak tanda kutip, agar pemecahan per `;`
 * tidak memotong komentar yang memuat titik koma.
 */
function stripSqlComments(sql) {
  let out = '';
  let quote = null;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

async function applySchema(connection) {
  const sql = await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  const statements = stripSqlComments(sql)
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await connection.query(statement);
  }
  console.log(`Skema diterapkan: ${statements.length} statement.`);
}

const TABLES = [
  'status_history',
  'audit_logs',
  'notifications',
  'complaints',
  'reviews',
  'commissions',
  'commission_rules',
  'transactions',
  'work_orders',
  'assignments',
  'service_orders',
  'bookings',
  'services',
  'availability',
  'technician_competencies',
  'categories',
  'technician_profiles',
  'customer_profiles',
  'password_resets',
  'sessions',
  'settings',
  'users',
];

async function dropTables(connection) {
  await connection.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of TABLES) {
    await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
  }
  await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  console.log('Tabel lama dihapus (--fresh).');
}

async function seed(connection) {
  const [[{ total }]] = await connection.query('SELECT COUNT(*) AS total FROM users');
  if (total > 0) {
    console.log(`Seed dilewati: sudah ada ${total} pengguna.`);
    return;
  }

  const userIds = {};
  for (const user of USERS) {
    const hash = await bcrypt.hash(user.password, 12);
    const [result] = await connection.query(
      `INSERT INTO users (name, email, phone, password_hash, role, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [user.name, user.email, user.phone, hash, user.role],
    );
    userIds[user.email] = result.insertId;

    if (user.role === 'customer' && user.address) {
      await connection.query(
        'INSERT INTO customer_profiles (user_id, address, city, postal_code) VALUES (?, ?, ?, ?)',
        [result.insertId, user.address, user.city, user.postal_code],
      );
    }

    if (user.role === 'technician' && user.tech) {
      const tech = user.tech;
      await connection.query(
        `INSERT INTO technician_profiles
          (user_id, status, bio, experience_years, service_area, review_note, submitted_at, reviewed_at, reviewed_by)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
        [
          result.insertId,
          tech.status,
          tech.bio,
          tech.experience_years,
          tech.service_area,
          tech.review_note || null,
          tech.status === 'pending' || tech.status === 'revision_required' ? null : new Date(),
          tech.status === 'pending' || tech.status === 'revision_required' ? null : userIds['admin@fieldsops.id'],
        ],
      );

      for (const day of [1, 2, 3, 4, 5, 6]) {
        await connection.query(
          'INSERT INTO availability (technician_id, day_of_week, start_time, end_time, is_active) VALUES (?, ?, ?, ?, 1)',
          [result.insertId, day, '08:00:00', '17:00:00'],
        );
      }
    }
  }

  const categoryIds = {};
  for (const cat of CATEGORIES) {
    const [result] = await connection.query(
      'INSERT INTO categories (name, slug, description, icon, sort_order, is_active) VALUES (?, ?, ?, ?, ?, 1)',
      [cat.name, cat.slug, cat.description, cat.icon, cat.sort_order],
    );
    categoryIds[cat.slug] = result.insertId;
  }

  const serviceIds = {};
  for (const service of SERVICES) {
    const [result] = await connection.query(
      `INSERT INTO services
        (category_id, name, slug, description, scope, requirements, price_type, price,
         duration_minutes, service_area, image_url, is_active, is_featured)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        categoryIds[service.cat],
        service.name,
        service.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        service.description,
        service.scope,
        service.requirements,
        service.price_type,
        service.price,
        service.duration,
        'Jakarta, Bandung, Yogyakarta',
        service.image,
        service.featured || 0,
      ],
    );
    serviceIds[service.name] = result.insertId;
  }

  const tech1 = userIds['teknisi1@fieldsops.id'];
  const tech2 = userIds['teknisi2@fieldsops.id'];
  const tech3 = userIds['teknisi3@fieldsops.id'];
  const tech4 = userIds['teknisi4@fieldsops.id'];
  const admin = userIds['admin@fieldsops.id'];
  const budi = userIds['budi@fieldsops.id'];
  const sinta = userIds['sinta@example.com'];

  const competencies = [
    [tech1, categoryIds.ac, 'approved'],
    [tech1, categoryIds['sepeda-motor'], 'approved'],
    [tech2, categoryIds.komputer, 'approved'],
    [tech2, categoryIds.sepeda, 'approved'],
    [tech3, categoryIds.ac, 'pending'],
    [tech4, categoryIds.komputer, 'pending'],
  ];
  for (const [techId, catId, status] of competencies) {
    await connection.query(
      'INSERT INTO technician_competencies (technician_id, category_id, status) VALUES (?, ?, ?)',
      [techId, catId, status],
    );
  }

  await connection.query(
    `INSERT INTO settings (setting_key, setting_value) VALUES
      ('platform_name', 'FieldsOps'),
      ('support_email', 'bantuan@fieldsops.id'),
      ('support_whatsapp', '6281234567890'),
      ('operational_area', 'Jakarta, Bandung, Yogyakarta'),
      ('commission_percent', '15'),
      ('cancellation_hours', '6'),
      ('cod_note', 'Bayar tunai setelah pekerjaan selesai dan dicek bersama teknisi.')
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
  );

  await connection.query(
    `INSERT INTO commission_rules (percent, effective_from, created_by) VALUES (15.00, CURDATE(), ?)`,
    [admin],
  );

  async function createBooking({
    code, customer, address, city, postal, date, time, method, channel, status, paymentStatus, notes, items,
  }) {
    const subtotal = items.reduce((sum, item) => sum + Number(item.price), 0);
    const [result] = await connection.query(
      `INSERT INTO bookings
        (code, customer_id, address, city, postal_code, scheduled_date, scheduled_time, notes,
         subtotal, total, status, payment_method, payment_channel, payment_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [code, customer, address, city, postal, date, time, notes || null, subtotal, subtotal, status, method, channel, paymentStatus],
    );
    const bookingId = result.insertId;

    for (const item of items) {
      const [soResult] = await connection.query(
        `INSERT INTO service_orders
          (booking_id, service_id, service_name, category_name, price_type, price, qty, status, technician_id)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          bookingId,
          serviceIds[item.service],
          item.service,
          item.category,
          item.priceType || 'fixed',
          item.price,
          item.status,
          item.technician || null,
        ],
      );
      item.id = soResult.insertId;
      item.bookingId = bookingId;
    }

    await connection.query(
      `INSERT INTO transactions (reference, booking_id, amount, method, channel, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [`TRX-${code.replace('BK-', '')}`, bookingId, subtotal, method, channel, paymentStatus === 'paid' ? 'paid' : paymentStatus === 'pending_verification' ? 'pending_verification' : 'unpaid'],
    );

    return bookingId;
  }

  // Booking 1 — selesai, sudah dibayar, satu service order diulas.
  const booking1 = await createBooking({
    code: 'BK-DEMO01',
    customer: budi,
    address: 'Jl. Tebet Raya No. 24, Tebet',
    city: 'Jakarta Selatan',
    postal: '12820',
    date: '2026-11-04',
    time: '09:00:00',
    method: 'full',
    channel: 'transfer',
    status: 'completed',
    paymentStatus: 'paid',
    notes: 'AC kamar utama, sudah 2 tahun tidak diservis.',
    items: [
      { service: 'Servis AC Cuci & Isi Freon', category: 'AC', price: 185000, status: 'completed', technician: tech1 },
      { service: 'Setel Rem & Gir', category: 'Sepeda', price: 75000, status: 'completed', technician: tech2 },
    ],
  });
  const [b1Orders] = await connection.query('SELECT id, service_name FROM service_orders WHERE booking_id = ? ORDER BY id', [booking1]);
  await connection.query(
    'INSERT INTO reviews (service_order_id, booking_id, customer_id, technician_id, rating, comment) VALUES (?, ?, ?, ?, ?, ?)',
    [b1Orders[0].id, booking1, budi, tech1, 5, 'Datang tepat waktu, AC langsung dingin. Dijelaskan juga cara cuci filter sendiri.'],
  );
  for (const order of b1Orders) {
    const techId = order.service_name.includes('AC') ? tech1 : tech2;
    const price = order.service_name.includes('AC') ? 185000 : 75000;
    const fee = Math.round(price * 0.15);
    await connection.query(
      `INSERT INTO commissions (service_order_id, booking_id, technician_id, gross_amount, percent, platform_fee, technician_earning)
       VALUES (?, ?, ?, ?, 15.00, ?, ?)`,
      [order.id, booking1, techId, price, fee, price - fee],
    );
    await connection.query(
      `INSERT INTO work_orders (service_order_id, technician_id, instructions, findings, actions_taken, status, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 'completed', '2026-11-04 09:10:00', '2026-11-04 11:20:00')`,
      [order.id, techId, 'Kerjakan sesuai cakupan layanan, foto sebelum dan sesudah.', 'Freon kurang 200 gram, filter tebal debu.', 'Cuci unit, isi freon, uji dingin 20 menit.'],
    );
    await connection.query(
      `INSERT INTO status_history (entity_type, entity_id, from_status, to_status, actor_id, note)
       VALUES ('service_order', ?, 'assigned', 'completed', ?, 'Pekerjaan diselesaikan teknisi')`,
      [order.id, techId],
    );
  }

  // Booking 2 — sedang berjalan, pembayaran menunggu verifikasi.
  const booking2 = await createBooking({
    code: 'BK-DEMO02',
    customer: budi,
    address: 'Jl. Tebet Raya No. 24, Tebet',
    city: 'Jakarta Selatan',
    postal: '12820',
    date: '2026-11-16',
    time: '13:30:00',
    method: 'full',
    channel: 'transfer',
    status: 'in_progress',
    paymentStatus: 'pending_verification',
    notes: 'Laptop lenovo ideapad, mati setelah kena air.',
    items: [
      { service: 'Perbaikan Laptop Mati Total', category: 'Komputer', priceType: 'estimate', price: 350000, status: 'in_progress', technician: tech2 },
    ],
  });
  const [[b2Order]] = await connection.query('SELECT id FROM service_orders WHERE booking_id = ? LIMIT 1', [booking2]);
  await connection.query(
    `INSERT INTO assignments (service_order_id, technician_id, status, assigned_by, responded_at)
     VALUES (?, ?, 'accepted', ?, NOW())`,
    [b2Order.id, tech2, admin],
  );
  await connection.query(
    `INSERT INTO work_orders (service_order_id, technician_id, instructions, findings, status, started_at)
     VALUES (?, ?, 'Cek jalur power dan motherboard. Laporkan bila perlu ganti part.', 'Ada korosi di area power rail.', 'in_progress', NOW())`,
    [b2Order.id, tech2],
  );
  await connection.query(
    `INSERT INTO status_history (entity_type, entity_id, from_status, to_status, actor_id, note)
     VALUES ('service_order', ?, 'assigned', 'in_progress', ?, 'Teknisi mulai bekerja')`,
    [b2Order.id, tech2],
  );

  // Booking 3 — menunggu penugasan, belum dibayar, COD.
  const booking3 = await createBooking({
    code: 'BK-DEMO03',
    customer: sinta,
    address: 'Komp. Griya Asri Blok C7',
    city: 'Bandung',
    postal: '40286',
    date: '2026-11-18',
    time: '10:00:00',
    method: 'cod',
    channel: null,
    status: 'submitted',
    paymentStatus: 'unpaid',
    notes: 'AC kamar tidur, remote tidak berfungsi.',
    items: [
      { service: 'Perbaikan AC Tidak Dingin', category: 'AC', priceType: 'estimate', price: 250000, status: 'awaiting_assignment' },
    ],
  });

  // Booking 4 — penawaran penugasan menunggu respons teknisi.
  const booking4 = await createBooking({
    code: 'BK-DEMO04',
    customer: budi,
    address: 'Jl. Tebet Raya No. 24, Tebet',
    city: 'Jakarta Selatan',
    postal: '12820',
    date: '2026-11-19',
    time: '15:00:00',
    method: 'cod',
    channel: null,
    status: 'processing',
    paymentStatus: 'unpaid',
    notes: 'Motor Beat 2020, suara kasar di area CVT.',
    items: [
      { service: 'Servis Ringan Motor', category: 'Sepeda Motor', price: 120000, status: 'assigned', technician: tech1 },
    ],
  });
  const [[b4Order]] = await connection.query('SELECT id FROM service_orders WHERE booking_id = ? LIMIT 1', [booking4]);
  await connection.query(
    `INSERT INTO assignments (service_order_id, technician_id, status, assigned_by)
     VALUES (?, ?, 'offered', ?)`,
    [b4Order.id, tech1, admin],
  );
  await connection.query(
    `INSERT INTO work_orders (service_order_id, technician_id, instructions, status)
     VALUES (?, ?, 'Servis ringan di rumah customer. Bawa oli 0.8L.', 'assigned')`,
    [b4Order.id, tech1],
  );

  await connection.query(
    `INSERT INTO complaints (code, user_id, booking_id, subject, message, status, response, handled_by, created_at)
     VALUES ('KL-DEMO01', ?, ?, 'AC berisik setelah servis', 'Unit indoor masih bergetar saat dinyalakan. Mohon dicek ulang.', 'resolved', 'Teknisi sudah melakukan kunjungan ulang dan menyetel dudukan unit. Terima kasih laporannya.', ?, NOW())`,
    [budi, booking1, admin],
  );

  const notifications = [
    [budi, 'Booking selesai', 'Servis AC Cuci & Isi Freon sudah selesai. Beri ulasan untuk teknisi.', '/booking/BK-DEMO01'],
    [budi, 'Pembayaran menunggu verifikasi', 'Bukti transfer BK-DEMO02 sedang diperiksa admin.', '/booking/BK-DEMO02'],
    [tech1, 'Penugasan baru', 'Servis Ringan Motor menunggu konfirmasi Anda.', '/teknisi/penugasan'],
    [tech2, 'Pekerjaan berjalan', 'Perbaikan Laptop Mati Total sudah dimulai. Jangan lupa unggah bukti.', '/teknisi/pekerjaan'],
    [admin, 'Pengajuan teknisi baru', 'Bayu Saputra mengajukan kemitraan dan menunggu verifikasi.', '/admin/verifikasi'],
  ];
  for (const [userId, title, body, link] of notifications) {
    await connection.query(
      'INSERT INTO notifications (user_id, title, body, link, is_read) VALUES (?, ?, ?, ?, 0)',
      [userId, title, body, link],
    );
  }

  const audits = [
    [admin, 'admin', 'technician.approved', 'technician', tech1, 'Menyetujui kemitraan Dedi Kurniawan'],
    [admin, 'admin', 'technician.approved', 'technician', tech2, 'Menyetujui kemitraan Agus Setiawan'],
    [admin, 'admin', 'assignment.created', 'service_order', b4Order.id, 'Menugaskan Dedi Kurniawan ke servis ringan motor'],
    [tech2, 'technician', 'work_order.started', 'work_order', b2Order.id, 'Memulai pekerjaan perbaikan laptop'],
  ];
  for (const [actor, role, action, entity, entityId, description] of audits) {
    await connection.query(
      'INSERT INTO audit_logs (actor_id, actor_role, action, entity, entity_id, description, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [actor, role, action, entity, entityId, description, '127.0.0.1'],
    );
  }

  console.log(
    `Seed selesai: ${USERS.length} pengguna, ${CATEGORIES.length} kategori, ${SERVICES.length} layanan, 4 booking demo.`,
  );
  console.log(`Akun demo — admin@fieldsops.id / ${PASSWORD.admin}, budi@fieldsops.id / ${PASSWORD.customer}, teknisi1@fieldsops.id / ${PASSWORD.technician}`);
}

async function main() {
  const connection = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
  });

  try {
    await ensureDatabase(connection);
    if (fresh) await dropTables(connection);
    await applySchema(connection);
    console.log(`Skema siap pada database \`${database}\`.`);
    if (fresh || forceSeed) {
      await seed(connection);
    } else {
      console.log('Tidak ada seed baru. Gunakan `npm run seed` untuk data demo.');
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error('Migrasi gagal:', error.message);
  if (error.code === 'ER_ACCESS_DENIED_ERROR') {
    console.error('Periksa DB_USER / DB_PASSWORD pada berkas .env.');
  }
  process.exitCode = 1;
});
