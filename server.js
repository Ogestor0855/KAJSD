'use strict';
// Servidor da página de vendas + checkout PIX do GTA IV CLIP LUCRO. Sem dependências externas.
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || '';
const PDF_PATH = path.resolve(ROOT, process.env.PRODUCT_PDF_PATH || 'private/gta-iv-clip-lucro.pdf');
const DATA_FILE = path.resolve(ROOT, process.env.ORDERS_FILE || 'data/orders.json');
const ORDER_TTL_MS = 24 * 60 * 60 * 1000;
// Link de pagamento com cartão (checkout externo da InfinitePay). Pode ser trocado pela variável de ambiente.
const CARD_CHECKOUT_URL = process.env.INFINITEPAY_CHECKOUT_URL || 'https://link.infinitepay.io/isaque085/VC1DLTAtUg-LXzP45g8Yz-27,50';

const PRODUCT = { id: 'gta-iv-clip-lucro', name: 'GTA IV CLIP LUCRO', amountCents: 2750 };
const FINAL_STATUSES = new Set(['paid', 'failed', 'expired']);
const METHODS = new Set(['PIX', 'CARD']);

// Oferta promocional de 7 dias (horário de Brasília). Validada sempre pelo relógio do servidor.
const OFFER_START = Date.parse(process.env.OFFER_START || '2026-11-19T00:00:00-03:00');
const OFFER_END = Date.parse(process.env.OFFER_END || '2026-11-26T23:59:59-03:00');
const offerActive = () => { const now = Date.now(); return now >= OFFER_START && now <= OFFER_END; };

// Acesso administrativo. A senha fica só como hash scrypt no servidor (nunca vai ao navegador).
// Para trocar: ADMIN_EMAIL e ADMIN_PASSWORD_HASH (gere com `npm run hash-senha -- "nova senha"`).
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'olhaeu@hotmail.com').toLowerCase();
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH ||
  'scrypt$a65c34bc1748c839382a1a0c63bd8180$f2d690d286b2669e99d8973baaa285fac9633ca4e1f73bbb0b3ce799a97b1809567985333437addb7309af3a39b4c2144515bee88c8d1e83fbedebc80a9457b9';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_SECURE = process.env.NODE_ENV === 'production';
const sessions = new Map(); // token → expiresAt (em memória: reiniciar o servidor encerra as sessões)

const PAGES = { '/': 'index.html', '/checkout': 'checkout.html', '/obrigado': 'obrigado.html' };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

// ---------- armazenamento (JSON em disco, gravação atômica e serializada) ----------
let orders = {};
try { orders = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { orders = {}; }
let writeChain = Promise.resolve();
function persist() {
  writeChain = writeChain.then(async () => {
    await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(orders, null, 2));
    await fsp.rename(tmp, DATA_FILE);
  }).catch((err) => console.error('[orders] falha ao salvar:', err));
  return writeChain;
}

function expireIfStale(order) {
  if (order.status === 'pending' && Date.now() - Date.parse(order.createdAt) > ORDER_TTL_MS) {
    setStatus(order, 'expired', { source: 'ttl' });
    persist();
  }
}

function setStatus(order, status, meta) {
  const now = new Date().toISOString();
  order.history.push({ from: order.status, to: status, at: now, ...meta });
  order.status = status;
  order.updatedAt = now;
  if (status === 'paid' && !order.paidAt) order.paidAt = now;
  if (status === 'shipped') order.shippedAt = now;
  if (meta && meta.paymentId) order.transactionId = meta.paymentId;
}

// ---------- validação ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validateCustomer(body) {
  const errors = {};
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  let phone = typeof body.whatsapp === 'string' ? body.whatsapp.replace(/\D/g, '') : '';
  if (phone.length >= 12 && phone.startsWith('55')) phone = phone.slice(2);

  if (name.length < 3 || name.length > 120 || !name.includes(' ')) errors.name = 'Informe seu nome completo.';
  if (email.length > 254 || !EMAIL_RE.test(email)) errors.email = 'Informe um e-mail válido.';
  const ddd = Number(phone.slice(0, 2));
  const validPhone = (phone.length === 11 && phone[2] === '9') || phone.length === 10;
  if (!validPhone || ddd < 11 || ddd > 99) errors.whatsapp = 'Informe um WhatsApp válido com DDD.';

  return { errors, data: { name, email, whatsapp: '+55' + phone } };
}

// ---------- rate limit simples por IP ----------
const hits = new Map();
function rateLimited(ip, limit = 10, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > limit;
}

// ---------- helpers HTTP ----------
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req, max = 10 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error('payload grande demais'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(buf) {
  try { const v = JSON.parse(buf.toString('utf8')); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

const isPaid = (order) => order.status === 'paid' || order.status === 'shipped';

function publicOrder(order) {
  // "shipped" e "cancelled" são controles internos do admin; o cliente vê só pago/pendente/etc.
  const status = order.status === 'shipped' ? 'paid' : order.status === 'cancelled' ? 'failed' : order.status;
  const out = { orderId: order.orderId, status, amount: order.amountCents / 100, product: PRODUCT.name };
  if (isPaid(order)) out.downloadUrl = '/api/download/' + order.accessToken;
  return out;
}

async function serveFile(res, file, cache) {
  try {
    const data = await fsp.readFile(file);
    send(res, 200, data, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': cache,
    });
  } catch {
    send(res, 404, 'Não encontrado');
  }
}

// ---------- rotas da API ----------
async function createOrder(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) return send(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos.' });

  if (!offerActive()) return send(res, 410, { error: 'A condição promocional terminou.', offerEnded: true });
  const body = parseJson(await readBody(req));
  if (!body) return send(res, 400, { error: 'JSON inválido.' });
  const { errors, data } = validateCustomer(body);
  if (Object.keys(errors).length) return send(res, 422, { error: 'Dados inválidos.', fields: errors });
  const method = METHODS.has(body.method) ? body.method : 'PIX';

  const now = new Date().toISOString();
  const number = Object.values(orders).reduce((max, o) => Math.max(max, o.number || 0), 1000) + 1;
  const order = {
    orderId: crypto.randomUUID(),
    number,
    accessToken: crypto.randomBytes(24).toString('base64url'),
    ...data,
    product: PRODUCT.id,
    amountCents: PRODUCT.amountCents, // valor fixo no servidor, nunca vem do cliente
    method,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    history: [],
  };
  orders[order.orderId] = order;
  await persist();
  console.log(`[orders] novo pedido ${order.orderId} (${order.email})`);
  send(res, 201, publicOrder(order));
}

function getOrder(res, id) {
  const order = orders[id];
  if (!order) return send(res, 404, { error: 'Pedido não encontrado.' });
  expireIfStale(order);
  send(res, 200, publicOrder(order), { 'Cache-Control': 'no-store' });
}

// Webhook genérico: corpo JSON { orderId, status: "paid"|"failed"|"expired", paymentId?, amount? }
// assinado com HMAC-SHA256(corpo bruto, PAYMENT_WEBHOOK_SECRET) em hex no header X-Webhook-Signature.
async function paymentWebhook(req, res) {
  if (!WEBHOOK_SECRET) return send(res, 503, { error: 'Webhook não configurado.' });
  const raw = await readBody(req, 64 * 1024);
  const given = Buffer.from(String(req.headers['x-webhook-signature'] || ''), 'utf8');
  const expected = Buffer.from(crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'), 'utf8');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return send(res, 401, { error: 'Assinatura inválida.' });
  }

  const body = parseJson(raw);
  if (!body || typeof body.orderId !== 'string') return send(res, 400, { error: 'Payload inválido.' });
  const order = orders[body.orderId];
  if (!order) return send(res, 404, { error: 'Pedido não encontrado.' });
  if (!FINAL_STATUSES.has(body.status)) return send(res, 422, { error: 'Status inválido.' });
  if (body.status === 'paid' && body.amount != null && Math.round(Number(body.amount) * 100) !== order.amountCents) {
    return send(res, 422, { error: 'Valor pago diferente do valor do pedido.' });
  }

  if (order.status === body.status) return send(res, 200, { ok: true, status: order.status });
  if (isPaid(order)) return send(res, 409, { error: 'Pedido já está pago.' });
  if (order.status === 'cancelled') return send(res, 409, { error: 'Pedido cancelado pelo administrador.' });
  if (order.status !== 'pending' && body.status !== 'paid') {
    return send(res, 409, { error: `Transição ${order.status} → ${body.status} não permitida.` });
  }

  setStatus(order, body.status, { source: 'webhook', paymentId: body.paymentId ? String(body.paymentId).slice(0, 120) : undefined });
  await persist();
  console.log(`[orders] ${order.orderId} → ${order.status}`);
  send(res, 200, { ok: true, status: order.status });
}

async function download(res, token) {
  const order = Object.values(orders).find((o) => o.accessToken === token);
  if (!order || !isPaid(order)) return send(res, 404, 'Não encontrado');
  try {
    const data = await fsp.readFile(PDF_PATH);
    send(res, 200, data, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="GTA-IV-CLIP-LUCRO.pdf"',
      'Cache-Control': 'private, no-store',
    });
  } catch {
    console.error('[download] PDF não encontrado em', PDF_PATH);
    send(res, 503, 'Arquivo temporariamente indisponível. Fale com o suporte.');
  }
}

function redirect(res, location) {
  res.writeHead(302, { ...SECURITY_HEADERS, Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

// ---------- checkout (remove a oferta do HTML quando ela termina) ----------
async function serveCheckout(res) {
  let html = await fsp.readFile(path.join(ROOT, 'checkout.html'), 'utf8');
  if (!offerActive()) {
    const ended = '<section class="card ended" role="status"><h2>Oferta encerrada</h2>' +
      '<p>A condição promocional de R$ 27,50 terminou em 26/11/2026. Novas compras por esse valor não estão mais disponíveis.</p>' +
      '<a class="btn btn-ghost" href="/">Voltar para a página inicial</a></section>';
    html = html.replace(/<!--OFFER:price-->[\s\S]*?<!--\/OFFER:price-->/g, '')
      .replace(/<!--OFFER:pay-->[\s\S]*?<!--\/OFFER:pay-->/, ended);
  }
  send(res, 200, html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
}

// ---------- admin ----------
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isAdmin(req) {
  const token = parseCookies(req).gta_admin;
  if (!token) return false;
  const expires = sessions.get(token);
  if (!expires || expires < Date.now()) { sessions.delete(token); return false; }
  return true;
}

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();
function verifyPassword(password) {
  const [, salt, hash] = ADMIN_PASSWORD_HASH.split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function sessionCookie(token, maxAgeSec) {
  return 'gta_admin=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAgeSec + (COOKIE_SECURE ? '; Secure' : '');
}

// Bloqueia POST administrativo vindo de outro site (além do cookie SameSite=Strict).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return false; } catch { return false; }
  }
  return String(req.headers['content-type'] || '').startsWith('application/json');
}

async function adminLogin(req, res) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'Requisição recusada.' });
  const key = 'login:' + (req.socket.remoteAddress || 'unknown');
  if (rateLimited(key, 5, 15 * 60 * 1000)) return send(res, 429, { error: 'Muitas tentativas. Aguarde 15 minutos.' });
  const body = parseJson(await readBody(req)) || {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const passwordOk = verifyPassword(typeof body.password === 'string' ? body.password : '');
  const emailOk = crypto.timingSafeEqual(sha256(email), sha256(ADMIN_EMAIL));
  if (!emailOk || !passwordOk) return send(res, 401, { error: 'E-mail ou senha inválidos.' });
  hits.delete(key);
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
}

function adminLogout(req, res) {
  sessions.delete(parseCookies(req).gta_admin);
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
}

function adminData(res) {
  Object.values(orders).forEach(expireIfStale);
  const list = Object.values(orders).map((o) => ({
    orderId: o.orderId, number: o.number || null, name: o.name, email: o.email, whatsapp: o.whatsapp,
    product: PRODUCT.name, method: o.method, amount: o.amountCents / 100, status: o.status,
    transactionId: o.transactionId || null, createdAt: o.createdAt, updatedAt: o.updatedAt,
    paidAt: o.paidAt || null, shippedAt: o.shippedAt || null, history: o.history,
  }));
  send(res, 200, {
    orders: list,
    product: { name: PRODUCT.name, type: 'Guia prático em PDF', price: PRODUCT.amountCents / 100, oldPrice: 69.9 },
    offer: { active: offerActive(), start: new Date(OFFER_START).toISOString(), end: new Date(OFFER_END).toISOString() },
  }, { 'Cache-Control': 'no-store' });
}

// Ações manuais do admin: confirmar pagamento conferido no banco, marcar como enviado ou cancelar.
const ADMIN_TRANSITIONS = {
  paid: ['pending', 'expired', 'failed'],
  shipped: ['paid'],
  cancelled: ['pending', 'expired', 'failed'],
};
async function adminSetStatus(req, res, id) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'Requisição recusada.' });
  const order = orders[id];
  if (!order) return send(res, 404, { error: 'Pedido não encontrado.' });
  const body = parseJson(await readBody(req)) || {};
  const allowed = ADMIN_TRANSITIONS[body.status];
  if (!allowed) return send(res, 422, { error: 'Status inválido.' });
  if (!allowed.includes(order.status)) {
    return send(res, 409, { error: 'Não é possível mudar de ' + order.status + ' para ' + body.status + '.' });
  }
  setStatus(order, body.status, { source: 'admin' });
  await persist();
  console.log('[admin] ' + order.orderId + ' → ' + order.status);
  send(res, 200, { ok: true, status: order.status });
}

// ---------- roteador ----------
const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    const method = req.method;

    if (method === 'POST' && pathname === '/api/orders') return await createOrder(req, res);
    if (method === 'POST' && pathname === '/api/payment/webhook') return await paymentWebhook(req, res);
    if (method === 'GET' && pathname === '/api/offer') {
      return send(res, 200, { active: offerActive(), end: new Date(OFFER_END).toISOString() }, { 'Cache-Control': 'no-store' });
    }
    if (method === 'POST' && pathname === '/api/admin/login') return await adminLogin(req, res);
    if (method === 'POST' && pathname === '/api/admin/logout') return adminLogout(req, res);
    let m;
    if (pathname.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Não autenticado.' });
      if (method === 'GET' && pathname === '/api/admin/data') return adminData(res);
      if (method === 'POST' && (m = pathname.match(/^\/api\/admin\/orders\/([0-9a-f-]{36})\/status$/))) {
        return await adminSetStatus(req, res, m[1]);
      }
      return send(res, 404, { error: 'Rota não encontrada.' });
    }
    if (method === 'GET' && (m = pathname.match(/^\/api\/orders\/([0-9a-f-]{36})$/))) return getOrder(res, m[1]);
    if (method === 'GET' && (m = pathname.match(/^\/api\/download\/([\w-]{32})$/))) return await download(res, m[1]);
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'Rota não encontrada.' });

    if (method !== 'GET' && method !== 'HEAD') return send(res, 405, 'Método não permitido');
    if (pathname === '/admin' || pathname === '/admin/') {
      if (!isAdmin(req)) return redirect(res, '/admin/login');
      return await serveFile(res, path.join(ROOT, 'admin', 'admin.html'), 'no-store');
    }
    if (pathname === '/admin/login') {
      if (isAdmin(req)) return redirect(res, '/admin');
      return await serveFile(res, path.join(ROOT, 'admin', 'login.html'), 'no-store');
    }
    if (pathname === '/checkout') return await serveCheckout(res);
    if (pathname === '/assets/pix-qrcode.jpeg' && !offerActive()) return send(res, 410, 'Oferta encerrada');
    if (pathname === '/pagar/cartao') {
      if (!offerActive()) return redirect(res, '/checkout');
      if (!/^https:\/\//.test(CARD_CHECKOUT_URL)) return send(res, 503, 'Pagamento com cartão indisponível no momento.');
      return redirect(res, CARD_CHECKOUT_URL);
    }
    if (PAGES[pathname]) return await serveFile(res, path.join(ROOT, PAGES[pathname]), 'no-cache');
    if ((m = pathname.match(/^\/assets\/([\w.-]+)$/))) {
      return await serveFile(res, path.join(ROOT, 'assets', m[1]), 'public, max-age=604800');
    }
    send(res, 404, 'Não encontrado');
  } catch (err) {
    if (res.headersSent) return res.destroy();
    send(res, err.status || 500, { error: err.status ? err.message : 'Erro interno.' });
    if (!err.status) console.error(err);
  }
});

server.listen(PORT, () => {
  console.log(`GTA IV CLIP LUCRO rodando em http://localhost:${PORT}`);
  if (!WEBHOOK_SECRET) console.warn('PAYMENT_WEBHOOK_SECRET não definido: webhook desativado, pedidos ficam pending.');
  if (!fs.existsSync(PDF_PATH)) console.warn('PDF do produto não encontrado em', PDF_PATH);
});
