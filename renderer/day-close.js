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
  const date = params.get('date');

  const [closing, settings] = await Promise.all([
    window.api.reports.dailyClosing(date),
    window.api.settings.get(),
  ]);

  const currency = settings.currency || '';
  const widthMm = Number(settings.receipt_width_mm) || 58;
  applyPageWidth(widthMm);


  const container = document.getElementById('report');
  container.innerHTML = `
    ${SI.headerHtml(settings, { compact: true, logoMaxHeight: 50 })}
    <p class="center">تقرير إغلاق اليوم</p>
    <p class="center">${SI.formatDate(closing.date)}</p>
    <hr />
    <table>
      <tr><td>عدد الفواتير</td><td style="text-align:left;">${closing.invoiceCount}</td></tr>
      <tr><td>مبيعات نقدًا</td><td style="text-align:left;">${closing.cash.toFixed(2)} ${currency}</td></tr>
      <tr><td>مبيعات بطاقة</td><td style="text-align:left;">${closing.card.toFixed(2)} ${currency}</td></tr>
      <tr><td>الخصومات</td><td style="text-align:left;">${closing.discount.toFixed(2)} ${currency}</td></tr>
      <tr><td>الضريبة</td><td style="text-align:left;">${closing.tax.toFixed(2)} ${currency}</td></tr>
      <tr><td>المرتجعات</td><td style="text-align:left;">${closing.returns.toFixed(2)} ${currency}</td></tr>
    </table>
    <hr />
    <table class="totals">
      <tr><td>إجمالي المبيعات</td><td style="text-align:left;">${closing.grossTotal.toFixed(2)} ${currency}</td></tr>
      <tr><td>الصافي بعد المرتجعات</td><td style="text-align:left;">${closing.netTotal.toFixed(2)} ${currency}</td></tr>
    </table>
    <hr />
    <p class="center">توقيع المسؤول: ______________</p>
  `;
}

render();
