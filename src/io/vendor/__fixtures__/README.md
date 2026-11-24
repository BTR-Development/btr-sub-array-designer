# Vendor reference vectors

Ground truth for the foreign-format exporters, taken from the FORMAT_HANDOFF package.
These are read by `vendorFixtures.test.ts` only — never imported by application code,
so they are not in the shipped bundle.

| File | What it is |
|---|---|
| `G01_target_4pcs.xmlc` | a real, encrypted Soundvision export of four KS28 |
| `TV1_expected.xmlc` | the handoff's expected exporter output for its reference project |
| `TV1_expected_plaintext.xml` | the decrypted form of the above |

`src/io/vendor/templates/soundvision-template.xml` is the decrypted `G01_target_4pcs.xmlc`;
the test asserts that relationship, so the template cannot drift from the real file.

The ArrayCalc side has no fixture here: its expected values are small enough to assert
inline in `vendor.test.ts`, and they match `ARRAYCALC/TEST_VECTORS/TV1_expected.dbpr`
row for row.
