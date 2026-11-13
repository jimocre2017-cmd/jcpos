/* Jimo Cafe POS 効果音（外部ファイル不要・オフラインでも鳴る。ブラウザの音声合成で作る）
 * JCSfx.play('order')  厨房：新しい注文が入った（ピンポンピーン）
 * JCSfx.play('send')   POS：注文を送信した（シュッ）
 * JCSfx.play('pay')    会計（チャリン）
 * JCSfx.play('served') 提供済みにした（ポッ）
 * JCSfx.play('undo')   取消・戻す（ポロン↓）
 * JCSfx.play('error')  エラー（ブッ）
 * ブラウザの決まりで、画面を一度タップするまで音は出せない。タップすると自動で有効になる。
 */
(function () {
  var ctx = null;
  var KEY = 'jcsfx_on';
  function isOn() { try { return localStorage.getItem(KEY) !== '0'; } catch (e) { return true; } }
  function setOn(v) { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) {} refreshButtons(); }
  function getCtx() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    return ctx;
  }
  function tone(freq, start, dur, type, vol, freqEnd) {
    var c = getCtx(); if (!c) return;
    var t0 = c.currentTime + start;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.3, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  var SOUNDS = {
    // 新しい注文：明るい3音（厨房の騒がしさでも気づける音量・長さ）を2回
    order: function () {
      [0, 0.55].forEach(function (d) {
        tone(1046.5, d + 0.00, 0.28, 'sine', 0.45);
        tone(1318.5, d + 0.14, 0.28, 'sine', 0.45);
        tone(1568.0, d + 0.28, 0.38, 'sine', 0.45);
      });
    },
    // 送信：軽い上昇スウィープ
    send: function () {
      tone(420, 0, 0.16, 'sine', 0.25, 1300);
      tone(1500, 0.14, 0.08, 'triangle', 0.15);
    },
    // 会計：レジのチャリン（金属的な高音2つ＋倍音）
    pay: function () {
      tone(2093, 0.00, 0.12, 'triangle', 0.35);
      tone(4186, 0.00, 0.08, 'sine', 0.12);
      tone(2637, 0.08, 0.45, 'triangle', 0.38);
      tone(5274, 0.08, 0.25, 'sine', 0.12);
      tone(3136, 0.08, 0.30, 'sine', 0.10);
    },
    served: function () { tone(988, 0, 0.09, 'sine', 0.22); tone(1319, 0.07, 0.10, 'sine', 0.18); },
    undo: function () { tone(587, 0, 0.14, 'sine', 0.28); tone(392, 0.12, 0.22, 'sine', 0.28); },
    error: function () { tone(180, 0, 0.25, 'sawtooth', 0.22); }
  };
  function play(name) {
    if (!isOn()) return;
    var f = SOUNDS[name]; if (!f) return;
    try { f(); } catch (e) {}
  }
  function unlock() { getCtx(); }
  ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(function (ev) {
    window.addEventListener(ev, unlock, { once: false, passive: true });
  });
  function refreshButtons() {
    var on = isOn();
    var list = document.querySelectorAll('[data-sfx-toggle]');
    for (var i = 0; i < list.length; i++) list[i].textContent = on ? '🔔 音ON' : '🔕 音OFF';
  }
  function toggle() {
    var next = !isOn();
    setOn(next);
    if (next) { unlock(); play('served'); }
  }
  document.addEventListener('DOMContentLoaded', refreshButtons);
  window.JCSfx = { play: play, toggle: toggle, isOn: isOn, unlock: unlock, refresh: refreshButtons };
})();
