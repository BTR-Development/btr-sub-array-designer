# Third-party notices

## Bundled in the application

| Component | Licence | Where |
|---|---|---|
| Manrope | SIL OFL 1.1 | `src/assets/fonts/`, text in `LICENSES/OFL-Manrope.txt` |
| IBM Plex Mono | SIL OFL 1.1 | `src/assets/fonts/`, text in `LICENSES/OFL-IBM-Plex-Mono.txt` |
| React, React DOM | MIT | npm |
| zustand | MIT | npm |

## Fetched by the Windows build

`desktop/build-windows.sh` downloads the Microsoft WebView2 SDK from NuGet and
checks its SHA-256. It is not stored in this repository. Its licence ships with
the package. The Windows installer carries `WebView2Loader.dll` from that SDK.

Development dependencies are listed in `package.json`.
