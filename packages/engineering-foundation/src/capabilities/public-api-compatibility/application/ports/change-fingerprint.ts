export interface ChangeFingerprint {
  sha256(value: string): string;
  sha512Integrity?(value: string): string;
}
