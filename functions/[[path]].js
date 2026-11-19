// Backend da página de vendas + checkout PIX do GTA VI CLIP LUCRO (Cloudflare Pages Functions).
// Mesmas rotas e regras do antigo server.js; pedidos, sessões e rate limit ficam no D1 (binding DB)
// e o PDF do produto no R2 (binding PRODUCT_FILES). Os arquivos estáticos vêm de dist/ (binding ASSETS).
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

const ORDER_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CARD_CHECKOUT_URL = 'https://link.infinitepay.io/isaque085/VC1DLTAtUg-LXzP45g8Yz-27,50';

const PRODUCT = { id: 'gta-iv-clip-lucro', name: 'GTA VI CLIP LUCRO', amountCents: 2750 };
const FINAL_STATUSES = new Set(['paid', 'failed', 'expired']);
const METHODS = new Set(['PIX', 'CARD']);

// Acesso administrativo. A senha fica só como hash scrypt no servidor (nunca vai ao navegador).
// Para trocar: secrets ADMIN_EMAIL e ADMIN_PASSWORD_HASH (gere com `npm run hash-senha -- "nova senha"`).
const DEFAULT_ADMIN_EMAIL = 'olhaeu@hotmail.com';
const DEFAULT_ADMIN_PASSWORD_HASH =
  'scrypt$a65c34bc1748c839382a1a0c63bd8180$f2d690d286b2669e99d8973baaa285fac9633ca4e1f73bbb0b3ce799a97b1809567985333437addb7309af3a39b4c2144515bee88c8d1e83fbedebc80a9457b9';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const PAGES = { '/': '/index.html', '/checkout': '/checkout.html', '/obrigado': '/obrigado.html' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- configuração (variáveis/secrets do Cloudflare) ----------
function config(env) {
  const offerStart = Date.parse(env.OFFER_START || '2026-11-19T00:00:00-03:00');
  const offerEnd = Date.parse(env.OFFER_END || '2026-11-26T23:59:59-03:00');
  return {
    webhookSecret: env.PAYMENT_WEBHOOK_SECRET || '',
    pdfKey: env.PRODUCT_PDF_KEY || 'gta-iv-clip-lucro.pdf',
    cardCheckoutUrl: env.INFINITEPAY_CHECKOUT_URL || DEFAULT_CARD_CHECKOUT_URL,
    adminEmail: (env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL).toLowerCase(),
    adminPasswordHash: env.ADMIN_PASSWORD_HASH || DEFAULT_ADMIN_PASSWORD_HASH,
    offerStart,
    offerEnd,
    // Oferta promocional de 7 dias (horário de Brasília). Validada sempre pelo relógio do servidor.
    offerActive() { const now = Date.now(); return now >= offerStart && now <= offerEnd; },
  };
}

// ---------- armazenamento (D1) ----------
function rowToOrder(r) {
  return {
    orderId: r.order_id, number: r.number, accessToken: r.access_token, name: r.name, email: r.email,
    whatsapp: r.whatsapp, product: r.product, amountCents: r.amount_cents, method: r.method, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at, paidAt: r.paid_at || undefined, shippedAt: r.shipped_at || undefined,
    transactionId: r.transaction_id || undefined, history: JSON.parse(r.history || '[]'),
  };
}

async function findOrder(db, column, value) {
  const row = await db.prepare(`SELECT * FROM orders WHERE ${column} = ?`).bind(value).first();
  return row ? rowToOrder(row) : null;
}

function setStatus(order, status, meta) {
  const now = new Date().toISOString();
  order.history.push({ from: order.status, to: status, at: now, ...meta });
  order.prevStatus = order.status;
  order.status = status;
  order.updatedAt = now;
  if (status === 'paid' && !order.paidAt) order.paidAt = now;
  if (status === 'shipped') order.shippedAt = now;
  if (meta && meta.paymentId) order.transactionId = meta.paymentId;
}

// Grava a mudança de status só se o pedido ainda estiver no status lido (evita corrida entre requisições).
function saveStatus(db, order) {
  return db.prepare(
    'UPDATE orders SET status = ?, updated_at = ?, paid_at = ?, shipped_at = ?, transaction_id = ?, history = ? ' +
    'WHERE order_id = ? AND status = ?'
  ).bind(order.status, order.updatedAt, order.paidAt || null, order.shippedAt || null, order.transactionId || null,
    JSON.stringify(order.history), order.orderId, order.prevStatus);
}

async function commitStatus(db, order) {
  const result = await saveStatus(db, order).run();
  if (!result.meta.changes) throw new HttpError(409, 'O pedido foi alterado por outra requisição. Tente novamente.');
}

const isStale = (order) => order.status === 'pending' && Date.now() - Date.parse(order.createdAt) > ORDER_TTL_MS;

async function expireIfStale(db, order) {
  if (!isStale(order)) return;
  setStatus(order, 'expired', { source: 'ttl' });
  await saveStatus(db, order).run();
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

// ---------- rate limit simples por IP (D1) ----------
async function rateLimited(db, key, limit = 10, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const [, , count] = await db.batch([
    db.prepare('DELETE FROM rate_hits WHERE at < ?').bind(now - 15 * 60 * 1000),
    db.prepare('INSERT INTO rate_hits (key, at) VALUES (?, ?)').bind(key, now),
    db.prepare('SELECT COUNT(*) AS n FROM rate_hits WHERE key = ? AND at >= ?').bind(key, now - windowMs),
  ]);
  return count.results[0].n > limit;
}

// ---------- helpers HTTP ----------
function send(status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  return new Response(isJson ? JSON.stringify(body) : body, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      ...headers,
    },
  });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { ...SECURITY_HEADERS, Location: location, 'Cache-Control': 'no-store' } });
}

async function readBody(request, max = 10 * 1024) {
  if (Number(request.headers.get('content-length') || 0) > max) throw new HttpError(413, 'payload grande demais');
  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.length > max) throw new HttpError(413, 'payload grande demais');
  return buf;
}

function parseJson(buf) {
  try { const v = JSON.parse(buf.toString('utf8')); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';
const isPaid = (order) => order.status === 'paid' || order.status === 'shipped';

function publicOrder(order) {
  // "shipped" e "cancelled" são controles internos do admin; o cliente vê só pago/pendente/etc.
  const status = order.status === 'shipped' ? 'paid' : order.status === 'cancelled' ? 'failed' : order.status;
  const out = { orderId: order.orderId, status, amount: order.amountCents / 100, product: PRODUCT.name };
  if (isPaid(order)) out.downloadUrl = '/api/download/' + order.accessToken;
  return out;
}

// Lê um arquivo de dist/ pelo binding ASSETS (segue o redirecionamento de URL "bonita" do Pages).
async function fetchAsset(ctx, assetPath) {
  const url = new URL(assetPath, ctx.request.url);
  let res = await ctx.env.ASSETS.fetch(new Request(url));
  const location = res.status >= 300 && res.status < 400 && res.headers.get('Location');
  if (location) res = await ctx.env.ASSETS.fetch(new Request(new URL(location, url)));
  return res.ok ? res : null;
}

async function serveFile(ctx, assetPath, cache) {
  const res = await fetchAsset(ctx, assetPath);
  if (!res) return send(404, 'Não encontrado');
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  headers.set('Cache-Control', cache);
  return new Response(ctx.request.method === 'HEAD' ? null : res.body, { status: 200, headers });
}

// ---------- rotas da API ----------
async function createOrder(ctx) {
  const { request, env, cfg } = ctx;
  if (await rateLimited(env.DB, clientIp(request))) return send(429, { error: 'Muitas tentativas. Aguarde alguns minutos.' });

  if (!cfg.offerActive()) return send(410, { error: 'A condição promocional terminou.', offerEnded: true });
  const body = parseJson(await readBody(request));
  if (!body) return send(400, { error: 'JSON inválido.' });
  const { errors, data } = validateCustomer(body);
  if (Object.keys(errors).length) return send(422, { error: 'Dados inválidos.', fields: errors });
  const method = METHODS.has(body.method) ? body.method : 'PIX';

  const now = new Date().toISOString();
  const order = {
    orderId: crypto.randomUUID(),
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
  // Número sequencial calculado dentro do próprio INSERT (D1 serializa as escritas).
  await env.DB.prepare(
    'INSERT INTO orders (order_id, number, access_token, name, email, whatsapp, product, amount_cents, method, status, created_at, updated_at, history) ' +
    'VALUES (?, (SELECT COALESCE(MAX(number), 1000) + 1 FROM orders), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(order.orderId, order.accessToken, order.name, order.email, order.whatsapp, order.product, order.amountCents,
    order.method, order.status, order.createdAt, order.updatedAt, '[]').run();
  console.log(`[orders] novo pedido ${order.orderId} (${order.email})`);
  return send(201, publicOrder(order));
}

async function getOrder(ctx, id) {
  const order = await findOrder(ctx.env.DB, 'order_id', id);
  if (!order) return send(404, { error: 'Pedido não encontrado.' });
  await expireIfStale(ctx.env.DB, order);
  return send(200, publicOrder(order), { 'Cache-Control': 'no-store' });
}

// Webhook genérico: corpo JSON { orderId, status: "paid"|"failed"|"expired", paymentId?, amount? }
// assinado com HMAC-SHA256(corpo bruto, PAYMENT_WEBHOOK_SECRET) em hex no header X-Webhook-Signature.
async function paymentWebhook(ctx) {
  const { request, env, cfg } = ctx;
  if (!cfg.webhookSecret) return send(503, { error: 'Webhook não configurado.' });
  const raw = await readBody(request, 64 * 1024);
  const given = Buffer.from(String(request.headers.get('x-webhook-signature') || ''), 'utf8');
  const expected = Buffer.from(crypto.createHmac('sha256', cfg.webhookSecret).update(raw).digest('hex'), 'utf8');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return send(401, { error: 'Assinatura inválida.' });
  }

  const body = parseJson(raw);
  if (!body || typeof body.orderId !== 'string') return send(400, { error: 'Payload inválido.' });
  const order = await findOrder(env.DB, 'order_id', body.orderId);
  if (!order) return send(404, { error: 'Pedido não encontrado.' });
  if (!FINAL_STATUSES.has(body.status)) return send(422, { error: 'Status inválido.' });
  if (body.status === 'paid' && body.amount != null && Math.round(Number(body.amount) * 100) !== order.amountCents) {
    return send(422, { error: 'Valor pago diferente do valor do pedido.' });
  }

  if (order.status === body.status) return send(200, { ok: true, status: order.status });
  if (isPaid(order)) return send(409, { error: 'Pedido já está pago.' });
  if (order.status === 'cancelled') return send(409, { error: 'Pedido cancelado pelo administrador.' });
  if (order.status !== 'pending' && body.status !== 'paid') {
    return send(409, { error: `Transição ${order.status} → ${body.status} não permitida.` });
  }

  setStatus(order, body.status, { source: 'webhook', paymentId: body.paymentId ? String(body.paymentId).slice(0, 120) : undefined });
  await commitStatus(env.DB, order);
  console.log(`[orders] ${order.orderId} → ${order.status}`);
  return send(200, { ok: true, status: order.status });
}

async function download(ctx, token) {
  const order = await findOrder(ctx.env.DB, 'access_token', token);
  if (!order || !isPaid(order)) return send(404, 'Não encontrado');
  const file = ctx.env.PRODUCT_FILES ? await ctx.env.PRODUCT_FILES.get(ctx.cfg.pdfKey) : null;
  if (!file) {
    console.error('[download] PDF não encontrado no R2:', ctx.cfg.pdfKey);
    return send(503, 'Arquivo temporariamente indisponível. Fale com o suporte.');
  }
  return new Response(file.body, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="GTA-VI-CLIP-LUCRO.pdf"',
      'Cache-Control': 'private, no-store',
    },
  });
}

// ---------- checkout (remove a oferta do HTML quando ela termina) ----------
async function serveCheckout(ctx) {
  const res = await fetchAsset(ctx, '/checkout.html');
  if (!res) return send(404, 'Não encontrado');
  let html = await res.text();
  if (!ctx.cfg.offerActive()) {
    const ended = '<section class="card ended" role="status"><h2>Oferta encerrada</h2>' +
      '<p>A condição promocional de R$ 27,50 terminou em 26/11/2026. Novas compras por esse valor não estão mais disponíveis.</p>' +
      '<a class="btn btn-ghost" href="/">Voltar para a página inicial</a></section>';
    html = html.replace(/<!--OFFER:price-->[\s\S]*?<!--\/OFFER:price-->/g, '')
      .replace(/<!--OFFER:pay-->[\s\S]*?<!--\/OFFER:pay-->/, ended);
  }
  return send(200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
}

// ---------- admin ----------
function parseCookies(request) {
  const out = {};
  for (const part of String(request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();
const tokenHash = (token) => sha256(token).toString('hex');

// Sessões no D1 (guarda só o hash do token do cookie).
async function isAdmin(ctx) {
  const token = parseCookies(ctx.request).gta_admin;
  if (!token) return false;
  const row = await ctx.env.DB.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?').bind(tokenHash(token)).first();
  if (!row || row.expires_at < Date.now()) {
    if (row) await ctx.env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(tokenHash(token)).run();
    return false;
  }
  return true;
}

function verifyPassword(cfg, password) {
  const [, salt, hash] = cfg.adminPasswordHash.split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function sessionCookie(request, token, maxAgeSec) {
  const secure = new URL(request.url).protocol === 'https:';
  return 'gta_admin=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAgeSec + (secure ? '; Secure' : '');
}

// Bloqueia POST administrativo vindo de outro site (além do cookie SameSite=Strict).
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin) {
    try { if (new URL(origin).host !== new URL(request.url).host) return false; } catch { return false; }
  }
  return String(request.headers.get('content-type') || '').startsWith('application/json');
}

async function adminLogin(ctx) {
  const { request, env, cfg } = ctx;
  if (!sameOrigin(request)) return send(403, { error: 'Requisição recusada.' });
  const key = 'login:' + clientIp(request);
  if (await rateLimited(env.DB, key, 5, 15 * 60 * 1000)) return send(429, { error: 'Muitas tentativas. Aguarde 15 minutos.' });
  const body = parseJson(await readBody(request)) || {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const passwordOk = verifyPassword(cfg, typeof body.password === 'string' ? body.password : '');
  const emailOk = crypto.timingSafeEqual(sha256(email), sha256(cfg.adminEmail));
  if (!emailOk || !passwordOk) return send(401, { error: 'E-mail ou senha inválidos.' });
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_hits WHERE key = ?').bind(key),
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)').bind(tokenHash(token), now + SESSION_TTL_MS),
  ]);
  return send(200, { ok: true }, { 'Set-Cookie': sessionCookie(request, token, SESSION_TTL_MS / 1000) });
}

async function adminLogout(ctx) {
  const token = parseCookies(ctx.request).gta_admin;
  if (token) await ctx.env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(tokenHash(token)).run();
  return send(200, { ok: true }, { 'Set-Cookie': sessionCookie(ctx.request, '', 0) });
}

async function adminData(ctx) {
  const { env, cfg } = ctx;
  const { results } = await env.DB.prepare('SELECT * FROM orders ORDER BY number').all();
  const orders = results.map(rowToOrder);
  const stale = orders.filter(isStale);
  stale.forEach((o) => setStatus(o, 'expired', { source: 'ttl' }));
  if (stale.length) await env.DB.batch(stale.map((o) => saveStatus(env.DB, o)));
  const list = orders.map((o) => ({
    orderId: o.orderId, number: o.number || null, name: o.name, email: o.email, whatsapp: o.whatsapp,
    product: PRODUCT.name, method: o.method, amount: o.amountCents / 100, status: o.status,
    transactionId: o.transactionId || null, createdAt: o.createdAt, updatedAt: o.updatedAt,
    paidAt: o.paidAt || null, shippedAt: o.shippedAt || null, history: o.history,
  }));
  return send(200, {
    orders: list,
    product: { name: PRODUCT.name, type: 'Guia prático em PDF', price: PRODUCT.amountCents / 100, oldPrice: 69.9 },
    offer: { active: cfg.offerActive(), start: new Date(cfg.offerStart).toISOString(), end: new Date(cfg.offerEnd).toISOString() },
  }, { 'Cache-Control': 'no-store' });
}

// Ações manuais do admin: confirmar pagamento conferido no banco, marcar como enviado ou cancelar.
const ADMIN_TRANSITIONS = {
  paid: ['pending', 'expired', 'failed'],
  shipped: ['paid'],
  cancelled: ['pending', 'expired', 'failed'],
};
async function adminSetStatus(ctx, id) {
  const { request, env } = ctx;
  if (!sameOrigin(request)) return send(403, { error: 'Requisição recusada.' });
  const order = await findOrder(env.DB, 'order_id', id);
  if (!order) return send(404, { error: 'Pedido não encontrado.' });
  const body = parseJson(await readBody(request)) || {};
  const allowed = ADMIN_TRANSITIONS[body.status];
  if (!allowed) return send(422, { error: 'Status inválido.' });
  if (!allowed.includes(order.status)) {
    return send(409, { error: 'Não é possível mudar de ' + order.status + ' para ' + body.status + '.' });
  }
  setStatus(order, body.status, { source: 'admin' });
  await commitStatus(env.DB, order);
  console.log('[admin] ' + order.orderId + ' → ' + order.status);
  return send(200, { ok: true, status: order.status });
}

// ---------- roteador ----------
async function route(ctx) {
  const { request, cfg } = ctx;
  const { pathname } = new URL(request.url);
  const method = request.method;
  let m;

  if (method === 'POST' && pathname === '/api/orders') return createOrder(ctx);
  if (method === 'POST' && pathname === '/api/payment/webhook') return paymentWebhook(ctx);
  if (method === 'GET' && pathname === '/api/offer') {
    return send(200, { active: cfg.offerActive(), end: new Date(cfg.offerEnd).toISOString() }, { 'Cache-Control': 'no-store' });
  }
  if (method === 'POST' && pathname === '/api/admin/login') return adminLogin(ctx);
  if (method === 'POST' && pathname === '/api/admin/logout') return adminLogout(ctx);
  if (pathname.startsWith('/api/admin/')) {
    if (!(await isAdmin(ctx))) return send(401, { error: 'Não autenticado.' });
    if (method === 'GET' && pathname === '/api/admin/data') return adminData(ctx);
    if (method === 'POST' && (m = pathname.match(/^\/api\/admin\/orders\/([0-9a-f-]{36})\/status$/))) {
      return adminSetStatus(ctx, m[1]);
    }
    return send(404, { error: 'Rota não encontrada.' });
  }
  if (method === 'GET' && (m = pathname.match(/^\/api\/orders\/([0-9a-f-]{36})$/))) return getOrder(ctx, m[1]);
  if (method === 'GET' && (m = pathname.match(/^\/api\/download\/([\w-]{32})$/))) return download(ctx, m[1]);
  if (pathname.startsWith('/api/')) return send(404, { error: 'Rota não encontrada.' });

  if (method !== 'GET' && method !== 'HEAD') return send(405, 'Método não permitido');
  if (pathname === '/admin' || pathname === '/admin/') {
    if (!(await isAdmin(ctx))) return redirect('/admin/login');
    return serveFile(ctx, '/admin/admin.html', 'no-store');
  }
  if (pathname === '/admin/login') {
    if (await isAdmin(ctx)) return redirect('/admin');
    return serveFile(ctx, '/admin/login.html', 'no-store');
  }
  if (pathname === '/checkout') return serveCheckout(ctx);
  if (pathname === '/assets/pix-qrcode.jpeg' && !cfg.offerActive()) return send(410, 'Oferta encerrada');
  if (pathname === '/pagar/cartao') {
    if (!cfg.offerActive()) return redirect('/checkout');
    if (!/^https:\/\//.test(cfg.cardCheckoutUrl)) return send(503, 'Pagamento com cartão indisponível no momento.');
    return redirect(cfg.cardCheckoutUrl);
  }
  if (PAGES[pathname]) return serveFile(ctx, PAGES[pathname], 'no-cache');
  if ((m = pathname.match(/^\/assets\/([\w.-]+)$/))) return serveFile(ctx, '/assets/' + m[1], 'public, max-age=604800');
  return send(404, 'Não encontrado');
}

export async function onRequest(context) {
  const ctx = { request: context.request, env: context.env, cfg: config(context.env) };
  try {
    return await route(ctx);
  } catch (err) {
    if (!err.status) console.error(err);
    return send(err.status || 500, { error: err.status ? err.message : 'Erro interno.' });
  }
}
