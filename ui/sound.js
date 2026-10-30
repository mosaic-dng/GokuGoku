// 水分補給課 · 音效合成（WebAudio，无素材文件，动森式软糯电子音）
'use strict';
const Sound = (() => {
  let ctx = null;
  let enabled = true;
  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, { at = 0, dur = 0.09, type = 'sine', gain = 0.09 } = {}) {
    const c = ac();
    const t0 = c.currentTime + at;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    if (Array.isArray(freq)) {
      o.frequency.setValueAtTime(freq[0], t0);
      o.frequency.exponentialRampToValueAtTime(Math.max(freq[1], 1), t0 + dur);
    } else {
      o.frequency.value = freq;
    }
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
  return {
    setEnabled(v) { enabled = !!v; },
    blip() {
      if (!enabled) return;
      tone(620 + Math.random() * 320, { dur: 0.045, type: 'triangle', gain: 0.035 });
    },
    pop() {
      if (!enabled) return;
      tone(659, { dur: 0.1, type: 'sine', gain: 0.08 });
      tone(880, { at: 0.09, dur: 0.16, type: 'sine', gain: 0.08 });
    },
    drink() {
      if (!enabled) return;
      tone([300, 140], { dur: 0.12, type: 'sine', gain: 0.12 });
      tone([320, 150], { at: 0.14, dur: 0.12, type: 'sine', gain: 0.12 });
      tone(784, { at: 0.30, dur: 0.09, type: 'triangle', gain: 0.06 });
      tone(1046, { at: 0.38, dur: 0.14, type: 'triangle', gain: 0.06 });
    },
    fanfare() {
      if (!enabled) return;
      const seq = [523, 659, 784, 1046];
      seq.forEach((f, i) => tone(f, { at: i * 0.11, dur: i === seq.length - 1 ? 0.34 : 0.1, type: 'triangle', gain: 0.09 }));
    },
    womp() {
      if (!enabled) return;
      tone([440, 300], { dur: 0.18, type: 'sine', gain: 0.08 });
    },
    click() {
      if (!enabled) return;
      tone(500, { dur: 0.04, type: 'triangle', gain: 0.05 });
    },
  };
})();
