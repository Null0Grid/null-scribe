# Build Null Scribe's native engines on Windows (MSVC, Visual Studio 2022 Build Tools) into bin\win\:
#   whisper-cli.exe     (whisper.cpp)  speech -> text
#   llama-server.exe    (llama.cpp)    built-in 3B summary model
#   scribe-audiotap.exe (native/audiotap) Meeting mode per-app capture
# Static C runtime (/MT), so users don't need the Visual C++ redistributable.
param(
  [string]$WhisperTag = $(if ($env:WHISPER_TAG) { $env:WHISPER_TAG } else { 'v1.9.5' }),
  [string]$LlamaTag = $(if ($env:LLAMA_TAG) { $env:LLAMA_TAG } else { 'b11757' })
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$work = Join-Path $root '.engine-build'
$out = Join-Path $root 'bin\win'
New-Item -ItemType Directory -Force $work, $out | Out-Null

# x86-64 baseline with AVX2/FMA/F16C (every Intel since 2013 Haswell, every AMD since 2015).
$common = @('-A', 'x64', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF',
  '-DGGML_AVX=ON', '-DGGML_AVX2=ON', '-DGGML_FMA=ON', '-DGGML_F16C=ON',
  '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded')

function Build-Engine($name, $repo, $tag, $target, $extra) {
  $src = Join-Path $work $name
  if (-not (Test-Path $src)) { git clone --depth 1 --branch $tag $repo $src; if ($LASTEXITCODE) { throw "clone $name failed" } }
  cmake -S $src -B "$src\build" @common @extra
  if ($LASTEXITCODE) { throw "cmake configure $name failed" }
  cmake --build "$src\build" --config Release --target $target -j
  if ($LASTEXITCODE) { throw "cmake build $name failed" }
  $exe = Get-ChildItem "$src\build" -Recurse -Filter "$target.exe" | Select-Object -First 1
  if (-not $exe) { throw "$target.exe not found after build" }
  Copy-Item $exe.FullName $out -Force
}

Build-Engine 'whisper.cpp' 'https://github.com/ggml-org/whisper.cpp' $WhisperTag 'whisper-cli' @('-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF')
Build-Engine 'llama.cpp' 'https://github.com/ggml-org/llama.cpp' $LlamaTag 'llama-server' @('-DLLAMA_CURL=OFF', '-DLLAMA_BUILD_TESTS=OFF')

# Meeting-mode capture helper (needs a Developer Command Prompt / vcvars environment for cl.exe)
Push-Location $work
cl /nologo /O2 /EHsc /std:c++17 /MT /DUNICODE /D_UNICODE (Join-Path $root 'native\audiotap\audiotap.cpp') ole32.lib mmdevapi.lib uuid.lib /Fe:scribe-audiotap.exe
if ($LASTEXITCODE) { throw 'audiotap build failed' }
Copy-Item scribe-audiotap.exe $out -Force
Pop-Location

Get-ChildItem $out | Format-Table Name, Length
