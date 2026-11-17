/**
 * Uji end-to-end FieldsOps.
 *
 * Jalankan server lebih dulu (`npm start`), lalu:
 *   node scripts/e2e.mjs            # memakai http://localhost:3000
 *   BASE=http://localhost:3000 node scripts/e2e.mjs
 *
 * Skrip ini membuat data baru (booking uji) dan memverifikasi hasilnya di
 * database. Data demo lama tidak diubah kecuali bila dipakai sebagai bahan uji.
 */
import fs from 'node:fs';
import mysql from 'mysql2/promise';

const BASE = process.env.BASE || 'http://localhost:3000';
const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD ?? 'ServBay.dev',
  database: process.env.DB_NAME || 'fieldsops',
  decimalNumbers: true,
};

let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

class Session {
  constructor(name) {
    this.name = name;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  store(response) {
    for (const raw of response.headers.getSetCookie?.() || []) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      const key = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(raw)) this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
  }

  async request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (this.cookies.size) headers.cookie = this.cookieHeader();
    const response = await fetch(`${BASE}${path}`, { ...options, headers, redirect: 'manual' });
    this.store(response);
    const text = await response.text();
    return { status: response.status, location: response.headers.get('location'), text, response };
  }

  async csrf(path) {
    const { text } = await this.request(path);
    const match = text.match(/name="_csrf" value="([^"]+)"/);
    return match ? match[1] : '';
  }

  async post(path, fields, { csrfFrom = path } = {}) {
    const token = await this.csrf(csrfFrom);
    const body = new URLSearchParams({ _csrf: token, ...fields });
    return this.request(path, { method: 'POST', body });
  }

  async upload(path, { field = 'proof', filename, mime, buffer, fields = {}, csrfFrom }) {
    const token = await this.csrf(csrfFrom || path);
    const form = new FormData();
    form.set('_csrf', token);
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.set(field, new Blob([buffer], { type: mime }), filename);
    return this.request(path, { method: 'POST', body: form });
  }

  async login(email, password) {
    const response = await this.post('/login', { email, password });
    return response;
  }
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

const dateAfter = (days) => {
  const now = new Date();
  now.setDate(now.getDate() + days);
  return now.toISOString().slice(0, 10);
};

async function main() {
  const db = await mysql.createConnection(DB);
  const q = async (sql, params = []) => (await db.execute(sql, params))[0];

  console.log(`\nFieldsOps E2E — ${BASE}\n${'='.repeat(62)}`);

  const customer = new Session('customer');
  const admin = new Session('admin');
  const technician = new Session('technician');

  console.log('\n[0] Autentikasi');
  const loginCustomer = await customer.login('budi@fieldsops.id', 'Pembeli#2026');
  check('login customer', loginCustomer.status === 302, loginCustomer.location);
  const loginAdmin = await admin.login('admin@fieldsops.id', 'Admin#2026');
  check('login admin', loginAdmin.status === 302, loginAdmin.location);
  const loginTech = await technician.login('teknisi1@fieldsops.id', 'Teknisi#2026');
  check('login teknisi', loginTech.status === 302, loginTech.location);

  const [budi] = await q("SELECT id FROM users WHERE email = 'budi@fieldsops.id'");
  const [techRow] = await q("SELECT id FROM users WHERE email = 'teknisi1@fieldsops.id'");
  check('id customer & teknisi ditemukan', Boolean(budi?.id && techRow?.id), `customer=${budi?.id} teknisi=${techRow?.id}`);

  console.log('\n[1] ALUR PEMBAYARAN: submit bukti → admin verifikasi');
  const payDate = dateAfter(3);
  const created = await customer.post('/booking', {
    service_id: '1',
    scheduled_date: payDate,
    scheduled_time: '10:00',
    address: `Jl. Uji Pembayaran No. 1, Jakarta Selatan ${Date.now()}`,
    city: 'Jakarta Selatan',
    postal_code: '12820',
    notes: 'Uji otomatis alur pembayaran',
    payment_method: 'full',
    payment_channel: 'transfer',
  });
  const payCode = (created.location || '').split('/booking/')[1];
  check('booking pembayaran dibuat', created.status === 302 && Boolean(payCode), created.location);
  const [payBooking] = await q('SELECT * FROM bookings WHERE code = ?', [payCode]);
  const [payTx] = await q('SELECT * FROM transactions WHERE booking_id = ?', [payBooking.id]);
  check('transaksi awal unpaid', payTx?.status === 'unpaid', payTx?.status);
  check('booking payment_status unpaid', payBooking.payment_status === 'unpaid', payBooking.payment_status);

  const pagePay = await customer.request(`/booking/${payCode}/bayar`);
  check('halaman pembayaran 200', pagePay.status === 200, String(pagePay.status));

  const upload = await customer.upload(`/booking/${payCode}/bayar`, {
    field: 'proof',
    filename: 'bukti-transfer.png',
    mime: 'image/png',
    buffer: PNG,
  });
  check('unggah bukti transfer', upload.status === 302, upload.location);
  const [payTxAfter] = await q('SELECT * FROM transactions WHERE booking_id = ?', [payBooking.id]);
  const [payBookingAfter] = await q('SELECT * FROM bookings WHERE id = ?', [payBooking.id]);
  check('status transaksi pending_verification', payTxAfter.status === 'pending_verification', payTxAfter.status);
  check('proof_url tersimpan', Boolean(payTxAfter.proof_url), payTxAfter.proof_url);
  check('booking menunggu verifikasi', payBookingAfter.payment_status === 'pending_verification', payBookingAfter.payment_status);

  const payPageAsAdmin = await admin.request('/admin/transaksi');
  check('admin melihat transaksi', payPageAsAdmin.status === 200 && payPageAsAdmin.text.includes(payCode));
  const verify = await admin.post(`/admin/transaksi/${payTxAfter.id}`, { action: 'verifikasi' }, { csrfFrom: '/admin/transaksi' });
  check('admin verifikasi pembayaran', verify.status === 302, verify.location);
  const [payTxFinal] = await q('SELECT * FROM transactions WHERE id = ?', [payTxAfter.id]);
  const [payBookingFinal] = await q('SELECT * FROM bookings WHERE id = ?', [payBooking.id]);
  check('transaksi menjadi paid', payTxFinal.status === 'paid', payTxFinal.status);
  check('booking lunas', payBookingFinal.payment_status === 'paid', payBookingFinal.payment_status);
  check('verifikator & waktu tercatat', Boolean(payTxFinal.verified_by && payTxFinal.verified_at), `by=${payTxFinal.verified_by}`);

  console.log('\n[2] ALUR PENUGASAN → WORK ORDER → KOMISI');
  const workDate = dateAfter(4);
  const workBooking = await customer.post('/booking', {
    service_id: '1',
    scheduled_date: workDate,
    scheduled_time: '13:00',
    address: `Jl. Uji Work Order No. 2, Jakarta Selatan ${Date.now()}`,
    city: 'Jakarta Selatan',
    postal_code: '12820',
    notes: 'Uji otomatis alur pekerjaan',
    payment_method: 'cod',
  });
  const workCode = (workBooking.location || '').split('/booking/')[1];
  const [wb] = await q('SELECT * FROM bookings WHERE code = ?', [workCode]);
  check('booking COD dibuat', workBooking.status === 302 && Boolean(workCode), workCode);
  const processed = await admin.post(`/admin/booking/${workCode}/proses`, {}, { csrfFrom: `/admin/booking/${workCode}` });
  check('admin memproses booking', processed.status === 302, processed.location);
  const [wo] = await q('SELECT * FROM service_orders WHERE booking_id = ?', [wb.id]);
  const [wbProcessed] = await q('SELECT * FROM bookings WHERE id = ?', [wb.id]);
  check('booking berstatus processing', wbProcessed.status === 'processing', wbProcessed.status);
  check('service order menunggu penugasan', wo.status === 'awaiting_assignment', wo.status);

  const assign = await admin.post(`/admin/service-order/${wo.id}/tugaskan`, { technician_id: String(techRow.id) }, { csrfFrom: `/admin/booking/${workCode}` });
  check('admin menugaskan teknisi', assign.status === 302, assign.location);
  const [assignment] = await q('SELECT * FROM assignments WHERE service_order_id = ? ORDER BY id DESC LIMIT 1', [wo.id]);
  const [woAfterAssign] = await q('SELECT * FROM service_orders WHERE id = ?', [wo.id]);
  const [workWo] = await q('SELECT * FROM work_orders WHERE service_order_id = ?', [wo.id]);
  check('assignment berstatus offered', assignment?.status === 'offered', assignment?.status);
  check('service order assigned + teknisi', woAfterAssign.status === 'assigned' && woAfterAssign.technician_id === techRow.id);
  check('work order terbentuk', workWo?.status === 'assigned', workWo?.status);

  const offerPage = await technician.request('/teknisi/penugasan');
  check('teknisi melihat penawaran', offerPage.status === 200 && offerPage.text.includes(workCode));
  const accept = await technician.post(`/teknisi/penugasan/${assignment.id}/terima`, {}, { csrfFrom: '/teknisi/penugasan' });
  check('teknisi menerima penugasan', accept.status === 302, accept.location);
  const [assignmentAccepted] = await q('SELECT * FROM assignments WHERE id = ?', [assignment.id]);
  check('assignment accepted', assignmentAccepted.status === 'accepted', assignmentAccepted.status);

  const start = await technician.post(`/teknisi/pekerjaan/${wo.id}/status`, { action: 'mulai' }, { csrfFrom: `/teknisi/pekerjaan/${wo.id}` });
  check('teknisi mulai pekerjaan', start.status === 302, start.location);
  const [woStarted] = await q('SELECT * FROM service_orders WHERE id = ?', [wo.id]);
  const [workStarted] = await q('SELECT * FROM work_orders WHERE service_order_id = ?', [wo.id]);
  check('status in_progress', woStarted.status === 'in_progress' && workStarted.status === 'in_progress', `${woStarted.status}/${workStarted.status}`);

  const evidence = await technician.upload(`/teknisi/pekerjaan/${wo.id}/bukti`, {
    field: 'evidence',
    filename: 'bukti-pekerjaan.png',
    mime: 'image/png',
    buffer: PNG,
  });
  check('unggah bukti pekerjaan', evidence.status === 302, evidence.location);
  const [workEvidence] = await q('SELECT * FROM work_orders WHERE service_order_id = ?', [wo.id]);
  check('evidence_url tersimpan', Boolean(workEvidence.evidence_url), workEvidence.evidence_url);
  const evidenceFetch = await technician.request(workEvidence.evidence_url);
  check('teknisi bisa membuka bukti', evidenceFetch.status === 200, String(evidenceFetch.status));
  const evidenceAsCustomer = await customer.request(workEvidence.evidence_url);
  check('customer terkait bisa membuka bukti', evidenceAsCustomer.status === 200, String(evidenceAsCustomer.status));

  const submit = await technician.post(
    `/teknisi/pekerjaan/${wo.id}/status`,
    { action: 'ajukan', actions_taken: 'Cuci unit, isi freon, uji dingin 20 menit.', findings: 'Filter bersih, suhu 16 derajat.' },
    { csrfFrom: `/teknisi/pekerjaan/${wo.id}` },
  );
  check('teknisi ajukan hasil', submit.status === 302, submit.location);
  const [workSubmitted] = await q('SELECT * FROM work_orders WHERE service_order_id = ?', [wo.id]);
  check('work order submitted_for_review', workSubmitted.status === 'submitted_for_review', workSubmitted.status);

  const reviewQueue = await admin.request('/admin/work-order');
  check('admin melihat antrean tinjauan', reviewQueue.status === 200 && reviewQueue.text.includes(workCode));
  const complete = await admin.post(`/admin/work-order/${workSubmitted.id}/selesai`, {}, { csrfFrom: '/admin/work-order' });
  check('admin menyelesaikan work order', complete.status === 302, complete.location);
  const [woDone] = await q('SELECT * FROM service_orders WHERE id = ?', [wo.id]);
  const [workDone] = await q('SELECT * FROM work_orders WHERE id = ?', [workSubmitted.id]);
  const [bookingDone] = await q('SELECT * FROM bookings WHERE id = ?', [wb.id]);
  const [commission] = await q('SELECT * FROM commissions WHERE service_order_id = ?', [wo.id]);
  check('service order completed', woDone.status === 'completed', woDone.status);
  check('work order completed', workDone.status === 'completed', workDone.status);
  check('booking completed', bookingDone.status === 'completed', bookingDone.status);

  const [codTx] = await q('SELECT * FROM transactions WHERE booking_id = ?', [wb.id]);
  check('transaksi COD tercatat', codTx?.method === 'cod', codTx?.method);
  const codVerify = await admin.post(`/admin/transaksi/${codTx.id}`, { action: 'verifikasi' }, { csrfFrom: '/admin/transaksi' });
  const [codTxAfter] = await q('SELECT * FROM transactions WHERE id = ?', [codTx.id]);
  check('admin memverifikasi pembayaran COD', codVerify.status === 302 && codTxAfter.status === 'paid', codTxAfter.status);
  const expectedFee = Math.round(Number(wo.price) * 0.15);
  check('komisi terhitung', Boolean(commission), commission ? `gross=${commission.gross_amount} fee=${commission.platform_fee}` : 'tidak ada');
  if (commission) {
    check('platform fee sesuai rumus 15%', Number(commission.platform_fee) === expectedFee, `${commission.platform_fee} vs ${expectedFee}`);
    check(
      'pendapatan teknisi = bruto - komisi',
      Number(commission.technician_earning) === Number(wo.price) - expectedFee,
      `${commission.technician_earning}`,
    );
  }
  const earningPage = await technician.request('/teknisi/pendapatan');
  check(
    'pendapatan teknisi tampil',
    earningPage.status === 200 && earningPage.text.includes(String((Number(wo.price) - expectedFee).toLocaleString('id-ID'))),
  );

  console.log('\n[3] ALUR ULASAN');
  const reviewForm = await customer.request(`/booking/${workCode}/ulasan/${wo.id}`);
  check('form ulasan terbuka', reviewForm.status === 200, String(reviewForm.status));
  const reviewPost = await customer.post(
    `/booking/${workCode}/ulasan/${wo.id}`,
    { rating: '5', comment: 'Kerja rapi dan cepat. <script>alert(1)</script>' },
    { csrfFrom: `/booking/${workCode}/ulasan/${wo.id}` },
  );
  check('kirim ulasan', reviewPost.status === 302, reviewPost.location);
  const [review] = await q('SELECT * FROM reviews WHERE service_order_id = ?', [wo.id]);
  check('ulasan tersimpan 5 bintang', review?.rating === 5, String(review?.rating));
  const detailAfterReview = await customer.request(`/booking/${workCode}`);
  check('script pada ulasan ter-escape (XSS)', !detailAfterReview.text.includes('<script>alert(1)</script>'), 'tidak ada tag mentah');
  const reviewAgain = await customer.post(`/booking/${workCode}/ulasan/${wo.id}`, { rating: '1', comment: 'ulang' }, { csrfFrom: `/booking/${workCode}` });
  const [reviewCount] = await q('SELECT COUNT(*) AS n FROM reviews WHERE service_order_id = ?', [wo.id]);
  check('ulasan ganda ditolak', reviewAgain.status === 302 && Number(reviewCount.n) === 1, `n=${reviewCount.n}`);

  console.log('\n[4] EDGE CASE: teknisi menolak penugasan');
  const rejectBooking = await customer.post('/booking', {
    service_id: '1',
    scheduled_date: dateAfter(5),
    scheduled_time: '14:00',
    address: `Jl. Uji Tolak No. 3, Jakarta Selatan ${Date.now()}`,
    city: 'Jakarta Selatan',
    postal_code: '12820',
    notes: 'Uji otomatis penolakan',
    payment_method: 'cod',
  });
  const rejectCode = (rejectBooking.location || '').split('/booking/')[1];
  const [rb] = await q('SELECT * FROM bookings WHERE code = ?', [rejectCode]);
  await admin.post(`/admin/booking/${rejectCode}/proses`, {}, { csrfFrom: `/admin/booking/${rejectCode}` });
  const [rso] = await q('SELECT * FROM service_orders WHERE booking_id = ?', [rb.id]);
  await admin.post(`/admin/service-order/${rso.id}/tugaskan`, { technician_id: String(techRow.id) }, { csrfFrom: `/admin/booking/${rejectCode}` });
  const [rejectAssignment] = await q('SELECT * FROM assignments WHERE service_order_id = ? ORDER BY id DESC LIMIT 1', [rso.id]);
  const reject = await technician.post(
    `/teknisi/penugasan/${rejectAssignment.id}/tolak`,
    { reason: 'Jadwal bertabrakan dengan pekerjaan lain.' },
    { csrfFrom: '/teknisi/penugasan' },
  );
  check('teknisi menolak penugasan', reject.status === 302, reject.location);
  const [rejectAssignmentAfter] = await q('SELECT * FROM assignments WHERE id = ?', [rejectAssignment.id]);
  const [rsoAfter] = await q('SELECT * FROM service_orders WHERE id = ?', [rso.id]);
  const [rwoAfter] = await q('SELECT * FROM work_orders WHERE service_order_id = ?', [rso.id]);
  check('assignment rejected + alasan', rejectAssignmentAfter.status === 'rejected' && Boolean(rejectAssignmentAfter.reason), rejectAssignmentAfter.reason);
  check('service order kembali awaiting_assignment', rsoAfter.status === 'awaiting_assignment', rsoAfter.status);
  check('teknisi dilepas dari order', rsoAfter.technician_id === null, String(rsoAfter.technician_id));
  check('work order lama dihapus', !rwoAfter, rwoAfter ? 'masih ada' : 'kosong');
  const reassign = await admin.post(`/admin/service-order/${rso.id}/tugaskan`, { technician_id: String(techRow.id) }, { csrfFrom: `/admin/booking/${rejectCode}` });
  check('admin bisa menugaskan ulang', reassign.status === 302);
  const [reassignRow] = await q('SELECT * FROM assignments WHERE service_order_id = ? ORDER BY id DESC LIMIT 1', [rso.id]);
  check('penugasan baru offered', reassignRow.status === 'offered' && reassignRow.id !== rejectAssignment.id);

  console.log('\n[5] EDGE CASE: customer membatalkan booking');
  const cancelBooking = await customer.post('/booking', {
    service_id: '1',
    scheduled_date: dateAfter(6),
    scheduled_time: '15:00',
    address: `Jl. Uji Batal No. 4, Jakarta Selatan ${Date.now()}`,
    city: 'Jakarta Selatan',
    postal_code: '12820',
    notes: 'Uji otomatis pembatalan',
    payment_method: 'cod',
  });
  const cancelCode = (cancelBooking.location || '').split('/booking/')[1];
  const [cb] = await q('SELECT * FROM bookings WHERE code = ?', [cancelCode]);
  await admin.post(`/admin/booking/${cancelCode}/proses`, {}, { csrfFrom: `/admin/booking/${cancelCode}` });
  const [cso] = await q('SELECT * FROM service_orders WHERE booking_id = ?', [cb.id]);
  await admin.post(`/admin/service-order/${cso.id}/tugaskan`, { technician_id: String(techRow.id) }, { csrfFrom: `/admin/booking/${cancelCode}` });
  const cancel = await customer.post(`/booking/${cancelCode}/batal`, { reason: 'Rencana berubah, jadi tidak perlu servis.' }, { csrfFrom: `/booking/${cancelCode}` });
  check('customer membatalkan booking', cancel.status === 302, cancel.location);
  const [cbAfter] = await q('SELECT * FROM bookings WHERE id = ?', [cb.id]);
  const [csoAfter] = await q('SELECT * FROM service_orders WHERE id = ?', [cso.id]);
  const [cAssignAfter] = await q('SELECT * FROM assignments WHERE service_order_id = ?', [cso.id]);
  const [cWoAfter] = await q('SELECT * FROM work_orders WHERE service_order_id = ?', [cso.id]);
  check('booking cancelled', cbAfter.status === 'cancelled', cbAfter.status);
  check('service order dibatalkan', csoAfter.status === 'cancelled', csoAfter.status);
  check('penugasan dilepas (tidak menggantung)', !cAssignAfter || cAssignAfter.status === 'cancelled', cAssignAfter?.status || 'tidak ada');
  const techOffersAfterCancel = await technician.request('/teknisi/penugasan');
  const offersSection = techOffersAfterCancel.text.split(/Riwayat|Penugasan terakhir/i)[0] || '';
  check('penawaran booking batal hilang dari daftar aktif teknisi', !offersSection.includes(cancelCode));
  const [openOffers] = await q("SELECT COUNT(*) AS n FROM assignments WHERE service_order_id = ? AND status = 'offered'", [cso.id]);
  check('tidak ada penawaran menggantung di database', Number(openOffers.n) === 0, `n=${openOffers.n}`);
  check('work order dibersihkan', !cWoAfter, cWoAfter ? 'masih ada' : 'kosong');
  const dupCheck = await customer.post('/booking', {
    service_id: '1',
    scheduled_date: dateAfter(6),
    scheduled_time: '15:00',
    address: cb.address,
    city: 'Jakarta Selatan',
    postal_code: '12820',
    notes: 'Slot setelah pembatalan',
    payment_method: 'cod',
  });
  check('slot yang dibatalkan bisa dipakai lagi', dupCheck.status === 302 && !String(dupCheck.location).includes(cancelCode), dupCheck.location);

  console.log('\n[6] RBAC');
  const customerToAdmin = await customer.request('/admin');
  const customerToTech = await customer.request('/teknisi');
  check('customer → /admin = 403', customerToAdmin.status === 403, String(customerToAdmin.status));
  check('customer → /teknisi = 403', customerToTech.status === 403, String(customerToTech.status));
  const techToAdmin = await technician.request('/admin');
  check('teknisi → /admin = 403', techToAdmin.status === 403, String(techToAdmin.status));
  const techPostTx = await technician.post(`/admin/transaksi/${payTxFinal.id}`, { action: 'refund', reason: 'coba curang' }, { csrfFrom: '/teknisi' });
  check('teknisi POST verifikasi/refund ditolak', techPostTx.status === 403, String(techPostTx.status));
  const [txUnchanged] = await q('SELECT * FROM transactions WHERE id = ?', [payTxFinal.id]);
  check('transaksi tidak berubah oleh teknisi', txUnchanged.status === 'paid', txUnchanged.status);
  const techToKomisi = await technician.post('/admin/komisi', { percent: '1' }, { csrfFrom: '/teknisi' });
  check('teknisi POST ubah komisi ditolak', techToKomisi.status === 403, String(techToKomisi.status));
  const anon = new Session('anon');
  const anonAdmin = await anon.request('/admin');
  check('anonim → /admin redirect login', anonAdmin.status === 302 && String(anonAdmin.location).startsWith('/login'), anonAdmin.location);
  const customerOtherBooking = await customer.request('/booking/BK-DEMO03');
  check('customer tidak bisa buka booking orang lain', customerOtherBooking.status === 404, String(customerOtherBooking.status));
  const customerToAdminApi = await customer.post('/admin/booking/' + workCode + '/proses', { action: 'proses' }, { csrfFrom: '/akun' });
  check('customer POST aksi admin ditolak', customerToAdminApi.status === 403, String(customerToAdminApi.status));

  console.log('\n[7] Injeksi & validasi');
  const sqli = await customer.request("/layanan?q=%27%20OR%201%3D1%20--%20&kategori=ac");
  check('pencarian SQLi tidak error 500', sqli.status === 200, String(sqli.status));
  const sqli2 = await admin.request("/admin/pengguna?q=%27%20UNION%20SELECT%20password_hash%20FROM%20users%20--%20");
  check('filter admin SQLi tidak error 500', sqli2.status === 200, String(sqli2.status));
  check('hash password tidak bocor', !/\\$2[aby]\\$/.test(sqli2.text));
  const badBooking = await customer.post('/booking', {
    service_id: '1',
    scheduled_date: '1999-01-01',
    scheduled_time: '10:00',
    address: 'pendek',
    city: '',
    payment_method: 'full',
  });
  check('validasi booking menolak input tidak valid', badBooking.status === 302, badBooking.location);
  const [badCount] = await q("SELECT COUNT(*) AS n FROM bookings WHERE address = 'pendek'");
  check('booking tidak valid tidak tersimpan', Number(badCount.n) === 0);
  const [workBeforeBadUpload] = await q('SELECT evidence_url FROM work_orders WHERE id = ?', [workSubmitted.id]);
  const oversized = await technician.upload(`/teknisi/pekerjaan/${wo.id}/bukti`, {
    field: 'evidence',
    filename: 'virus.exe',
    mime: 'application/x-msdownload',
    buffer: Buffer.from('MZ'),
  });
  const [workAfterBadUpload] = await q('SELECT evidence_url FROM work_orders WHERE id = ?', [workSubmitted.id]);
  check(
    'unggahan tipe berbahaya ditolak',
    oversized.status === 302 &&
      workAfterBadUpload.evidence_url === workBeforeBadUpload.evidence_url &&
      !fs.readdirSync('storage/private/pekerjaan').some((name) => name.endsWith('.exe')),
    `status=${oversized.status}`,
  );

  console.log('\n[8] Cek halaman utama (tidak ada 500)');
  const pages = [
    ['/', customer],
    ['/layanan', customer],
    ['/kategori', customer],
    ['/layanan/servis-ac-cuci-isi-freon', customer],
    ['/akun', customer],
    ['/teknisi', technician],
    ['/teknisi/pekerjaan', technician],
    ['/teknisi/pendapatan', technician],
    ['/teknisi/riwayat', technician],
    ['/admin', admin],
    ['/admin/booking', admin],
    ['/admin/transaksi', admin],
    ['/admin/komisi', admin],
    ['/admin/work-order', admin],
    ['/admin/laporan', admin],
  ];
  const bad = [];
  for (const [path, session] of pages) {
    const result = await session.request(path);
    if (result.status !== 200) bad.push(`${path}=${result.status}`);
  }
  check('semua halaman utama 200', bad.length === 0, bad.join(', ') || 'ok');

  await db.end();

  console.log(`\n${'='.repeat(62)}`);
  console.log(`HASIL: ${pass} PASS · ${fail} FAIL`);
  if (fail) console.log(`Gagal: ${failures.join(' | ')}`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error('\nE2E gagal dijalankan:', error);
  process.exit(1);
});
