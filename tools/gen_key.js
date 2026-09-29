'use strict';

const crypto = require('crypto');

const pair = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' }
});
const spki = pair.publicKey;
const manifestKey = spki.toString('base64');
const digest = crypto.createHash('sha256').update(spki).digest('hex').slice(0, 32);
let extensionId = '';
for (const digit of digest) extensionId += String.fromCharCode(97 + parseInt(digit, 16));

console.log('"key": "' + manifestKey + '",');
console.log('Extension ID: ' + extensionId);
console.log('Redirect URL: https://' + extensionId + '.chromiumapp.org/');
