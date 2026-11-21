import { generateKeyPairSync } from "node:crypto"

/**
 * A new RSA private key in PEM, made at run time, so that no secret scanner
 * of a Git host finds a key in a test file.
 */
export function madeUpPrivateKey(bits: 2048 | 4096): string {
  return generateKeyPairSync("rsa", { modulusLength: bits })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString()
    .trim()
}
