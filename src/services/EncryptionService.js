import crypto from 'crypto';

class EncryptionService {
  constructor() {
    // Generate or load encryption key from environment
    this.algorithm = 'aes-256-gcm';
    this.keyLength = 32; // 256 bits
    this.ivLength = 16; // 128 bits
    this.tagLength = 16; // 128 bits
    this.saltLength = 64; // 512 bits
    
    // Load or generate master key
    this.masterKey = this.loadOrGenerateMasterKey();
  }

  /**
   * Load master key from environment or generate new one
   */
  loadOrGenerateMasterKey() {
    if (process.env.ENCRYPTION_MASTER_KEY) {
      const key = Buffer.from(process.env.ENCRYPTION_MASTER_KEY, 'hex');
      if (key.length !== this.keyLength) {
        throw new Error(`Invalid master key length. Expected ${this.keyLength} bytes`);
      }
      return key;
    }
    
    // Generate new key if not provided
    const newKey = crypto.randomBytes(this.keyLength);
    console.warn('⚠️  Generated new encryption key. Set ENCRYPTION_MASTER_KEY env variable:');
    console.warn(`ENCRYPTION_MASTER_KEY=${newKey.toString('hex')}`);
    return newKey;
  }

  /**
   * Derive a key from master key using PBKDF2
   */
  deriveKey(salt, iterations = 100000) {
    return crypto.pbkdf2Sync(this.masterKey, salt, iterations, this.keyLength, 'sha256');
  }

  /**
   * Encrypt data using AES-256-GCM
   */
  encrypt(data) {
    try {
      // Convert data to string if object
      const plaintext = typeof data === 'object' ? JSON.stringify(data) : String(data);
      
      // Generate random salt and IV
      const salt = crypto.randomBytes(this.saltLength);
      const iv = crypto.randomBytes(this.ivLength);
      
      // Derive key from master key
      const key = this.deriveKey(salt);
      
      // Create cipher
      const cipher = crypto.createCipheriv(this.algorithm, key, iv);
      
      // Encrypt data
      const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final()
      ]);
      
      // Get auth tag
      const authTag = cipher.getAuthTag();
      
      // Combine salt, iv, authTag, and encrypted data
      const combined = Buffer.concat([
        salt,
        iv,
        authTag,
        encrypted
      ]);
      
      // Return base64 encoded
      return combined.toString('base64');
    } catch (error) {
      console.error('Encryption error:', error);
      throw new Error('Failed to encrypt data');
    }
  }

  /**
   * Decrypt data using AES-256-GCM
   */
  decrypt(encryptedData) {
    try {
      // Decode from base64
      const combined = Buffer.from(encryptedData, 'base64');
      
      // Extract components
      const salt = combined.slice(0, this.saltLength);
      const iv = combined.slice(this.saltLength, this.saltLength + this.ivLength);
      const authTag = combined.slice(
        this.saltLength + this.ivLength,
        this.saltLength + this.ivLength + this.tagLength
      );
      const encrypted = combined.slice(this.saltLength + this.ivLength + this.tagLength);
      
      // Derive key from master key
      const key = this.deriveKey(salt);
      
      // Create decipher
      const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
      decipher.setAuthTag(authTag);
      
      // Decrypt data
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
      ]);
      
      // Try to parse as JSON, otherwise return as string
      const plaintext = decrypted.toString('utf8');
      try {
        return JSON.parse(plaintext);
      } catch {
        return plaintext;
      }
    } catch (error) {
      console.error('Decryption error:', error);
      throw new Error('Failed to decrypt data');
    }
  }

  /**
   * Encrypt session data for storage
   */
  encryptSessionData(sessionData) {
    // Remove sensitive client object before encryption
    const dataToEncrypt = {
      ...sessionData,
      client: undefined, // Don't encrypt the WhatsApp client object
      encryptedAt: new Date().toISOString()
    };
    
    return this.encrypt(dataToEncrypt);
  }

  /**
   * Decrypt session data from storage
   */
  decryptSessionData(encryptedData) {
    const decrypted = this.decrypt(encryptedData);
    return {
      ...decrypted,
      decryptedAt: new Date().toISOString()
    };
  }

  /**
   * Hash sensitive data (one-way)
   */
  hash(data) {
    const hash = crypto.createHash('sha256');
    hash.update(typeof data === 'object' ? JSON.stringify(data) : String(data));
    return hash.digest('hex');
  }

  /**
   * Generate secure random token
   */
  generateToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * Verify data integrity using HMAC
   */
  generateHMAC(data, key = this.masterKey) {
    const hmac = crypto.createHmac('sha256', key);
    hmac.update(typeof data === 'object' ? JSON.stringify(data) : String(data));
    return hmac.digest('hex');
  }

  /**
   * Verify HMAC
   */
  verifyHMAC(data, signature, key = this.masterKey) {
    const expectedSignature = this.generateHMAC(data, key);
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  }

  /**
   * Rotate encryption key
   */
  async rotateKey(oldKey, newKey) {
    // This would be used to re-encrypt all data with new key
    // Implementation depends on storage backend
    console.log('Key rotation initiated...');
    this.masterKey = Buffer.from(newKey, 'hex');
    return true;
  }

  /**
   * Get encryption metrics
   */
  getMetrics() {
    return {
      algorithm: this.algorithm,
      keyLength: this.keyLength * 8, // in bits
      ivLength: this.ivLength * 8,
      tagLength: this.tagLength * 8,
      saltLength: this.saltLength * 8,
      keyDerivation: 'PBKDF2-SHA256',
      iterations: 100000
    };
  }
}

// Export singleton instance
export default new EncryptionService();
