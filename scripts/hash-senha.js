'use strict';
// Gera o valor de ADMIN_PASSWORD_HASH para uma nova senha do admin.
//   npm run hash-senha -- "nova senha"
const crypto = require('node:crypto');
const password = process.argv[2];
if (!password) { console.error('Uso: npm run hash-senha -- "nova senha"'); process.exit(1); }
const salt = crypto.randomBytes(16).toString('hex');
console.log('scrypt$' + salt + '$' + crypto.scryptSync(password, salt, 64).toString('hex'));
