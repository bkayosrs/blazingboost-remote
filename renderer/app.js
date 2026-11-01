// Müşteri tarafı: sinyal bağlantısı, oyun penceresinin yakalanması ve WebRTC oturumu.

const $ = (id) => document.getElementById(id);

// Hız öncelikli: FPS yüksek kalır, internet yetmezse görüntü küçültülür.
// Yük müşterinin upload'ında: "auto"da üst sınır yüksek, WebRTC hattın kaldırabildiği en yüksek
// bitrate'e çıkar; hat daralınca FPS'i değil çözünürlüğü kendisi düşürür (maintain-framerate).
// Sabit modlar görüntüyü baştan küçültür; booster tarafında ek yük yoktur.
// FPS sınırı ayrı seçilir (fpsLimit); 30 FPS aynı kalitede yaklaşık yarı bant genişliği harcar.
const QUALITY = {
  auto: { maxBitrate: 6_000_000, scaleResolutionDownBy: 1 },
  high: { maxBitrate: 4_000_000, scaleResolutionDownBy: 1 },
  medium: { maxBitrate: 1_200_000, scaleResolutionDownBy: 1.5 },
  low: { maxBitrate: 400_000, scaleResolutionDownBy: 2.5 },
};
const FPS_LIMITS = [30, 60];
// Codec booster panelinden seçilir. Ölçüm (OSRS 1200×628, aynı makine):
//   VP8 yazılım ~22 ms / ~39 FPS, H.264 donanım ~55 ms / ~20 FPS (MF kodlayıcı kare düşürüyor).
// Bu yüzden varsayılan VP8; H.264 panelden seçilebilir.
const CODECS = ['VP8', 'H264', 'VP9'];
let preferredCodec = 'VP8';

// SDP'ye eklenen bit hızı ipucu (kbps): yüksek başlangıç, yavaş ısınmayı atlar.
// Ölçüm: x-google-min/max-bitrate (CBR'ye yakın) tamponu ~8 ms'den ~50 ms'ye çıkardı; kaldırıldı.
const SDP_BITRATE = { start: 1500 };

let settings;
let ws = null;
let reconnectDelay = 1000;
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

let pc = null;
let sessionId = 0;
let sender = null;
let videoTransceiver = null;
let channels = {};
let stream = null;
let target = null;
let quality = 'auto';
let fpsLimit = 60;
let restartTimer = null;
let encoderTimer = null;
let following = false;
let signalQueue = Promise.resolve();

async function init() {
  settings = await api.getSettings();
  render();
  bindUi();
  connectSignaling();
  followTarget();
  setInterval(followTarget, 1500);
  api.onKickRequest(() => kick('customer'));
}

// ---- Sinyal ----

function connectSignaling() {
  let sock;
  try {
    sock = new WebSocket(settings.serverUrl);
  } catch {
    setText('serverStatus', 'invalid server address');
    return;
  }
  ws = sock;
  sock.onopen = () => {
    reconnectDelay = 1000;
    send({ t: 'register', code: settings.code, pin: settings.pin, key: settings.key });
  };
  sock.onmessage = (e) => onSignal(JSON.parse(e.data));
  sock.onclose = () => {
    if (ws !== sock) return;
    serverOnline = false;
    showServer();
    setTimeout(connectSignaling, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
}

function reconnectSignaling() {
  const old = ws;
  ws = null;
  if (old) old.close();
  connectSignaling();
}

function send(m) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

// Proxy'ler boşta kalan WebSocket'i kapatmasın.
setInterval(() => send({ t: 'ping' }), 25000);

async function onSignal(m) {
  switch (m.t) {
    case 'registered':
      if (m.iceServers) iceServers = m.iceServers;
      serverOnline = true;
      showServer();
      break;
    case 'error':
      setText('serverStatus', m.error === 'code-in-use' ? 'this code is used on another device' : 'error: ' + m.error);
      break;
    case 'booster-joined':
      // TURN bilgileri yalnızca doğrulanmış bir booster bağlanınca gelir.
      if (m.iceServers) iceServers = m.iceServers;
      if (!settings.allowAccess) {
        send({ t: 'kick', reason: 'access-disabled' });
        break;
      }
      // Yalnızca sunucu bağlantısı koptuysa P2P oturum hâlâ yaşıyor olabilir; bozma.
      if (m.resume && pc && pc.connectionState === 'connected') break;
      await startSession().catch((e) => console.error('Oturum başlatılamadı', e));
      break;
    case 'booster-left':
      endSession();
      break;
    case 'signal':
      signalQueue = signalQueue.then(() => onRemoteSignal(m.data)).catch((e) => console.warn(e));
      break;
  }
}

async function onRemoteSignal(d) {
  if (!pc || !d || d.session !== sessionId) return;
  // Gönderici bit hızı ipuçlarını karşı tarafın cevabından okur; cevaba da eklenir.
  if (d.sdp) await pc.setRemoteDescription({ type: d.sdp.type, sdp: mungeBitrate(d.sdp.sdp) });
  else if (d.candidate) await pc.addIceCandidate(d.candidate).catch(() => {});
}

// ---- WebRTC oturumu ----

async function startSession() {
  endPeer();
  const id = ++sessionId;
  const peer = new RTCPeerConnection({ iceServers });
  pc = peer;
  peer.onicecandidate = (e) => {
    if (e.candidate) send({ t: 'signal', data: { session: id, candidate: e.candidate } });
  };
  peer.onconnectionstatechange = () => onConnectionState(peer);

  // Girdi kanalları kayıplı ve sırasız: paket kuyrukta beklemez, yeniden gönderilmez. Kaybolan bir
  // "bırak" mesajı booster'ın 200 ms'de bir gönderdiği basılı-tuş özetiyle düzelir (input.js).
  // Kontrol mesajları (kalite, FPS, hedef pencere, istatistik) ayrı ve güvenilir kanalda.
  channels.ctl = peer.createDataChannel('ctl');
  channels.input = peer.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
  channels.move = peer.createDataChannel('move', { ordered: false, maxRetransmits: 0 });
  for (const ch of Object.values(channels)) ch.onmessage = (e) => onBoosterMessage(e.data);
  channels.ctl.onopen = sendTarget;

  videoTransceiver = peer.addTransceiver('video', { direction: 'sendonly' });
  sender = videoTransceiver.sender;
  preferCodecs(videoTransceiver);

  updateSession('Booster connecting…', true);
  await sendOffer(false);
  if (pc !== peer) return;
  await applyQuality();
  await followTarget();
}

function preferCodecs(transceiver) {
  // Chromium listeyi alıcı yeteneklerine göre doğruluyor; gönderici listesi verilirse hata fırlatıyor.
  const caps = RTCRtpReceiver.getCapabilities('video');
  if (!caps || !transceiver.setCodecPreferences) return;
  const order = [preferredCodec, ...CODECS.filter((c) => c !== preferredCodec)].map((c) => `video/${c}`);
  const rank = (c) => {
    const i = order.indexOf(c.mimeType);
    return i === -1 ? order.length : i;
  };
  // rtx / red / ulpfec listede kalır: kayıpta yeniden gönderim ve FEC için gerekli.
  try {
    transceiver.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b)));
  } catch (e) {
    console.warn('Codec tercihi uygulanamadı, varsayılanlar kullanılacak', e);
  }
}

async function sendOffer(iceRestart) {
  const peer = pc;
  const offer = await peer.createOffer({ iceRestart });
  if (pc !== peer) return;
  await peer.setLocalDescription({ type: 'offer', sdp: mungeBitrate(offer.sdp) });
  send({ t: 'signal', data: { session: sessionId, sdp: peer.localDescription } });
}

/** Video codec'lerinin fmtp satırlarına x-google bit hızı ipuçlarını ekler (SDP munging). */
function mungeBitrate(sdp) {
  const params = `x-google-start-bitrate=${SDP_BITRATE.start}`;
  const lines = sdp.split('\r\n');
  const pts = new Set();
  for (const line of lines) {
    const m = line.match(/^a=rtpmap:(\d+) (H264|VP8|VP9)\/90000/);
    if (m) pts.add(m[1]);
  }
  const out = [];
  for (const line of lines) {
    const fmtp = line.match(/^a=fmtp:(\d+) (.*)$/);
    if (fmtp && pts.has(fmtp[1])) {
      pts.delete(fmtp[1]);
      out.push(line.includes('x-google-') ? line : `${line};${params}`);
      continue;
    }
    out.push(line);
    const rtpmap = line.match(/^a=rtpmap:(\d+) (H264|VP8|VP9)\/90000/);
    // fmtp satırı olmayan codec (ör. VP8) için yeni satır; sonradan gelen fmtp'yi atla.
    if (rtpmap && !lines.some((l) => l.startsWith(`a=fmtp:${rtpmap[1]} `))) {
      out.push(`a=fmtp:${rtpmap[1]} ${params}`);
      pts.delete(rtpmap[1]);
    }
  }
  return out.join('\r\n');
}

// Booster panelinden codec değişimi: aynı bağlantıda yeniden müzakere (görüntü kısa süre donabilir).
async function switchCodec(codec) {
  if (!CODECS.includes(codec) || codec === preferredCodec) return;
  preferredCodec = codec;
  if (!pc || !videoTransceiver) return;
  preferCodecs(videoTransceiver);
  await sendOffer(false).catch((e) => console.warn('Codec değiştirilemedi', e));
}

// Uzak bağlantı modu (kademeli, yalnızca Quality: Auto). Uzun mesafede ya da kayıplı hatta büyük
// kareler hattan geç çıkıyor ve tampon büyüyor; küçük kareler gecikmeyi düşürür.
// Seviye ping VEYA paket kaybıyla yükselir (2 ardışık ölçüm), iyileşince her 8 sn'de bir kademe geri
// iner. Giriş/çıkış eşikleri arasındaki boşluk modun sürekli açılıp kapanmasını önler.
const FAR_LEVELS = [
  null,
  { height: 720, maxBitrate: 1_500_000, fps: 30, enterRtt: 0.15, enterLoss: 0.03, exitRtt: 0.12, exitLoss: 0.01 },
  { height: 540, maxBitrate: 700_000, fps: 30, enterRtt: 0.25, enterLoss: 0.08, exitRtt: 0.2, exitLoss: 0.04 },
];
const FAR_ENTER_SAMPLES = 2;
const FAR_EXIT_SAMPLES = 8;
let farLevel = 0;
let farBad = 0;
let farGood = 0;
let lastFrameHeight = 0; // gönderilen görüntünün (kırpılmış) yüksekliği

function farActive() {
  return farLevel > 0 && quality === 'auto';
}

function effectiveFps() {
  return farActive() ? Math.min(fpsLimit, FAR_LEVELS[farLevel].fps) : fpsLimit;
}

function updateFarMode(rtt, loss) {
  if (rtt == null) return;
  loss = loss || 0;
  const next = FAR_LEVELS[farLevel + 1];
  if (next && (rtt > next.enterRtt || loss > next.enterLoss)) {
    farGood = 0;
    if (++farBad >= FAR_ENTER_SAMPLES) {
      farBad = 0;
      farLevel++;
      applyQuality();
    }
    return;
  }
  farBad = 0;
  const current = FAR_LEVELS[farLevel];
  if (current && rtt < current.exitRtt && loss < current.exitLoss) {
    if (++farGood >= FAR_EXIT_SAMPLES) {
      farGood = 0;
      farLevel--;
      applyQuality();
    }
  } else {
    farGood = 0;
  }
}

function resetFarMode() {
  farLevel = 0;
  farBad = 0;
  farGood = 0;
  resetRateControl();
}

// Gecikme öncelikli hız kontrolü (ekran kartlarındaki dinamik çözünürlüğün internet karşılığı).
// Hattın boş hâlindeki ping (son 2 dk'nın en düşüğü) taban kabul edilir. Ping tabanın belirgin
// üstüne çıkarsa ya da paket kaybı başlarsa veri modemde/operatörde kuyruğa giriyor demektir: bit hızı
// hemen düşürülür (FPS sabit kalır, kodlayıcı gerekirse çözünürlüğü düşürür). Ping tabana inince bit
// hızı yavaşça geri artırılır. Böylece gecikme pinge yakın kalır.
const RATE = {
  windowSamples: 120, // taban ping penceresi (1 ölçüm/sn); uzun tıkanmada taban yukarı kaymasın
  queueMs: 30, // tabanın bu kadar (en az) üstü = kuyruk birikiyor
  queueRatio: 0.15, // ...ya da tabanın %15'i, hangisi büyükse
  clearMs: 15, // tabana bu kadar yakınsa hat boş
  loss: 0.05, // bu kayıp oranının üstü = tıkanma
  cut: 0.7, // tıkanınca gönderilen hızın %70'ine in
  hardCut: 0.5, // kuyruk çok büyükse (hat aniden daraldı) yarısına in
  raise: 1.1, // hat boşken her adımda %10 artır...
  gentleRaise: 1.02, // ...son tıkandığı hıza yaklaşınca yavaşça (sürekli kuyruk sınamasın)
  minBitrate: 250_000,
  cutGapMs: 2000, // art arda iki düşürme arası (kuyruğun boşalmasını bekle)
  raiseDelayMs: 3000, // düşürmeden sonra artırmaya başlamadan önce
};
let rttSamples = [];
let rateCap = null; // bit/sn; null = sınır yok
let lastRateCut = 0;
let lastCongestedRate = null; // son tıkanmanın olduğu gönderim hızı
let queuedSamples = 0; // tek bir ping sıçraması düşürme yapmasın: art arda 2 kötü ölçüm

function resetRateControl() {
  rttSamples = [];
  rateCap = null;
  lastRateCut = 0;
  lastCongestedRate = null;
  queuedSamples = 0;
}

function rateLimited() {
  return rateCap != null;
}

/** Her saniye: ping (sn), kayıp (0..1), gönderilen hız (kbps). */
function updateRateControl(rtt, loss, kbps) {
  if (rtt == null) return;
  const ms = rtt * 1000;
  rttSamples.push(ms);
  if (rttSamples.length > RATE.windowSamples) rttSamples.shift();
  if (rttSamples.length < 3) return;
  const base = Math.min(...rttSamples);
  const now = Date.now();
  const threshold = Math.max(RATE.queueMs, base * RATE.queueRatio);
  const queued = ms > base + threshold || (loss || 0) > RATE.loss;
  const ceiling = currentProfile().maxBitrate;
  let next = rateCap;
  queuedSamples = queued ? queuedSamples + 1 : 0;
  if (queued) {
    if (queuedSamples < 2 || now - lastRateCut < RATE.cutGapMs || kbps == null) return;
    // Sınırın değil gerçekten gönderilen hızın altına inilir; yoksa düşürme etkisiz kalır.
    const sent = Math.min(kbps * 1000, rateCap ?? Infinity, ceiling);
    lastCongestedRate = sent;
    next = Math.max(RATE.minBitrate, Math.round(sent * (ms > base + 3 * threshold ? RATE.hardCut : RATE.cut)));
    lastRateCut = now;
  } else if (rateCap != null && ms < base + RATE.clearMs && now - lastRateCut > RATE.raiseDelayMs) {
    // 20 sn tıkanma olmadıysa hat açılmış olabilir: yine hızlı artır.
    const nearLimit = lastCongestedRate != null && rateCap > lastCongestedRate * 0.85 && now - lastRateCut < 20000;
    next = Math.round(rateCap * (nearLimit ? RATE.gentleRaise : RATE.raise));
    if (next >= ceiling) next = null;
  } else {
    return;
  }
  if (next === rateCap) return;
  console.log('Hız sınırı', next == null ? 'yok' : Math.round(next / 1000) + ' kbps', `(ping ${Math.round(ms)}, taban ${Math.round(base)})`);
  rateCap = next;
  applyQuality();
}

/** Kalite seçimine ve uzak bağlantı moduna göre geçerli ayarlar (hız kontrolü hariç). */
function currentProfile() {
  const level = farActive() ? FAR_LEVELS[farLevel] : null;
  return level
    ? { maxBitrate: level.maxBitrate, scaleResolutionDownBy: Math.max(1, (lastFrameHeight || level.height) / level.height) }
    : QUALITY[quality];
}

// Ayarlar sırayla uygulanır: iki setParameters çakışırsa Chromium ikincisini reddediyor.
let qualityQueue = Promise.resolve();

function applyQuality() {
  qualityQueue = qualityQueue.then(applyQualityNow).catch((e) => console.warn('Kalite ayarı uygulanamadı', e));
  return qualityQueue;
}

async function applyQualityNow() {
  const s = sender;
  if (!s) return;
  const profile = currentProfile();
  // Kırpılmış küçük görüntü (Fixed mod) zaten küçük; daha da küçültmek yazıları okunmaz yapar.
  const small = crop && crop.rect.width <= SMALL_FRAME_WIDTH;
  const encoding = {
    ...profile,
    maxBitrate: rateCap != null ? Math.min(profile.maxBitrate, rateCap) : profile.maxBitrate,
    scaleResolutionDownBy: small ? 1 : profile.scaleResolutionDownBy,
    maxFramerate: effectiveFps(),
    priority: 'high',
    networkPriority: 'high',
  };
  // Her denemede taze getParameters(): Chromium eski parametre nesnesini reddeder.
  const set = (withPreference) => {
    const params = s.getParameters();
    if (!params.encodings || !params.encodings.length) return Promise.resolve();
    Object.assign(params.encodings[0], encoding);
    if (withPreference) params.degradationPreference = 'maintain-framerate';
    return s.setParameters(params);
  };
  try {
    await set(true);
  } catch {
    await set(false);
  }
}

function onConnectionState(peer) {
  if (pc !== peer) return;
  const s = peer.connectionState;
  if (s === 'connected') {
    clearTimeout(restartTimer);
    restartTimer = null;
    updateSession('Booster connected', true);
    boosterConnected = true;
    showServer();
    api.sessionState(true);
    if (!encoderTimer) encoderTimer = setInterval(reportEncoder, 1000);
  } else if (s === 'disconnected') {
    updateSession('Weak connection, reconnecting…', true);
    scheduleIceRestart(3000);
  } else if (s === 'failed') {
    updateSession('Connection lost, reconnecting…', true);
    scheduleIceRestart(0);
  }
}

// Booster panelinde müşteri tarafının durumu görünsün: kaç kare yakalanıyor, kaçı gönderiliyor,
// kodlama ne kadar sürüyor ve ne sınırlıyor (cpu / bandwidth). Düşük FPS'in sebebi buradan okunur.
let lastOutbound = null;

async function reportEncoder() {
  if (!pc || !channels.ctl || channels.ctl.readyState !== 'open') return;
  const report = await pc.getStats();
  let out = null;
  let rtt = null;
  let relay = false;
  let loss = 0;
  let mediaRtt = null; // görüntü paketlerinin ölçtüğü ping (RTCP); kuyruğu ICE pinginden daha hızlı gösterir
  report.forEach((s) => {
    if (s.type === 'outbound-rtp' && s.kind === 'video') out = s;
    // Booster'ın alıcı raporundaki kayıp oranı (0..1).
    if (s.type === 'remote-inbound-rtp' && s.kind === 'video') {
      if (typeof s.fractionLost === 'number') loss = s.fractionLost;
      if (typeof s.roundTripTime === 'number') mediaRtt = s.roundTripTime;
    }
    if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) {
      rtt = s.currentRoundTripTime;
      const local = report.get(s.localCandidateId);
      const remote = report.get(s.remoteCandidateId);
      relay = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay');
    }
  });
  if (!out) return;
  let encodeMs = null;
  let captureFps = null;
  let kbps = null;
  if (lastOutbound) {
    if (out.framesEncoded > lastOutbound.framesEncoded) {
      encodeMs = ((out.totalEncodeTime - lastOutbound.totalEncodeTime) / (out.framesEncoded - lastOutbound.framesEncoded)) * 1000;
    }
    const dt = (out.timestamp - lastOutbound.timestamp) / 1000;
    captureFps = (realFrameCount - lastOutbound.realFrameCount) / dt;
    kbps = ((out.bytesSent - lastOutbound.bytesSent) * 8) / 1000 / dt;
  }
  lastOutbound = { ...out, realFrameCount };
  updateFarMode(rtt, loss);
  updateRateControl(mediaRtt ?? rtt, loss, kbps);
  showLink(rtt);
  channels.ctl.send(
    JSON.stringify({
      t: 'enc',
      impl: out.encoderImplementation || null,
      hw: !!out.powerEfficientEncoder,
      far: farActive(),
      adapt: rateLimited(),
      route: relay ? 'relay' : 'direct',
      kbps,
      farHeight: farActive() ? FAR_LEVELS[farLevel].height : null,
      loss,
      captureFps,
      sentFps: out.framesPerSecond ?? null,
      limit: out.qualityLimitationReason || 'none',
      encodeMs,
    }),
  );
}

// Müşteri penceresinde booster bağlantısının durumu, sade: ping, gecikme ve kalite düşürüldüyse not.
let boosterLatency = null; // booster panelinin ölçtüğü toplam gecikme (ms)

function showLink(rtt) {
  if (rtt == null) {
    setText('linkStatus', 'connecting…');
    return;
  }
  const parts = [`Ping ${Math.round(rtt * 1000)} ms`];
  if (boosterLatency != null) parts.push(`Latency ≈ ${boosterLatency} ms`);
  if (farActive() || rateLimited()) parts.push('slow internet, picture quality lowered');
  setText('linkStatus', parts.join(' · '));
}

// Ağ değişince (Wi-Fi kopması, IP değişimi) oturumu kapatmadan yeni yol bul.
function scheduleIceRestart(delay) {
  if (restartTimer) return;
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    if (!pc || pc.connectionState === 'connected') return;
    try {
      await sendOffer(true);
    } catch (e) {
      console.warn(e);
    }
    scheduleIceRestart(8000);
  }, delay);
}

function onBoosterMessage(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.t === 'q') {
    if (QUALITY[m.mode]) {
      quality = m.mode;
      applyQuality();
    }
    return;
  }
  if (m.t === 'codec') {
    switchCodec(m.value);
    return;
  }
  // Booster başka bir bağlantı yolunu (doğrudan / Cloudflare TURN) denemek istiyor: oturum yeniden kurulur.
  if (m.t === 'new-session') {
    startSession().catch((e) => console.error('Oturum başlatılamadı', e));
    return;
  }
  if (m.t === 'lat') {
    if (typeof m.ms === 'number') boosterLatency = m.ms;
    return;
  }
  if (m.t === 'fps') {
    if (FPS_LIMITS.includes(m.value)) {
      fpsLimit = m.value;
      applyQuality();
    }
    return;
  }
  api.input(m);
}

function endPeer() {
  clearTimeout(restartTimer);
  restartTimer = null;
  clearInterval(encoderTimer);
  encoderTimer = null;
  lastOutbound = null;
  resetFarMode();
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.close();
  }
  pc = null;
  sender = null;
  videoTransceiver = null;
  channels = {};
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  target = null;
  api.setTarget(0);
}

function endSession() {
  endPeer();
  api.sessionState(false);
  updateSession('No booster connected', false);
  boosterConnected = false;
  showServer();
  boosterLatency = null;
  setText('linkStatus', '—');
}

function kick(reason) {
  send({ t: 'kick', reason });
  endSession();
}

// ---- Oyun penceresi ----

async function followTarget() {
  if (following) return;
  following = true;
  try {
    await applyTarget(await api.findTarget(!!pc));
    if (target) clientArea = await api.clientArea(target.hwnd);
  } catch (e) {
    console.warn(e);
  } finally {
    following = false;
  }
}

// Pencere yakalama yalnızca pencere değişince kare verir. Düzensiz gelen kareler booster
// tarayıcısının tamponunu büyütüyordu (ölçülen: ~720 ms). Son kare tekrarlanarak sabit hızda
// gönderilir; değişmeyen kareler kodlayıcıda neredeyse hiç bit tutmaz.
let realFrameCount = 0; // oyundan gerçekten gelen kare sayısı (tanı için)

// ---- Otomatik kırpma ----
// Yalnızca oyun alanı gönderilir: pencerenin başlık çubuğu ve RuneLite'ın Fixed modda oyunun etrafına
// koyduğu siyah boşluk kesilir. Fixed – Classic'te yayın ~765×503'e iner; düşük internette büyük kazanç.
const CROP_DETECT_MS = 1000;
const CROP_SAMPLE_WIDTH = 320;
const CROP_BLACK_LEVEL = 18; // bunun altındaki parlaklık "boş" sayılır
const CROP_MIN_CHANGE = 0.02; // küçük oynamalar kodlayıcıyı yeniden başlatmasın
const SMALL_FRAME_WIDTH = 1100; // bundan dar görüntü küçültülmeden gönderilir

let crop = null; // { rect: {x,y,width,height}, frameWidth, frameHeight }
let pendingCrop = null;
let clientArea = null; // oyun alanının pencere içindeki yeri (0..1), main süreçten
const cropCanvas = new OffscreenCanvas(1, 1);
const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });

function detectCrop(frame) {
  // Koordinatlar karenin görünen alanına göre; kodlama tamponu biraz daha büyük olabilir.
  const base = frame.visibleRect;
  const fw = base.width;
  const fh = base.height;
  const sw = CROP_SAMPLE_WIDTH;
  const sh = Math.max(1, Math.round((sw * fh) / fw));
  if (cropCanvas.width !== sw || cropCanvas.height !== sh) {
    cropCanvas.width = sw;
    cropCanvas.height = sh;
  }
  cropCtx.drawImage(frame, 0, 0, sw, sh);
  const data = cropCtx.getImageData(0, 0, sw, sh).data;

  const area = clientArea || { x: 0, y: 0, w: 1, h: 1 };
  const ax0 = Math.floor(area.x * sw);
  const ay0 = Math.floor(area.y * sh);
  const ax1 = Math.min(sw, Math.ceil((area.x + area.w) * sw));
  const ay1 = Math.min(sh, Math.ceil((area.y + area.h) * sh));
  let minX = sw;
  let minY = sh;
  let maxX = -1;
  let maxY = -1;
  for (let y = ay0; y < ay1; y++) {
    for (let x = ax0; x < ax1; x++) {
      const i = (y * sw + x) * 4;
      if (data[i] + data[i + 1] + data[i + 2] > CROP_BLACK_LEVEL * 3) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return; // tamamen siyah (yükleme ekranı): mevcut kırpmayı koru

  // Örnekleme kaba olduğu için bir hücre pay bırak; oyun kenarı asla kesilmesin.
  const even = (v) => Math.max(0, Math.floor(v / 2) * 2);
  const x0 = even(Math.max(ax0, minX - 1) * (fw / sw));
  const y0 = even(Math.max(ay0, minY - 1) * (fh / sh));
  const x1 = Math.min(fw, Math.ceil((Math.min(ax1, maxX + 2) * fw) / sw));
  const y1 = Math.min(fh, Math.ceil((Math.min(ay1, maxY + 2) * fh) / sh));
  const rect = { x: x0, y: y0, width: even(x1 - x0), height: even(y1 - y0) };
  if (rect.width < 64 || rect.height < 64) return;

  const same = (a, b) =>
    a &&
    Math.abs(a.x - b.x) <= fw * CROP_MIN_CHANGE &&
    Math.abs(a.y - b.y) <= fh * CROP_MIN_CHANGE &&
    Math.abs(a.width - b.width) <= fw * CROP_MIN_CHANGE &&
    Math.abs(a.height - b.height) <= fh * CROP_MIN_CHANGE;
  const current = crop && { ...crop.rect, x: crop.rect.x - base.x, y: crop.rect.y - base.y };
  if (crop && crop.frameWidth === fw && crop.frameHeight === fh && same(current, rect)) return;
  // İki taramada aynı çıkarsa uygula (geçici menü/animasyon kırpmayı oynatmasın).
  if (!same(pendingCrop, rect)) {
    pendingCrop = rect;
    return;
  }
  pendingCrop = null;
  crop = { rect: { ...rect, x: base.x + rect.x, y: base.y + rect.y }, frameWidth: fw, frameHeight: fh };
  api.setCrop({ x: rect.x / fw, y: rect.y / fh, w: rect.width / fw, h: rect.height / fh });
  applyQuality();
}

function resetCrop() {
  crop = null;
  pendingCrop = null;
  clientArea = null;
  api.setCrop(null);
}

function steadyStream(raw) {
  const reader = new MediaStreamTrackProcessor({ track: raw }).readable.getReader();
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const writer = generator.writable.getWriter();
  let last = null;
  let lastWrite = 0;
  let stopped = false;

  let lastDetect = 0;

  const emit = (frame) => {
    // Kodlayıcı geride kaldıysa kuyruk büyütme; sıradaki kareyi bekle.
    if (writer.desiredSize !== null && writer.desiredSize <= 0) return;
    lastWrite = performance.now();
    // Tekrarlanan karelerde de zaman damgası ilerlemeli.
    const init = { timestamp: Math.round(lastWrite * 1000) };
    if (crop && crop.frameWidth === frame.visibleRect.width && crop.frameHeight === frame.visibleRect.height) {
      init.visibleRect = crop.rect;
    }
    try {
      writer.write(new VideoFrame(frame, init)).catch(() => {});
    } catch {
      // Pencere boyutu değişirken kırpma alanı geçersiz kalabilir; bir sonraki taramada düzelir.
      crop = null;
    }
  };

  (async () => {
    while (!stopped) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      realFrameCount++;
      lastFrameHeight = crop ? crop.rect.height : value.visibleRect.height;
      if (last) last.close();
      last = value;
      if (performance.now() - lastDetect > CROP_DETECT_MS) {
        lastDetect = performance.now();
        detectCrop(value);
      }
      emit(value);
    }
  })();

  const timer = setInterval(() => {
    // Tekrar hızı booster'ın seçtiği FPS sınırını izler.
    if (last && !stopped && performance.now() - lastWrite >= 1000 / effectiveFps()) emit(last);
  }, 4);

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (last) last.close();
    last = null;
    reader.cancel().catch(() => {});
    raw.stop();
  };
  const originalStop = generator.stop.bind(generator);
  generator.stop = () => {
    cleanup();
    originalStop();
  };
  raw.addEventListener('ended', () => generator.stop());
  return new MediaStream([generator]);
}

async function applyTarget(t) {
  const s = sender;
  if (!s) return;
  const live = stream && stream.getVideoTracks()[0]?.readyState === 'live';
  if (t ? target && t.hwnd === target.hwnd && live : !target && !stream) return;

  const old = stream;
  stream = null;
  target = null;
  resetCrop();
  if (t) {
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: t.sourceId, maxFrameRate: 60 } },
      });
      if (sender !== s) {
        next.getTracks().forEach((tr) => tr.stop());
        return;
      }
      const steady = steadyStream(next.getVideoTracks()[0]);
      const track = steady.getVideoTracks()[0];
      // Ölçüldü: 'detail' ile alıcı tamponu ~0 ms, 'motion' ile ~90 ms.
      track.contentHint = 'detail';
      await s.replaceTrack(track);
      stream = steady;
      target = t;
    } catch (e) {
      console.warn('Pencere yakalanamadı', e);
      await s.replaceTrack(null).catch(() => {});
    }
  } else {
    await s.replaceTrack(null).catch(() => {});
  }
  if (old) old.getTracks().forEach((tr) => tr.stop());
  api.setTarget(target ? target.hwnd : 0);
  sendTarget();
}

function sendTarget() {
  if (channels.ctl && channels.ctl.readyState === 'open') {
    channels.ctl.send(JSON.stringify({ t: 'target', title: target ? target.title : null }));
  }
}

// ---- Arayüz ----

function setText(id, text) {
  $(id).textContent = text;
}

function render() {
  setText('code', settings.code.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3'));
  setText('pin', settings.pin);
  $('allow').checked = settings.allowAccess;
  $('autostart').checked = settings.autoStart;
}

// Sunucu satırı: çevrimdışı / booster bekleniyor / booster bağlı.
let serverOnline = false;
let boosterConnected = false;

function showServer() {
  setText('serverStatus', !serverOnline ? 'offline, reconnecting…' : boosterConnected ? 'Connected' : 'waiting for booster');
}

function updateSession(text, active) {
  setText('sessionText', text);
  $('session').classList.toggle('active', active);
  $('kick').hidden = !active;
}

function bindUi() {
  $('kick').addEventListener('click', () => kick('customer'));

  $('allow').addEventListener('change', async (e) => {
    settings = await api.saveSettings({ allowAccess: e.target.checked });
    if (!settings.allowAccess && pc) kick('access-disabled');
  });

  $('autostart').addEventListener('change', async (e) => {
    settings = await api.saveSettings({ autoStart: e.target.checked });
  });

  $('newPin').addEventListener('click', async () => {
    endSession();
    settings = await api.newPin();
    render();
    reconnectSignaling(); // sunucu eski PIN'le bağlı booster'ı düşürür
  });

}

init();
