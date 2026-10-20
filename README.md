# Null Scribe

**Your data. Your grid.**

Null Scribe records or imports a conversation, transcribes it on your own machine with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), and summarizes it with a **built-in 3B model** (llama.cpp, runs inside the app). If you'd rather use your own [Ollama](https://ollama.com) server, that's an option in Settings. Nothing goes to the cloud unless you choose **Open in Claude**.

Part of the Null Grid suite: Null Search · Null Grid · Null Notes · Null Drive · Null Scribe.

## What it does

```
record / import ──► ffmpeg (16 kHz mono WAV) ──► whisper.cpp ──► transcript
                                                                   │
        built-in Llama 3.2 3B  ─or─  your Ollama server ◄──────────┘
                  (chunked map → reduce)
                                   │
                                   ▼
             summary.md  ──►  Send to Null Notes · Open in Claude · Export .md
```

- **Record** from the mic (with a live level meter) or **import** any audio or video file (mp3, m4a, wav, ogg, flac, webm, mp4, mkv…).
- **Transcribe** locally with timestamps. The speech model downloads once, on first use.
- **Summarize** into Overview, Key points, Decisions, Action items (checklist with owners) and Open questions. Long recordings are split into chunks, each chunk is summarized, and the notes are merged.
- **Send to Notes / Send to Drive** puts the session straight into Null Notes or onto your Null Drive server (see *Null Grid integration*).
- **Open in Claude** copies the summary and transcript to the clipboard and opens claude.ai in your browser, so you can paste it into a new chat and ask questions about it.
- **Re-summarize** reruns only the summary, for example after switching engine or model. The saved transcript is reused.
- **History** keeps every session on disk in the app's data folder.

## Null Grid integration

### Send to Notes (Null Notes)
Saves the session as a note in `<vault>/Scribe/`, with `id: <uuid>` in the frontmatter (the Null Notes note-id format), then opens it with `nullnotes://open?id=<uuid>`. Null Notes' file watcher indexes it within about 2 seconds, so it's also searchable from Null Search. Nothing is ever overwritten: a name clash gets " (2)". Settings suggests your vaults by reading Null Notes' recent-vault list (`dev.nullgrid.notes/settings.json`, including the Microsoft Store install's package folder).

### Send to Drive (Null Drive)
Uploads to your Null Drive server: the `.md` note, a `.pdf`, and/or the audio (MP3, M4A, FLAC, OGG or WAV) into a `Null Scribe/` folder.
- **Setup:** Settings → Null Drive → server address + a full-access token from *Null Drive → Devices* (a search-only token can't upload). **Test** checks it with `GET /api/v1/me`.
- **Safe uploads:** `PUT /api/v1/files/{path}` with `If-Match: 0` (create only, never overwrite) and `X-Content-SHA256`. A name clash gets " (2)", and re-sending identical content doesn't make a duplicate.
- **Token storage:** encrypted with the OS keychain (DPAPI on Windows, libsecret/KWallet on Linux). Without a keychain it's kept in memory until the app closes, never written in plain text.
- **End-to-end encrypted Drive accounts** only accept files encrypted by a Null Grid app that holds the key, so Scribe detects them (`user.e2ee` from `/api/v1/me`) and suggests Send to Notes instead. Null Notes syncs to encrypted Drive accounts itself.
- **HTTPS:** a certificate the OS trusts works. Self-signed certificates aren't pinned yet, so use the `http://` LAN address for those.

## Meeting mode

Record a call from **Zoom, Discord, Teams, or any app**, plus your own mic, while leaving everything else out (Spotify, games, notifications).

- Switch **New capture → Meeting**, tick the apps to record, keep **Include my microphone** on, and press record.
- The app audio and the mic are recorded as **separate tracks**. Each is transcribed on its own, so every line is labeled **You** (your mic) or with the **app's name**: `[02:14] Discord: can you send the deck?`. Two apps at once (e.g. Zoom and Discord) get separate labels.
- If you're on speakers instead of headphones, your mic also hears the call. Lines that appear on both tracks at the same moment are dropped from "You."
- Ticked apps are remembered. If an app isn't playing yet (you haven't joined the call), it's picked up automatically when it starts.
- You still hear everything normally; nothing is rerouted.

| Platform | How | Requirements |
|---|---|---|
| Windows | `scribe-audiotap.exe` (in `native/audiotap/`), using Windows **process loopback capture** for the chosen processes and their child processes | Windows 10 version 2004 (build 19041) or later |
| Linux | PipeWire: a private recording node, with only the chosen apps' streams linked into it via `pw-link` | PipeWire (default on Ubuntu 22.10+, Fedora 34+) and `pipewire-bin` |

The Windows helper is prebuilt in `native/audiotap/scribe-audiotap.exe`. `npm run build:engines` on Windows rebuilds it from source when MSVC (`cl`) or MinGW (`g++`) is available. From Linux, `npm run build:audiotap-cross` cross-compiles it with zig (`pip install ziglang`).

Tell people when you record them. Zoom shows a recording notice for its own recorder, but not for this.

## Summary engines

| Engine | Setup | Notes |
|---|---|---|
| **Built-in** (default) | none | Bundled `llama-server` (llama.cpp) runs privately on `127.0.0.1`. The model downloads once (~2 GB). It starts on demand and shuts down after 5 idle minutes to free RAM. Needs about 4 GB of free RAM. |
| **Ollama** | your server | Better quality with bigger models (7B+), and offloads the work to your homelab GPU. |

Built-in models:

| Model | Size | License |
|---|---|---|
| Llama 3.2 3B Instruct (Q4_K_M) — default | 2.0 GB | Llama 3.2 Community License. Commercial use allowed; show "Built with Llama" (e.g. in About / the Store listing). |
| Qwen 2.5 3B Instruct (Q4_K_M) | 2.1 GB | Qwen Research License. Restricts commercial use, so treat it as personal-use only. |

Model downloads come from Hugging Face. The app downloads the files itself; they are not shipped in the installer.

## Requirements

| Piece | Why |
|---|---|
| Node.js 20+ | to run and build the app |
| git + cmake + a C++ compiler (Linux) | to build whisper.cpp and llama.cpp once |
| Ollama (optional) | only if you choose the Ollama engine, e.g. `ollama pull llama3.2:3b` |

ffmpeg is bundled through `ffmpeg-static`, so users don't need to install it.

## Run from source

```bash
npm install
npm run build:engines     # Linux: builds whisper-cli + llama-server into bin/linux/ (Windows: ./scripts/build-engines.ps1)
npm start
```

That's enough to work. The first recording downloads the speech model and the 3B model. Optional, in **Settings** (Ctrl+,):

- **Engine.** Switch to *My Ollama server*, enter the address, and press **Test**.
- **Speech model.** `base.en` is the default. Use a non-`.en` model for Polish or other languages.
- **Null Notes vault.** Point it at the folder Null Notes opens.

> If Ollama runs on another machine, start it with `OLLAMA_HOST=0.0.0.0` so it listens on the network. Keep that port behind your LAN or Tailscale; don't expose it to the internet.

## Download

Grab the latest build from [Releases](https://github.com/Null0Grid/null-scribe/releases):

| File | For |
|---|---|
| `null-scribe_<version>_amd64.deb` | Debian / Ubuntu: `sudo apt install ./null-scribe_<version>_amd64.deb` |
| `NullScribe-<version>-Setup.exe` | Windows 10 (2004+) / 11, per-user install, no admin |
| `NullScribe_<version>.0_x64.msix` | Microsoft Store submission |

Needs a 64-bit CPU with AVX2 (Intel 2013+ / AMD 2015+). The models (~2.2 GB) download on first launch.

## Build releases

Releases are built by GitHub Actions (`.github/workflows/release.yml`): **Actions → Release → Run workflow**, enter the version (it must match `package.json`). The workflow:

1. runs the tests;
2. **Linux:** builds whisper.cpp and llama.cpp (pinned tags, AVX2 baseline), then the `.deb` on Ubuntu 22.04 (so it runs on newer distros), and test-installs it;
3. **Windows:** builds the engines and the Meeting-mode helper with MSVC (static runtime), the NSIS installer, and the **Store MSIX** with MakePri + MakeAppx (`packaging/msix/build-msix.ps1`);
4. publishes a GitHub Release with all three files and `SHA256SUMS`, creating the `v<version>` tag.

### Microsoft Store

1. The Partner Center identity is built in: `NULLGRID.NullScribe`, publisher `CN=8685350B-5C4C-4422-9CDF-8AEB87F50B2F`, display name `NULLGRID` (package family `NULLGRID.NullScribe_yb898v9ybphdc`, Store ID [9P2FHWTQPN6G](https://apps.microsoft.com/detail/9P2FHWTQPN6G)). The repository variables `MSIX_IDENTITY_NAME`, `MSIX_PUBLISHER` and `MSIX_PUBLISHER_DISPLAY_NAME` override them if they ever change.
2. Run the Release workflow and upload the `.msix` to a new submission. It's unsigned on purpose; the Store signs it.
3. Listing notes: mention "Built with Llama" (Llama 3.2 license). In the certification notes, explain the microphone and audio-recording use, and that the models download on first launch.

The manifest (`packaging/msix/AppxManifest.xml`) declares full trust and the microphone, targets Windows 10 2004+ (needed for per-app audio capture), and uses the tile set in `packaging/msix/Assets/`.

### Building locally

- **Linux:** `npm ci && npm run build:engines && npm run dist:linux` → `dist/null-scribe_<v>_amd64.deb`
- **Windows** (Developer PowerShell for VS 2022): `npm ci; ./scripts/build-engines.ps1; npm run dist:win; ./packaging/msix/build-msix.ps1 -Version <v>`

## Where data lives

| OS | Folder |
|---|---|
| Linux | `~/.config/Null Scribe/` |
| Windows | `%APPDATA%\Null Scribe\` |

Inside it: `settings.json`, `models/` (speech and summary models), and `sessions/<id>/` holding `audio.wav`, `transcript.json`, `summary.md`, `document.md` and `meta.json`. Deleting a session removes its folder.

## Project layout

```
native/audiotap/  Windows meeting-capture helper (C++)
src/
  capture/      Meeting mode: pipewire.js (Linux) · windows.js (helper wrapper)
  main/         Electron main process: windows, IPC, settings, session storage
  pipeline/     audio · download · models · transcribe · chunk · summarize ·
                local-llm (llama-server) · engine (built-in vs Ollama) · markdown · index
  renderer/     UI (index.html, styles.css, app.js, markdown.js)
scripts/build-engines.sh
test/pipeline.test.js
```

The pipeline has no Electron dependency, so it can be reused elsewhere, for example as a headless homelab service.

## Tests

```bash
npm test
```

23 tests cover Meeting mode (track merging and echo removal, PipeWire graph parsing and link planning, Windows session grouping, multi-track pipeline), plus chunking, whisper JSON parsing, map-reduce summarizing, a fake Ollama server, a fake llama-server (start, reuse, stop, crash), engine selection, the session and settings stores, real ffmpeg conversion, and a full end-to-end pipeline run.

## Testing with a real recording

`npm run test:budget` runs the included example (`examples/budget-meeting/`, a 3-minute budget meeting) through the real pipeline: the speech model, cleanup, and the built-in Llama 3.2 3B. It writes `test-report.md` with:

- **Word accuracy** of the transcript against the script (`transcript.md`).
- A **10-fact checklist** (`facts.js`), scored for the app's summary next to a reference summary written by Claude (`reference-summary.md`).
- All four texts: the script, the raw transcript, the cleaned transcript, and the AI summary.

Use your own files with `npm run test:recording -- my-call.mp3 my-script.md`. Models download once into `.test-models/`.

## Roadmap

- Per-person speaker labels within one app (diarization)
- GPU builds of the built-in engine (Vulkan/CUDA)
- Store recordings in Null Drive
- Version 5.0: cross-product sync and search with Null Search

## Notes

- Recording people without their consent is illegal in many places. Make sure everyone agrees.
- `ffmpeg-static` ships a GPL build of FFmpeg as a separate executable. Keep its license notice with releases, and review the licensing before publishing.
- Model licenses are summarized above for convenience. Read the actual license texts before a commercial release.

Copyright © NULLGRID. All rights reserved.
