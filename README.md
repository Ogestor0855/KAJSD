# GTA IV CLIP LUCRO — página de vendas + checkout PIX

Cloudflare Pages: arquivos estáticos em `dist/` + backend em `functions/[[path]].js` (Pages Functions).
Pedidos, sessões do admin e rate limit ficam no **D1** (binding `DB`); o PDF do produto no **R2** (binding `PRODUCT_FILES`).
Configuração em `wrangler.toml`; esquema do banco em `migrations/`.

```
npm install
npm run db:migrate:local  # cria as tabelas no D1 local
npm start                 # build + wrangler pages dev em http://127.0.0.1:3000
```

Segredos locais em `.dev.vars` (não versionado), ex.: `PAYMENT_WEBHOOK_SECRET=...`.

Deploy (Cloudflare Pages, projeto `gta6`): build command `npm run build`, output `dist` (já definido no `wrangler.toml`).
Mudanças no esquema: `npm run db:migrate` aplica as migrations no D1 remoto.

Rotas: `/` (vendas) → `/checkout` → `/obrigado?pedido=<id>`.
Cartão de crédito: `/pagar/cartao` redireciona para `INFINITEPAY_CHECKOUT_URL` (o pagamento e a entrega por cartão acontecem na InfinitePay, fora deste sistema de pedidos).

## Antes de publicar

1. Ative o R2 no painel da Cloudflare, crie o bucket e envie o PDF (comandos no `wrangler.toml`), depois descomente
   o bloco `[[r2_buckets]]`. O arquivo **não** é público; só sai por `/api/download/<token>` para pedidos `paid`.
2. Defina os secrets: `npx wrangler pages secret put PAYMENT_WEBHOOK_SECRET --project-name gta6`
   (idem para `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH`, se quiser trocar o acesso padrão).
3. Os pedidos ficam no D1 `gta-iv-clip-lucro` — contém dados pessoais, não exponha.

## Status do pedido

`pending` → `paid` | `failed` | `expired` (pendentes expiram após 24 h).
O botão "Já fiz o pagamento" só cria o pedido como `pending`. Nada no navegador marca como pago.

## Confirmação de pagamento

O QR Code e o código PIX são **estáticos** (mesmo código para todos os compradores), então o banco
não consegue avisar automaticamente qual pedido foi pago. Hoje a confirmação é manual:

```
npm run confirmar                     # lista pedidos pending do D1 (remoto se SITE_URL estiver definido)
npm run confirmar -- <orderId>        # após conferir o PIX no app do banco → paid
npm run confirmar -- <orderId> failed # recusa
```

Para confirmação automática, integre um gateway que gere uma cobrança PIX por pedido e envie
webhook. O endpoint já existe:

`POST /api/payment/webhook`
- corpo: `{ "orderId": "...", "status": "paid" | "failed" | "expired", "paymentId": "...", "amount": 27.5 }`
- header `X-Webhook-Signature`: HMAC-SHA256 do corpo bruto com `PAYMENT_WEBHOOK_SECRET`, em hex.

Cada gateway tem formato próprio de webhook/assinatura: adapte a função `paymentWebhook` em
`functions/[[path]].js` quando escolher o provedor.

## Admin (`/admin`)

Login em `/admin/login`. A senha fica no servidor apenas como hash scrypt (`functions/[[path]].js`), nunca no HTML/JS.
Para trocar: `npm run hash-senha -- "nova senha"` e defina `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` como secrets.
Sessão no D1 (12 h, cookie HttpOnly + SameSite=Strict; `Secure` em HTTPS).

Na dashboard o admin vê pedidos e clientes, e em cada pedido pode **Confirmar pagamento** (após conferir no banco/InfinitePay),
**Marcar como enviado** ou **Cancelar**. Pedidos de cartão são registrados antes do redirecionamento e ficam
"Aguardando pagamento" até essa confirmação manual (não há webhook da InfinitePay configurado).

## Oferta

`OFFER_START` / `OFFER_END` (padrão 19/11/2026 00:00 a 26/11/2026 23:59, horário de Brasília). Fora do período o servidor
recusa novos pedidos, remove QR/código PIX do checkout, bloqueia `/assets/pix-qrcode.jpeg` e não redireciona para o cartão.
