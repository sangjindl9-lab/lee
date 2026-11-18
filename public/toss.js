// 토스페이먼츠 결제창 호출. 금액·주문번호는 서버가 내려준 값만 사용한다.
(function () {
  var el = document.getElementById('toss');
  if (!el || !window.TossPayments) return;
  var d = el.dataset;
  var payment = window.TossPayments(d.clientKey).payment({ customerKey: d.customer });
  document.getElementById('tosspay').addEventListener('click', function () {
    payment.requestPayment({ method: 'CARD', amount: { currency: 'KRW', value: Number(d.amount) }, orderId: d.orderId, orderName: d.name, successUrl: d.success, failUrl: d.fail });
  });
})();
