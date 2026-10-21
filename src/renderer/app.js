'use strict';

const $ = (id) => document.getElementById(id);
const api = window.scribe;

const state = {
  tab: 'summary',
  sessions: [],
  activeId: null,
  active: null,
  busy: false,
  recorder: null,
};

/* ---------- helpers ---------- */

function fmtTime(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

let toastTimer;
function toast(msg, bad = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (bad ? ' bad' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), bad ? 6000 : 3500);
}

function errMsg(err) {
  // Electron prefixes IPC errors with "Error invoking remote method '...': Error: "
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function show(view) {
  for (const v of ['viewCapture', 'viewProcess', 'viewSession']) $(v).hidden = v !== view;
}

/* ---------- sessions list ---------- */

async function refreshList() {
  state.sessions = await api.listSessions();
  const ul = $('sessionList');
  ul.innerHTML = '';
  if (!state.sessions.length) {
    ul.innerHTML = '<li class="empty">No sessions yet. Record or import one.</li>';
    return;
  }
  for (const s of state.sessions) {
    const li = document.createElement('li');
    li.className = 'session-item' + (s.id === state.activeId ? ' active' : '');
    const dot = document.createElement('span');
    dot.className = 'dot ' + (s.status === 'done' ? '' : s.status);
    const body = document.createElement('div');
    body.style.minWidth = '0';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.title;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${fmtDate(s.createdAt)}${s.durationMs ? ' · ' + fmtTime(s.durationMs) : ''}`;
    body.append(name, sub);
    li.append(dot, body);
    li.addEventListener('click', () => openSession(s.id));
    ul.append(li);
  }
}

async function openSession(id) {
  if (state.busy && state.processingId === id) return show('viewProcess');
  try {
    state.active = await api.getSession(id);
  } catch (err) {
    return toast(errMsg(err), true);
  }
  state.activeId = id;
  if (!meetingUi.recording) hideLive();
  renderSession();
  show('viewSession');
  refreshList();
}

function renderSession() {
  const { meta, summary, segments } = state.active;
  $('sessionTitle').value = meta.title;
  $('sessionMeta').textContent = [fmtDate(meta.createdAt), meta.durationMs ? fmtTime(meta.durationMs) : null, meta.source, `${segments.length} segments`]
    .filter(Boolean)
    .join('  ·  ');

  const err = $('sessionError');
  err.hidden = meta.status !== 'error';
  err.textContent = meta.status === 'error' ? `Processing failed: ${meta.error || 'unknown error'}` : '';

  const hasSummary = !!summary;
  for (const id of ['notesBtn', 'claudeBtn', 'copyBtn']) $(id).disabled = !hasSummary || state.busy;
  $('driveBtn').disabled = state.busy;
  $('downloadBtn').disabled = state.busy;
  $('resumBtn').disabled = !segments.length || state.busy;

  fillTemplateSelect($('sessionTemplate'), meta.template || tplUi.defaultId);
  $('sessionTemplate').disabled = !segments.length || state.busy;
  renderSpeakerBar();

  $('summaryPane').innerHTML = hasSummary
    ? window.renderMarkdown(summary)
    : '<p class="empty">No summary yet.' + (segments.length ? ' Fix the issue above (or switch engine in Settings), then use Re-summarize.' : '') + '</p>';
  renderTranscript();
}

function renderTranscript() {
  const pane = $('transcriptPane');
  const q = $('transcriptFilter').value.trim().toLowerCase();
  const segs = state.active?.segments || [];
  const rows = segs.filter((s) => !q || s.text.toLowerCase().includes(q));
  if (!rows.length) {
    pane.innerHTML = `<p class="empty">${segs.length ? 'No matches.' : 'No transcript.'}</p>`;
    return;
  }
  const esc = window.escapeHtml;
  const re = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
  pane.innerHTML = rows
    .map((s) => {
      let text = esc(s.text);
      if (re) text = text.replace(re, (m) => `<mark>${m}</mark>`);
      const spk = s.speaker ? `<span class="spk ${roleClass(s)}">${esc(s.speaker)}</span>` : '';
      return `<div class="seg"><span class="t">${fmtTime(s.start)}</span><span>${spk}${text}</span></div>`;
    })
    .join('');
}

function roleClass(s) {
  return (s.role || (s.speaker === 'You' ? 'you' : 'app')) === 'you' ? 'you' : 'app';
}

/* ---------- speaker renaming (Transcript tab) ---------- */

function renderSpeakerBar() {
  const bar = $('speakerBar');
  const segs = state.active?.segments || [];
  const speakers = [];
  for (const s of segs) if (s.speaker && !speakers.some((x) => x.name === s.speaker)) speakers.push({ name: s.speaker, cls: roleClass(s) });
  bar.hidden = state.tab !== 'transcript' || !speakers.length;
  if (bar.hidden) return;
  const esc = window.escapeHtml;
  bar.innerHTML =
    '<span class="mic-label">Speakers</span>' +
    speakers
      .map((s) => `<button class="spk-chip" data-speaker="${esc(s.name)}" title="Rename ${esc(s.name)}"><span class="spk ${s.cls}">${esc(s.name)}</span><span class="pen">✎</span></button>`)
      .join('') +
    '<span class="fineprint">Click a name to rename it everywhere</span>';
}

$('speakerBar').addEventListener('click', (e) => {
  const chip = e.target.closest('.spk-chip');
  if (!chip || state.busy) return;
  const from = chip.dataset.speaker;
  const input = document.createElement('input');
  input.value = from;
  input.maxLength = 40;
  input.setAttribute('aria-label', `New name for ${from}`);
  chip.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const to = input.value.trim();
    if (!save || !to || to === from) return renderSpeakerBar();
    try {
      state.active = await api.renameSpeaker(state.activeId, from, to);
      renderSession();
      toast(`Renamed ${from} to ${to}`);
    } catch (err) {
      toast(errMsg(err), true);
      renderSpeakerBar();
    }
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') finish(true);
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
});

/* ---------- summary templates ---------- */

const ADD_OWN = '__add__';
const tplUi = { list: [], defaultId: 'meeting' };

async function loadTemplates() {
  try {
    const r = await api.listTemplates();
    tplUi.list = r.templates;
    tplUi.defaultId = r.defaultId;
  } catch (_) {
    /* keep what we had */
  }
}

function fillTemplateSelect(sel, value) {
  const esc = window.escapeHtml;
  const opt = (t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`;
  const own = tplUi.list.filter((t) => !t.builtin);
  sel.innerHTML =
    tplUi.list.filter((t) => t.builtin).map(opt).join('') +
    (own.length ? `<optgroup label="Your templates">${own.map(opt).join('')}</optgroup>` : '') +
    `<option value="${ADD_OWN}">+ Add your own…</option>`;
  sel.value = tplUi.list.some((t) => t.id === value) ? value : 'meeting';
  sel.dataset.prev = sel.value;
}

function captureTemplate() {
  const v = $('templateSelect').value;
  return v && v !== ADD_OWN ? v : undefined;
}

/** A template select changed: "+ Add your own…" opens the editor, then selects the new template. */
function onTemplatePick(sel, onPicked) {
  sel.addEventListener('change', () => {
    if (sel.value !== ADD_OWN) {
      sel.dataset.prev = sel.value;
      return onPicked?.(sel.value);
    }
    const prev = sel.dataset.prev || 'meeting';
    sel.value = prev;
    openTemplateDialog(null, (savedId) => {
      fillTemplateSelect(sel, savedId);
      onPicked?.(savedId);
    });
  });
}

onTemplatePick($('templateSelect'));
onTemplatePick($('defaultTemplateSelect'), () => renderCustomTemplateList());
onTemplatePick($('sessionTemplate'), (id) => {
  if (!state.active || id === (state.active.meta.template || tplUi.defaultId)) return;
  const name = tplUi.list.find((t) => t.id === id)?.name || 'this template';
  toast(`Re-writing the summary as ${name}…`);
  resummarize(id);
});

function renderCustomTemplateList() {
  const esc = window.escapeHtml;
  const own = tplUi.list.filter((t) => !t.builtin);
  $('customTemplateList').innerHTML = own.length
    ? own
        .map(
          (t) =>
            `<li><span class="tpl-name">${esc(t.name)}</span><button type="button" class="btn btn-ghost btn-sm" data-edit="${esc(t.id)}">Edit</button><button type="button" class="btn btn-ghost btn-sm btn-danger" data-del="${esc(t.id)}">Delete</button></li>`
        )
        .join('')
    : '<li class="empty">None yet. Add one for the kind of conversations you record most.</li>';
}

async function refreshTemplateSelects(keep = {}) {
  await loadTemplates();
  fillTemplateSelect($('templateSelect'), keep.capture ?? $('templateSelect').value);
  fillTemplateSelect($('defaultTemplateSelect'), keep.def ?? $('defaultTemplateSelect').value);
  if (state.active) fillTemplateSelect($('sessionTemplate'), state.active.meta.template || tplUi.defaultId);
  renderCustomTemplateList();
}

$('addTemplateBtn').addEventListener('click', () => openTemplateDialog(null, () => refreshTemplateSelects()));
$('customTemplateList').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]');
  const del = e.target.closest('[data-del]');
  if (edit) {
    const t = tplUi.list.find((x) => x.id === edit.dataset.edit);
    if (t) openTemplateDialog(t, () => refreshTemplateSelects());
  } else if (del) {
    await deleteTemplate(del.dataset.del);
  }
});

async function deleteTemplate(id) {
  const t = tplUi.list.find((x) => x.id === id);
  if (!t || !confirm(`Delete the template "${t.name}"? Summaries already written with it are kept.`)) return false;
  try {
    await api.deleteTemplate(id);
    await refreshTemplateSelects({ def: $('defaultTemplateSelect').value === id ? 'meeting' : undefined, capture: $('templateSelect').value === id ? 'meeting' : undefined });
    toast(`Deleted "${t.name}"`);
    return true;
  } catch (err) {
    toast(errMsg(err), true);
    return false;
  }
}

let tplEditing = null; // { id, onSaved }

function openTemplateDialog(tpl, onSaved) {
  tplEditing = { id: tpl?.id || null, onSaved };
  $('templateDialogTitle').textContent = tpl ? 'Edit template' : 'New template';
  $('tplName').value = tpl?.name || '';
  $('tplInstructions').value = tpl?.instructions || '';
  $('tplError').textContent = '';
  $('tplDeleteBtn').hidden = !tpl;
  $('templateDialog').showModal();
  $('tplName').focus();
}

$('tplSaveBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    const r = await api.saveTemplate({ id: tplEditing?.id || undefined, name: $('tplName').value, instructions: $('tplInstructions').value });
    tplUi.list = r.templates;
    $('templateDialog').close('save');
    toast(`Saved template "${$('tplName').value.trim()}"`);
    await tplEditing?.onSaved?.(r.savedId);
    renderCustomTemplateList();
  } catch (err) {
    $('tplError').textContent = errMsg(err);
  }
});

$('tplCancelBtn').addEventListener('click', () => $('templateDialog').close('cancel'));
$('tplDeleteBtn').addEventListener('click', async () => {
  if (tplEditing?.id && (await deleteTemplate(tplEditing.id))) $('templateDialog').close('deleted');
});

/* Audio auto-deleted in the background (Settings → Storage): refresh what's on screen. */
api.onSessionsChanged(async ({ audioDeleted = [] } = {}) => {
  if (state.activeId && audioDeleted.includes(state.activeId) && !state.busy) {
    try {
      state.active = await api.getSession(state.activeId);
    } catch (_) {
      /* ignore */
    }
  }
});

/* ---------- tabs ---------- */

document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    const isTranscript = tab.dataset.tab === 'transcript';
    state.tab = tab.dataset.tab;
    $('summaryPane').hidden = isTranscript;
    $('transcriptPane').hidden = !isTranscript;
    $('transcriptFilter').hidden = !isTranscript;
    $('sessionTplWrap').hidden = isTranscript;
    renderSpeakerBar();
  })
);
$('transcriptFilter').addEventListener('input', renderTranscript);

/* ---------- processing ---------- */

const STAGES = ['convert', 'model', 'transcribe', 'summarize'];

function resetStages() {
  document.querySelectorAll('.stages li').forEach((li) => {
    li.className = '';
    li.querySelector('i').style.width = '0';
  });
  $('processMsg').textContent = '';
}

api.onProgress(({ id, stage, progress, message }) => {
  if (id !== state.processingId) return;
  $('processMsg').textContent = message || '';
  const idx = STAGES.indexOf(stage);
  if (idx === -1) return;
  document.querySelectorAll('.stages li').forEach((li) => {
    const i = STAGES.indexOf(li.dataset.stage);
    if (i < idx) {
      li.className = 'done';
      li.querySelector('i').style.width = '100%';
    } else if (i === idx) {
      li.className = progress >= 1 ? 'done' : 'active';
      li.querySelector('i').style.width = `${Math.round(progress * 100)}%`;
    }
  });
});

function process(inputPath, title) {
  return runCapture(() => api.run(inputPath, title, captureTemplate()), title);
}

/** Show the processing view while runner() (a pipeline IPC call) works, then open the result. */
async function runCapture(runner, title) {
  if (state.busy) return toast('Already processing a recording.', true);
  state.busy = true;
  state.processingId = null;
  resetStages();
  $('processTitle').textContent = title || 'New conversation';
  show('viewProcess');

  // The session id arrives with the first progress event; capture it.
  const off = api.onProgress((p) => {
    if (!state.processingId) state.processingId = p.id;
  });
  setTimeout(refreshList, 300);

  try {
    const result = await runner();
    state.busy = false;
    toast('Summary ready');
    $('titleInput').value = '';
    await refreshList();
    await openSession(result.meta.id);
  } catch (err) {
    state.busy = false;
    const msg = errMsg(err);
    toast(msg === 'Cancelled' ? 'Cancelled' : msg, msg !== 'Cancelled');
    await refreshList();
    if (state.processingId) await openSession(state.processingId);
    else show('viewCapture');
  } finally {
    off();
    state.processingId = null;
  }
}

$('cancelBtn').addEventListener('click', () => api.cancel());

$('importBtn').addEventListener('click', async () => {
  const file = await api.pickAudio();
  if (file) process(file, $('titleInput').value.trim());
});

/* ---------- recording ---------- */

let meterRaf;
let timerInt;

async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    return toast(`Microphone unavailable: ${err.message}`, true);
  }
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    stopMeter();
    const blob = new Blob(chunks, { type: mime });
    if (blob.size < 2000) return toast('Recording was empty.', true);
    const path = await api.saveRecording(await blob.arrayBuffer());
    process(path, $('titleInput').value.trim());
  };
  recorder.start(1000);
  state.recorder = recorder;

  const started = Date.now();
  $('recordBtn').classList.add('recording');
  $('recordTime').classList.add('live');
  $('recordHint').textContent = 'Recording… press again to stop and summarize';
  timerInt = setInterval(() => ($('recordTime').textContent = fmtTime(Date.now() - started)), 250);
  startMeter(stream);
}

function stopRecording() {
  clearInterval(timerInt);
  $('recordBtn').classList.remove('recording');
  $('recordTime').classList.remove('live');
  $('recordTime').textContent = '00:00';
  $('recordHint').textContent = 'Press to record from your microphone';
  state.recorder?.stop();
  state.recorder = null;
}

function startMeter(stream) {
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const canvas = $('meter');
  const g = canvas.getContext('2d');
  const bars = 40;
  const draw = () => {
    analyser.getByteFrequencyData(data);
    g.clearRect(0, 0, canvas.width, canvas.height);
    const w = canvas.width / bars;
    for (let i = 0; i < bars; i++) {
      const v = data[Math.floor((i / bars) * data.length * 0.7)] / 255;
      const h = Math.max(2, v * canvas.height);
      g.fillStyle = i / bars < 0.5 ? `rgba(0, 229, 255, ${0.35 + v * 0.65})` : `rgba(255, 46, 136, ${0.35 + v * 0.65})`;
      g.fillRect(i * w + 1, (canvas.height - h) / 2, w - 3, h);
    }
    meterRaf = requestAnimationFrame(draw);
  };
  draw();
  startMeter.ctx = ctx;
}

function stopMeter() {
  cancelAnimationFrame(meterRaf);
  startMeter.ctx?.close();
  const c = $('meter');
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
}

$('recordBtn').addEventListener('click', () => {
  if (state.busy) return toast('Wait for the current recording to finish processing.', true);
  if (state.mode === 'meeting') return toggleMeeting();
  if (state.nativeCapture) return toggleMeeting({ micOnly: true }); // picker + live transcript
  if (state.recorder) stopRecording();
  else startRecording();
});

/* ---------- Meeting mode ---------- */

state.mode = 'mic';
const meetingUi = { sources: [], selected: new Set(), recording: false, timer: null, started: 0, lastBytes: {}, offStatus: null };

/* Microphone picker (native capture only; the browser fallback always uses the default mic). */
async function loadMics() {
  if (!state.nativeCapture) return;
  const [mics, cfg] = await Promise.all([api.listMics().catch(() => []), api.getSettings()]);
  const esc = window.escapeHtml;
  const sel = $('micSelect');
  const keep = sel.value || cfg.micDevice || '';
  sel.innerHTML = '<option value="">System default</option>' +
    mics.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}${m.isDefault ? ' (default)' : ''}</option>`).join('');
  // A remembered mic that's unplugged shows as missing rather than silently switching.
  if (keep && !mics.some((m) => m.id === keep)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(keep)}">Saved mic (not connected)</option>`);
  sel.value = keep;
  syncMicRow();
}

function syncMicRow() {
  const needsMic = state.mode === 'mic' || $('meetingMic').checked;
  $('micRow').hidden = !state.nativeCapture || !needsMic;
}

$('meetingMic').addEventListener('change', syncMicRow);
$('micSelect').addEventListener('focus', loadMics);

function setMode(mode) {
  if (state.recorder || meetingUi.recording) return;
  state.mode = mode;
  document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('meetingPanel').hidden = mode !== 'meeting';
  $('importBlock').hidden = mode === 'meeting';
  $('meter').hidden = mode === 'meeting' || state.nativeCapture;
  syncMicRow();
  $('recordHint').textContent = mode === 'meeting' ? 'Press to start recording the meeting' : 'Press to record from your microphone';
  if (mode === 'meeting') loadMeetingSources();
}

document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('meetingRefresh').addEventListener('click', () => loadMeetingSources());

async function loadMeetingSources() {
  const avail = await api.meetingAvailable();
  $('meetingUnavailable').hidden = avail.ok;
  $('meetingUnavailable').textContent = avail.ok ? '' : avail.reason;
  $('recordBtn').disabled = !avail.ok;
  if (!avail.ok) return;

  const cfg = await api.getSettings();
  if (!meetingUi.loadedPrefs) {
    (cfg.meetingApps || []).forEach((k) => meetingUi.selected.add(k));
    $('meetingMic').checked = cfg.meetingMic !== false;
    meetingUi.loadedPrefs = true;
  }
  try {
    meetingUi.sources = await api.meetingSources();
  } catch (err) {
    meetingUi.sources = [];
    toast(`Could not list apps: ${errMsg(err)}`, true);
  }
  renderMeetingSources();
}

function renderMeetingSources() {
  const ul = $('meetingApps');
  const esc = window.escapeHtml;
  const playing = new Map(meetingUi.sources.map((s) => [s.id, s]));
  // Remembered apps that aren't playing right now still show, so they get picked up when they start.
  const rows = [...meetingUi.sources];
  for (const k of meetingUi.selected) if (!playing.has(k)) rows.push({ id: k, name: k.replace(/^\w/, (c) => c.toUpperCase()), waiting: true });
  if (!rows.length) {
    ul.innerHTML = '<li class="empty">No apps are playing sound right now. Join your call, then press Refresh.</li>';
    return;
  }
  ul.innerHTML = rows
    .map((s) => {
      const on = meetingUi.selected.has(s.id);
      const stateText = s.waiting ? 'waiting for audio' : 'playing';
      return `<li data-id="${esc(s.id)}" class="${on ? 'on' : ''}">
        <input type="checkbox" ${on ? 'checked' : ''} tabindex="-1" />
        <span class="app-name">${esc(s.name)}</span>
        <span class="app-state ${s.waiting ? '' : 'playing'}">${stateText}</span>
      </li>`;
    })
    .join('');
  ul.querySelectorAll('li[data-id]').forEach((li) =>
    li.addEventListener('click', () => {
      if (meetingUi.recording) return;
      const id = li.dataset.id;
      if (meetingUi.selected.has(id)) meetingUi.selected.delete(id);
      else meetingUi.selected.add(id);
      renderMeetingSources();
    })
  );
}

async function toggleMeeting({ micOnly = false } = {}) {
  if (meetingUi.recording) return stopMeeting();
  const appKeys = micOnly ? [] : [...meetingUi.selected];
  const mic = micOnly ? true : $('meetingMic').checked;
  if (!appKeys.length && !mic) return toast('Tick at least one app or include your microphone.', true);
  const micId = $('micSelect').value;
  try {
    await api.meetingStart(appKeys, mic, micId, micOnly);
  } catch (err) {
    return toast(errMsg(err), true);
  }
  meetingUi.micOnly = micOnly;
  meetingUi.recording = true;
  $('micSelect').disabled = true;
  startLive();
  meetingUi.started = Date.now();
  meetingUi.lastBytes = {};
  document.querySelectorAll('.mode').forEach((b) => (b.disabled = true));
  $('meetingPanel').classList.add('locked');
  $('recordBtn').classList.add('recording');
  $('recordTime').classList.add('live');
  $('recordHint').textContent = micOnly ? 'Recording… press again to stop and summarize' : 'Recording the meeting… press again to stop and summarize';
  $('meetingLive').hidden = false;
  renderMeetingLive({ linkedApps: [], tracks: [] });
  meetingUi.timer = setInterval(() => ($('recordTime').textContent = fmtTime(Date.now() - meetingUi.started)), 250);
  meetingUi.offStatus = api.onMeetingStatus(renderMeetingLive);
}

function renderMeetingLive(s) {
  const esc = window.escapeHtml;
  const chips = [];
  for (const t of s.tracks || []) {
    const prev = meetingUi.lastBytes[t.speaker] ?? 0;
    const receiving = t.peak !== undefined ? t.peak > 0.01 : t.bytes > prev;
    meetingUi.lastBytes[t.speaker] = t.bytes;
    chips.push(`<span class="chip ${receiving ? 'live' : ''}"><i></i>${esc(t.speaker)}</span>`);
  }
  if (meetingUi.selected.size && !(s.linkedApps || []).length) {
    chips.push('<span class="chip warn"><i></i>waiting for app audio</span>');
  }
  if (s.error) chips.push(`<span class="chip warn"><i></i>${esc(s.error).slice(0, 80)}</span>`);
  $('meetingLive').innerHTML = chips.join('');
}

async function stopMeeting() {
  clearInterval(meetingUi.timer);
  meetingUi.offStatus?.();
  meetingUi.recording = false;
  stopLive();
  $('micSelect').disabled = false;
  document.querySelectorAll('.mode').forEach((b) => (b.disabled = false));
  $('meetingPanel').classList.remove('locked');
  $('recordBtn').classList.remove('recording');
  $('recordTime').classList.remove('live');
  $('recordTime').textContent = '00:00';
  $('meetingLive').hidden = true;
  $('recordHint').textContent = meetingUi.micOnly ? 'Press to record from your microphone' : 'Press to start recording the meeting';
  let result;
  try {
    result = await api.meetingStop();
  } catch (err) {
    return toast(errMsg(err), true);
  }
  const title = $('titleInput').value.trim();
  if (meetingUi.micOnly) {
    // Plain mic recording: no speaker labels needed.
    const file = result.tracks[0].path;
    return runCapture(() => api.run(file, title, captureTemplate()), title);
  }
  const source = result.apps.length ? `Meeting: ${result.apps.join(', ')}` : 'Meeting (mic only)';
  runCapture(() => api.runTracks(result.tracks, title, source, captureTemplate()), title || source);
}

/* ---------- session actions ---------- */

async function action(fn) {
  try {
    await fn();
  } catch (err) {
    toast(errMsg(err), true);
  }
}

$('notesBtn').addEventListener('click', () =>
  action(async () => {
    const cfg = await api.getSettings();
    if (!cfg.notesFolder) {
      toast('Pick your Null Notes vault first.', true);
      return openSettings();
    }
    const r = await api.sendToNotes(state.activeId);
    const where = r.file.split(/[\\/]/).slice(-2).join('/');
    toast(r.opened ? `Saved to Null Notes (${where}). Opening it…` : `Saved to Null Notes: ${where}`);
  })
);

/* Send to Null Drive: a small sheet to pick what to upload (defaults from Settings). */
async function openDriveSheet() {
  const cfg = await api.getSettings();
  $('driveMd').checked = cfg.driveSendMd !== false;
  $('drivePdf').checked = !!cfg.driveSendPdf;
  const noAudio = !!state.active?.meta.audioDeletedAt;
  $('driveAudio').checked = !!cfg.driveSendAudio && !noAudio;
  $('driveAudio').disabled = noAudio;
  $('driveAudio').closest('label').title = noAudio ? 'The audio was deleted automatically (Settings → Storage)' : '';
  $('driveAudioFmt').value = cfg.driveAudioFormat || 'mp3';
  const tok = await api.driveTokenStatus();
  const ready = cfg.driveAddress && tok.saved;
  $('driveDest').textContent = ready ? `→ ${cfg.driveAddress.replace(/\/+$/, '')}  /  ${cfg.driveFolder || 'Null Scribe'}/` : 'Null Drive isn’t set up yet. Add the address and a token in Settings.';
  $('driveUploadBtn').textContent = ready ? 'Upload' : 'Set up Null Drive…';
  $('driveUploadBtn').dataset.ready = ready ? '1' : '';
  $('driveSheet').hidden = false;
  $('driveBtn').setAttribute('aria-expanded', 'true');
}
function closeDriveSheet() {
  $('driveSheet').hidden = true;
  $('driveBtn').setAttribute('aria-expanded', 'false');
}
$('driveBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  closeDownloadMenu();
  if ($('driveSheet').hidden) openDriveSheet();
  else closeDriveSheet();
});
$('driveUploadBtn').addEventListener('click', () => {
  if (!$('driveUploadBtn').dataset.ready) {
    closeDriveSheet();
    return openSettings();
  }
  const opts = { id: state.activeId, md: $('driveMd').checked, pdf: $('drivePdf').checked, audio: $('driveAudio').checked, audioFormat: $('driveAudioFmt').value };
  closeDriveSheet();
  action(async () => {
    toast('Uploading to Null Drive…');
    const r = await api.sendToDrive(opts);
    const n = r.uploaded.length;
    toast(`Uploaded ${n} file${n === 1 ? '' : 's'} to Null Drive → ${r.folder}/`);
  });
});

$('claudeBtn').addEventListener('click', () =>
  action(async () => {
    await api.openInClaude(state.activeId);
    toast('Copied to clipboard. Paste it into the new Claude chat (Ctrl+V).');
  })
);

/* Download menu: transcript (md/txt/pdf/html) and audio (mp3/m4a/wav/flac/ogg). */
let exportFormats = null;

async function openDownloadMenu() {
  exportFormats = exportFormats || (await api.exportFormats());
  const esc = window.escapeHtml;
  const item = (kind, f, right) => `<button class="dl-item" role="menuitem" data-kind="${kind}" data-id="${f.id}"><span>${esc(f.label)}</span><span class="ext">${esc(right)}</span></button>`;
  $('downloadMenu').innerHTML =
    '<div class="dl-group">Transcript</div>' +
    exportFormats.transcript.map((f) => item('transcript', f, `.${f.ext}`)).join('') +
    '<div class="dl-sep"></div><div class="dl-group">Audio</div>' +
    (state.active?.meta.audioDeletedAt
      ? exportFormats.audio.map((f) => item('audio', f, 'auto-deleted').replace('<button', '<button disabled title="The audio was deleted automatically (Settings → Storage)"')).join('')
      : exportFormats.audio.map((f) => item('audio', f, f.note)).join(''));
  $('downloadMenu').hidden = false;
  $('downloadBtn').setAttribute('aria-expanded', 'true');
  $('downloadMenu').querySelector('.dl-item')?.focus();
}

function closeDownloadMenu() {
  $('downloadMenu').hidden = true;
  $('downloadBtn').setAttribute('aria-expanded', 'false');
}

$('downloadBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  closeDriveSheet();
  if ($('downloadMenu').hidden) openDownloadMenu();
  else closeDownloadMenu();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.dl-wrap')) {
    closeDownloadMenu();
    closeDriveSheet();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeDownloadMenu();
    closeDriveSheet();
  }
});
$('downloadMenu').addEventListener('click', (e) => {
  const btn = e.target.closest('.dl-item');
  if (!btn) return;
  closeDownloadMenu();
  const { kind, id } = btn.dataset;
  action(async () => {
    toast(kind === 'audio' ? 'Preparing audio…' : 'Preparing file…');
    const file = kind === 'audio' ? await api.exportAudio(state.activeId, id) : await api.exportTranscript(state.activeId, id);
    if (file) toast(`Saved ${file.split(/[\\/]/).pop()}`);
  });
});

$('copyBtn').addEventListener('click', () =>
  action(async () => {
    await api.copyText(state.active.summary);
    toast('Summary copied');
  })
);

$('resumBtn').addEventListener('click', () => resummarize());

function resummarize(templateId) {
  return action(async () => {
    state.busy = true;
    state.processingId = state.activeId;
    resetStages();
    ['convert', 'model', 'transcribe'].forEach((s) => {
      const li = document.querySelector(`.stages li[data-stage="${s}"]`);
      li.className = 'done';
      li.querySelector('i').style.width = '100%';
    });
    $('processTitle').textContent = state.active.meta.title;
    show('viewProcess');
    try {
      state.active = await api.rerunSummary(state.activeId, templateId);
      toast('Summary updated');
    } finally {
      state.busy = false;
      state.processingId = null;
      await openSession(state.activeId);
    }
  });
}

$('deleteBtn').addEventListener('click', () =>
  action(async () => {
    if (!confirm(`Delete "${state.active.meta.title}"? The recording, transcript and summary are removed from this device.`)) return;
    await api.deleteSession(state.activeId);
    state.activeId = null;
    state.active = null;
    await refreshList();
    show('viewCapture');
  })
);

$('sessionTitle').addEventListener('change', () =>
  action(async () => {
    state.active = await api.renameSession(state.activeId, $('sessionTitle').value);
    await refreshList();
  })
);
$('sessionTitle').addEventListener('keydown', (e) => e.key === 'Enter' && e.target.blur());

$('newBtn').addEventListener('click', () => {
  if (state.busy) return show('viewProcess');
  state.activeId = null;
  refreshList();
  show('viewCapture');
  $('titleInput').focus();
});

/* ---------- settings ---------- */

const form = $('settingsForm');

let llmModels = [];

function syncEngineUi() {
  const builtin = form.elements.summaryEngine.value === 'builtin';
  $('builtinBox').hidden = !builtin;
  $('ollamaBox').hidden = builtin;
  const m = llmModels.find((x) => x.id === form.elements.builtinModel.value);
  $('builtinInfo').textContent = m
    ? `${m.downloaded ? 'Downloaded.' : 'Downloads once, on first summary.'} License: ${m.license}. Needs about 4 GB of free RAM.${m.id.startsWith('llama') ? ' Built with Llama.' : ''}`
    : '';
}

async function openSettings() {
  const [cfg, models] = await Promise.all([api.getSettings(), api.whisperModels()]);
  const esc = window.escapeHtml;
  llmModels = models.llm;
  await loadTemplates();
  fillTemplateSelect($('defaultTemplateSelect'), tplUi.defaultId);
  renderCustomTemplateList();
  $('whisperSelect').innerHTML = models.whisper.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('');
  $('builtinSelect').innerHTML = models.llm.map((m) => `<option value="${m.id}">${esc(m.label)}${m.downloaded ? ' ✓' : ''}</option>`).join('');
  for (const [k, v] of Object.entries(cfg)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = v !== false;
    else el.value = v;
  }
  $('ollamaStatus').textContent = '';
  $('ollamaStatus').className = 'status mono';
  syncEngineUi();
  await loadVaults(cfg.notesFolder);
  const tok = await api.driveTokenStatus();
  $('driveToken').value = '';
  $('driveToken').placeholder = tok.saved ? 'Saved ✓ (paste a new token to replace it)' : 'Paste a token from Null Drive → Devices';
  setDriveStatus(tok.saved && !tok.secure ? 'No system keychain found: the token is kept only until Null Scribe closes.' : '', 'warn');
  $('settingsDialog').showModal();
}

/* Null Notes vault picker: suggests the vaults Null Notes has opened recently. */
async function loadVaults(current) {
  const vaults = await api.notesVaults().catch(() => []);
  const esc = window.escapeHtml;
  const short = (p) => (p.length > 48 ? `…${p.slice(-46)}` : p);
  const opts = vaults.map((v) => ({ value: v.path, label: `${v.name}  —  ${short(v.path)}` }));
  if (current && !vaults.some((v) => v.path === current)) opts.unshift({ value: current, label: current });
  $('vaultSelect').innerHTML =
    (opts.length ? '' : '<option value="">No Null Notes vault found. Choose a folder…</option>') +
    opts.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  $('vaultSelect').value = current || (opts[0]?.value ?? '');
  form.elements.notesFolder.value = $('vaultSelect').value;
}
$('vaultSelect').addEventListener('change', () => (form.elements.notesFolder.value = $('vaultSelect').value));

function setDriveStatus(text, kind = '') {
  $('driveStatus').textContent = text;
  $('driveStatus').className = `status${kind === 'ok' ? ' ok' : kind === 'bad' ? ' bad' : kind === 'warn' ? ' warn' : ''}`;
}

$('driveTestBtn').addEventListener('click', async () => {
  setDriveStatus('Connecting…');
  const r = await api.driveTest(form.elements.driveAddress.value.trim(), $('driveToken').value.trim() || undefined);
  if (!r.ok) return setDriveStatus(r.error, 'bad');
  const who = `Connected as ${r.username}${r.device ? ` · token “${r.device}”` : ''}`;
  if (r.e2ee !== 'off') return setDriveStatus(`${who} · this account is end-to-end encrypted, so uploads go through Null Notes instead.`, 'warn');
  setDriveStatus(`${who} · ready to upload`, 'ok');
});

$('settingsBtn').addEventListener('click', openSettings);
$('engineSelect').addEventListener('change', syncEngineUi);
$('builtinSelect').addEventListener('change', syncEngineUi);

$('testOllamaBtn').addEventListener('click', async () => {
  const status = $('ollamaStatus');
  status.textContent = 'Connecting…';
  status.className = 'status mono';
  const r = await api.testOllama(form.elements.ollamaHost.value.trim());
  if (r.ok) {
    status.textContent = r.models.length ? `Connected · ${r.models.length} models: ${r.models.slice(0, 6).join(', ')}${r.models.length > 6 ? '…' : ''}` : 'Connected, but no models installed (ollama pull llama3.2:3b)';
    status.className = 'status mono ok';
    $('ollamaModels').innerHTML = r.models.map((m) => `<option value="${window.escapeHtml(m)}"></option>`).join('');
  } else {
    status.textContent = `Not reachable: ${r.error}`;
    status.className = 'status mono bad';
  }
});

$('pickFolderBtn').addEventListener('click', async () => {
  const dir = await api.pickFolder();
  if (!dir) return;
  if (![...$('vaultSelect').options].some((o) => o.value === dir)) {
    $('vaultSelect').insertAdjacentHTML('afterbegin', `<option value="${window.escapeHtml(dir)}">${window.escapeHtml(dir)}</option>`);
    [...$('vaultSelect').options].filter((o) => !o.value).forEach((o) => o.remove());
  }
  $('vaultSelect').value = dir;
  form.elements.notesFolder.value = dir;
});

$('settingsDialog').addEventListener('close', async () => {
  if ($('settingsDialog').returnValue !== 'save') return;
  const patch = {};
  for (const k of ['summaryEngine', 'builtinModel', 'ollamaHost', 'ollamaModel', 'whisperModel', 'language', 'notesFolder', 'chunkChars', 'driveAddress', 'driveFolder', 'driveAudioFormat', 'customWords', 'summaryTemplate']) {
    patch[k] = form.elements[k].value.trim();
  }
  if (patch.summaryTemplate === ADD_OWN) delete patch.summaryTemplate;
  patch.audioRetentionDays = Number(form.elements.audioRetentionDays.value) || 0;
  for (const k of ['notesOpenAfter', 'driveSendMd', 'driveSendPdf', 'driveSendAudio']) patch[k] = form.elements[k].checked;
  await api.setSettings(patch);
  const newToken = $('driveToken').value.trim();
  if (newToken) await api.driveSetToken(newToken);
  toast('Settings saved');
  await loadTemplates();
  fillTemplateSelect($('templateSelect'), tplUi.defaultId);
  // A new speech model or built-in model may need downloading first.
  await checkSetup();
});

/* ---------- live transcript panel (bottom-left) ---------- */

const liveUi = { off: [], lines: [] };

function startLive() {
  liveUi.lines = [];
  $('liveBody').innerHTML = '<div class="live-hint">Listening… lines appear every few seconds.</div>';
  $('liveTitle').textContent = 'Live transcript';
  $('liveDot').classList.remove('idle');
  $('liveCount').textContent = '';
  $('livePanel').hidden = false;
  liveUi.off.push(api.onLiveSegments(addLiveSegments));
  liveUi.off.push(
    api.onLiveNotice((text) => {
      $('liveBody').insertAdjacentHTML('beforeend', `<div class="live-hint">${window.escapeHtml(text)}</div>`);
    })
  );
}

function addLiveSegments(segments) {
  const body = $('liveBody');
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  body.querySelector('.live-hint')?.remove();
  liveUi.lines.push(...segments);
  liveUi.lines.sort((a, b) => a.start - b.start);
  const esc = window.escapeHtml;
  body.innerHTML = liveUi.lines
    .map((s) => {
      const spk = s.speaker ? `<span class="spk ${roleClass(s)}">${esc(s.speaker)}</span>` : '';
      return `<div class="live-line"><span class="t">${fmtTime(s.start)}</span><span>${spk}${esc(s.text)}</span></div>`;
    })
    .join('');
  $('liveCount').textContent = `${liveUi.lines.length}`;
  if (nearBottom) body.scrollTop = body.scrollHeight;
}

/** Recording stopped: keep the preview visible while the final transcript is made. */
function stopLive() {
  liveUi.off.forEach((off) => off());
  liveUi.off = [];
  $('liveDot').classList.add('idle');
  $('liveTitle').textContent = 'Preview — finalizing';
  if (!liveUi.lines.length) $('livePanel').hidden = true;
}

function hideLive() {
  $('livePanel').hidden = true;
}

/* ---------- first-run setup ---------- */

const setupState = { status: null, running: false, progress: {} };

function mb(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)} GB` : `${Math.round(n)} MB`;
}

function renderSetup() {
  const st = setupState.status;
  if (!st) return;
  $('setupItems').innerHTML = st.items
    .map((it) => {
      const p = it.downloaded ? 1 : setupState.progress[it.id] ?? 0;
      const sizeText = p >= 1 ? 'Ready ✓' : p > 0 ? `${mb(it.sizeMb * p)} / ${mb(it.sizeMb)}` : mb(it.sizeMb);
      return `<li class="setup-item lit${p >= 1 ? ' done' : ''}">
        <div class="row"><span class="label">${window.escapeHtml(it.label)}</span><span class="size">${sizeText}</span></div>
        <div class="bar"><i data-p="${p}"></i></div>
      </li>`;
    })
    .join('');
  // Widths are set from script: the page's CSP blocks inline style="" attributes.
  $('setupItems').querySelectorAll('.bar i').forEach((i) => (i.style.width = `${Math.round(Number(i.dataset.p) * 100)}%`));

  const parts = [];
  if (st.neededMb) parts.push(`${mb(st.neededMb)} to download`);
  if (st.freeMb != null) parts.push(`${mb(st.freeMb)} free on this drive`);
  $('setupSummary').textContent = parts.join(' · ');

  $('setupStartBtn').hidden = setupState.running;
  $('setupCancelBtn').hidden = !setupState.running;
  $('setupOllamaBtn').hidden = setupState.running || st.engine === 'ollama';

  const err = $('setupError');
  if (st.missingEngines?.length) {
    err.hidden = false;
    err.textContent = `This copy of Null Scribe is missing ${st.missingEngines.join(' and ')}. Please reinstall the app.`;
    $('setupStartBtn').disabled = true;
  }
}

async function runSetup() {
  setupState.running = true;
  $('setupError').hidden = true;
  renderSetup();
  try {
    setupState.status = await api.setupStart();
    setupState.running = false;
    if (setupState.status.ready) {
      $('setupScreen').hidden = true;
      toast('Null Scribe is ready');
      return;
    }
  } catch (err) {
    setupState.running = false;
    const msg = errMsg(err);
    $('setupError').hidden = false;
    $('setupError').textContent =
      msg === 'Cancelled'
        ? 'Paused. Press Download to continue.'
        : `${/^download failed/i.test(msg) ? msg : `Download failed: ${msg}`}. Check your connection and press Download to retry.`;
    $('setupStartBtn').textContent = 'Download';
    setupState.status = await api.setupStatus();
  }
  renderSetup();
}

api.onSetupProgress(({ id, progress }) => {
  setupState.progress[id] = progress;
  renderSetup();
});

$('setupStartBtn').addEventListener('click', runSetup);
$('setupCancelBtn').addEventListener('click', () => api.setupCancel());
$('setupOllamaBtn').addEventListener('click', async () => {
  await openSettings();
  form.elements.summaryEngine.value = 'ollama';
  syncEngineUi();
});

/** Show the setup screen if anything the current settings need is missing. Returns true if shown. */
async function checkSetup({ autoStart = false } = {}) {
  setupState.status = await api.setupStatus();
  if (setupState.status.ready) {
    $('setupScreen').hidden = true;
    return false;
  }
  setupState.progress = {};
  $('setupScreen').hidden = false;
  renderSetup();
  if (autoStart && !setupState.status.missingEngines.length) runSetup();
  return true;
}

/* ---------- boot ---------- */

document.addEventListener('keydown', (e) => {
  if (e.key === ',' && (e.ctrlKey || e.metaKey)) openSettings();
});

(async () => {
  await refreshList();
  await loadTemplates();
  fillTemplateSelect($('templateSelect'), tplUi.defaultId);
  const cfg = await api.getSettings();
  show('viewCapture');
  const avail = await api.meetingAvailable().catch(() => ({ ok: false }));
  state.nativeCapture = avail.ok;
  $('meter').hidden = state.nativeCapture;
  if (state.nativeCapture) {
    $('micRow').hidden = false;
    await loadMics();
  }
  await checkSetup({ autoStart: true });
})();
