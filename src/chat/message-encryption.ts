import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
@Injectable()
export class MessageEncryption {
  private readonly key: Buffer;
  constructor(config: ConfigService) {
    this.key = Buffer.from(
      config.getOrThrow<string>('CHAT_ENCRYPTION_KEY'),
      'utf8',
    );
  }
  encrypt(text: string) {
    // Dart encrypt.AES defaults to SIC (CTR) with PKCS7 padding.
    const iv = randomBytes(16),
      input = Buffer.from(text, 'utf8');
    const padding = 16 - (input.length % 16);
    const cipher = createCipheriv('aes-256-ctr', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.concat([input, Buffer.alloc(padding, padding)])),
      cipher.final(),
    ]);
    return `${iv.toString('base64')}:${ciphertext.toString('base64')}`;
  }
  decrypt(value: string) {
    const parts = value.split(':');
    if (parts.length !== 2) return value;
    try {
      const iv = Buffer.from(parts[0], 'base64');
      const cipher = createDecipheriv('aes-256-ctr', this.key, iv);
      const plaintext = Buffer.concat([
        cipher.update(Buffer.from(parts[1], 'base64')),
        cipher.final(),
      ]);
      const padding = plaintext.at(-1)!;
      if (
        !padding ||
        padding > 16 ||
        !plaintext.subarray(-padding).every((b) => b === padding)
      )
        throw new Error();
      return plaintext.subarray(0, -padding).toString('utf8');
    } catch {
      return 'Erreur lors du déchiffrement';
    }
  }
}
