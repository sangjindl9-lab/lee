'use strict';
const { q } = require('../db');
const { clock, must, str, notFound } = require('../util');
const { notify } = require('../log');

function open(kind, refId, userA, userB, subject) {
  const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
  must(a !== b, '자신에게는 메시지를 보낼 수 없습니다.');
  q.run('INSERT OR IGNORE INTO threads (kind, ref_id, user_a, user_b, subject, created_at, last_at) VALUES (?,?,?,?,?,?,?)', kind, refId, a, b, str(subject, 200), clock.iso(), clock.iso());
  return q.get('SELECT * FROM threads WHERE kind = ? AND ref_id = ? AND user_a = ? AND user_b = ?', kind, refId, a, b);
}
function load(user, threadId) {
  const t = q.get('SELECT * FROM threads WHERE id = ?', threadId);
  if (!t || (t.user_a !== user.id && t.user_b !== user.id)) throw notFound();
  return t;
}
function post(user, threadId, body) {
  const t = load(user, threadId);
  must(str(body).length >= 1, '내용을 입력하세요.');
  q.insert('messages', { thread_id: t.id, sender_id: user.id, body: str(body, 5000), created_at: clock.iso() });
  q.update('threads', t.id, { last_at: clock.iso() });
  notify(t.user_a === user.id ? t.user_b : t.user_a, '새 메시지', t.subject, `/my/messages/${t.id}`);
  return t;
}
const list = (user) => q.all(`SELECT t.*, (SELECT body FROM messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_body,
  (SELECT name FROM users u WHERE u.id = CASE WHEN t.user_a = ? THEN t.user_b ELSE t.user_a END) AS other_name
  FROM threads t WHERE t.user_a = ? OR t.user_b = ? ORDER BY t.last_at DESC LIMIT 100`, user.id, user.id, user.id);
const messages = (threadId) => q.all('SELECT m.*, u.name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.thread_id = ? ORDER BY m.id', threadId);
module.exports = { open, load, post, list, messages };
