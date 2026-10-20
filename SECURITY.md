# Security

## Reporting a problem

Email **volosteele55@proton.me** with the details. Please don't open a public issue for security problems.

## How Null Scribe handles your data

| Data | Where it stays |
|---|---|
| Recordings, transcripts, summaries | On your computer, in the app's data folder (`%APPDATA%\Null Scribe` / `~/.config/Null Scribe`). Nothing is uploaded unless you press a Send button. |
| Speech and summary models | Downloaded once from Hugging Face over HTTPS (or your own mirror via `NULL_SCRIBE_MODEL_MIRROR`), then run offline. |
| Transcription and summaries | Run locally (whisper.cpp, llama.cpp bound to `127.0.0.1` on a random port). With the Ollama engine, transcripts go to the Ollama address you set. |
| Null Drive token | Encrypted with the OS keychain (DPAPI on Windows, libsecret/KWallet on Linux). Without a keychain it's kept in memory only, never written in plain text. |
| Null Notes | Notes are written into the vault folder you chose; nothing goes over the network. |
| Open in Claude | Copies text to your clipboard and opens claude.ai in your browser. Nothing is sent until you paste it. |

## App hardening

- Renderer runs sandboxed with context isolation and no Node access; a strict Content Security Policy (no remote scripts, no inline styles or scripts).
- The page can't navigate away or open windows; links open in the system browser.
- Only microphone permission is granted; every other permission request is denied.
- Model output is HTML-escaped before display, so a summary can't inject markup.
- Meeting mode records only the apps you tick; it never reroutes or mutes anyone's audio.

Recording people without their consent is illegal in many places. Tell people when you record them.
