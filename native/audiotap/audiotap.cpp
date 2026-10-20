// scribe-audiotap — Windows audio capture helper for Null Scribe's Meeting mode.
//
//   scribe-audiotap list
//       Prints one JSON array of processes that currently have an audio session
//       on any active output device: [{"pid":1234,"exe":"Zoom.exe","active":true}, ...]
//
//   scribe-audiotap list-mics
//       Prints the active input devices: [{"id":"{0.0.1...}","name":"Headset Mic","default":true}, ...]
//
//   scribe-audiotap capture --out-dir DIR [--pid N]... [--mic [--mic-id ID]]
//       Records each --pid's audio (and its child processes) with Windows process
//       loopback capture into DIR\app-<pid>.wav, and the default microphone into
//       DIR\you.wav. All files are 48 kHz 16-bit and share one start time; silent
//       stretches are filled with zeros so the tracks stay aligned.
//       Status is printed to stdout as JSON lines about once a second.
//       Stops when stdin closes or receives "stop", then finalizes the WAV files.
//
// Process loopback requires Windows 10 version 2004 (build 19041) or later.
// Build (MSVC):   cl /O2 /EHsc /std:c++17 audiotap.cpp ole32.lib mmdevapi.lib avrt.lib
// Build (MinGW):  g++ -O2 -std=c++17 audiotap.cpp -lole32 -lmmdevapi -luuid -static -municode

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <functiondiscoverykeys_devpkey.h>

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// ---- Process loopback declarations (audioclientactivationparams.h, missing from older SDKs/MinGW) ----
#ifndef VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
typedef enum AUDIOCLIENT_ACTIVATION_TYPE {
  AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
  AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} AUDIOCLIENT_ACTIVATION_TYPE;
typedef enum PROCESS_LOOPBACK_MODE {
  PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
  PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} PROCESS_LOOPBACK_MODE;
typedef struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
  DWORD TargetProcessId;
  PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;
typedef struct AUDIOCLIENT_ACTIVATION_PARAMS {
  AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
  union {
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
  };
} AUDIOCLIENT_ACTIVATION_PARAMS;
#endif

static const GUID kIID_IAgileObject = {0x94ea2b94, 0xe9cc, 0x49e0, {0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90}};

static const UINT32 kRate = 48000;
static std::mutex g_out;

// ------------------------------------------------------------------ helpers

static std::string narrow(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}

static std::string jsonEscape(const std::string& s) {
  std::string o;
  for (char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': break;
      default:
        if ((unsigned char)c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += c;
    }
  }
  return o;
}

static void emit(const std::string& line) {
  std::lock_guard<std::mutex> lock(g_out);
  fputs(line.c_str(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static void emitError(const std::string& msg, HRESULT hr = S_OK) {
  char buf[32] = "";
  if (hr != S_OK) snprintf(buf, sizeof buf, " (0x%08lx)", (unsigned long)hr);
  emit("{\"event\":\"error\",\"message\":\"" + jsonEscape(msg + buf) + "\"}");
}

static std::wstring exeNameForPid(DWORD pid) {
  std::wstring name;
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return name;
  wchar_t path[MAX_PATH * 2];
  DWORD len = (DWORD)(sizeof(path) / sizeof(path[0]));
  if (QueryFullProcessImageNameW(h, 0, path, &len)) {
    std::wstring full(path, len);
    size_t slash = full.find_last_of(L"\\/");
    name = slash == std::wstring::npos ? full : full.substr(slash + 1);
  }
  CloseHandle(h);
  return name;
}

static int64_t qpcNow100ns() {
  static LARGE_INTEGER freq = [] { LARGE_INTEGER f; QueryPerformanceFrequency(&f); return f; }();
  LARGE_INTEGER t;
  QueryPerformanceCounter(&t);
  return (int64_t)((double)t.QuadPart * 1e7 / (double)freq.QuadPart);
}

// ------------------------------------------------------------------ WAV writer

class WavWriter {
 public:
  bool open(const std::wstring& path, WORD channels) {
    channels_ = channels;
    f_ = _wfopen(path.c_str(), L"wb");
    if (!f_) return false;
    writeHeader(0);
    return true;
  }
  void write(const int16_t* data, size_t frames) {
    if (!f_ || !frames) return;
    fwrite(data, sizeof(int16_t) * channels_, frames, f_);
    frames_ += frames;
  }
  void writeSilence(uint64_t frames) {
    static const std::vector<int16_t> zeros(4800 * 2, 0);
    while (frames > 0) {
      size_t n = (size_t)std::min<uint64_t>(frames, 4800);
      write(zeros.data(), n);
      frames -= n;
    }
  }
  uint64_t frames() const { return frames_; }
  void close() {
    if (!f_) return;
    fseek(f_, 0, SEEK_SET);
    writeHeader(frames_ * channels_ * sizeof(int16_t));
    fclose(f_);
    f_ = nullptr;
  }
  ~WavWriter() { close(); }

 private:
  void writeHeader(uint64_t dataBytes) {
    uint32_t data = (uint32_t)std::min<uint64_t>(dataBytes, 0xFFFFFFFFull - 36);
    uint32_t riff = 36 + data;
    uint16_t fmtTag = 1, bits = 16, align = channels_ * 2;
    uint32_t fmtLen = 16, rate = kRate, byteRate = kRate * align;
    fwrite("RIFF", 1, 4, f_); fwrite(&riff, 4, 1, f_); fwrite("WAVE", 1, 4, f_);
    fwrite("fmt ", 1, 4, f_); fwrite(&fmtLen, 4, 1, f_); fwrite(&fmtTag, 2, 1, f_);
    fwrite(&channels_, 2, 1, f_); fwrite(&rate, 4, 1, f_); fwrite(&byteRate, 4, 1, f_);
    fwrite(&align, 2, 1, f_); fwrite(&bits, 2, 1, f_);
    fwrite("data", 1, 4, f_); fwrite(&data, 4, 1, f_);
  }
  FILE* f_ = nullptr;
  WORD channels_ = 2;
  uint64_t frames_ = 0;
};

// ------------------------------------------------------------------ async activation handler

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler {
 public:
  ActivationHandler() { done_ = CreateEventW(nullptr, TRUE, FALSE, nullptr); }
  ~ActivationHandler() { CloseHandle(done_); }

  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler) || riid == kIID_IAgileObject) {
      *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++refs_; }
  STDMETHODIMP_(ULONG) Release() override {
    ULONG r = --refs_;
    if (!r) delete this;
    return r;
  }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT activateHr = E_FAIL;
    IUnknown* unk = nullptr;
    hr_ = op->GetActivateResult(&activateHr, &unk);
    if (SUCCEEDED(hr_)) hr_ = activateHr;
    if (SUCCEEDED(hr_) && unk) hr_ = unk->QueryInterface(__uuidof(IAudioClient), (void**)&client_);
    if (unk) unk->Release();
    SetEvent(done_);
    return S_OK;
  }

  HRESULT wait(IAudioClient** out, DWORD ms) {
    if (WaitForSingleObject(done_, ms) != WAIT_OBJECT_0) return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    if (FAILED(hr_)) return hr_;
    *out = client_;
    client_ = nullptr;
    return S_OK;
  }

 private:
  std::atomic<ULONG> refs_{1};
  HANDLE done_;
  HRESULT hr_ = E_FAIL;
  IAudioClient* client_ = nullptr;
};

// ------------------------------------------------------------------ one capture stream

struct Stream {
  std::string name;      // "app-1234" or "you"
  DWORD pid = 0;         // 0 for the mic
  WORD channels = 2;
  IAudioClient* client = nullptr;
  IAudioCaptureClient* capture = nullptr;
  HANDLE event = nullptr;
  WavWriter wav;
  std::atomic<float> peak{0.f};
  std::thread thread;
  std::string error;
};

static WAVEFORMATEX pcmFormat(WORD channels) {
  WAVEFORMATEX f{};
  f.wFormatTag = WAVE_FORMAT_PCM;
  f.nChannels = channels;
  f.nSamplesPerSec = kRate;
  f.wBitsPerSample = 16;
  f.nBlockAlign = channels * 2;
  f.nAvgBytesPerSec = kRate * f.nBlockAlign;
  return f;
}

static HRESULT openProcessLoopback(Stream& s) {
  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = s.pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT pv{};
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  auto* handler = new ActivationHandler();
  IActivateAudioInterfaceAsyncOperation* op = nullptr;
  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, handler, &op);
  if (SUCCEEDED(hr)) hr = handler->wait(&s.client, 10000);
  if (op) op->Release();
  handler->Release();
  if (FAILED(hr)) return hr;

  WAVEFORMATEX fmt = pcmFormat(s.channels);
  hr = s.client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                            200 * 10000 /* 200 ms */, 0, &fmt, nullptr);
  return hr;
}

static HRESULT openMicrophone(Stream& s, const std::wstring& micId) {
  IMMDeviceEnumerator* en = nullptr;
  IMMDevice* dev = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&en);
  if (SUCCEEDED(hr)) {
    // A chosen device that has gone away (unplugged headset) falls back to the default mic.
    if (!micId.empty() && FAILED(en->GetDevice(micId.c_str(), &dev))) {
      emitError("Chosen microphone not found; using the default one");
      dev = nullptr;
    }
    if (!dev) hr = en->GetDefaultAudioEndpoint(eCapture, eConsole, &dev);
  }
  if (SUCCEEDED(hr)) hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&s.client);
  if (dev) dev->Release();
  if (en) en->Release();
  if (FAILED(hr)) return hr;
  WAVEFORMATEX fmt = pcmFormat(s.channels);
  return s.client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                              AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                              200 * 10000, 0, &fmt, nullptr);
}

static HRESULT prepare(Stream& s) {
  s.event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HRESULT hr = s.client->SetEventHandle(s.event);
  if (SUCCEEDED(hr)) hr = s.client->GetService(__uuidof(IAudioCaptureClient), (void**)&s.capture);
  return hr;
}

// Capture loop. t0 is the shared start time (100 ns QPC units) so every track begins together.
static void captureLoop(Stream* s, int64_t t0, std::atomic<bool>* stop) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const uint64_t gapTolerance = kRate / 50; // 20 ms
  HRESULT hr = s->client->Start();
  if (FAILED(hr)) { s->error = "Start failed"; emitError(s->name + ": could not start capture", hr); }

  while (SUCCEEDED(hr) && !stop->load()) {
    WaitForSingleObject(s->event, 100);
    UINT32 packet = 0;
    while (SUCCEEDED(hr = s->capture->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      UINT64 devPos = 0, qpcPos = 0;
      hr = s->capture->GetBuffer(&data, &frames, &flags, &devPos, &qpcPos);
      if (FAILED(hr)) break;

      // Fill any silent gap (loopback delivers nothing while the app is quiet).
      if (qpcPos > (UINT64)t0) {
        uint64_t expected = (uint64_t)((qpcPos - (UINT64)t0) * kRate / 10000000ull);
        if (expected > s->wav.frames() + gapTolerance) s->wav.writeSilence(expected - s->wav.frames());
      }

      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        s->wav.writeSilence(frames);
      } else {
        const int16_t* pcm = reinterpret_cast<const int16_t*>(data);
        s->wav.write(pcm, frames);
        int peak = 0;
        for (UINT32 i = 0; i < frames * s->channels; i += 8) peak = std::max(peak, std::abs((int)pcm[i]));
        float p = peak / 32768.f;
        if (p > s->peak.load()) s->peak.store(p);
      }
      s->capture->ReleaseBuffer(frames);
    }
    if (hr == AUDCLNT_E_DEVICE_INVALIDATED) {
      emitError(s->name + ": audio device went away");
      break;
    }
  }
  s->client->Stop();
  CoUninitialize();
}

// ------------------------------------------------------------------ commands

static int cmdList() {
  IMMDeviceEnumerator* en = nullptr;
  IMMDeviceCollection* devices = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&en);
  if (SUCCEEDED(hr)) hr = en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices);
  if (FAILED(hr)) { emitError("Could not enumerate audio devices", hr); return 1; }

  struct Entry { DWORD pid; std::wstring exe; bool active; };
  std::vector<Entry> out;
  UINT count = 0;
  devices->GetCount(&count);
  for (UINT d = 0; d < count; d++) {
    IMMDevice* dev = nullptr;
    IAudioSessionManager2* mgr = nullptr;
    IAudioSessionEnumerator* sessions = nullptr;
    if (FAILED(devices->Item(d, &dev))) continue;
    if (SUCCEEDED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&mgr)) &&
        SUCCEEDED(mgr->GetSessionEnumerator(&sessions))) {
      int n = 0;
      sessions->GetCount(&n);
      for (int i = 0; i < n; i++) {
        IAudioSessionControl* ctl = nullptr;
        IAudioSessionControl2* ctl2 = nullptr;
        if (FAILED(sessions->GetSession(i, &ctl))) continue;
        if (SUCCEEDED(ctl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&ctl2))) {
          DWORD pid = 0;
          AudioSessionState state = AudioSessionStateInactive;
          ctl2->GetProcessId(&pid);
          ctl2->GetState(&state);
          if (pid && ctl2->IsSystemSoundsSession() != S_OK && state != AudioSessionStateExpired) {
            bool found = false;
            for (auto& e : out) if (e.pid == pid) { e.active = e.active || state == AudioSessionStateActive; found = true; }
            if (!found) out.push_back({pid, exeNameForPid(pid), state == AudioSessionStateActive});
          }
          ctl2->Release();
        }
        ctl->Release();
      }
    }
    if (sessions) sessions->Release();
    if (mgr) mgr->Release();
    dev->Release();
  }
  devices->Release();
  en->Release();

  std::string json = "[";
  for (size_t i = 0; i < out.size(); i++) {
    if (i) json += ",";
    json += "{\"pid\":" + std::to_string(out[i].pid) + ",\"exe\":\"" + jsonEscape(narrow(out[i].exe)) + "\",\"active\":" + (out[i].active ? "true" : "false") + "}";
  }
  json += "]";
  emit(json);
  return 0;
}

static std::atomic<bool> g_stop{false};

static BOOL WINAPI onCtrl(DWORD) {
  g_stop = true;
  return TRUE;
}

static std::unique_ptr<Stream> openApp(const std::wstring& outDir, DWORD pid) {
  auto s = std::make_unique<Stream>();
  s->name = "app-" + std::to_string(pid);
  s->pid = pid;
  s->channels = 2;
  HRESULT hr = openProcessLoopback(*s);
  if (SUCCEEDED(hr)) hr = prepare(*s);
  if (FAILED(hr)) {
    emitError("Could not capture process " + std::to_string(pid) + " (needs Windows 10 2004 or later)", hr);
    return nullptr;
  }
  if (!s->wav.open(outDir + L"\\app-" + std::to_wstring(pid) + L".wav", 2)) {
    emitError("Cannot write output file");
    return nullptr;
  }
  return s;
}

static int cmdListMics() {
  IMMDeviceEnumerator* en = nullptr;
  IMMDeviceCollection* devices = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&en);
  if (SUCCEEDED(hr)) hr = en->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &devices);
  if (FAILED(hr)) { emitError("Could not enumerate microphones", hr); return 1; }

  std::wstring defaultId;
  IMMDevice* def = nullptr;
  if (SUCCEEDED(en->GetDefaultAudioEndpoint(eCapture, eConsole, &def))) {
    LPWSTR id = nullptr;
    if (SUCCEEDED(def->GetId(&id))) { defaultId = id; CoTaskMemFree(id); }
    def->Release();
  }

  std::string json = "[";
  UINT count = 0;
  devices->GetCount(&count);
  for (UINT i = 0; i < count; i++) {
    IMMDevice* dev = nullptr;
    if (FAILED(devices->Item(i, &dev))) continue;
    LPWSTR id = nullptr;
    std::wstring name = L"Microphone";
    IPropertyStore* props = nullptr;
    if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props))) {
      PROPVARIANT v;
      PropVariantInit(&v);
      if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) name = v.pwszVal;
      PropVariantClear(&v);
      props->Release();
    }
    if (SUCCEEDED(dev->GetId(&id))) {
      if (json.size() > 1) json += ",";
      json += "{\"id\":\"" + jsonEscape(narrow(id)) + "\",\"name\":\"" + jsonEscape(narrow(name)) + "\",\"default\":" +
              (defaultId == id ? "true" : "false") + "}";
      CoTaskMemFree(id);
    }
    dev->Release();
  }
  devices->Release();
  en->Release();
  emit(json + "]");
  return 0;
}

static int cmdCapture(const std::wstring& outDir, const std::vector<DWORD>& pids, bool mic, const std::wstring& micId) {
  std::vector<std::unique_ptr<Stream>> streams;
  for (DWORD pid : pids) {
    if (auto s = openApp(outDir, pid)) streams.push_back(std::move(s));
  }
  if (mic) {
    auto s = std::make_unique<Stream>();
    s->name = "you";
    s->channels = 1;
    HRESULT hr = openMicrophone(*s, micId);
    if (SUCCEEDED(hr)) hr = prepare(*s);
    if (FAILED(hr)) emitError("Could not open the microphone", hr);
    else if (!s->wav.open(outDir + L"\\you.wav", 1)) { emitError("Cannot write output file"); return 1; }
    else streams.push_back(std::move(s));
  }
  if (streams.empty() && pids.empty()) { emitError("Nothing to capture"); return 2; }

  SetConsoleCtrlHandler(onCtrl, TRUE);
  const int64_t t0 = qpcNow100ns();
  for (auto& s : streams) s->thread = std::thread(captureLoop, s.get(), t0, &g_stop);
  emit("{\"event\":\"started\"}");

  // stdin commands: "add <pid>" starts capturing another process (an app that joined late;
  // its track begins with silence back to t0 so it stays aligned). "stop" or EOF ends the capture.
  std::mutex pendingLock;
  std::vector<DWORD> pending;
  std::thread input([&pendingLock, &pending] {
    std::string line;
    while (!g_stop && std::getline(std::cin, line)) {
      if (line.rfind("stop", 0) == 0) break;
      if (line.rfind("add ", 0) == 0) {
        DWORD pid = (DWORD)strtoul(line.c_str() + 4, nullptr, 10);
        if (pid) {
          std::lock_guard<std::mutex> lock(pendingLock);
          pending.push_back(pid);
        }
      }
    }
    g_stop = true;
  });
  input.detach();

  while (!g_stop) {
    Sleep(1000);
    std::vector<DWORD> toAdd;
    {
      std::lock_guard<std::mutex> lock(pendingLock);
      toAdd.swap(pending);
    }
    for (DWORD pid : toAdd) {
      bool have = false;
      for (auto& s : streams) have = have || s->pid == pid;
      if (have) continue;
      if (auto s = openApp(outDir, pid)) {
        s->thread = std::thread(captureLoop, s.get(), t0, &g_stop);
        emit("{\"event\":\"added\",\"pid\":" + std::to_string(pid) + "}");
        streams.push_back(std::move(s));
      }
    }
    std::string json = "{\"event\":\"status\",\"tracks\":[";
    for (size_t i = 0; i < streams.size(); i++) {
      if (i) json += ",";
      char peak[16];
      snprintf(peak, sizeof peak, "%.3f", streams[i]->peak.exchange(0.f));
      json += "{\"name\":\"" + streams[i]->name + "\",\"frames\":" + std::to_string(streams[i]->wav.frames()) + ",\"peak\":" + peak + "}";
    }
    emit(json + "]}");
  }

  for (auto& s : streams) if (s->thread.joinable()) s->thread.join();

  // Pad every track to the same end time, then finalize headers.
  const uint64_t endFrames = (uint64_t)((qpcNow100ns() - t0) * (int64_t)kRate / 10000000ll);
  std::string files = "[";
  for (size_t i = 0; i < streams.size(); i++) {
    auto& s = streams[i];
    if (s->wav.frames() < endFrames) s->wav.writeSilence(endFrames - s->wav.frames());
    s->wav.close();
    if (s->capture) s->capture->Release();
    if (s->client) s->client->Release();
    if (s->event) CloseHandle(s->event);
    if (i) files += ",";
    files += "\"" + s->name + "\"";
  }
  emit("{\"event\":\"stopped\",\"tracks\":" + files + "]}");
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) { emitError("COM init failed", hr); return 1; }
  if (argc < 2) {
    fprintf(stderr, "usage: scribe-audiotap list | list-mics | capture --out-dir DIR [--pid N]... [--mic [--mic-id ID]]\n");
    return 64;
  }
  std::wstring cmd = argv[1];
  int rc = 64;
  if (cmd == L"list") {
    rc = cmdList();
  } else if (cmd == L"list-mics") {
    rc = cmdListMics();
  } else if (cmd == L"capture") {
    std::wstring outDir;
    std::vector<DWORD> pids;
    bool mic = false;
    std::wstring micId;
    for (int i = 2; i < argc; i++) {
      std::wstring a = argv[i];
      if (a == L"--out-dir" && i + 1 < argc) outDir = argv[++i];
      else if (a == L"--pid" && i + 1 < argc) pids.push_back((DWORD)_wtoi(argv[++i]));
      else if (a == L"--mic") mic = true;
      else if (a == L"--mic-id" && i + 1 < argc) micId = argv[++i];
    }
    if (outDir.empty()) { emitError("--out-dir is required"); rc = 64; }
    else rc = cmdCapture(outDir, pids, mic, micId);
  }
  CoUninitialize();
  return rc;
}
