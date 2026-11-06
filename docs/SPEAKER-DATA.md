# Speaker data

## The rule

Every number in the library must be traceable to the manufacturer's own
published material. If a value cannot be confirmed, it is `null`.

`null` is a first-class, supported state: the UI draws an unknown-size cabinet at
a nominal footprint and says "dimensions unknown — drawn at a nominal size". That
is strictly better than a plausible-looking invented number, because an invented
width silently corrupts array pitch and therefore the whole prediction.

## What counts as published material

Either a **manufacturer datasheet (PDF)** or a **product page**. `sourceType`
records which of the two, and `sourcePage` the page a figure was read from.

The datasheet is preferred, for three reasons that matter in practice:

- it is **versioned**, so a citation stays meaningful, where a product page can
  change under its own URL without notice;
- it usually **states the basis** of a max-SPL figure — peak or continuous, half
  space or free field, which noise — and that basis is the difference between two
  numbers that look comparable and are not;
- it carries the **mechanical drawing**, which is where the W×H×D ordering can
  actually be checked rather than inferred from a spec line.

Two limits on this, and they are the whole reason the policy is written down:

1. **Record the facts, cite the document, never vendor the PDF.** A dimension or
   an SPL figure is a fact and is not the manufacturer's to license; their
   document, its text and its drawings are. No datasheet is committed to this
   repo, and no datasheet prose is copied into `note` — `note` holds the exact
   spec-line wording only so the reading can be re-checked.
2. **A datasheet does not raise the acoustic grade.** It gives geometry and
   published specs, not a directivity balloon, so a model sourced this way is
   still grade **C**. Grade describes the prediction data and nothing else. A
   test pins this.

   Where a datasheet does print polar plots, digitising them is a real route to
   grade **B** — but a printed polar is magnitude-only at a handful of
   frequencies, so it needs a stated assumption about phase before the engine can
   use it. That assumption has not been made, and is not made silently.

The rule that did NOT change: a figure nobody publishes stays `null`. Never
guess, never interpolate from a similar model, never round a drawing off a
photo.

## Two ways to add a model

### 1. Data-driven (preferred)

```bash
node scripts/add-speaker.mjs --template > my-sub.json
$EDITOR my-sub.json
node scripts/add-speaker.mjs my-sub.json
```

The record:

```json
{
  "id": "manufacturer-model-slug",
  "manufacturer": "Manufacturer",
  "model": "MODEL",
  "widthMm": 1340,
  "heightMm": 550,
  "depthMm": 719,
  "weightKg": 79,
  "type": "omnidirectional",
  "construction": "2 x 18\" bass reflex",
  "radiation": "standard or cardioid configuration",
  "maxSpl": 143,
  "minHz": 25,
  "maxHz": null,
  "cardioidVariant": true,
  "sourceUrl": "https://…/KS28-datasheet.pdf",
  "sourceType": "manufacturer-datasheet",
  "sourcePage": 2,
  "retrieved": "2026-08-17",
  "note": "Exact wording of the spec line the numbers came from."
}
```

`sourceType` is `manufacturer-datasheet` or `manufacturer-website` and defaults
to the latter; `sourcePage` is optional and only meaningful for a datasheet. The
Inspector labels the link by kind, so a reader can see at a glance whether a
figure came from a PDF or a web page — and the page number rides along.

The script rejects a record that has no `sourceUrl`, no ISO `retrieved` date,
a missing dimension key, an implausible millimetre value, an unrecognised
`sourceType`, or a duplicate `id` (unless `--force`). Nothing is written unless
every record passes.

Accepts a single object or an array. Records land in
[`src/speakers/extra.json`](../src/speakers/extra.json), sorted, and are
validated again at runtime by
[`loadExtra.ts`](../src/speakers/loadExtra.ts) — a bad record is skipped with a
console warning rather than breaking the app.

`cardioidVariant: true` additionally emits a `…-cardioid` twin using the
analytical gradient model, for cabinets whose manufacturer documents a
cardioid/directional operating mode.

**Field notes**

- `widthMm` / `heightMm` / `depthMm` are the **cabinet as it stands in the
  array**. Width is the axis that sets array pitch. Watch out: manufacturers list
  the three numbers in different orders — copy the raw wording into `note`.
- `maxSpl` is dB @ 1 m as published. Record the basis (peak / continuous / half
  space) in `note`; it is not comparable across brands.
- `type` is `omnidirectional | cardioid | infra | other`.

### 2. Hand-written (for models needing a custom prediction dataset)

Add to [`src/speakers/library.ts`](../src/speakers/library.ts) when the model
needs something the JSON pipeline cannot express — a bespoke element cluster, or
an imported balloon.

Curated entries take precedence over `extra.json` on an `id` clash, so a bulk
import cannot shadow a verified model.

## Data quality grades

| | Meaning | Ships today |
|---|---|---|
| **A** | Manufacturer prediction data (licensed import) | no |
| **B** | Verified directivity data | no |
| **C** | Analytical approximation | yes |
| **D** | Proxy model (custom cabinets) | yes |

The grade describes the **acoustic prediction data only**. Dimensions can be
fully verified on a grade-C model — and in this library they are.

A test in [`speakers.test.ts`](../src/speakers/speakers.test.ts) asserts that no
bundled model claims A or B. Raising a model to A/B requires attaching a real
`balloon` dataset through a licensed import path.

## Prediction datasets

Defined in [`schema.ts`](../src/speakers/schema.ts):

- **`omni`** — ideal point source.
- **`elements`** — radiating elements at real positions in the cabinet's local
  frame (`+X` right, `+Y` front, `+Z` up), each with gain, delay and polarity.
  The far field is their complex sum. `normaliseOnAxis` divides by the on-axis
  magnitude at each frequency, modelling processor EQ.
- **`balloon`** — magnitude and phase over `frequency × azimuth × elevation`,
  laid out as `index = (fi·nAz + ai)·nEl + ei`. Local azimuth 0° / elevation 0° is
  on axis. The engine slices it to the working frequency at prepare time and
  samples it bilinearly.

## Where a cabinet radiates from

```ts
acousticOrigin(model)   // local frame, relative to the position handle
```

The handle a user drags on the plan is the cabinet's **geometric centre** — that
is what the box is drawn around and what the hit test uses. The cabinet does not
radiate from there. `acousticOrigin` returns the front baffle, `y = depth/2`,
and the engine rotates that offset with the cabinet before computing any
distance.

This is not a refinement. A sub is omnidirectional, so its directivity is 1 in
every direction and a 180° rotation changes nothing about *how* it radiates —
only about *where from*. Treat the cabinet as a dimensionless point and that is
the only thing a rotation could have changed, so it becomes a no-op. The
textbook reverse stack — put one sub on another, turn the top one round, delay
it by `d/c`, invert it — then models two coincident sources, whose front and
rear levels are equal by symmetry at **every** delay. The front-to-back ratio
comes out as exactly 0.0 dB. The cardioid is not weak; it cannot exist.

With the origin on the baffle, two cabinets nose to tail are one cabinet depth
apart and the same experiment gives about 29 dB of rear rejection at 63 Hz with
`d/c` = 1.75 ms, plus roughly 2 dB of forward gain over a single box. Pinned by
[`cardioid.test.ts`](../src/engine/cardioid.test.ts), which also pins the 0.0 dB
failure so nobody can quietly take the offset out again.

The baffle is an **analytical** choice, in the same spirit as everything else
graded `C`. A real 21″ cone sits some way behind its baffle, so a reverse
stack's true acoustic spacing is a little under the cabinet depth. No
manufacturer publishes that recess, so BTR does not invent one: it uses the
convention that field delay figures are quoted against, and that
`analyticCardioidDataset` already assumed. A model with better data overrides it
with `acousticOriginM`. An unknown depth yields a zero offset, never a guess.

Two consequences worth knowing:

- When every cabinet faces the same way the offset is the same vector on all of
  them, so it cancels out of every path difference. Broadside, end-fire and
  steered arrays are unchanged.
- Anything that turns a cabinet — a cardioid pair, an arc — changes. A delay
  written against the distance between two crosses on the drawing is now wrong
  by one cabinet depth; delay against the distance between the two baffles.

### What the reverse stack actually buys

Two KS21 nose to tail, `d` = 0.601 m, delay `d/c` = 1.75 ms, polarity inverted,
measured 20 m in front and 20 m behind at 1.5 m:

| f | front | rear | front/back | vs one box | vs the same two boxes stacked in phase |
|---|---|---|---|---|---|
| 25 Hz | 106.5 | 82.5 | 24.0 dB | −5.6 dB | −11.6 dB |
| 40 Hz | 110.4 | 83.2 | 27.2 dB | −1.7 dB | −7.7 dB |
| 63 Hz | 113.9 | 84.7 | 29.3 dB | +1.8 dB | −4.2 dB |
| 100 Hz | 116.9 | 87.0 | 29.8 dB | +4.8 dB | −1.2 dB |
| 160 Hz | 117.9 | 90.2 | 27.7 dB | +5.8 dB | −0.2 dB |

The rejection holds across the whole sub band; what varies is the price. The
last column is the one that decides deployments: turning the second box round
costs about 12 dB at 25 Hz and about 4 dB at 63 Hz against simply stacking both
forward. That is the `2|sin(kd)|` gradient roll-off, not a modelling artefact,
and it is why `normaliseOnAxis` exists.

Stacking vertically is slightly worse than standing the pair side by side, and
for a reason that only shows up once cabinets have dimensions. Vertically, the
two acoustic origins differ in height as well as in depth, so the line joining
them is not the axis the `d/c` delay compensates: the null tilts off the rear
axis (deepest around 163° rather than 180°), the best delay drifts to about
1.83 ms, and 180° itself gets 29 dB instead of the 33 dB a side-by-side pair
reaches at the textbook 1.75 ms. Both are perfectly usable; the vertical stack
is simply not the geometry its own formula describes.

## The analytical cardioid

```ts
analyticCardioidDataset(depthM)
```

Front element at the origin; rear element at `(0, −d, 0)` with `d` = cabinet
depth, delayed by `d/c` and polarity inverted.

```
D(θ) = 1 − e^{−jkd(1 + cos θ)}
```

- rear (`cos θ = −1`): `D = 0` — a true null
- on axis (`cos θ = 1`): `|D| = 2|sin(kd)|` — the real gradient roll-off, which
  `normaliseOnAxis` flattens the way a cardioid preset's EQ does

This is a physical model, not a fixed "−15 dB behind" fudge. It is still an
approximation of any specific product and is always labelled as one.

### What the normalisation will not do

`2|sin(kd)|` does not only roll off; it climbs, peaks at `c/4d`, and then dives
through zero at `c/2d`. Dividing by it at every frequency therefore has a pole,
and the pole is not academic: on axis the numerator vanishes with it and the
quotient stays sane, but OFF axis it does not. `db-sl-sub` predicted **172.7 dB
at 20 m** — thirty above its own rating — at 176 Hz, which is one drag of the
frequency slider.

So the modelled EQ is bounded, in two ways that between them changed nothing
inside the working band:

- at most **12 dB** of boost, far above the 3 dB a 0.975 m cardioid asks for at
  20 Hz and the 11 dB a 0.4 m one does;
- **no boost at all above the first on-axis peak**, where the response is
  falling into the null for geometric reasons and lifting it would invent
  output the driver does not have. Above that point the factor shelves at the
  value it had reached, rather than snapping to unity.

Measured over 20–125 Hz against the old unbounded rule, the change is
**0.000000 dB for every cabinet in the library**.

Above the peak it is not zero, and that is the point. Three of the deeper
cabinets — `db-sl-sub`, `db-j-sub`, `db-ksl-sub` — now draw a 50–60 dB on-axis
notch between 176 and 190 Hz where they used to draw a flat line. **The notch
is what the two-element model says**, and the flat line was the EQ inventing up
to 60 dB to hide it. Neither is a real cabinet: a real cardioid preset is
band-limited and a real sub is not a pure gradient up there. Treat the analytic
cardioid as valid across the sub band and not above the first on-axis peak,
which `c/4d` puts at 88 Hz for a 0.975 m box and 162 Hz for a 0.53 m one.

## Custom cabinets and proxies

A user-defined cabinet never gets an invented pattern. [`proxy.ts`](../src/speakers/proxy.ts)
picks the closest verified model, ranked by:

1. `omnidirectional` vs `cardioid` — a hard gate
2. width (weighted highest: it sets array pitch)
3. height
4. depth
5. LF corner agreement, when both are known

The custom model keeps the **user's dimensions** for drawing and geometry. It is
graded **D**, and the UI shows "Prediction proxy: <maker> <model> / Acoustic
prediction is approximate."

What it borrows from the proxy is **directivity, never geometry**:

- a balloon is measured directivity and carries no dimensions, so it is borrowed
  as it stands;
- an **element dataset is geometry**. The rear element of a library cardioid sits
  one *proxy* depth behind the origin, so borrowing it wholesale placed a
  radiator where the user's cabinet does not reach — a 0.4 m deep box inherited
  the Meyer 750-LFC's 0.53 m separation, putting its rear element 0.13 m behind
  its own back baffle, along with the cardioid delay of a cabinet the user does
  not own. The gradient is rebuilt from the user's own depth instead, and the
  provenance says so rather than claiming the pattern was borrowed.

Nothing else of the proxy's transfers either. The proxy's **max SPL** used to be
inherited when the user left the field blank, which printed 130.5 dB in the
Inspector as if this cabinet published it — and, because `refSplDb` is a drive
level rather than a caption, set the cabinet's amplitude in the summation too.
An unstated rating stays `null`.

### A gradient needs a real separation

`analyticCardioidDataset` refuses a depth it was not given. The separation IS the
cabinet depth and the rear delay is `d/c`, so there is no such thing as a
gradient cardioid with a substituted spacing: a `?? 0.7` fallback would quote a
0.7 m separation, and its 2.04 ms delay, for a box nobody measured. A cabinet
whose depth is unpublished therefore gets **no cardioid variant at all** — the
omni entry still ships, `extra.json` records with `type: "cardioid"` or
`cardioidVariant: true` are refused by both gates with a message naming
`depthMm`, and a custom cabinet is never asked for one, since the dialog requires
a depth.

## Where a cabinet stands

A position is the cabinet's **geometric centre**, which makes "on the deck"
`z = height/2` and not `z = 0`. Everything that places a cabinet by a FACE goes
through `centreZFromBottomFace`:

| place | the face it is given |
|---|---|
| `+ Add` in the speaker dialog | the deck, on plan view |
| the vertical stack control | the bottom face when stacked, the top face when flown (`stackCentreFromRef`) |
| the shipped presets | the deck, for every preset that is not the flown column (`deckZ`) |

An unpublished height is not halved: the cabinet is left at the face height it
was given.
