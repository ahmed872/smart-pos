// Shared presentation of the store identity and invoice values. Used by the receipt, the daily
// closing, the sales report and the main window so every surface prints the same identity from
// the same settings. Loaded as a plain script in the renderer (window.StoreIdentity) and as a
// module in tests.
(function (root) {
  const IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/i;

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function money(amount, currency) {
    const n = Number(amount) || 0;
    return currency ? `${n.toFixed(2)} ${currency}` : n.toFixed(2);
  }

  const pad = (n) => String(n).padStart(2, '0');

  // Stored timestamps are SQLite local time strings "YYYY-MM-DD HH:MM:SS".
  function formatDateTimeText(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(value || ''));
    return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : String(value || '');
  }

  function formatDateText(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(value || '');
  }

  // Dates are numbers-and-slashes; isolate them left-to-right so RTL text around them cannot
  // reorder their parts.
  function ltr(text) {
    return `<bdi dir="ltr">${escapeHtml(text)}</bdi>`;
  }

  function formatDateTime(value) {
    return ltr(formatDateTimeText(value));
  }

  function formatDate(value) {
    return ltr(formatDateText(value));
  }

  function paymentLabel(method) {
    return method === 'card' ? 'بطاقة' : 'نقدًا';
  }

  // Effective rate of an invoice, derived from its own stored amounts (not today's setting).
  function taxRate(sale) {
    const taxable = (Number(sale.total) || 0) - (Number(sale.tax) || 0);
    if (!(Number(sale.tax) > 0) || !(taxable > 0)) return 0;
    return Math.round((sale.tax / taxable) * 10000) / 100;
  }

  function hasLogo(settings) {
    return !!(settings && typeof settings.logo_data_url === 'string' && IMAGE_DATA_URL_RE.test(settings.logo_data_url));
  }

  // Store header. compact: logo + name only (internal reports); full: plus contact and
  // registration details (customer-facing receipt). Empty values are simply not printed.
  function headerHtml(settings, options = {}) {
    const s = settings || {};
    const parts = [];
    if (hasLogo(s)) {
      parts.push(`<div class="si-logo"><img src="${s.logo_data_url}" alt="" style="max-height:${options.logoMaxHeight || 60}px;max-width:100%;" /></div>`);
    }
    if (s.store_name) parts.push(`<div class="si-name">${escapeHtml(s.store_name)}</div>`);
    if (!options.compact) {
      if (s.store_address) parts.push(`<div class="si-line">${escapeHtml(s.store_address)}</div>`);
      if (s.store_phone) parts.push(`<div class="si-line">هاتف: ${ltr(s.store_phone)}</div>`);
      if (s.tax_number) parts.push(`<div class="si-line">الرقم الضريبي: ${ltr(s.tax_number)}</div>`);
      if (s.commercial_register) parts.push(`<div class="si-line">السجل التجاري: ${ltr(s.commercial_register)}</div>`);
    }
    return `<div class="si-header">${parts.join('')}</div>`;
  }

  // Plain-text identity of an invoice, encoded in the receipt QR code.
  function invoiceQrText(sale, settings) {
    const s = settings || {};
    return [
      s.store_name,
      s.tax_number ? `الرقم الضريبي: ${s.tax_number}` : '',
      `فاتورة: ${sale.sale_number}`,
      `التاريخ: ${formatDateTimeText(sale.created_at)}`,
      `الإجمالي: ${money(sale.total, s.currency)}`,
      Number(sale.tax) > 0 ? `الضريبة: ${money(sale.tax, s.currency)}` : '',
    ].filter(Boolean).join('\n');
  }

  const api = {
    escapeHtml, money, formatDateTimeText, formatDateText, formatDateTime, formatDate,
    paymentLabel, taxRate, hasLogo, headerHtml, invoiceQrText,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StoreIdentity = api;
})(typeof window !== 'undefined' ? window : this);
