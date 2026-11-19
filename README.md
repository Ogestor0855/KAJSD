# GTA IV CLIP LUCRO — página de vendas + checkout PIX

Node.js 22+ sem dependências externas.

```
cp .env.example .env      # preencha PAYMENT_WEBHOOK_SECRET
npm start                 # http://localhost:3000
```

Rotas: `/` (vendas) → `/checkout` → `/obrigado?pedido=<id>`.
Cartão de crédito: `/pagar/cartao` redireciona para `INFINITEPAY_CHECKOUT_URL` (o pagamento e a entrega por cartão acontecem na InfinitePay, fora deste sistema de pedidos).

## Antes de publicar

1. Coloque o PDF do produto em `private/gta-iv-clip-lucro.pdf` (ou ajuste `PRODUCT_PDF_PATH`).
   Essa pasta **não** é servida publicamente; o arquivo só sai por `/api/download/<token>` para pedidos `paid`.
2. Defina `PAYMENT_WEBHOOK_SECRET` no `.env` (ou nas variáveis da hospedagem).
3. Hospede em um serviço que rode Node com disco persistente (VPS, Railway, Render com disk etc.).
   Os pedidos ficam em `data/orders.json` — contém dados pessoais, não versione nem exponha.

## Status do pedido

`pending` → `paid` | `failed` | `expired` (pendentes expiram após 24 h).
O botão "Já fiz o pagamento" só cria o pedido como `pending`. Nada no navegador marca como pago.

## Confirmação de pagamento

O QR Code e o código PIX são **estáticos** (mesmo código para todos os compradores), então o banco
não consegue avisar automaticamente qual pedido foi pago. Hoje a confirmação é manual:

```
npm run confirmar                     # lista pedidos pending (nome, e-mail, WhatsApp)
npm run confirmar -- <orderId>        # após conferir o PIX no app do banco → paid
npm run confirmar -- <orderId> failed # recusa
```

Para confirmação automática, integre um gateway que gere uma cobrança PIX por pedido e envie
webhook. O endpoint já existe:

`POST /api/payment/webhook`
- corpo: `{ "orderId": "...", "status": "paid" | "failed" | "expired", "paymentId": "...", "amount": 27.5 }`
- header `X-Webhook-Signature`: HMAC-SHA256 do corpo bruto com `PAYMENT_WEBHOOK_SECRET`, em hex.

Cada gateway tem formato próprio de webhook/assinatura: adapte a função `paymentWebhook` em
`server.js` quando escolher o provedor.

## Admin (`/admin`)

Login em `/admin/login`. A senha fica no servidor apenas como hash scrypt (`server.js`), nunca no HTML/JS.
Para trocar: `npm run hash-senha -- "nova senha"` e defina `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` no ambiente.
Sessão em memória (12 h, cookie HttpOnly + SameSite=Strict; `Secure` com `NODE_ENV=production`): reiniciar o servidor exige novo login.

Na dashboard o admin vê pedidos e clientes, e em cada pedido pode **Confirmar pagamento** (após conferir no banco/InfinitePay),
**Marcar como enviado** ou **Cancelar**. Pedidos de cartão são registrados antes do redirecionamento e ficam
"Aguardando pagamento" até essa confirmação manual (não há webhook da InfinitePay configurado).

## Oferta

`OFFER_START` / `OFFER_END` (padrão 19/11/2026 00:00 a 26/11/2026 23:59, horário de Brasília). Fora do período o servidor
recusa novos pedidos, remove QR/código PIX do checkout, bloqueia `/assets/pix-qrcode.jpeg` e não redireciona para o cartão.
