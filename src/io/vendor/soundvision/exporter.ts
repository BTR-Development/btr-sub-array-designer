/**
 * BTR project -> L-Acoustics Soundvision `.xmlc`.
 *
 * Pipeline:  BTR -> neutral model -> validate -> template surgery -> AES encrypt
 *            -> self-check (decrypt our own output and compare)
 *
 * The template and the codec are loaded lazily, so nothing here is in the main
 * bundle until someone actually exports.
 */

import type { BTRProject } from '../../../core/types';
import type { SpeakerDataProvider } from '../../../speakers/provider';
import { toVendorModel, validateForTarget } from '../internalModel';
import { soundvisionDeviceFor } from '../deviceMap';
import { safeFilename, type VendorExporter, type VendorExportOptions } from '../types';
import { XMLC_UNAVAILABLE, xmlcCodecAvailable } from './xmlcCodec';

export const soundvisionExporter: VendorExporter = {
  id: 'soundvision-xmlc',
  label: 'L-Acoustics Soundvision',
  target: 'soundvision',
  extension: '.xmlc',
  mimeType: 'application/octet-stream',
  application: 'Soundvision',
  verificationNote: 'exp.noteSoundvision',

  describe(project, provider, options) {
    const model = toVendorModel(project, provider);
    const d = validateForTarget(model, 'soundvision', options?.nativeModels);
    return xmlcCodecAvailable() ? d : { ...d, errors: [XMLC_UNAVAILABLE, ...d.errors] };
  },

  async export(project: BTRProject, provider: SpeakerDataProvider, options?: VendorExportOptions) {
    const model = toVendorModel(project, provider);
    const diagnostics = validateForTarget(model, 'soundvision', options?.nativeModels);
    if (diagnostics.errors.length) {
      throw new Error(`Cannot export to Soundvision:\n  ${diagnostics.errors.join('\n  ')}`);
    }

    if (!xmlcCodecAvailable()) throw new Error(XMLC_UNAVAILABLE);

    const [{ buildSvDocument, writeSoundvisionXml }, { encryptXmlc, decryptXmlc }, templateMod] =
      await Promise.all([
        import('./writer'),
        import('./xmlcCodec'),
        import('../templates/soundvision-template.xml?raw'),
      ]);

    const doc = buildSvDocument(
      model.sources,
      model.groupName,
      (s) => soundvisionDeviceFor(s.btrSpeakerId, options?.nativeModels).device,
      // Soundvision has no group delay, so fold the module offset into every cluster
      model.groupRelativeDelayMs,
    );

    const xml = writeSoundvisionXml(doc, templateMod.default);
    const ciphertext = await encryptXmlc(xml);

    // Self-check: our own ciphertext must decrypt back to exactly what we serialised.
    const back = await decryptXmlc(ciphertext.buffer as ArrayBuffer);
    if (back !== xml) throw new Error('Soundvision export self-check failed: the file does not round-trip.');

    return {
      blob: new Blob([ciphertext as BlobPart], { type: this.mimeType }),
      filename: safeFilename(project.project.name, this.extension),
      diagnostics,
    };
  },
};
