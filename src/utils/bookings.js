import crypto from 'node:crypto';
import { query, queryOne } from '../db.js';

export const TIME_SLOTS = ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'];

export const CANCELLABLE_BOOKING = new Set(['submitted', 'processing']);

export function generateCode(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase().slice(-5)}${crypto
    .randomBytes(2)
    .toString('hex')
    .toUpperCase()}`;
}

export function todayISO() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function isPastSlot(dateISO, time) {
  if (!dateISO || !time) return true;
  const stamp = new Date(`${dateISO}T${time}:00+07:00`);
  return Number.isNaN(stamp.getTime()) || stamp.getTime() < Date.now() - 60 * 1000;
}

export function validateBookingInput(body) {
  const errors = {};
  const data = {
    serviceIds: [],
    date: String(body.scheduled_date || '').trim(),
    time: String(body.scheduled_time || '').trim(),
    address: String(body.address || '').trim(),
    city: String(body.city || '').trim(),
    postalCode: String(body.postal_code || '').trim(),
    notes: String(body.notes || '').trim(),
    method: body.payment_method === 'cod' ? 'cod' : 'full',
    channel: body.payment_channel === 'qris' ? 'qris' : body.payment_channel === 'transfer' ? 'transfer' : null,
  };

  const primary = Number(body.service_id);
  if (Number.isInteger(primary) && primary > 0) data.serviceIds.push(primary);
  const extras = body.extra ? (Array.isArray(body.extra) ? body.extra : [body.extra]) : [];
  for (const extra of extras) {
    const id = Number(extra);
    if (Number.isInteger(id) && id > 0 && !data.serviceIds.includes(id)) data.serviceIds.push(id);
  }

  if (data.serviceIds.length === 0) errors.service = 'Pilih minimal satu layanan.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) errors.date = 'Tanggal kunjungan wajib dipilih.';
  else if (data.date < todayISO()) errors.date = 'Tanggal tidak boleh di masa lalu.';
  if (!TIME_SLOTS.includes(data.time)) errors.time = 'Pilih jam kunjungan yang tersedia.';
  else if (!errors.date && isPastSlot(data.date, data.time)) errors.time = 'Jam ini sudah lewat. Pilih jam lain.';
  if (data.address.length < 10) errors.address = 'Alamat lengkap minimal 10 karakter agar teknisi tidak tersesat.';
  if (data.address.length > 300) errors.address = 'Alamat terlalu panjang (maksimal 300 karakter).';
  if (!data.city) errors.city = 'Kota wajib diisi.';
  if (data.postalCode && !/^\d{5}$/.test(data.postalCode)) errors.postalCode = 'Kode pos harus 5 angka.';
  if (data.notes.length > 500) errors.notes = 'Catatan maksimal 500 karakter.';
  if (data.method === 'full' && !data.channel) errors.channel = 'Pilih transfer bank atau QRIS untuk pembayaran penuh.';

  return { errors, data };
}

/** Booking + seluruh relasinya untuk halaman detail. */
export async function loadBookingDetail(bookingId) {
  const booking = await queryOne('SELECT * FROM bookings WHERE id = ? LIMIT 1', [bookingId]);
  if (!booking) return null;

  const orders = await query(
    `SELECT so.*, u.name AS technician_name, u.phone AS technician_phone,
            wo.status AS work_status, wo.id AS work_order_id, wo.evidence_url,
            r.id AS review_id, r.rating AS review_rating
     FROM service_orders so
     LEFT JOIN users u ON u.id = so.technician_id
     LEFT JOIN work_orders wo ON wo.service_order_id = so.id
     LEFT JOIN reviews r ON r.service_order_id = so.id
     WHERE so.booking_id = ?
     ORDER BY so.id`,
    [bookingId],
  );

  const transactions = await query('SELECT * FROM transactions WHERE booking_id = ? ORDER BY id DESC', [bookingId]);
  const timeline = await query(
    `SELECT sh.*, u.name AS actor_name FROM status_history sh
     LEFT JOIN users u ON u.id = sh.actor_id
     WHERE (sh.entity_type = 'booking' AND sh.entity_id = ?)
        OR (sh.entity_type = 'service_order' AND sh.entity_id IN (SELECT id FROM service_orders WHERE booking_id = ?))
     ORDER BY sh.created_at, sh.id`,
    [bookingId, bookingId],
  );

  return { booking, orders, transaction: transactions[0] || null, transactions, timeline };
}

export async function recalcBookingStatus(bookingId) {
  const booking = await queryOne('SELECT status FROM bookings WHERE id = ?', [bookingId]);
  if (!booking || booking.status === 'cancelled') return booking?.status;
  const orders = await query('SELECT status FROM service_orders WHERE booking_id = ?', [bookingId]);
  const active = orders.filter((order) => order.status !== 'cancelled');
  let next = booking.status;
  if (active.length === 0) next = 'cancelled';
  else if (active.every((order) => order.status === 'completed')) next = 'completed';
  else if (active.some((order) => order.status === 'in_progress')) next = 'in_progress';
  else if (active.some((order) => order.status === 'assigned')) next = 'processing';
  else next = 'processing';

  if (next !== booking.status) {
    await query('UPDATE bookings SET status = ? WHERE id = ?', [next, bookingId]);
  }
  return next;
}

