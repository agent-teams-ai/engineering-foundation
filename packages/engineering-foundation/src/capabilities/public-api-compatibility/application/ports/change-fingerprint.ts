export interface ChangeFingerprint {
  sha256(value: string | Uint8Array): string;
  sha512Integrity?(value: string): string;
}
