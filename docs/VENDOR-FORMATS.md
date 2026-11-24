# Soundvision and ArrayCalc interchange

BTR reads and writes project files for **L-Acoustics Soundvision** (`.xmlc`) and
**d&b ArrayCalc** (`.dbpr`). Writing is in `File → Export to`; reading is just
`File → Open…`, which routes by file extension.

Neither format is documented publicly; both were reverse-engineered, and the
findings are reproduced here so nobody has to redo that work. Read
[the verification status](#verification-status) before trusting output on a show.

---

## What crosses over

Import and export share one neutral model, one set of coordinate transforms and one
delay convention, so the table below reads in both directions.

## What gets written

| | Soundvision | ArrayCalc |
|---|---|---|
| Position X/Y/Z | ✅ | ✅ |
| Horizontal aiming (yaw) | ✅ | ✅ |
| Level | ✅ | ✅ |
| Delay | ✅ | ✅ |
| Polarity inversion | ✅ (probable) | ❌ no such column |
| Mute | ❌ | ✅ |
| Pitch / roll | ❌ | ❌ |
| Group common delay | baked into each cluster | `SourceGroups.RelativeDelay` |

Everything BTR cannot express in a target is reported in the export dialog
*before* the file is written. Nothing is dropped silently.

---

## Coordinates

The neutral model is **defined as** the Soundvision world frame, so the Soundvision
adapter is an identity transform and only ArrayCalc converts. BTR already uses the
same axis roles, so BTR → neutral is also identity.

```
BTR / Soundvision      +x lateral    +y depth (into the audience)   +z up
ArrayCalc              OriginX depth   OriginY lateral (negated)     OriginZ up
```

```
OriginX =  y            depth
OriginY = -x            lateral      CONFIRMED
OriginZ =  z            height       CONFIRMED
HorizontalAngle = -yaw               CONFIRMED
```

Confirmed against a golden pair — the same four-sub array saved from both
applications — with both signs:

| ArrayCalc Y | Soundvision X | ArrayCalc Horiz | Soundvision azimuth |
|---:|---:|---:|---:|
| +15 | −15 | +40° | −40° |
| +5 | −5 | 0° | 0° |
| −5 | +5 | 0° | 0° |
| −15 | +15 | −40° | +40° |

**The one soft spot is the depth axis.** Every source in every reference file sits at
depth 0, so `y ↔ OriginX` was never exercised — neither the pairing nor its sign is
measured. Exporting sources at different depths raises a warning for exactly this
reason. To settle it: place one cabinet at depth +2 m in Soundvision, export, and read
`position[1]`.

Angles are degrees in both applications, stored 1:1 with the UI including sign, and
are never normalised to 0…360.

---

## Delay

This is the part that is easy to get wrong.

`CabinetsAdditionalData.Delay` in a `.dbpr` is **not** the delay an operator types. It
is the UI's **Total dly.** column, in **seconds**:

```
Delay_stored_s = (design_delay_ms + SourceGroups.RelativeDelay_ms) / 1000
```

BTR's module offset (a group's delay offset) maps exactly onto
`SourceGroups.RelativeDelay`, so the two tools agree column for column:

| BTR | ArrayCalc |
|---|---|
| source delay | **Delay** column |
| group delay offset | **Delay (rel.)** |
| Total dly. in the array table | **Total dly.** |

Soundvision has no group delay, so the offset is folded into every cluster's own
delay. Both routes therefore produce the same acoustic result, and a test asserts the
two files describe the same array.

---

## Cabinet substitution

Neither target accepts an arbitrary model string:

- Soundvision resolves `<model>` + `<preset>` against its own device library.
- ArrayCalc resolves `Cabinets.SpeakerId` against a loudspeaker database that is **not
  in the project file**, so a wrong id cannot be detected by any tool on our side.

So BTR maps every cabinet onto a device the target is known to accept, and reports
what it changed:

| BTR model | → Soundvision | → ArrayCalc |
|---|---|---|
| L-Acoustics KS28 (and cardioid) | **KS28** ✅ verified | B2-SUB (substituted) |
| L-Acoustics KS21 / SB18 | KS28, or the native name on request | B2-SUB (substituted) |
| d&b SL-SUB | KS28 (substituted) | **SL-SUB** ✅ verified (`SpeakerId 114`) |
| everything else | KS28 (substituted) | B2-SUB (`SpeakerId 24`) |

**Why KS28 for everything by default.** Every Soundvision reference file we have
contains only `KS28` / `KS28_60`. No other preset string has ever been observed, so
writing `KS21` means also inventing `KS21_60`. That is a guess in two places, and this
project does not ship guesses by default — so it is behind an opt-in checkbox,
labelled as unverified, and off unless you tick it.

Adding a verified device later is one entry in `src/io/vendor/deviceMap.ts`: for
Soundvision the model and preset strings from a real export, for ArrayCalc the
`SpeakerId` read out of a saved project. **Do not guess an id.**

---

## How the files are built

Neither writer serialises from scratch — both do **template surgery** on a real
vendor file, replacing only what depends on the source list and preserving everything
else byte for byte.

### Soundvision `.xmlc`

```
BTR → neutral model → validate → template surgery → AES-256-CBC → self-check
```

- **Container**: AES-256-CBC, PKCS#7, no header, no compression.
- **The key is not in this repository.** Soundvision encrypts its files with a key
  that belongs to L-Acoustics, so it is not published here. The codec reads it at
  build time from two variables, normally kept in an untracked `.env.local` next to
  `package.json` (the `*.local` pattern is in `.gitignore`):

  ```
  VITE_SV_XMLC_KEY=<32 characters>
  VITE_SV_XMLC_IV=<16 characters>
  ```

  A build without them works in full except for Soundvision `.xmlc`: the export
  dialog says why it cannot write one, opening an encrypted `.xmlc` says the same,
  and a plaintext Soundvision `.xml` still imports. The ArrayCalc side needs no key.
  The tests that need the key are skipped without it and run with it.
- **The trap**: the key and IV *look* like hex and are not. Soundvision passes the
  ASCII characters straight to the cipher, so the 32-character key string **is** the
  32-byte key. Hex-decoding gives a 16-byte key and silently wrong output.
- **The second trap**: inside a `<cluster>`, every `<enclosure>` carries its own
  zero-filled `<acoustics>` block *before* the cluster-level one. Anchor on
  `<source_usage>` to find the real delay/gain — a lazy regex finds the wrong block.
- A cluster carries ~2 KB of DSP defaults per enclosure plus document-level machinery
  (`source_linkage`, `amplification`, `autofilter_results`, `version`). None of it is
  derivable from a source list, so it is preserved from the template.
- The exporter decrypts its own output and compares before handing you the file.

### ArrayCalc `.dbpr`

A `.dbpr` is a plain SQLite 3 database — no encryption, no checksum — shared by
ArrayCalc **and** R1. It holds 53 tables, most of which have nothing to do with
loudspeakers.

What makes row surgery safe, measured rather than assumed:

- sub cabinets have `DeviceId = 0` and `AmplifierChannel = 0`, i.e. they are not
  patched to amplifiers, so no amp or patch table has to change;
- every other table with a `CabinetId` column is empty in the reference projects, so
  there are no dangling references;
- `TableVersions` and the schema come from a genuine project and are untouched.

The writer deletes the template's SUBS cabinets, inserts one `Cabinets` +
`CabinetsAdditionalData` row per source, updates the group and project name, and runs
`PRAGMA integrity_check` before returning. A generated file differs from the template
by roughly 350 bytes.

SQLite runs as WebAssembly (`sql.js`), loaded lazily together with the template, so
neither is in the main bundle until you actually export.

---

## Importing

`File → Open…` accepts `.xmlc`, `.dbpr` and BTR's own `.json`. A vendor file opens a
picker rather than loading blind, because a vendor project usually holds more than a
sub array — the reference ArrayCalc project has a SUBS group *and* an "Unused
channels" group with 16 non-sub cabinets.

The picker lists every group with its cabinet type, count and relative delay, and
pre-ticks the ones that look like subwoofers. That hint comes from
`SourceGroupsAdditionalData.System = 'SUBs'` or group `Type = 3` — and ArrayCalc's
Type values are a hypothesis, not documented semantics, so **nothing is filtered out
on your behalf**. You decide; the app only suggests.

### What comes back

| | Soundvision | ArrayCalc |
|---|---|---|
| Position, aiming, level | ✅ | ✅ |
| Delay | ✅ (as stored) | ✅ design delay recovered from the total |
| Group relative delay | — (no such field) | ✅ becomes a BTR module offset |
| Polarity | ✅ | — |
| Mute | — | ✅ |
| Acoustic data | never — BTR always simulates with its own models | |

**Delay, in reverse.** `CabinetsAdditionalData.Delay` is the **Total dly.** column in
seconds, so the design delay is `stored × 1000 − RelativeDelay`. ArrayCalc stores that
total with float noise — the reference project holds `16.998053` ms for a delay the
operator set as 12.4 — so the recovered value is rounded to ArrayCalc's 0.1 ms UI
resolution. If a file ever carries genuinely finer precision, the importer says so
rather than discarding it quietly.

**Soundvision stacks.** A cluster stores ONE ground position for the whole stack and
Soundvision derives the vertical spacing itself, so per-box height is not in the file.
A multi-enclosure cluster is rebuilt using the cabinet height, and the importer warns
every time it does so. ArrayCalc needs none of this — it stores a real Z per cabinet.

### Cabinets BTR does not stock

A vendor model with no BTR equivalent is **not** given invented dimensions. It becomes
a project-local placeholder with `dimensions: null`, quality **D**, and an omni model.
The app already draws an unknown-size cabinet at a nominal footprint with a visible
"dimensions unknown" note, and the Inspector lets you swap in a library cabinet to get
real geometry.

This matters more than it sounds: a guessed cabinet width silently corrupts array
pitch, and array pitch is what the whole prediction rests on.

Known models map back as you would expect — KS28/KS21/SB18 to their L-Acoustics
entries, SL-SUB/KSL-SUB/J-SUB/V-SUB/B22-SUB to their d&b entries. `SB28` maps to KS28
as the closest stocked cabinet and says so.

### Round-trip behaviour

Neither format is a superset of BTR, so a round trip is lossy in specific, documented
ways:

| Route | What survives | What changes |
|---|---|---|
| BTR → ArrayCalc → BTR | geometry, aiming, level, design delay **and** the module offset | polarity is lost; cabinets become B2-SUB placeholders |
| BTR → Soundvision → BTR | geometry, aiming, level, polarity, **total** delay | the module offset arrives folded into each source, not as a group |

Both are asserted by tests, so the losses stay exactly this size.

---

## Verification status

**Read this before relying on either exporter.**

| | Status |
|---|---|
| `.xmlc` cipher | **Settled.** Byte-exact round-trip against real Soundvision files. A test decrypts a genuine export and asserts it equals the shipped template. |
| `.xmlc` structure | Matches a real Soundvision export field for field — positions, orientations, delay, gain, models, presets. |
| `.xmlc` opens in Soundvision | **Confirmed** in Soundvision 2026.3.1: positions, axes, enclosure order and cardioid stacks open as exported. |
| `.dbpr` structure | Valid SQLite, passes `integrity_check`, preserves schema and table versions, reads back with the expected geometry. Matches the reference vector row for row. |
| `.dbpr` opens in ArrayCalc | **NOT VERIFIED.** No copy of ArrayCalc was available. |
| Reading a real `.xmlc` | **Confirmed.** A genuine encrypted Soundvision export imports with the right geometry, delay and stack structure. |
| Reading a real `.dbpr` | **Confirmed.** A genuine ArrayCalc project imports with the right geometry, recovered design delays and group offset. |
| Depth axis (`y`) | **Unverified sign** — see [Coordinates](#coordinates). |
| Soundvision `<inverted>` | The field exists and is 0 in every reference; that writing 1 inverts polarity is probable, not confirmed. |
| Reversed / cardioid cabinets | Expressed as a 180° yaw. Works by construction, but no reference file contains a reversed box, so ArrayCalc's own encoding is unconfirmed. |

Known remaining risks on the ArrayCalc side: it may validate `SpeakerId` against its
loudspeaker database and reject or silently replace an unknown one; it may expect
`CabinetsPerPosition` and the `Previous/NextObjectString` chain to be self-consistent
for multi-box stacks (BTR writes one cabinet per position, so the chain is trivially
consistent but untested at scale); it may recompute delays on open.

**The single highest-value next step is to open a generated file in each application.**
That needs nothing but a laptop with the software.

---

## Tests

`src/io/vendor/vendor.test.ts` covers the transforms, device mapping, validation and
both writers, including the exact golden-project values.

`src/io/vendor/vendorImport.test.ts` covers both readers against real vendor files,
the scene-to-project conversion, and both round trips.

`src/io/vendor/vendorFixtures.test.ts` is the one with external ground truth: it
decrypts a genuine Soundvision export and asserts it equals the shipped template, and
compares our generated XML against the reference exporter's expected output field for
field. If the codec, the transform or the template ever drift, that test fails.

### One trap worth keeping in mind

Deciding whether an `.xmlc` is encrypted must be a strict **prefix** check. An early
version of the importer asked whether the first 64 bytes merely *contained* a `<`,
which is true for roughly one encrypted file in five — 0x3C turns up in random
ciphertext — and those files skipped decryption entirely and failed with a misleading
message. There is a regression test for it.
