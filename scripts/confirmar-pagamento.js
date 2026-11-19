'use strict';
// Lista pedidos pendentes ou confirma um pagamento PIX conferido manualmente no app do banco.
//   npm run confirmar                      → lista pedidos pending
//   npm run confirmar -- <orderId>         → envia "paid" ao webhook (assinado)
//   npm run confirmar -- <orderId> failed  → marca como failed
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');

const secret = process.env.PAYMENT_WEBHOOK_SECRET;
const base = process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`;
const [orderId, status = 'paid'] = process.argv.slice(2);

if (!orderId) {
  // Pedidos ficam no D1: lê o banco remoto (ou o local do `npm start` quando SITE_URL não está definido).
  const where = process.env.SITE_URL ? '--remote' : '--local';
  const sql = "SELECT order_id, created_at, name, email, whatsapp FROM orders WHERE status = 'pending' ORDER BY created_at";
  const out = JSON.parse(execSync(`npx wrangler d1 execute DB ${where} --json --command "${sql}"`, { encoding: 'utf8' }));
  const pending = out[0].results;
  if (!pending.length) return console.log('Nenhum pedido pendente.');
  for (const o of pending) console.log(`${o.order_id}  ${o.created_at}  ${o.name}  ${o.email}  ${o.whatsapp}`);
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
