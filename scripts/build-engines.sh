#!/usr/bin/env bash
# Build the two native engines Null Scribe bundles and place them in bin/<os>/:
#   whisper-cli   (whisper.cpp)  speech → text
#   llama-server  (llama.cpp)    built-in 3B summary model
# Linux: builds both from source (needs git, cmake, a C++ compiler).
# Windows: run from Git Bash; downloads the official prebuilt releases instead.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WHISPER_TAG="${WHISPER_TAG:-v1.9.5}"   # pinned; same versions as scripts/build-engines.ps1
LLAMA_TAG="${LLAMA_TAG:-b11757}"
WORK="$ROOT/.engine-build"

case "$(uname -s)" in
  Linux*)  OS=linux ;;
  Darwin*) OS=mac ;;
  MINGW*|MSYS*|CYGWIN*) OS=win ;;
  *) echo "Unsupported OS: $(uname -s)"; exit 1 ;;
esac

OUT="$ROOT/bin/$OS"
mkdir -p "$OUT" "$WORK"

# ---------------------------------------------------------------- Windows
if [ "$OS" = "win" ]; then
  cd "$WORK"

  # whisper.cpp prebuilt
  if [ -z "$WHISPER_TAG" ]; then
    W_URL="https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip"
  else
    W_URL="https://github.com/ggml-org/whisper.cpp/releases/download/$WHISPER_TAG/whisper-bin-x64.zip"
  fi
  echo "Downloading $W_URL"
  curl -fL -o whisper.zip "$W_URL"
  rm -rf w && mkdir w && unzip -q whisper.zip -d w
  find w -iname 'whisper-cli.exe' -exec cp {} "$OUT/" \;
  find w -iname '*.dll' -exec cp {} "$OUT/" \;

  # llama.cpp prebuilt (CPU build; asset names include the build number, so look it up)
  API="https://api.github.com/repos/ggml-org/llama.cpp/releases/${LLAMA_TAG:+tags/$LLAMA_TAG}"
  [ -z "$LLAMA_TAG" ] && API="https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
  L_URL="$(curl -fsSL "$API" | grep -o '"browser_download_url": *"[^"]*bin-win-cpu-x64\.zip"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
  [ -n "$L_URL" ] || { echo "Could not find a llama.cpp win-cpu-x64 release asset"; exit 1; }
  echo "Downloading $L_URL"
  curl -fL -o llama.zip "$L_URL"
  rm -rf l && mkdir l && unzip -q llama.zip -d l
  find l -iname 'llama-server.exe' -exec cp {} "$OUT/" \;
  find l -iname '*.dll' -exec cp -n {} "$OUT/" \;

  # Meeting-mode capture helper (process loopback): build from source if a compiler is around,
  # otherwise use the prebuilt copy committed in native/audiotap/.
  SRC="$ROOT/native/audiotap/audiotap.cpp"
  if command -v cl >/dev/null 2>&1; then
    (cd "$WORK" && cl /nologo /O2 /EHsc /std:c++17 "$(cygpath -w "$SRC")" ole32.lib mmdevapi.lib /Fe:scribe-audiotap.exe) && cp "$WORK/scribe-audiotap.exe" "$OUT/"
  elif command -v g++ >/dev/null 2>&1; then
    g++ -O2 -std=c++17 -municode "$SRC" -lole32 -lmmdevapi -luuid -static -o "$OUT/scribe-audiotap.exe"
  else
    echo "No C++ compiler found for scribe-audiotap.exe. Use scripts/build-engines.ps1 from a Visual Studio Developer prompt."; exit 1
  fi

  for f in whisper-cli.exe llama-server.exe scribe-audiotap.exe; do
    [ -f "$OUT/$f" ] || { echo "$f missing after download"; exit 1; }
  done
  echo "Installed engines to $OUT"
  exit 0
fi

# ---------------------------------------------------------------- Linux / macOS
JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
# Static builds (no .so files to ship). GGML_NATIVE=OFF so the binary isn't tied to the build machine;
# AVX2/FMA/F16C on as the baseline (every Intel since 2013 Haswell, every AMD since 2015), otherwise
# ggml falls back to plain SSE and transcription/summaries get several times slower.
COMMON=(-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON)

build() { # name repo tag target cmake-extra...
  local name="$1" repo="$2" tag="$3" target="$4"; shift 4
  if [ ! -d "$WORK/$name" ]; then
    git clone --depth 1 ${tag:+--branch "$tag"} "$repo" "$WORK/$name"
  fi
  cmake -S "$WORK/$name" -B "$WORK/$name/build" "${COMMON[@]}" "$@"
  cmake --build "$WORK/$name/build" --config Release -j "$JOBS" --target "$target"
  cp "$WORK/$name/build/bin/$target" "$OUT/$target"
  chmod +x "$OUT/$target"
}

build whisper.cpp https://github.com/ggml-org/whisper.cpp "$WHISPER_TAG" whisper-cli \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF
build llama.cpp https://github.com/ggml-org/llama.cpp "$LLAMA_TAG" llama-server \
  -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF

echo "Installed engines to $OUT:"
ls -la "$OUT"
