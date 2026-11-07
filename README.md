# BTR SAD - Sub Array Designer

Design a subwoofer array and predict its sound field from wave physics. Runs in
the browser, or as a desktop app on macOS and Windows.

Author: Karol Bernacki, BTR Solutions. Contact: karol@btr-poland.com

## Download

| System | File |
|---|---|
| macOS 12 or newer, Apple silicon and Intel | [BTR-SAD-macOS.dmg](https://github.com/BTR-Development/btr-sub-array-designer/releases/latest/download/BTR-SAD-macOS.dmg) |
| Windows 10 or 11, x64 | [BTR-SAD-Windows-Setup.exe](https://github.com/BTR-Development/btr-sub-array-designer/releases/latest/download/BTR-SAD-Windows-Setup.exe) |

The builds are not signed by Apple or Microsoft yet, so the system asks once:

- **macOS:** open the DMG and drag BTR SAD to Applications. On first launch macOS
  refuses it; go to System Settings → Privacy & Security and choose Open Anyway.
- **Windows:** the installer needs no administrator rights. If SmartScreen stops
  it, choose More info → Run anyway. WebView2 comes with Windows 11 and current
  Windows 10.

## What it does

- Places subwoofers in plan and 3D view, as single cabinets or as arrays.
- Builds delay tapers, arcs, end-fire and cardioid stacks from the array geometry.
- Takes end-fired rows filled by hand, mixed cabinet types included, and sets
  their delays from the row geometry.
- Computes the interference map and polar response per frequency or band.
- Saves projects as `.btrsub` files, and produces a delay and position sheet for
  the crew and an image of the map.
- Interface in English, Polish and Italian.

## How far to trust a map

The interference between cabinets is computed exactly. The radiation pattern of a
single cabinet is an approximation, and the program says so on every map through a
data grade:

| Grade | Meaning |
|---|---|
| A, B | manufacturer or verified directivity data, available only through a balloon you import yourself |
| C | analytical model: ideal point source, or a two-element pressure gradient |
| D | proxy model: another cabinet's acoustics stands in |

**No bundled model is above grade C.** No manufacturer prediction data is
included. Dimensions, weight, frequency range and maximum SPL come from the
manufacturers' published material, and an unconfirmed value stays `null`. See
[docs/SPEAKER-DATA.md](docs/SPEAKER-DATA.md).

There is no import from or export to other manufacturers' prediction programs.

## Run it

Requires Node.js 22 or newer.

```bash
npm ci
npm run dev
```

Checks:

```bash
npx tsc -b && npx oxlint && npm test && npm run build
```

## Desktop builds

Both are built on macOS: `./desktop/build-macos.sh --dmg` and
`./desktop/build-windows.sh` (needs `mingw-w64` and NSIS). See
[desktop/README.md](desktop/README.md).

## Project layout

| Path | Contents |
|---|---|
| `src/engine` | wave physics and delay computation |
| `src/speakers` | speaker library and data schema |
| `src/state` | store and array logic |
| `src/render`, `src/ui` | drawing and interface |
| `src/io` | project files and the delay sheet |
| `desktop` | macOS (Swift) and Windows (C++) shells |

Some older comments in the code are still in Polish.

## Licence

[Apache-2.0](LICENSE). Fonts are under SIL OFL 1.1: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The BTR name and logo are not
covered by the licence: see [NOTICE](NOTICE). Manufacturer and product names belong
to their owners, and this project is not affiliated with any of them.
