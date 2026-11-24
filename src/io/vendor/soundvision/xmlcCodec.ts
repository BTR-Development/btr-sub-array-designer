/**
 * Soundvision `.xmlc` codec: AES-256-CBC, PKCS#7.
 *
 * Soundvision encrypts its project files. This repository does NOT contain the
 * key: it is read at build time from two environment variables, normally kept
 * in an untracked `.env.local` next to package.json:
 *
 *   VITE_SV_XMLC_KEY=<32 characters>
 *   VITE_SV_XMLC_IV=<16 characters>
 *
 * The characters LOOK like hex and are not: Soundvision passes the ASCII
 * characters straight to the cipher, so the 32-character key string IS the
 * 32-byte AES-256 key. Hex-decoding them produces a 16-byte key and silently
 * wrong output.
 *
 * Without the key the program still builds and runs; writing a .xmlc and
 * reading an encrypted one say why they cannot, and a plaintext Soundvision
 * .xml still imports. See docs/VENDOR-FORMATS.md.
 */

const KEY_ASCII: string = import.meta.env.VITE_SV_XMLC_KEY ?? '';
const IV_ASCII: string = import.meta.env.VITE_SV_XMLC_IV ?? '';

const enc = new TextEncoder();

/** True when this build was given the Soundvision key and IV. */
export function xmlcCodecAvailable(): boolean {
  return KEY_ASCII.length === 32 && IV_ASCII.length === 16;
}

export const XMLC_UNAVAILABLE =
  'This build has no Soundvision codec key, so it cannot write or open encrypted .xmlc files. ' +
  'A plaintext Soundvision .xml still imports. To build with the key, see docs/VENDOR-FORMATS.md.';

async function importKey(usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (!xmlcCodecAvailable()) throw new Error(XMLC_UNAVAILABLE);
  return crypto.subtle.importKey('raw', enc.encode(KEY_ASCII), { name: 'AES-CBC' }, false, [usage]);
}

export async function encryptXmlc(plaintext: string): Promise<Uint8Array> {
  const key = await importKey('encrypt');
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: enc.encode(IV_ASCII) },
    key,
    enc.encode(plaintext),
  );
  return new Uint8Array(ct);
}

export async function decryptXmlc(ciphertext: BufferSource): Promise<string> {
  const key = await importKey('decrypt');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: enc.encode(IV_ASCII) },
    key,
    ciphertext,
  );
  return new TextDecoder('utf-8').decode(pt);
}
