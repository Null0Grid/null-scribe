# Changelog

## 5.2.0

- **About window:** an About button next to Settings, with the version, `© NULL LABS. All rights reserved.`, the license and links to the source, privacy policy, trademark policy and third-party notices.
- Exported PDF, Word, LibreOffice and web-page files end with `© NULL LABS. All rights reserved.`; the sidebar reads "by Null Labs" instead of the slogan.
- **Brand:** Null Scribe is part of **Null** by **Null Labs**. The in-app wordmark reads NULL SCRIBE (no slashes), and Linux/AUR/Store metadata name Null Labs as the developer. The Microsoft Store display name follows Partner Center (Null Labs); the package identity is unchanged.
- **License:** the code is now GPL-3.0-only (`LICENSE`). The names and the // mark stay trademarks of Null Labs; see the trademark note in the README.
- Store icon exports in `assets/store/` (300, 150 and 71 px on #0a0a0f).
- **Word and LibreOffice downloads:** Download → *Document (Microsoft Word)* `.docx` and *Document (LibreOffice)* `.odt`. Headings, bullets, ☐ action items, timestamps and a Time / Speaker / Text transcript table; `.docx` also opens in Google Docs.

## 5.1.1

- **New app icon**: the new Null logo on the window, taskbar, installer, Microsoft Store tiles and Linux packages.
- **ARM64** builds of every Linux package: `.deb`, `.rpm`, AppImage, `.tar.gz` (Raspberry Pi 4/5, ARM laptops).
- **Flatpak** bundles (`.flatpak`, x86_64 and aarch64) and a Flathub manifest with AppStream metadata.
- **Snap** packages (`.snap`, amd64 and arm64).
- **AUR** package files for `null-scribe-bin` (`PKGBUILD` + `.SRCINFO`).
- These formats were also added to the 5.1.0 release; from 5.1.1 every release builds them.

## 5.1.0

- **Summary templates:** Meeting, Lecture / class, Interview, Stand-up, 1:1, and your own templates (add, edit, delete). Pick one before recording, set a default in Settings, or re-write an old summary with another template from the Summary tab.
- **Rename speakers** from the Transcript tab ("Discord" → "Tom", "You" → your name); the transcript, summary, Markdown and exports all update.
- **Custom words:** a list of names and terms passed to whisper.cpp (`--prompt`) and to the summarizer, so they're spelled right.
- **Subtitles:** `.srt` and `.vtt` downloads.
- **Audio auto-delete:** delete recordings' audio after 1, 7, 15, 30, 90 or 180 days (Settings → Storage); transcripts and summaries are kept.

## 1.0.0 — first release

- **Capture:** record from a chosen microphone, import any audio/video file, or **Meeting mode**: record chosen apps (Zoom, Discord, Teams…) while leaving others (Spotify, games) out. PipeWire on Linux, Windows process loopback on Windows 10 2004+.
- **On-device transcription** with whisper.cpp. Speaker labels: **You** (your mic) and each app by name (`Discord:`), with mic-echo removal and a **live transcript** panel while recording.
- **Transcript cleanup:** removes um/uh, stutters and stage directions; keeps every real word. The verbatim copy is kept too.
- **AI summary** from the built-in **Llama 3.2 3B** (llama.cpp, runs in the app, no server) or your own **Ollama** server: overview, key points with timestamps, decisions, action items, open questions.
- **Null Grid integration:** **Send to Notes** (a note with a Null Notes id, opened via `nullnotes://`) and **Send to Drive** (`.md`, PDF and/or audio uploaded to Null Drive, never overwriting).
- **Downloads:** transcript as `.md`, `.txt`, `.pdf`, `.html`; audio as MP3, M4A, WAV, FLAC, OGG from a lossless master.
- **Open in Claude:** copies the summary and transcript and opens claude.ai.
- **First-run setup** downloads the models with progress, pause/resume and a disk-space check.
- **Neon Lab** design, the Null Grid look, dark only.
- Packages: `.deb`, `.rpm`, AppImage, `.tar.gz`, Windows installer, Microsoft Store MSIX.
