// omnio p2p chat skeleton
// No backend database. No message storage. No accounts.
// A public PeerJS signaling server is used ONLY to help two browsers
// exchange connection info (WebRTC "offer/answer"). It never sees
// message content, files, or video. Swap PEER_SERVER_CONFIG below to
// point at a self-hosted PeerServer for full independence later.

const PEER_SERVER_CONFIG = undefined; // undefined = use PeerJS's free public broker for now

const myIdEl = document.getElementById('my-id');
const copyBtn = document.getElementById('copy-id');
const peerInput = document.getElementById('peer-id-input');
const connectBtn = document.getElementById('connect-btn');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const msgInput = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');

let peer = null;
let conn = null;

function randomId(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function setStatus(text, isErr = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('err', isErr);
}

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
}

function initPeer() {
  const id = randomId();
  peer = PEER_SERVER_CONFIG ? new Peer(id, PEER_SERVER_CONFIG) : new Peer(id);

  peer.on('open', (assignedId) => {
    myIdEl.textContent = assignedId;
    setStatus('ready — share your id, or enter a peer id to connect');
  });

  peer.on('connection', (incoming) => {
    if (conn) {
      incoming.close(); // only one connection at a time for now
      return;
    }
    conn = incoming;
    wireConnection();
    setStatus('connected to ' + conn.peer);
    logMsg('system', conn.peer + ' connected', 'sys');
    enableChat(true);
  });

  peer.on('error', (err) => {
    setStatus('error: ' + err.type, true);
  });
}

function wireConnection() {
  conn.on('data', (data) => {
    if (data && data.type === 'chat') {
      logMsg(conn.peer, data.text);
    }
  });
  conn.on('close', () => {
    setStatus('peer disconnected');
    logMsg('system', conn.peer + ' disconnected', 'sys');
    enableChat(false);
    conn = null;
  });
}

connectBtn.addEventListener('click', () => {
  const targetId = peerInput.value.trim().toUpperCase();
  if (!targetId) return;
  if (conn) {
    setStatus('already connected — refresh to start a new session', true);
    return;
  }
  setStatus('connecting to ' + targetId + '...');
  conn = peer.connect(targetId, { reliable: true });
  conn.on('open', () => {
    wireConnection();
    setStatus('connected to ' + targetId);
    logMsg('system', 'connected to ' + targetId, 'sys');
    enableChat(true);
  });
  conn.on('error', (err) => {
    setStatus('connection failed: ' + err, true);
  });
});

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(myIdEl.textContent).then(() => {
    setStatus('id copied to clipboard');
  });
});

function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !conn) return;
  conn.send({ type: 'chat', text });
  logMsg('you', text, 'me');
  msgInput.value = '';
}

sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

initPeer();
