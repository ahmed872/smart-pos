const { escapeHtml, formatDateTime } = window.StoreIdentity;
const { userMessage } = window.UiMessages;

async function loadOrders() {
  const orders = await window.api.kitchen.list();
  const container = document.getElementById('orders');
  if (orders.length === 0) {
    container.innerHTML = '<p style="color:var(--text-dim);">لا توجد طلبات حاليًا</p>';
    return;
  }
  container.innerHTML = orders.map((o) => `
    <div class="kitchen-order ${o.kitchen_status}">
      <h3>فاتورة <bdi dir="ltr">${escapeHtml(o.sale_number)}</bdi> - ${formatDateTime(o.created_at)}</h3>
      <ul>
        ${o.items.map((it) => `<li>${it.qty} × ${escapeHtml(it.name)}</li>`).join('')}
      </ul>
      <div style="display:flex;gap:8px;">
        ${o.kitchen_status === 'pending' ? `<button class="secondary" data-action="preparing" data-id="${o.sale_id}">بدء التحضير</button>` : ''}
        ${o.kitchen_status === 'preparing' ? `<button class="primary" style="width:auto;padding:8px 16px;" data-action="ready" data-id="${o.sale_id}">جاهز للتسليم</button>` : ''}
      </div>
    </div>
  `).join('');

  container.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await window.api.kitchen.updateStatus(Number(btn.dataset.id), btn.dataset.action);
      } catch (err) {
        alert(userMessage(err));
      }
      loadOrders();
    });
  });
}


loadOrders();
setInterval(loadOrders, 4000);
