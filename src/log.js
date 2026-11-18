'use strict';
const { q } = require('./db');
const { clock } = require('./util');

function audit(actor, action, targetType, targetId, detail = {}, ip = null) {
  q.insert('audit_logs', {
    actor_id: actor?.id ?? null, actor_role: actor?.auditRole || (actor ? 'user' : 'system'),
    action, target_type: targetType || '', target_id: String(targetId ?? ''), detail: JSON.stringify(detail), ip, created_at: clock.iso(),
  });
}
function notify(userId, title, body = '', link = '', dedupeKey = null) {
  if (!userId) return;
  q.run('INSERT OR IGNORE INTO notifications (user_id, title, body, link, dedupe_key, created_at) VALUES (?,?,?,?,?,?)', userId, title, body, link, dedupeKey, clock.iso());
}
function notifyStaff(role, title, body = '', link = '', dedupeKey = null) {
  for (const r of q.all("SELECT DISTINCT user_id FROM staff_roles WHERE role IN (?, 'super')", role)) notify(r.user_id, title, body, link, dedupeKey);
}
module.exports = { audit, notify, notifyStaff };
