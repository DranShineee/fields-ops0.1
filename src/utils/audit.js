import { query } from '../db.js';

const SENSITIVE_KEYS = /(password|token|secret|hash|ktp)/i;

function sanitize(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const clean = {};
  for (const [key, value] of Object.entries(meta)) {
    clean[key] = SENSITIVE_KEYS.test(key) ? '[disembunyikan]' : value;
  }
  return JSON.stringify(clean);
}

/** Catat aktivitas sensitif (NFR-LOG-001, tidak dapat diedit dari UI). */
export async function logAudit(req, { action, entity, entityId = null, description, meta = null }) {
  const actor = req.session?.user || null;
  await query(
    `INSERT INTO audit_logs (actor_id, actor_role, action, entity, entity_id, description, meta_json, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      actor?.id || null,
      actor?.role || 'system',
      action,
      entity,
      entityId,
      String(description).slice(0, 400),
      sanitize(meta),
      (req.ip || '').slice(0, 60),
    ],
  );
}

export async function logStatus(req, { entityType, entityId, fromStatus, toStatus, note = null }) {
  await query(
    `INSERT INTO status_history (entity_type, entity_id, from_status, to_status, actor_id, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [entityType, entityId, fromStatus || null, toStatus, req.session?.user?.id || null, note],
  );
}
