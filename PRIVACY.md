# Null Scribe Privacy Policy

**Effective date:** October 20, 2026
**Publisher:** NULLGRID

Null Scribe records or imports conversations, transcribes them, and writes AI summaries, all on your own computer. This policy explains what the app does with your data. In short, NULLGRID never receives your recordings, transcripts, or summaries.

## What NULLGRID collects

**Nothing.** Null Scribe has no accounts, analytics, telemetry, advertising, or crash reporting. NULLGRID runs no servers that the app connects to.

## Data stored on your device

| Data | Where it is kept |
|---|---|
| Recordings, transcripts, summaries | The app's data folder on your computer |
| Settings | The same folder |
| Speech and AI models | The same folder, downloaded once on first launch |
| Null Drive access token (if you add one) | Encrypted with your operating system's secure storage (Windows DPAPI, or the Linux keyring) |

Transcription (whisper.cpp) and summaries (llama.cpp) run locally on your computer. The summary engine listens only on your own machine (127.0.0.1) and is not reachable from your network or the internet.

## Microphone and app audio

Null Scribe uses your microphone only while you are recording. In Meeting mode, it captures audio only from the apps you select (for example Zoom or Discord), and only while the recording runs. It never records in the background, and it does not mute or reroute anyone's audio.

## When data leaves your device

Data leaves your computer only in these cases:

- **Model download (first launch).** The app downloads the speech and AI models from Hugging Face (huggingface.co). Hugging Face can see your IP address, as with any download, under [Hugging Face's privacy policy](https://huggingface.co/privacy). No recordings or personal content are sent. Advanced users can point downloads to their own server instead.
- **Ollama (optional).** If you choose Ollama as the summary engine, transcripts are sent to the Ollama address you enter. Usually that is your own computer or home server.
- **Send to Null Drive (optional).** When you press Send to Drive, the files you chose are uploaded to the Null Drive server address you entered. That server is yours or one you trust; NULLGRID does not operate it.
- **Send to Null Notes (optional).** This saves a note into the Null Notes vault folder on your computer. Nothing goes over the network.
- **Open in Claude (optional).** This copies the summary to your clipboard and opens claude.ai in your browser. Nothing is sent unless you paste it there. Once you do, [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy) applies.
- **Export.** Audio, transcripts, and summaries you export are saved wherever you choose.

## Microsoft Store and app distribution

If you install Null Scribe from the Microsoft Store, Microsoft handles purchase, installation, and update data under the [Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement). NULLGRID does not receive personal information from Microsoft beyond the aggregate download and crash statistics Microsoft provides to app publishers.

## Deleting your data

- Delete any session inside the app (Session → Delete).
- Settings → Storage can delete recordings' audio automatically after 1 to 180 days, keeping the transcripts and summaries.
- Uninstalling the Microsoft Store version removes the app's data folder.
- On Linux, uninstalling leaves your data in `~/.config/Null Scribe`. Delete that folder to remove everything.

Because NULLGRID never receives your data, we have nothing to delete on our end.

## Recording other people

Recording a conversation without everyone's consent is illegal in many places. You are responsible for telling people when you record them and getting their consent where the law requires it.

## Children

Null Scribe is not directed at children under 13, and NULLGRID does not knowingly collect information from anyone.

## Changes to this policy

If the app's data handling changes, we will update this policy and its effective date before releasing that version.

## Contact

Questions about this policy: **volosteele55@proton.me**
