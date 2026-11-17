const currency = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
});

const dateFmt = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' });
const dateLongFmt = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
const timeFmt = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });

export function formatRupiah(value) {
  return currency.format(Number(value) || 0).replace(/\u00a0/g, ' ');
}

export function formatDate(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return dateFmt.format(date);
}

export function formatDateLong(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return dateLongFmt.format(date);
}

export function formatDateInput(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export function formatTime(value) {
  if (!value) return '—';
  if (typeof value === 'string' && /^\d{2}:\d{2}/.test(value)) return value.slice(0, 5);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return timeFmt.format(date);
}

export function formatDateTime(value) {
  if (!value) return '—';
  return `${formatDate(value)} · ${formatTime(value)}`;
}

export function normalizePhone(input) {
  const digits = String(input || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.startsWith('62')) return digits;
  if (digits.startsWith('0')) return `62${digits.slice(1)}`;
  if (digits.startsWith('8')) return `62${digits}`;
  return digits;
}

export function formatPhone(input) {
  const normalized = normalizePhone(input);
  return normalized ? `+${normalized}` : '—';
}

export function waLink(phone, message) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  return `https://wa.me/${normalized}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
}

export const ROLE_LABELS = { customer: 'Customer', technician: 'Technician', admin: 'Admin' };

export const BOOKING_STATUS = {
  submitted: { label: 'Diajukan', tone: 'wait' },
  processing: { label: 'Diproses', tone: 'info' },
  in_progress: { label: 'Dikerjakan', tone: 'active' },
  completed: { label: 'Selesai', tone: 'done' },
  cancelled: { label: 'Dibatalkan', tone: 'cancel' },
};

export const SERVICE_ORDER_STATUS = {
  submitted: { label: 'Diajukan', tone: 'wait' },
  awaiting_assignment: { label: 'Menunggu teknisi', tone: 'wait' },
  assigned: { label: 'Ditugaskan', tone: 'info' },
  in_progress: { label: 'Dikerjakan', tone: 'active' },
  completed: { label: 'Selesai', tone: 'done' },
  cancelled: { label: 'Dibatalkan', tone: 'cancel' },
  needs_reschedule: { label: 'Perlu jadwal ulang', tone: 'warn' },
};

export const ASSIGNMENT_STATUS = {
  offered: { label: 'Ditawarkan', tone: 'wait' },
  accepted: { label: 'Diterima', tone: 'info' },
  rejected: { label: 'Ditolak', tone: 'cancel' },
  reassigned: { label: 'Dialihkan', tone: 'warn' },
  cancelled: { label: 'Dibatalkan', tone: 'cancel' },
};

export const WORK_ORDER_STATUS = {
  assigned: { label: 'Ditugaskan', tone: 'info' },
  accepted: { label: 'Diterima', tone: 'info' },
  in_progress: { label: 'Dikerjakan', tone: 'active' },
  blocked: { label: 'Terhambat', tone: 'warn' },
  submitted_for_review: { label: 'Menunggu tinjauan', tone: 'wait' },
  completed: { label: 'Selesai', tone: 'done' },
};

export const TECHNICIAN_STATUS = {
  pending: { label: 'Menunggu', tone: 'wait' },
  under_review: { label: 'Sedang ditinjau', tone: 'info' },
  revision_required: { label: 'Perlu revisi', tone: 'warn' },
  approved: { label: 'Disetujui', tone: 'done' },
  rejected: { label: 'Ditolak', tone: 'cancel' },
  suspended: { label: 'Ditangguhkan', tone: 'cancel' },
};

export const PAYMENT_STATUS = {
  unpaid: { label: 'Belum dibayar', tone: 'wait' },
  pending_verification: { label: 'Menunggu verifikasi', tone: 'info' },
  paid: { label: 'Lunas', tone: 'done' },
  failed: { label: 'Gagal', tone: 'cancel' },
  expired: { label: 'Kedaluwarsa', tone: 'cancel' },
  refunded: { label: 'Dikembalikan', tone: 'warn' },
};

export const COMPLAINT_STATUS = {
  open: { label: 'Terbuka', tone: 'wait' },
  in_review: { label: 'Ditinjau', tone: 'info' },
  resolved: { label: 'Selesai', tone: 'done' },
  rejected: { label: 'Ditolak', tone: 'cancel' },
};

export const PAYMENT_METHOD_LABELS = { full: 'Bayar penuh', cod: 'COD — bayar di tempat' };
export const PAYMENT_CHANNEL_LABELS = { transfer: 'Transfer bank', qris: 'QRIS' };

export function label(map, key) {
  return (map[key] && map[key].label) || key || '—';
}

export function tone(map, key) {
  return (map[key] && map[key].tone) || 'info';
}

export function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

export const DAY_LABELS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

export const ORDER_STATUS_MAP = BOOKING_STATUS;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Badge status siap pakai di template EJS. */
export function statusBadge(map, key) {
  const info = map[key] || { label: key || '—', tone: 'info' };
  return `<span class="status-pill tone-${escapeHtml(info.tone)}">${escapeHtml(info.label)}</span>`;
}

export function stars(rating) {
  const value = Math.round(Number(rating) || 0);
  if (!value) return '<span class="muted tiny">Belum ada ulasan</span>';
  return `<span class="rating-line"><span class="star" aria-hidden="true">${'★'.repeat(value)}${'☆'.repeat(Math.max(0, 5 - value))}</span><span>${Number(rating).toFixed(1)}</span></span>`;
}

export function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}
