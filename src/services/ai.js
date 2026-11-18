'use strict';
// 선택 기능: AI 초안 작성 보조. 키가 없으면 꺼져 있고 거래 기능에는 영향을 주지 않는다.
// 환불·권리 분쟁 판단에는 연결하지 않는다. 사용자가 입력한 내용만 보내며, 보내기 전 명시적 동의를 받는다.
const config = require('../config');
const { q } = require('../db');
const { clock, sha256, must, str, AppError } = require('../util');

const KINDS = {
  request_draft: ['의뢰서 초안', '사용자가 적은 메모를 바탕으로 소프트웨어 개발 의뢰서 초안을 작성하세요. 항목: 개발 목적, 기능 요구사항(번호 목록), 실행 환경, 납기·예산에서 확인할 점, 소스코드 제공 조건, 권리 귀속, 유지보수. 메모에 없는 사실은 지어내지 말고 "확인 필요"로 표시하세요.'],
  product_description: ['상품 설명 초안', '판매자가 적은 메모를 바탕으로 소프트웨어 상품 설명 초안을 작성하세요. 항목: 해결하는 업무 문제, 기능 목록, 포함 범위, 제외 범위, 지원 환경. 과장 표현, 보증 표현("100% 안전", "무조건" 등), 메모에 없는 기능은 쓰지 마세요.'],
  requirement_gaps: ['요구사항 누락 확인', '아래 요구사항에서 빠져 있거나 모호해서 분쟁이 생길 수 있는 부분을 질문 목록으로 정리하세요. 실행 환경, 데이터, 권한, 예외 처리, 검수 기준, 소스·권리 조건, 외부 유료 서비스 비용을 점검하세요.'],
  quote_summary: ['견적 비교 요약', '아래 여러 견적을 범위, 제외 범위, 단계와 기간, 금액, 수정 범위, 지원 조건 기준으로 중립적으로 비교 요약하세요. 어느 견적을 고르라는 추천은 하지 말고 차이점과 추가로 확인할 질문만 제시하세요.'],
  inspection_checklist: ['검수 항목 초안', '아래 계약 범위를 바탕으로 구매자가 확인할 검수 체크리스트 초안을 작성하세요. 각 항목은 예/아니오로 확인 가능해야 합니다.'],
};
const enabled = () => !!config.anthropicKey;

async function draft(user, kind, input, consent) {
  must(KINDS[kind], '지원하지 않는 작업입니다.');
  if (!enabled()) throw new AppError('AI 초안 기능이 설정되어 있지 않습니다.', 503);
  must(consent === true, '입력한 내용을 외부 AI 서비스(Anthropic)로 전송하는 데 동의해야 합니다.', 400, 'CONSENT_REQUIRED');
  const text = str(input, 12000);
  must(text.length >= 20, '내용을 20자 이상 입력하세요.');
  q.insert('ai_consents', { user_id: user.id, kind, content_hash: sha256(text), created_at: clock.iso() });
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropicKey });
  try {
    const res = await client.beta.messages.create({
      model: config.aiModel, max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      system: `당신은 한국어 소프트웨어 거래 플랫폼의 문서 작성 보조입니다. ${KINDS[kind][1]} 결과는 사람이 검토·수정할 초안입니다. 법률 판단, 환불 여부, 권리 분쟁의 결론은 내리지 마세요. 마크다운 없이 일반 텍스트로 답하세요.`,
      messages: [{ role: 'user', content: text }],
    });
    if (res.stop_reason === 'refusal') throw new AppError('AI가 이 요청에 대한 초안을 만들지 않았습니다. 직접 작성해 주세요.', 422);
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (e instanceof Anthropic.RateLimitError) throw new AppError('AI 서비스 사용량이 많습니다. 잠시 후 다시 시도하세요.', 429);
    if (e instanceof Anthropic.AuthenticationError) throw new AppError('AI 서비스 인증 설정에 문제가 있습니다.', 503);
    if (e instanceof Anthropic.APIError) throw new AppError('AI 서비스 오류로 초안을 만들지 못했습니다. 직접 작성해 주세요.', 502);
    throw new AppError('AI 서비스에 연결하지 못했습니다. 직접 작성해 주세요.', 502);
  }
}
module.exports = { KINDS, enabled, draft };
