/**
 * Branding is centralised so the product name can be swapped in one place.
 */
export const BRANDING = {
  companyName: 'BTR Solutions',
  author: 'Karol Bernacki',
  /** feature requests and general contact with the author */
  contactEmail: 'karol@btr-poland.com',
  productName: 'BTR Sub Array Designer',
  shortName: 'BTR',
  tagline: '2D subwoofer array design & wave-based prediction',
  formatId: 'btr-sub-array',
  /**
   * 2 marks a file written after the group-yaw sign was corrected. A v1 file
   * with a rotated group resolves to different positions in this build, so the
   * version is what lets the reader say so instead of moving the array in
   * silence. See legacyYawNotice in io/btrJson.ts.
   */
  formatVersion: 2,
  fileExtension: '.btrsub',
} as const;
