// peerbox — peer-to-peer chat, calls, and file sharing.
// Walkie-talkie model: nothing is ever stored, not even locally, not
// even encrypted. Close the tab and the entire session is gone —
// that is the design, not a missing feature.
//
// A public PeerJS broker is used ONLY to introduce two browsers to each
// other (WebRTC signaling). It never sees chat text, files, or media.
// Swap PEER_SERVER_CONFIG to point at a self-hosted PeerServer later
// for full independence from any third-party broker.

const PEER_SERVER_CONFIG = undefined; // undefined = PeerJS free public broker

// Free public TURN servers (Open Relay Project). These relay encrypted
// traffic between peers so neither side ever sees the other's real IP
// address. Free tier has bandwidth/rate limits, which can cause the
// instability you saw on the iPhone test — a self-hosted coturn server
// removes that dependency once it's worth the monthly cost.
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:global.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

const CHUNK_SIZE = 64 * 1024;          // 64KB — fewer, larger frames than the original 16KB
const FILE_WARN_BYTES = 150 * 1024 * 1024;  // warn above 150MB
const FILE_HARD_CAP_BYTES = 500 * 1024 * 1024; // refuse above 500MB — protects browser memory
const ID_LENGTH = 12;                   // higher entropy: ~32^12 combinations, brute force is infeasible
const RECONNECT_ATTEMPTS = 3;
const CONNECT_COOLDOWN_MS = 1500;       // throttle repeated connect attempts client-side

const objectUrls = new Set(); // track blob URLs so wipe can revoke them
const fileUrls = new Map();   // file id -> its object URL, for the per-file close button

// ---- elements ----
const myIdEl = document.getElementById('my-id');
const copyBtn = document.getElementById('copy-id');
const peerInput = document.getElementById('peer-id-input');
const connectBtn = document.getElementById('connect-btn');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const msgInput = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');

const videoWrap = document.getElementById('video-wrap');
const remoteVideo = document.getElementById('remote-video');
const localVideo = document.getElementById('local-video');
const remoteAudio = document.getElementById('remote-audio');
const voiceBtn = document.getElementById('voice-btn');
const videoBtn = document.getElementById('video-btn');
const hangupBtn = document.getElementById('hangup-btn');

const fileDrop = document.getElementById('file-drop');
const fileInput = document.getElementById('file-input');
const attachBtn = document.getElementById('attach-btn');

// ---- state ----
let peer = null;
let conn = null;
let activeCall = null;
let localStream = null;
const incomingFiles = new Map();
let fileCounter = 0;
let lastConnectAttempt = 0;
let reconnectTries = 0;
let lastPeerId = null;
let manualDisconnect = false;
let pendingTarget = null; // the id we're currently trying to connect to, if any

// ---- helpers ----
function randomId(len = ID_LENGTH) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  const bytes = crypto.getRandomValues(new Uint8Array(len)); // CSPRNG, not Math.random
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function setStatus(text, isErr = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('err', isErr);
}

// XSS-safe: always build message nodes with textContent, never innerHTML with remote data
function logMsg(who, text, cls = '') {
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  const whoSpan = document.createElement('span');
  whoSpan.className = 'who';
  whoSpan.textContent = who + ':';
  div.appendChild(whoSpan);
  div.appendChild(document.createTextNode(text));
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function enableChat(enabled) {
  msgInput.disabled = !enabled;
  sendBtn.disabled = !enabled;
  attachBtn.disabled = !enabled;
  voiceBtn.disabled = !enabled;
  videoBtn.disabled = !enabled;
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// ---- doc worker: docx/xlsx parsing off the main thread ----
let docWorker = null;
let docWorkerReqId = 0;
const docWorkerCallbacks = new Map();

function getDocWorker() {
  if (!docWorker) {
    docWorker = new Worker('doc-worker.js');
    docWorker.onmessage = (e) => {
      const { reqId, ok, html, error } = e.data;
      const cb = docWorkerCallbacks.get(reqId);
      if (!cb) return;
      docWorkerCallbacks.delete(reqId);
      ok ? cb.resolve(html) : cb.reject(new Error(error));
    };
  }
  return docWorker;
}

function callDocWorker(kind, buffer) {
  return new Promise((resolve, reject) => {
    const reqId = ++docWorkerReqId;
    docWorkerCallbacks.set(reqId, { resolve, reject });
    getDocWorker().postMessage({ reqId, kind, buffer }, [buffer]); // transferred, not copied
  });
}

// ---- peer + data connection ----
function initPeer() {
  const id = randomId();
  const opts = Object.assign(
    { config: Object.assign({}, ICE_CONFIG, { iceTransportPolicy: 'relay' }) },
    PEER_SERVER_CONFIG || {}
  );
  peer = new Peer(id, opts);

  peer.on('open', (assignedId) => {
    myIdEl.textContent = assignedId;
    setStatus('ready — share your id, or enter a peer id to connect');
  });

  peer.on('connection', (incoming) => {
    // Mutual-connect race: both sides pressed connect on each other at once.
    // Resolve deterministically by comparing ids, so exactly one side wins
    // instead of both timing out or one side being silently orphaned.
    if (conn && pendingTarget === incoming.peer) {
      if (myIdEl.textContent < incoming.peer) {
        incoming.close(); // we keep our own outgoing attempt, ignore theirs
        return;
      } else {
        try { conn.close(); } catch (e) {} // yield our outgoing, adopt theirs instead
        conn = null;
        pendingTarget = null;
      }
    } else if (conn) {
      incoming.close(); // already talking to someone else — refuse
      return;
    }

    conn = incoming;
    setStatus('connecting to ' + incoming.peer + '...');
    conn.on('open', () => {
      lastPeerId = incoming.peer;
      wireConnection();
      setStatus('connected to ' + conn.peer);
      logMsg('system', conn.peer + ' connected', 'sys');
      enableChat(true);
    });
  });

  peer.on('call', (call) => {
    if (call.peer !== (conn && conn.peer)) { call.close(); return; } // only accept calls from the connected peer
    const wantsVideo = call.metadata && call.metadata.video;
    const ok = confirm((wantsVideo ? 'Video' : 'Voice') + ' call from ' + call.peer + '. Answer?');
    if (!ok) { call.close(); return; }
    startLocalMedia(wantsVideo).then((stream) => {
      call.answer(stream);
      wireCall(call, wantsVideo);
    });
  });

  peer.on('disconnected', () => {
    setStatus('lost connection to signaling server — reconnecting...', true);
    peer.reconnect();
  });

  peer.on('error', (err) => setStatus('error: ' + err.type, true));
}

function wireConnection() {
  conn.on('data', handleData);
  conn.on('close', () => {
    enableChat(false);
    if (!manualDisconnect && reconnectTries < RECONNECT_ATTEMPTS && lastPeerId) {
      reconnectTries++;
      setStatus('connection dropped — retrying (' + reconnectTries + '/' + RECONNECT_ATTEMPTS + ')...', true);
      const target = lastPeerId;
      conn = null;
      setTimeout(() => attemptConnect(target), 1000 * reconnectTries);
    } else {
      setStatus('peer disconnected');
      logMsg('system', conn.peer + ' disconnected', 'sys');
      conn = null;
    }
  });
}

function attemptConnect(targetId) {
  if (conn) return;
  setStatus('connecting to ' + targetId + '...');
  pendingTarget = targetId;
  const pending = peer.connect(targetId, { reliable: true });
  conn = pending;

  const timeout = setTimeout(() => {
    if (conn === pending && !pending.open) {
      setStatus('connection timed out — check the id and try again', true);
      try { pending.close(); } catch (e) {}
      conn = null;
      pendingTarget = null;
    }
  }, 15000);

  pending.on('open', () => {
    clearTimeout(timeout);
    reconnectTries = 0;
    lastPeerId = targetId;
    pendingTarget = null;
    wireConnection();
    setStatus('connected to ' + targetId);
    logMsg('system', 'connected to ' + targetId, 'sys');
    enableChat(true);
  });
  pending.on('error', (err) => {
    clearTimeout(timeout);
    setStatus('connection failed: ' + err, true);
    if (conn === pending) { conn = null; pendingTarget = null; }
  });
}

connectBtn.addEventListener('click', () => {
  const now = Date.now();
  if (now - lastConnectAttempt < CONNECT_COOLDOWN_MS) return; // client-side throttle
  lastConnectAttempt = now;

  const targetId = peerInput.value.trim().toUpperCase();
  if (!targetId || conn) return;
  manualDisconnect = false;
  reconnectTries = 0;
  attemptConnect(targetId);
});

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(myIdEl.textContent).then(() => setStatus('id copied to clipboard'));
});

// ---- chat ----
function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !conn) return;
  conn.send({ type: 'chat', text });
  logMsg('you', text, 'me');
  msgInput.value = '';
}
sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

// ---- voice / video calls ----
async function startLocalMedia(video) {
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!video });
  if (video) {
    localVideo.srcObject = localStream;
    videoWrap.classList.add('active');
  }
  return localStream;
}

function showPlayPrompt(mediaEl) {
  setStatus('tap the video/audio area to start playback (browser blocked autoplay)', true);
  const resume = () => { mediaEl.play().catch(() => {}); document.removeEventListener('click', resume); };
  document.addEventListener('click', resume, { once: true });
}

function wireCall(call, video) {
  activeCall = call;
  hangupBtn.disabled = false;
  voiceBtn.disabled = true;
  videoBtn.disabled = true;
  call.on('stream', (remoteStream) => {
    if (video) {
      remoteVideo.srcObject = remoteStream;
      videoWrap.classList.add('active');
      remoteVideo.play().catch(() => showPlayPrompt(remoteVideo));
    } else {
      remoteAudio.srcObject = remoteStream;
      remoteAudio.play().catch(() => showPlayPrompt(remoteAudio));
    }
    setStatus((video ? 'video' : 'voice') + ' call connected with ' + call.peer);
  });
  call.on('close', endCall);
  call.on('error', () => endCall());
}

async function placeCall(video) {
  if (!conn) return;
  const stream = await startLocalMedia(video);
  const call = peer.call(conn.peer, stream, { metadata: { video } });
  wireCall(call, video);
}

voiceBtn.addEventListener('click', () => placeCall(false));
videoBtn.addEventListener('click', () => placeCall(true));
hangupBtn.addEventListener('click', () => { if (activeCall) activeCall.close(); endCall(); });

function endCall() {
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  videoWrap.classList.remove('active');
  remoteVideo.srcObject = null;
  localVideo.srcObject = null;
  remoteAudio.srcObject = null;
  activeCall = null;
  hangupBtn.disabled = true;
  if (conn) { voiceBtn.disabled = false; videoBtn.disabled = false; }
  setStatus(conn ? 'connected to ' + conn.peer : 'not connected');
}

// ---- file sharing + read-only viewer ----
fileDrop.addEventListener('click', () => fileInput.click());
fileDrop.addEventListener('dragover', (e) => { e.preventDefault(); fileDrop.classList.add('drag'); });
fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('drag'));
fileDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDrop.classList.remove('drag');
  if (e.dataTransfer.files[0]) sendFile(e.dataTransfer.files[0]);
});
attachBtn.addEventListener('click', () => fileInput.click());
logEl.addEventListener('dragover', (e) => e.preventDefault());
logEl.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) sendFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) sendFile(fileInput.files[0]);
  fileInput.value = '';
});

// XSS-safe: built with DOM properties, never innerHTML with remote/user-controlled strings
function makeFileItem(id, name, size, who) {
  const div = document.createElement('div');
  div.className = 'file-item';
  div.id = 'file-' + id;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const left = document.createElement('span');
  left.textContent = who + ': ' + name;
  const right = document.createElement('span');
  right.textContent = formatBytes(size);
  const closeBtn = document.createElement('span');
  closeBtn.textContent = ' ✕';
  closeBtn.title = 'close this preview';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.marginLeft = '8px';
  closeBtn.addEventListener('click', () => {
    const url = fileUrls.get(id);
    if (url) { URL.revokeObjectURL(url); objectUrls.delete(url); fileUrls.delete(id); }
    div.remove();
  });
  meta.appendChild(left);
  meta.appendChild(right);
  meta.appendChild(closeBtn);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const barFill = document.createElement('div');
  barFill.className = 'bar-fill';
  barFill.id = 'bar-' + id;
  bar.appendChild(barFill);

  const viewer = document.createElement('div');
  viewer.className = 'viewer';
  viewer.id = 'viewer-' + id;

  div.appendChild(meta);
  div.appendChild(bar);
  div.appendChild(viewer);
  logEl.appendChild(div); // part of the chat flow now, in order with text
  logEl.scrollTop = logEl.scrollHeight;
  return div;
}

function warnLargeFile(size) {
  return confirm(
    'This file is ' + formatBytes(size) + '. Large transfers can slow down or crash the browser tab ' +
    'on either side, especially on phones. Send anyway?'
  );
}

async function sendFile(file) {
  if (!conn) { setStatus('connect to a peer first', true); return; }
  if (file.size > FILE_HARD_CAP_BYTES) {
    setStatus('file too large (' + formatBytes(file.size) + ') — 500MB limit to avoid crashing the tab', true);
    return;
  }
  if (file.size > FILE_WARN_BYTES && !warnLargeFile(file.size)) return;

  const id = 'f' + (fileCounter++) + '-' + Date.now();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  makeFileItem(id, file.name, file.size, 'you');

  conn.send({ type: 'file-meta', id, name: file.name, mime: file.type || 'application/octet-stream', size: file.size, chunks: totalChunks });

  const dc = conn.dataChannel;
  let lastReportedPct = -1;

  for (let i = 0; i < totalChunks; i++) {
    // Blob.slice() is a cheap reference, not a copy — only this one chunk
    // gets read into memory at a time, instead of the whole file up front.
    const start = i * CHUNK_SIZE;
    const chunkBlob = file.slice(start, start + CHUNK_SIZE);
    const chunkBuf = await chunkBlob.arrayBuffer();
    conn.send({ type: 'file-chunk', id, index: i, data: new Uint8Array(chunkBuf) });

    const pct = Math.floor(((i + 1) / totalChunks) * 100);
    if (pct !== lastReportedPct) { updateBar(id, pct); lastReportedPct = pct; } // throttle DOM writes

    if (dc && dc.bufferedAmount > 4 * 1024 * 1024) {
      await new Promise((res) => {
        dc.bufferedAmountLowThreshold = 1 * 1024 * 1024;
        dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; res(); };
      });
    }
  }
  conn.send({ type: 'file-end', id });
  renderViewer(id, file, file.name, file.type); // reuse the original Blob — no duplicate copy for preview
}

function updateBar(id, pct) {
  const bar = document.getElementById('bar-' + id);
  if (bar) bar.style.width = pct + '%';
}

function handleData(data) {
  if (!data || !data.type) return;
  switch (data.type) {
    case 'chat':
      if (typeof data.text === 'string') logMsg(conn.peer, data.text.slice(0, 5000));
      break;
    case 'file-meta': {
      // reject bad-faith or oversized metadata before allocating anything
      const size = Number(data.size) || 0;
      const chunks = Number(data.chunks) || 0;
      if (size > FILE_HARD_CAP_BYTES || chunks > (FILE_HARD_CAP_BYTES / CHUNK_SIZE) + 1 || chunks <= 0) {
        logMsg('system', 'refused incoming file: exceeds size limit', 'sys');
        return;
      }
      const name = String(data.name || 'file').slice(0, 200);
      // one preallocated buffer, written into by offset, instead of an array
      // of many small Uint8Arrays later concatenated by the browser
      incomingFiles.set(data.id, {
        name, mime: String(data.mime || ''), size,
        buffer: new Uint8Array(size), received: 0, total: chunks, lastPct: -1
      });
      makeFileItem(data.id, name, size, conn.peer);
      break;
    }
    case 'file-chunk': {
      const f = incomingFiles.get(data.id);
      if (!f || data.index < 0 || data.index >= f.total) return; // bounds check — refuses malformed chunk indices
      const offset = data.index * CHUNK_SIZE;
      f.buffer.set(data.data, offset); // write directly into place, no intermediate array
      f.received++;
      const pct = Math.floor((f.received / f.total) * 100);
      if (pct !== f.lastPct) { updateBar(data.id, pct); f.lastPct = pct; } // throttle DOM writes
      break;
    }
    case 'file-end': {
      const f = incomingFiles.get(data.id);
      if (!f) return;
      const blob = new Blob([f.buffer], { type: f.mime }); // built once, from one buffer
      renderViewer(data.id, blob, f.name, f.mime);
      incomingFiles.delete(data.id);
      break;
    }
  }
}

// XSS-safe rendering: element properties (src, alt, textContent) are used
// for anything derived from a remote peer's data — never innerHTML with
// interpolated strings, which is how a malicious file name could inject
// script into the page.
function renderViewer(id, blob, name, mime) {
  const container = document.getElementById('viewer-' + id);
  if (!container) return;
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  fileUrls.set(id, url);
  mime = mime || '';

  const note = (text) => {
    const span = document.createElement('span');
    span.style.fontSize = '12px';
    span.style.color = 'var(--fg-dim)';
    span.textContent = text + ' — ';
    container.appendChild(span);
  };

  if (mime.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = name;
    container.appendChild(img);
  } else if (mime.startsWith('video/')) {
    const v = document.createElement('video');
    v.src = url; v.controls = true; v.playsInline = true;
    container.appendChild(v);
  } else if (mime.startsWith('audio/')) {
    const a = document.createElement('audio');
    a.src = url; a.controls = true;
    container.appendChild(a);
  } else if (mime === 'application/pdf') {
    const embed = document.createElement('embed');
    embed.src = url; embed.type = 'application/pdf';
    container.appendChild(embed);
  } else if (mime.startsWith('text/') || /\.(md|json|log)$/i.test(name)) {
    blob.text().then((txt) => {
      const pre = document.createElement('pre');
      pre.textContent = txt.slice(0, 20000);
      container.appendChild(pre);
    });
  } else if (/\.docx$/i.test(name)) {
    blob.arrayBuffer().then((buf) => callDocWorker('docx', buf))
      .then((html) => {
        // mammoth output is inserted via innerHTML deliberately — this HTML
        // comes from mammoth's own converter, not raw attacker-controlled
        // string concatenation, but treat it as best-effort preview only.
        const div = document.createElement('div');
        div.className = 'doc-html';
        div.innerHTML = html;
        container.appendChild(div);
      })
      .catch(() => note('could not preview this document'));
  } else if (/\.(xlsx|xls|csv)$/i.test(name)) {
    blob.arrayBuffer().then((buf) => callDocWorker('sheet', buf))
      .then((html) => {
        const div = document.createElement('div');
        div.className = 'sheet-wrap';
        div.innerHTML = html;
        container.appendChild(div);
      }).catch(() => note('could not preview this sheet'));
  } else {
    note('no inline preview for this format');
  }

  const link = document.createElement('a');
  link.className = 'dl';
  link.href = url;
  link.download = name;
  link.textContent = 'download';
  link.style.fontSize = '12px';
  link.style.display = 'inline-block';
  link.style.marginTop = '6px';
  container.appendChild(link);
}

// ---- wipe / end session ----
const wipeBtn = document.getElementById('wipe-btn');
wipeBtn.addEventListener('click', () => {
  const ok = confirm('Ends the call, disconnects, clears everything on screen, and gets you a brand new id. Continue?');
  if (!ok) return;
  wipeEverything();
});

function wipeEverything() {
  manualDisconnect = true;

  if (activeCall) { try { activeCall.close(); } catch (e) {} }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  remoteVideo.srcObject = null;
  localVideo.srcObject = null;
  remoteAudio.srcObject = null;
  videoWrap.classList.remove('active');

  if (conn) { try { conn.close(); } catch (e) {} conn = null; }
  if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }

  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls.clear();
  fileUrls.clear();
  incomingFiles.clear();
  lastPeerId = null;

  // belt-and-braces: this app never writes to these, but clear them
  // anyway in case a future change accidentally does
  try { localStorage.clear(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
  if (window.indexedDB && indexedDB.databases) {
    indexedDB.databases().then((dbs) => dbs.forEach((d) => indexedDB.deleteDatabase(d.name)));
  }

  logEl.innerHTML = '';
  enableChat(false);
  hangupBtn.disabled = true;
  setStatus('wiped — reloading with a fresh id...');

  setTimeout(() => location.reload(), 600);
}

initPeer();
