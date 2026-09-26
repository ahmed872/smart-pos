const SI = window.StoreIdentity;

function applyPageWidth(widthMm) {
  const style = document.createElement('style');
  style.textContent = `
    @page { size: ${widthMm}mm auto; margin: 2mm; }
    body { width: ${widthMm - 6}mm; }
  `;
  document.head.appendChild(style);
}

async function render() {
  const params = new URLSearchParams(window.location.search);
  const saleId = Number(params.get('saleId'));
  const data = await window.api.sales.full(saleId);
  const container = document.getElementById('receipt');

  if (!data) {
    container.textContent = 'الفاتورة غير موجودة';
    return;
  }

  const { sale, items, refunds, settings } = data;
  const currency = settings.currency || '';
  const money = (n) => SI.money(n, currency);
  applyPageWidth(Number(settings.receipt_width_mm) || 58);

  const qrDataUrl = await window.api.print.qr(SI.invoiceQrText(sale, settings));
  // Same model as the reports: the discount actually applied is subtotal - (total - tax).
  const discount = Math.max(sale.subtotal - (sale.total - sale.tax), 0);
  const rate = SI.taxRate(sale);

  container.innerHTML = `
    ${SI.headerHtml(settings, { logoMaxHeight: 50 })}
    <hr />
    <p class="center">فاتورة رقم: <bdi dir="ltr">${SI.escapeHtml(sale.sale_number)}</bdi></p>
    <p class="center">التاريخ: ${SI.formatDateTime(sale.created_at)}</p>
    <p class="center">الكاشير: ${SI.escapeHtml(sale.cashier_name || '-')}</p>
    <p class="center">طريقة الدفع: ${SI.paymentLabel(sale.payment_method)}</p>
    <hr />
    <table>
      ${items.map((it) => `
        <tr>
          <td colspan="2">${SI.escapeHtml(it.name)}</td>
        </tr>
        <tr>
          <td><bdi dir="ltr">${it.qty} × ${it.unit_price.toFixed(2)}</bdi></td>
          <td style="text-align:left;">${it.line_total.toFixed(2)}</td>
        </tr>
      `).join('')}
    </table>
    <hr />
    <table class="totals">
      <tr><td>الإجمالي الفرعي</td><td style="text-align:left;">${money(sale.subtotal)}</td></tr>
      <tr><td>الخصم</td><td style="text-align:left;">${money(discount)}</td></tr>
      <tr><td>الضريبة${rate ? ` (<bdi dir="ltr">${rate}%</bdi>)` : ''}</td><td style="text-align:left;">${money(sale.tax)}</td></tr>
      <tr><td>الإجمالي</td><td style="text-align:left;">${money(sale.total)}</td></tr>
      ${refunds && refunds.count > 0 ? `
        <tr><td>المرتجعات</td><td style="text-align:left;">- ${money(refunds.amount)}</td></tr>
        <tr><td>الصافي بعد المرتجعات</td><td style="text-align:left;">${money(sale.total - refunds.amount)}</td></tr>
      ` : ''}
    </table>
    <hr />
    <div class="qr-box"><img src="${qrDataUrl}" alt="QR" /></div>
    ${settings.receipt_footer ? `<p class="center">${SI.escapeHtml(settings.receipt_footer)}</p>` : ''}
  `;
}

render();
