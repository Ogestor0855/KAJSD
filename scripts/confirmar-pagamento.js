'use strict';
// Lista pedidos pendentes ou confirma um pagamento PIX conferido manualmente no app do banco.
//   npm run confirmar                      → lista pedidos pending
//   npm run confirmar -- <orderId>         → envia "paid" ao webhook (assinado)
//   npm run confirmar -- <orderId> failed  → marca como failed
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const secret = process.env.PAYMENT_WEBHOOK_SECRET;
const base = process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`;
const dataFile = path.resolve(__dirname, '..', process.env.ORDERS_FILE || 'data/orders.json');
const [orderId, status = 'paid'] = process.argv.slice(2);

if (!orderId) {
  let orders = {};
  try { orders = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch {}
  const pending = Object.values(orders).filter((o) => o.status === 'pending');
  if (!pending.length) return console.log('Nenhum pedido pendente.');
  for (const o of pending) console.log(`${o.orderId}  ${o.createdAt}  ${o.name}  ${o.email}  ${o.whatsapp}`);
  return;
}

if (!secret) { console.error('Defina PAYMENT_WEBHOOK_SECRET no .env'); process.exit(1); }
const body = JSON.stringify({ orderId, status, amount: 27.5, paymentId: 'manual-' + Date.now() });
const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

fetch(base + '/api/payment/webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signature },
  body,
})
  .then(async (r) => console.log(r.status, await r.text()))
  .catch((err) => { console.error('Falha ao chamar o webhook:', err.message); process.exit(1); });
