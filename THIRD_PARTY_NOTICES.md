# Third-party notices

Null Scribe is proprietary (see LICENSE). It bundles or downloads the following, under their own licenses.

## Bundled in the app

| Component | License | Use |
|---|---|---|
| [Electron](https://www.electronjs.org) (Chromium, Node.js) | MIT, plus Chromium's licenses (`LICENSES.chromium.html` in the app folder) | App runtime |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | MIT | Speech to text (`whisper-cli`) |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | MIT | Built-in summary engine (`llama-server`) |
| [docx](https://github.com/dolanmiu/docx) | MIT | Word (.docx) downloads |
| [JSZip](https://github.com/Stuk/jszip) | MIT (dual MIT / GPLv3; used under MIT) | LibreOffice (.odt) downloads |
| [FFmpeg](https://ffmpeg.org) via [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | GPL v3 build, shipped as a separate executable; source at ffmpeg.org | Audio conversion and export |
| [Silkscreen](https://fonts.google.com/specimen/Silkscreen) | SIL Open Font License 1.1 | Display font |
| [IBM Plex Sans](https://github.com/IBM/plex) | SIL Open Font License 1.1 | Body font |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | SIL Open Font License 1.1 | Monospace font |

The font license texts are in `src/renderer/fonts/`.

## Downloaded on first launch (not in the installer)

| Model | License |
|---|---|
| whisper.cpp ggml speech models (OpenAI Whisper weights) | MIT |
| Llama 3.2 3B Instruct, Q4_K_M GGUF (default summary model) | Llama 3.2 Community License. **Built with Llama.** |
| Qwen 2.5 3B Instruct, Q4_K_M GGUF (optional) | Qwen Research License (restrictions on commercial use) |
