'use strict';
// Monta dist/ com apenas os arquivos públicos do site (o Cloudflare Pages publica essa pasta).
// Código do backend (functions/), scripts, migrations e private/ nunca entram em dist/.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const PUBLIC = ['index.html', 'checkout.html', 'obrigado.html', 'admin', 'assets'];

fs.rmSync(OUT, { recursive: true, force: true });
for (const item of PUBLIC) {
  fs.cpSync(path.join(ROOT, item), path.join(OUT, item), { recursive: true });
}
console.log('dist/ gerado:', PUBLIC.join(', '));
