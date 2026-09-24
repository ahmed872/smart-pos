function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function render() {
  const params = new URLSearchParams(window.location.search);
  const from = params.get('from');
  const to = params.get('to');

  const [summary, rows, settings] = await Promise.all([
    window.api.reports.summary(from, to),
    window.api.reports.detailRows(from, to),
    window.api.settings.get(),
  ]);

  const currency = settings.currency || '';
  const container = document.getElementById('report');

  container.innerHTML = `
    ${settings.logo_data_url ? `<div style="text-align:center;margin-bottom:6px;"><img src="${settings.logo_data_url}" style="max-height:70px;" /></div>` : ''}
    <h1>${escapeHtml(settings.store_name || '')}</h1>
    <p class="sub">تقرير المبيعات من ${escapeHtml(from)} إلى ${escapeHtml(to)}</p>

    <h2>الملخص</h2>
    <table class="summary-table">
      <tr><td>عدد الفواتير</td><td>${summary.invoiceCount}</td></tr>
      <tr><td>إجمالي المبيعات قبل الخصم</td><td>${summary.grossSales.toFixed(2)} ${currency}</td></tr>
      <tr><td>الخصومات</td><td>${summary.totalDiscount.toFixed(2)} ${currency}</td></tr>
      <tr><td>المرتجعات (شاملة الضريبة)</td><td>${summary.totalReturns.toFixed(2)} ${currency}</td></tr>
      <tr><td>صافي المبيعات (بدون ضريبة)</td><td>${summary.netSales.toFixed(2)} ${currency}</td></tr>
      <tr><td>صافي الضريبة</td><td>${summary.netTax.toFixed(2)} ${currency}</td></tr>
      <tr><td>الصافي شامل الضريبة</td><td>${summary.netTotal.toFixed(2)} ${currency}</td></tr>
      <tr><td>التكلفة</td><td>${summary.totalCost.toFixed(2)} ${currency}</td></tr>
      <tr><td>صافي الربح</td><td>${summary.profit.toFixed(2)} ${currency}</td></tr>
    </table>

    <h2>الأكثر مبيعًا</h2>
    <table>
      <thead><tr><th>المنتج</th><th>الكمية المباعة</th><th>الإيراد</th></tr></thead>
      <tbody>
        ${summary.topProducts.map((p) => `
          <tr><td>${escapeHtml(p.name)}</td><td>${p.qty_sold}</td><td>${p.revenue.toFixed(2)}</td></tr>
        `).join('')}
      </tbody>
    </table>

    <h2>تفاصيل الفواتير</h2>
    <table>
      <thead>
        <tr>
          <th>التاريخ</th><th>رقم الفاتورة</th><th>الكاشير</th><th>الصنف</th>
          <th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td>${escapeHtml(r.created_at)}</td>
            <td>${escapeHtml(r.sale_number)}</td>
            <td>${escapeHtml(r.cashier_name || '-')}</td>
            <td>${escapeHtml(r.product_name)}</td>
            <td>${r.qty}</td>
            <td>${r.unit_price.toFixed(2)}</td>
            <td>${r.line_total.toFixed(2)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

render();
