'use strict';
// 내장 테스트 결제창. 실제 결제 사업자의 결제창을 대신하는 시험용 화면이다.
const r = require('express').Router();
const { q } = require('../db');
const { h, needUser } = require('../web');
const { html, csrf, field, won, notice } = require('../ui');
const { must } = require('../util');
const sandbox = require('../providers/sandbox');

function load(req) {
  // 테스트 사업자가 활성일 때만 동작한다(실결제 환경에서는 존재하지 않는 경로로 취급).
  must(require('../providers').active().name === 'sandbox', '찾을 수 없습니다.', 404);
  const p = q.get('SELECT * FROM sandbox_payments WHERE id = ?', req.params.id);
  const o = p && q.get('SELECT * FROM orders WHERE order_no = ? AND buyer_id = ?', p.order_no, req.user.id);
  must(o, '결제 정보를 찾을 수 없습니다.', 404);
  return { p, o };
}
r.get('/sandbox-pg/pay/:id', needUser, h(async (req, res) => {
  const { p, o } = load(req);
  if (p.status !== 'READY') return res.redirect(`/pay/return/${o.id}`);
  res.page({ title: '테스트 결제', body: html`<div class="narrow"><h1>테스트 결제창</h1>
    ${notice('시험용 결제창입니다. 실제 돈이 이동하지 않으며 결제대금 보호도 적용되지 않습니다', 'warn')}
    <form method="post" action="/sandbox-pg/pay/${p.id}" class="card">${csrf(req)}
      <p class="sub">${o.title}</p><div class="amount">${won(p.amount)}</div>
      ${field('결제수단(시험)', 'method', 'card', { options: [['card', '카드'], ['transfer', '계좌이체'], ['vbank', '가상계좌 — 부분 취소 미지원으로 동작']] })}
      ${field('결과(시험)', 'result', 'success', { options: [['success', '결제 성공'], ['fail', '결제 실패']] })}
      <button class="btn primary block">진행</button></form></div>` });
}));
r.post('/sandbox-pg/pay/:id', needUser, h(async (req, res) => {
  const { p, o } = load(req);
  await sandbox.simulate(p.id, { result: req.body.result === 'fail' ? 'fail' : 'success', method: ['card', 'transfer', 'vbank'].includes(req.body.method) ? req.body.method : 'card' });
  res.redirect(`/pay/return/${o.id}`);
}));
module.exports = r;
