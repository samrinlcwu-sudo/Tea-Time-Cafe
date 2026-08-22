const ORDER_STATUSES = ["NEW", "PREPARING", "READY", "COMPLETED"];

const containerEl = document.getElementById("orders-container");
const refreshButtonEl = document.getElementById("refresh-button");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function formatItems(items) {
  return (items || [])
    .map((item) => {
      const details = [item.size, ...(item.options || [])].filter(Boolean).join(", ");
      return `${item.quantity}x ${item.name}${details ? ` (${details})` : ""}`;
    })
    .join(", ");
}

function formatCustomerInfo(fulfillment) {
  const f = fulfillment || {};
  const parts = [];
  if (f.name) parts.push(f.name);
  if (f.type === "delivery") {
    if (f.phone) parts.push(f.phone);
    if (f.address) parts.push(f.address + (f.apartment ? `, ${f.apartment}` : ""));
    if (f.instructions) parts.push(`note: ${f.instructions}`);
  } else if (f.type === "pickup" && f.pickupTime) {
    parts.push(`pickup: ${f.pickupTime}`);
  }
  return parts.length ? parts.join(" · ") : "—";
}

function renderOrders(orders) {
  if (orders.length === 0) {
    containerEl.innerHTML = '<div class="empty">No orders yet.</div>';
    return;
  }

  const rows = orders
    .slice()
    .reverse()
    .map((order) => {
      const fulfillment = order.fulfillment || {};
      const options = ORDER_STATUSES.map(
        (s) => `<option value="${s}"${s === order.status ? " selected" : ""}>${s}</option>`
      ).join("");
      return `
        <tr data-order-id="${escapeHtml(order.orderId)}">
          <td>${escapeHtml(order.orderId)}</td>
          <td>${escapeHtml(formatItems(order.items))}</td>
          <td>${escapeHtml(fulfillment.type || "—")}</td>
          <td>${escapeHtml(formatCustomerInfo(fulfillment))}</td>
          <td>$${Number(order.pricing?.grandTotal ?? 0).toFixed(2)}</td>
          <td><select class="status-select">${options}</select></td>
        </tr>
      `;
    })
    .join("");

  containerEl.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Order ID</th>
            <th>Items</th>
            <th>Fulfillment</th>
            <th>Customer</th>
            <th>Total</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  containerEl.querySelectorAll(".status-select").forEach((select) => {
    select.addEventListener("change", async (event) => {
      const row = event.target.closest("tr");
      const orderId = row.dataset.orderId;
      const newStatus = event.target.value;
      event.target.disabled = true;
      try {
        const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: newStatus }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          alert(body.error || "Failed to update status.");
          await loadOrders();
          return;
        }
      } catch {
        alert("Failed to reach the server.");
        await loadOrders();
      } finally {
        event.target.disabled = false;
      }
    });
  });
}

async function loadOrders() {
  containerEl.innerHTML = "Loading orders...";
  try {
    const res = await fetch("/api/orders");
    if (!res.ok) throw new Error("Request failed");
    const data = await res.json();
    renderOrders(data.orders || []);
  } catch {
    containerEl.innerHTML = '<div class="error">Failed to load orders. Is the backend running?</div>';
  }
}

refreshButtonEl.addEventListener("click", loadOrders);
loadOrders();
