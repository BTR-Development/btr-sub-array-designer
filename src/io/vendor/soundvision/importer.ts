/**
 * L-Acoustics Soundvision `.xmlc` importer.
 *
 * Decrypt (AES-256-CBC, ASCII key/IV) then parse. Both are lazily loaded so the
 * codec and reader stay out of the main bundle.
 */

import { VendorReadError, type VendorImporter } from '../importTypes';

/** True only when the bytes actually begin an XML document (BOM and space tolerated). */
function isPlaintextXml(bytes: Uint8Array): boolean {
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3; // UTF-8 BOM
  while (i < bytes.length && bytes[i] <= 0x20) i++;
  const head = new TextDecoder('utf-8').decode(bytes.slice(i, i + 32));
  return head.startsWith('<?xml') || head.startsWith('<physical_configuration');
}

export const soundvisionImporter: VendorImporter = {
  id: 'soundvision-xmlc',
  label: 'L-Acoustics Soundvision',
  target: 'soundvision',
  extensions: ['.xmlc', '.xml'],
  application: 'Soundvision',

  canImport(file) {
    return /\.(xmlc|xml)$/i.test(file.name);
  },

  async read(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const [{ decryptXmlc, xmlcCodecAvailable, XMLC_UNAVAILABLE }, { readSoundvisionXml }] = await Promise.all([
      import('./xmlcCodec'),
      import('./reader'),
    ]);

    // A decrypted .xml export is already plaintext; a .xmlc is encrypted.
    //
    // The sniff must be a strict PREFIX check. Testing whether the head merely
    // *contains* '<' misfires on roughly one encrypted file in five, because 0x3C
    // turns up in random ciphertext — and the file then skips decryption entirely.
    let xml: string;
    if (isPlaintextXml(bytes)) {
      xml = new TextDecoder('utf-8').decode(bytes);
    } else {
      if (bytes.length === 0 || bytes.length % 16 !== 0) {
        throw new VendorReadError(
          `This is neither plain XML nor AES ciphertext: ${bytes.length} bytes is not a multiple of the 16-byte block size.`,
        );
      }
      if (!xmlcCodecAvailable()) throw new VendorReadError(XMLC_UNAVAILABLE);
      try {
        xml = await decryptXmlc(bytes.buffer as ArrayBuffer);
      } catch {
        throw new VendorReadError(
          'Could not decrypt this .xmlc. The key is confirmed for Soundvision build 3.19.1.2; ' +
            'the application ships more than one key pair, so a file from a different version ' +
            'may need a different one.',
        );
      }
    }
    return readSoundvisionXml(xml);
  },
};
