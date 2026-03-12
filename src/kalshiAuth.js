const crypto = require('crypto');
const fs = require('fs');

function loadPrivateKey({ privateKeyPath, privateKeyPem }) {
  if (privateKeyPem) return privateKeyPem;
  if (!privateKeyPath) {
    throw new Error('Missing private key. Set KALSHI_PRIVATE_KEY_PATH or KALSHI_PRIVATE_KEY_PEM.');
  }
  return fs.readFileSync(privateKeyPath, 'utf8');
}

function signRequest({ method, path, timestampMs, privateKey }) {
  const message = `${timestampMs}${method.toUpperCase()}${path}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(message);
  signer.end();

  return signer.sign(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    },
    'base64',
  );
}

module.exports = { loadPrivateKey, signRequest };
