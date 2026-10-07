/**
 * Clinic Voice Assistant — Frontend
 * Audio format required by iotype STT (via backend):
 *   - 16-bit signed little-endian PCM
 *   - Sample rate: 44100 Hz
 *   - Mono
 *   - Sent as raw binary WebSocket frames
 *
 * Silence detection (frontend):
 *   After user has spoken, if RMS energy stays low for 3 seconds,
 *   show "در حال پردازش..." immediately (does not wait for backend).
 */

(function () {
  'use strict';

  // ---------- Config ----------
  const WS_PORT = 8080;
  const TARGET_SAMPLE_RATE = 44100;
  const CHUNK_SAMPLES = 4096; // ~93 ms at 44.1 kHz
  const PHONE_KEY = 'clinic_phone';

  // Silence / VAD
  const SILENCE_MS = 3000;          // 3 seconds of quiet → show processing
  const SPEECH_RMS_THRESHOLD = 0.015; // energy above this = speech
  const MIN_SPEECH_MS = 400;        // must have spoken at least this long

  // ---------- DOM ----------
  const phoneDisplay = document.getElementById('phoneDisplay');
  const logoutBtn = document.getElementById('logoutBtn');
  const micBtn = document.getElementById('micBtn');
  const statusText = document.getElementById('statusText');
  const hintText = document.getElementById('hintText');
  const processingBanner = document.getElementById('processingBanner');
  const transcriptCard = document.getElementById('transcriptCard');
  const partialText = document.getElementById('partialText');
  const replyCard = document.getElementById('replyCard');
  const replyText = document.getElementById('replyText');
  const micStage = document.querySelector('.mic-stage');
  const iconMic = micBtn.querySelector('.icon-mic');
  const iconStop = micBtn.querySelector('.icon-stop');

  // ---------- State ----------
  let phone = localStorage.getItem(PHONE_KEY);
  let ws = null;
  let mediaStream = null;
  let audioContext = null;
  let processor = null;
  let sourceNode = null;
  let isListening = false;
  let isProcessing = false;
  let audioPlayer = null;
  let isPlaying = false;

  // VAD state
  let hadSpeech = false;
  let speechAccumMs = 0;
  let silenceStartTs = null;
  let silenceTriggered = false;

  // ---------- Auth guard ----------
  if (!phone || !/^09\d{9}$/.test(phone)) {
    window.location.replace('/login');
    return;
  }
  phoneDisplay.textContent = phone;

  logoutBtn.addEventListener('click', () => {
    stopEverything();
    localStorage.removeItem(PHONE_KEY);
    window.location.href = '/login';
  });

  // ---------- UI helpers ----------
  function setStatus(text) {
    statusText.textContent = text;
    // do not force-show status while processing banner is up
    if (!isProcessing) statusText.hidden = false;
  }

  function showHint(show) {
    if (hintText) hintText.hidden = !show;
  }

  function showProcessing(show) {
    isProcessing = show;
    if (show) {
      processingBanner.classList.add('is-visible');
      processingBanner.removeAttribute('hidden');
      statusText.hidden = true;
      showHint(false);
      micBtn.classList.add('disabled');
      micStage.classList.remove('listening');
      micBtn.classList.remove('active');
      iconMic.hidden = false;
      iconStop.hidden = true;
    } else {
      processingBanner.classList.remove('is-visible');
      processingBanner.setAttribute('hidden', '');
      statusText.hidden = false;
      micBtn.classList.remove('disabled');
    }
  }

  function setMicActive(active) {
    isListening = active;
    micBtn.classList.toggle('active', active);
    micBtn.setAttribute('aria-pressed', String(active));
    micStage.classList.toggle('listening', active);
    iconMic.hidden = active;
    iconStop.hidden = !active;
    if (active) {
      // reset VAD
      hadSpeech = false;
      speechAccumMs = 0;
      silenceStartTs = null;
      silenceTriggered = false;

      setStatus('در حال گوش دادن... صحبت کنید');
      showHint(true);
      showProcessing(false);
      replyCard.hidden = true;
      transcriptCard.hidden = true;
      partialText.textContent = '';
    } else {
      showProcessing(false);
      setStatus('برای صحبت، دکمه را لمس کنید');
      showHint(false);
    }
  }

  function resetVad() {
    hadSpeech = false;
    speechAccumMs = 0;
    silenceStartTs = null;
    silenceTriggered = false;
  }

  /**
   * Called on every audio chunk while listening.
   * When user has spoken and then is quiet for SILENCE_MS → show processing.
   */
  function processVad(floatSamples, durationMs) {
    if (!isListening || silenceTriggered || isProcessing) return;

    // RMS energy
    let sum = 0;
    for (let i = 0; i < floatSamples.length; i++) {
      const v = floatSamples[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / floatSamples.length);
    const isSpeech = rms >= SPEECH_RMS_THRESHOLD;

    if (isSpeech) {
      hadSpeech = true;
      speechAccumMs += durationMs;
      silenceStartTs = null; // reset silence clock
    } else if (hadSpeech && speechAccumMs >= MIN_SPEECH_MS) {
      // quiet after real speech
      if (silenceStartTs === null) {
        silenceStartTs = performance.now();
      } else {
        const quietMs = performance.now() - silenceStartTs;
        if (quietMs >= SILENCE_MS) {
          onSilenceDetected();
        }
      }
    }
  }

  function onSilenceDetected() {
    if (silenceTriggered || isProcessing) return;
    silenceTriggered = true;
    console.log('[VAD] 3s silence after speech → show processing');

    // Stop mic capture (backend still has its own 3s after STT text)
    stopCapture();
    isListening = false;
    micStage.classList.remove('listening');
    micBtn.classList.remove('active');
    iconMic.hidden = false;
    iconStop.hidden = true;

    // Show the processing banner right when user paused 3 seconds
    showProcessing(true);
  }
    async function reopenMic() {
    if (isListening) return;
    try {
      await startCapture();
      setMicActive(true);
    } catch (err) {
      console.error('[Mic] Reopen failed', err);
      setMicActive(false);
      setStatus('دسترسی به میکروفون لازم است');
    }
  }
  // ---------- WebSocket ----------
  function getWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = location.hostname || 'localhost';
    return `${proto}//${host}:${WS_PORT}/?phone=${encodeURIComponent(phone)}`;
  }

  function connectWebSocket() {
    return new Promise((resolve, reject) => {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        resolve(ws);
        return;
      }

      const url = getWsUrl();
      console.log('[WS] Connecting:', url);
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
        try { ws.close(); } catch (_) {}
      }, 10000);

      ws.onopen = () => {
        clearTimeout(timeout);
        console.log('[WS] Connected');
        resolve(ws);
      };

      ws.onerror = (err) => {
        clearTimeout(timeout);
        console.error('[WS] Error', err);
        reject(err);
      };

      ws.onclose = (ev) => {
        console.log('[WS] Closed', ev.code, ev.reason);
        if (isListening) {
          stopCapture();
          setMicActive(false);
          setStatus('اتصال قطع شد. دوباره تلاش کنید');
        }
        ws = null;
      };

      ws.onmessage = handleServerMessage;
    });
  }

  function handleServerMessage(event) {
    // Binary = TTS audio (WAV from backend)
    if (event.data instanceof ArrayBuffer) {
      console.log('[WS] Received audio binary, bytes:', event.data.byteLength);
      showProcessing(false);
      playAudioBuffer(event.data);
      return;
    }

    try {
      const msg = JSON.parse(
        typeof event.data === 'string'
          ? event.data
          : new TextDecoder().decode(event.data)
      );
      console.log('[WS] JSON:', msg);

      // Backend confirmed turn is being answered — keep/ensure processing UI
      if (msg.type === 'status' && msg.status === 'answering') {
        if (!isProcessing) {
          stopCapture();
          isListening = false;
          showProcessing(true);
        }
      }
      if (msg.type === 'status' && msg.status === 'listening') {
        reopenMic();
      }
      if (msg.partial) {
        transcriptCard.hidden = false;
        partialText.textContent = msg.partial;
      }
      if (msg.text && msg.role === 'assistant') {
        replyCard.hidden = false;
        replyText.textContent = msg.text;
      }
    } catch (e) {
      console.warn('[WS] Non-JSON text message', e);
    }
  }

  // ---------- Audio capture: 16-bit PCM @ 44100 Hz ----------
  async function startCapture() {
    if (mediaStream) return;

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: TARGET_SAMPLE_RATE,
        },
        video: false,
      });
    } catch (err) {
      console.error('[Mic] Permission denied or error', err);
      setStatus('دسترسی به میکروفون لازم است');
      throw err;
    }

    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: TARGET_SAMPLE_RATE,
    });

    const actualRate = audioContext.sampleRate;
    console.log('[Audio] Context sampleRate:', actualRate);

    sourceNode = audioContext.createMediaStreamSource(mediaStream);

    const bufferSize = 4096;
    processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

    let residual = new Float32Array(0);

    processor.onaudioprocess = (e) => {
      if (!isListening || !ws || ws.readyState !== WebSocket.OPEN) return;

      const input = e.inputBuffer.getChannelData(0);
      const durationMs = (input.length / actualRate) * 1000;

      // VAD on original samples (before resample)
      processVad(input, durationMs);

      // If silence already triggered, stop sending further audio
      if (silenceTriggered) return;

      let samples;
      if (actualRate === TARGET_SAMPLE_RATE) {
        samples = input;
      } else {
        samples = resampleLinear(input, actualRate, TARGET_SAMPLE_RATE);
      }

      const combined = new Float32Array(residual.length + samples.length);
      combined.set(residual);
      combined.set(samples, residual.length);

      let offset = 0;
      while (offset + CHUNK_SAMPLES <= combined.length) {
        const chunk = combined.subarray(offset, offset + CHUNK_SAMPLES);
        const pcm = floatTo16BitPCM(chunk);
        try {
          ws.send(pcm);
        } catch (err) {
          console.error('[WS] Send failed', err);
        }
        offset += CHUNK_SAMPLES;
      }
      residual = combined.subarray(offset);
    };

    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    sourceNode.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);
  }

  function stopCapture() {
    if (processor) {
      try { processor.disconnect(); } catch (_) {}
      processor.onaudioprocess = null;
      processor = null;
    }
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch (_) {}
      sourceNode = null;
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
  }

  function floatTo16BitPCM(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Array.length; i++) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      s = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(i * 2, s | 0, true);
    }
    return buffer;
  }

  function resampleLinear(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const newLen = Math.round(input.length / ratio);
    const output = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const srcIndex = i * ratio;
      const i0 = Math.floor(srcIndex);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const frac = srcIndex - i0;
      output[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return output;
  }

  // ---------- Playback ----------
  function playAudioBuffer(arrayBuffer) {
    const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);

    if (audioPlayer) {
      audioPlayer.pause();
      try { URL.revokeObjectURL(audioPlayer.src); } catch (_) {}
    }

    audioPlayer = new Audio(url);
    isPlaying = true;
    setStatus('در حال پخش پاسخ...');

    audioPlayer.onended = () => {
      isPlaying = false;
      URL.revokeObjectURL(url);
      resetVad();
      setStatus('برای صحبت، دکمه را لمس کنید');
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ text: 'audio_finished' }));
        console.log('[WS] Sent audio_finished');
      }
    };

    audioPlayer.onerror = () => {
      isPlaying = false;
      setStatus('خطا در پخش صدا');
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ text: 'audio_finished' }));
      }
    };

    audioPlayer.play().catch(() => {
      setStatus('برای شنیدن پاسخ، صفحه را لمس کنید');
      const unlock = () => {
        audioPlayer.play().finally(() => {
          document.removeEventListener('click', unlock);
          document.removeEventListener('touchstart', unlock);
        });
      };
      document.addEventListener('click', unlock, { once: true });
      document.addEventListener('touchstart', unlock, { once: true });
    });
  }

  // ---------- Main toggle ----------
  async function toggleMic() {
    if (isProcessing || isPlaying) return;

    if (isListening) {
      // Manual stop by user
      stopCapture();
      setMicActive(false);
      resetVad();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ text: 'stop' }));
      }
      return;
    }

    try {
      setStatus('در حال اتصال...');
      micBtn.classList.add('disabled');

      await connectWebSocket();
      await startCapture();

      micBtn.classList.remove('disabled');
      setMicActive(true);
    } catch (err) {
      console.error('[Toggle] Failed', err);
      stopCapture();
      setMicActive(false);
      resetVad();
      micBtn.classList.remove('disabled');
      setStatus('اتصال برقرار نشد. دوباره تلاش کنید');
    }
  }

  function stopEverything() {
    stopCapture();
    setMicActive(false);
    showProcessing(false);
    resetVad();
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ text: 'stop' }));
        }
        ws.close();
      } catch (_) {}
      ws = null;
    }
    if (audioPlayer) {
      audioPlayer.pause();
      audioPlayer = null;
    }
  }

  micBtn.addEventListener('click', toggleMic);
  window.addEventListener('beforeunload', stopEverything);

  console.log('[App] Ready. Phone:', phone);
})();
