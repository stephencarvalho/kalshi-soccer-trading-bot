const crypto = require('crypto');

const { getSupabaseServerClient, isSupabaseAuthConfigured } = require('./supabaseAuth');

const USER_CREDENTIALS_TABLE = 'user_credentials';
const CURRENT_KEY_VERSION = 1;

function decodeEncryptionKey(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;

  if (/^[a-f0-9]{64}$/i.test(normalized)) {
    return Buffer.from(normalized, 'hex');
  }

  try {
    const decoded = Buffer.from(normalized, 'base64');
    if (decoded.length === 32) return decoded;
  } catch {
    return null;
  }

  return null;
}

function getPemEncryptionKey() {
  return decodeEncryptionKey(process.env.PEM_ENCRYPTION_KEY);
}

function isCredentialStorageConfigured() {
  return Boolean(isSupabaseAuthConfigured() && getPemEncryptionKey());
}

function getCredentialsTable() {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    throw new Error('Supabase auth is not configured for credential storage.');
  }

  return supabase.from(USER_CREDENTIALS_TABLE);
}

function normalizePrivateKeyPem(value) {
  return `${String(value || '').replace(/\r\n/g, '\n').trim()}\n`;
}

function validatePrivateKeyPem(privateKeyPem) {
  const normalized = normalizePrivateKeyPem(privateKeyPem);
  try {
    crypto.createPrivateKey({
      key: normalized,
      format: 'pem',
    });
  } catch {
    throw new Error('Uploaded file is not a valid PEM private key.');
  }
  return normalized;
}

function encryptPrivateKeyPem(privateKeyPem) {
  const key = getPemEncryptionKey();
  if (!key) {
    throw new Error('PEM_ENCRYPTION_KEY must be a 32-byte base64 or 64-char hex value.');
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKeyPem, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    pem_ciphertext: ciphertext.toString('base64'),
    pem_iv: iv.toString('base64'),
    pem_auth_tag: authTag.toString('base64'),
    pem_key_version: CURRENT_KEY_VERSION,
  };
}

function decryptPrivateKeyPem(record) {
  const key = getPemEncryptionKey();
  if (!key) {
    throw new Error('PEM_ENCRYPTION_KEY must be a 32-byte base64 or 64-char hex value.');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(String(record.pem_iv || ''), 'base64'),
  );
  decipher.setAuthTag(Buffer.from(String(record.pem_auth_tag || ''), 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(String(record.pem_ciphertext || ''), 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function maskKalshiApiKeyId(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length <= 8) return text;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

async function getCredentialRecordForUser(userId) {
  if (!isCredentialStorageConfigured()) return null;

  const { data, error } = await getCredentialsTable()
    .select(
      'user_id, kalshi_api_key_id, pem_file_name, pem_ciphertext, pem_iv, pem_auth_tag, pem_key_version, created_at, updated_at',
    )
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getCredentialStatusForUser(userId) {
  const record = await getCredentialRecordForUser(userId);
  return {
    configured: isCredentialStorageConfigured(),
    hasCredential: Boolean(record),
    kalshiApiKeyIdMasked: record ? maskKalshiApiKeyId(record.kalshi_api_key_id) : null,
    pemFileName: record?.pem_file_name || null,
    createdAt: record?.created_at || null,
    updatedAt: record?.updated_at || null,
    keyVersion: record?.pem_key_version || null,
  };
}

async function getKalshiCredentialsForUser(userId) {
  const record = await getCredentialRecordForUser(userId);
  if (!record) return null;

  return {
    keyId: String(record.kalshi_api_key_id || '').trim(),
    privateKeyPem: decryptPrivateKeyPem(record),
    updatedAt: record.updated_at || null,
  };
}

async function saveCredentialForUser({ userId, kalshiApiKeyId, privateKeyPem, pemFileName }) {
  if (!isCredentialStorageConfigured()) {
    throw new Error('Credential storage is not configured. Set Supabase env vars and PEM_ENCRYPTION_KEY.');
  }

  const normalizedKeyId = String(kalshiApiKeyId || '').trim();
  if (!normalizedKeyId) {
    throw new Error('Kalshi API key ID is required.');
  }

  const normalizedFileName = String(pemFileName || '').trim();
  if (!normalizedFileName) {
    throw new Error('PEM file name is required.');
  }

  const normalizedPem = validatePrivateKeyPem(privateKeyPem);
  const encrypted = encryptPrivateKeyPem(normalizedPem);
  const payload = {
    user_id: userId,
    kalshi_api_key_id: normalizedKeyId,
    pem_file_name: normalizedFileName,
    ...encrypted,
    updated_at: new Date().toISOString(),
  };

  const { error } = await getCredentialsTable().upsert(payload, {
    onConflict: 'user_id',
  });

  if (error) throw error;
  return getCredentialStatusForUser(userId);
}

async function deleteCredentialForUser(userId) {
  if (!isCredentialStorageConfigured()) {
    return {
      configured: false,
      hasCredential: false,
      kalshiApiKeyIdMasked: null,
      pemFileName: null,
      createdAt: null,
      updatedAt: null,
      keyVersion: null,
    };
  }

  const { error } = await getCredentialsTable().delete().eq('user_id', userId);
  if (error) throw error;

  return {
    configured: true,
    hasCredential: false,
    kalshiApiKeyIdMasked: null,
    pemFileName: null,
    createdAt: null,
    updatedAt: null,
    keyVersion: null,
  };
}

module.exports = {
  CURRENT_KEY_VERSION,
  USER_CREDENTIALS_TABLE,
  deleteCredentialForUser,
  getCredentialStatusForUser,
  getKalshiCredentialsForUser,
  getPemEncryptionKey,
  isCredentialStorageConfigured,
  saveCredentialForUser,
  validatePrivateKeyPem,
};
