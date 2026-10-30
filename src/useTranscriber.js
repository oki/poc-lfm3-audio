import { ref } from "vue";

const WS_URL = "ws://localhost:9931/v1/realtime";
export const METER_MAX = 0.15;  // RMS level that fills the whole meter
const VAD = {
  startMs: 200,      // ms of voice before a turn starts
  endMs: 800,        // ms of silence before a turn ends
  prerollMs: 300,    // ms of audio before the start to include
  maxTurnMs: 30000   // safety cap: longest single turn
};

const WORKLET = `
  class Grab extends AudioWorkletProcessor {
    process(inputs) {
      const ch = inputs[0][0];
      if (ch) this.port.postMessage(ch.slice(0));
      return true;
    }
  }
  registerProcessor("grab", Grab);`;

export function useTranscriber(prompt) {
  const status = ref("Connecting to server…");
  const listening = ref(false);
  const ready = ref(false);
  const level = ref(0);
  const threshold = ref(0.02);
  const lines = ref([]);   // { text, sep? }

  let ws = null, inRate = 16000;
  let ctx = null, speaking = false, busy = false, queued = false;
  let voicedMs = 0, silentMs = 0, turnMs = 0, preroll = [], prerollMs = 0;
  let carry = new Float32Array(0), pos = 0, pending = [];
  let botLine = null, retry = null;

  // ---------- Connection and session ----------
  function connect() {
    clearTimeout(retry);
    if (ws) { ws.onclose = null; ws.close(); }
    ready.value = false; busy = false; queued = false; speaking = false; botLine = null;
    resetVad();
    ws = new WebSocket(WS_URL);
    ws.onerror = () => { status.value = "Cannot connect – is llama-server running?"; };
    ws.onclose = () => {   // also fires after a failed connect; retry until the server is up
      ready.value = false;
      if (!status.value.startsWith("Cannot connect")) status.value = "Connection lost – reconnecting…";
      retry = setTimeout(connect, 2000);
    };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
  }
  const send = (obj) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

  function handle(ev) {
    switch (ev.type) {
      case "session.created":
        inRate = ev.session?.audio?.input?.format?.rate ?? inRate;
        send({ type: "session.update", session: { type: "realtime", instructions: prompt.value.trim() } });
        ready.value = true;
        if (lines.value.length) lines.value.push({ text: "new session", sep: true });
        status.value = listening.value ? "Listening…" : "Ready – click Start";
        break;
      case "response.output_text.delta":
        if (!botLine) { botLine = { text: "" }; lines.value.push(botLine); }
        botLine.text += ev.delta;
        break;
      case "response.done":
        botLine = null; busy = false;
        if (queued) requestText();
        else if (listening.value) status.value = "Listening…";
        break;
      case "error":
        console.error(ev);
        status.value = "Server error: " + (ev.error?.message ?? "see console");
        busy = false; queued = false;
        break;
    }
  }

  // ---------- Microphone ----------
  async function initAudio() {
    const c = new AudioContext();
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    await c.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
    const node = new AudioWorkletNode(c, "grab");
    node.port.onmessage = (e) => onMic(e.data);
    c.createMediaStreamSource(mic).connect(node);
    node.connect(c.destination);   // output is silence, but keeps the node running
    ctx = c;
  }

  // ---------- Voice activity detection (VAD) ----------
  function onMic(chunk) {
    if (!ctx) return;
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    const rms = Math.sqrt(sum / chunk.length);
    level.value = Math.max(rms, level.value * 0.98);
    if (!listening.value || !ready.value) return;

    const ms = chunk.length / ctx.sampleRate * 1000;
    const loud = rms > threshold.value;

    if (!speaking) {
      preroll.push(chunk); prerollMs += ms;
      while (prerollMs > VAD.prerollMs) prerollMs -= preroll.shift().length / ctx.sampleRate * 1000;
      voicedMs = Math.max(0, voicedMs + (loud ? ms : -ms));
      if (voicedMs >= VAD.startMs) {
        speaking = true; silentMs = 0; turnMs = 0;
        carry = new Float32Array(0); pos = 0; pending = [];
        preroll.forEach((c) => pushAudio(c));
        preroll = []; prerollMs = 0;
        status.value = "Speaking…";
      }
    } else {
      pushAudio(chunk);
      turnMs += ms;
      silentMs = loud ? 0 : silentMs + ms;
      if (silentMs >= VAD.endMs || turnMs >= VAD.maxTurnMs) endTurn();
    }
  }

  function resetVad() { speaking = false; voicedMs = 0; silentMs = 0; preroll = []; prerollMs = 0; }

  function endTurn() {
    speaking = false; voicedMs = 0;
    flush();
    send({ type: "input_audio_buffer.commit" });
    queued = true;
    if (!busy) requestText();   // while a response is active, only queue
  }

  function requestText() {
    busy = true; queued = false;
    send({ type: "response.create", response: { output_modalities: ["text"] } });
    status.value = "Transcribing…";
  }

  // resample from the device rate (usually 48 kHz) to inRate, linear interpolation
  function pushAudio(chunk) {
    const buf = new Float32Array(carry.length + chunk.length);
    buf.set(carry); buf.set(chunk, carry.length);
    const step = ctx.sampleRate / inRate;
    while (pos + 1 < buf.length) {
      const i = Math.floor(pos), f = pos - i;
      pending.push(buf[i] * (1 - f) + buf[i + 1] * f);
      pos += step;
    }
    const keep = Math.min(Math.floor(pos), buf.length);
    carry = buf.slice(keep); pos -= keep;
    if (pending.length >= inRate / 10) flush();   // send every ~100 ms
  }

  function flush() {
    if (!pending.length) return;
    const pcm = new Int16Array(pending.length);
    for (let i = 0; i < pending.length; i++) {
      const s = Math.max(-1, Math.min(1, pending[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    pending = [];
    send({ type: "input_audio_buffer.append", audio: toBase64(new Uint8Array(pcm.buffer)) });
  }

  function toBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // ---------- UI actions ----------
  async function toggle() {
    if (!ctx) {
      try { await initAudio(); }
      catch (err) { status.value = "Microphone access denied: " + err.message; return; }
    }
    await ctx.resume();
    listening.value = !listening.value;
    if (!listening.value && speaking) endTurn();   // stopped mid-sentence: send what was captured
    else if (!listening.value) resetVad();
    if (!busy) status.value = listening.value ? "Listening…" : "Paused";
  }

  function apply() { lines.value = []; connect(); }

  const text = () => lines.value.filter((l) => !l.sep).map((l) => l.text).join("\n");
  const copy = () => navigator.clipboard.writeText(text());

  connect();
  return { status, listening, ready, level, threshold, lines, toggle, apply, copy, text };
}
