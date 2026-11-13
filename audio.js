/**
 * ABYSS CORE（アビス・コア）― Web Audio API 深海シンセサイザー音響エンジン
 * 外部音声ファイルを一切使用せず、100%リアルタイム合成による深海ASMR、
 * 深海ソナー、工業計器SE、相棒ロボ通信音、和音、ミュート制御を提供する。
 * 公開シンボル: window.AbyssAudio
 */
(function (global) {
  'use strict';

  var EPSILON = 0.0001;
  var MASTER_UNMUTED_GAIN = 0.72;
  var AMBIENT_TARGET_GAIN = 0.34;

  var COOLDOWN_MS = {
    clickSlider: 35,
    boogie: 90,
    cash: 95,
    tidyChord: 400,
    warning: 2200,
    unlock: 450,
    sonar: 350
  };

  var state = {
    supported: true,
    initialized: false,
    muted: false,
    ctx: null,
    masterGain: null,
    compressor: null,
    sfxBus: null,
    ambientBus: null,
    reverbSend: null,
    reverbNode: null,
    reverbReturn: null,
    delaySend: null,
    delayNode: null,
    delayFeedback: null,
    delayReturn: null,
    shortNoiseBuffer: null,
    ambientNoiseBuffer: null,
    ambientDesired: false,
    ambientRunning: false,
    ambientNodes: null,
    ambientStopTimer: null,
    activeCashVoices: 0,
    cashComboIndex: 0,
    lastTimes: {
      clickSlider: 0,
      boogie: 0,
      cash: 0,
      tidyChord: 0,
      warning: 0,
      unlock: 0,
      sonar: 0
    }
  };

  function nowMs() {
    if (global.performance && typeof global.performance.now === 'function') {
      return global.performance.now();
    }
    return Date.now();
  }

  function clamp(val, min, max) {
    if (!Number.isFinite(val)) {
      return min;
    }
    if (val < min) {
      return min;
    }
    if (val > max) {
      return max;
    }
    return val;
  }

  function safeFreq(ctx, freq) {
    var nyquist = ctx && ctx.sampleRate ? ctx.sampleRate * 0.45 : 18000;
    return clamp(freq, 20, nyquist);
  }

  function canTriggerCooldown(key, minIntervalMs) {
    var t = nowMs();
    var last = state.lastTimes[key] || 0;
    if (t - last < minIntervalMs) {
      return false;
    }
    state.lastTimes[key] = t;
    return true;
  }

  function safeDisconnect(node) {
    if (!node || typeof node.disconnect !== 'function') {
      return;
    }
    try {
      node.disconnect();
    } catch (_) {
      // 既に切断済みの場合は安全に無視する
    }
  }

  function bindAutoCleanup(sourceNode, nodesToDisconnect) {
    if (!sourceNode) {
      return;
    }
    sourceNode.onended = function () {
      for (var i = 0; i < nodesToDisconnect.length; i += 1) {
        safeDisconnect(nodesToDisconnect[i]);
      }
    };
  }

  /**
   * 均等ホワイト＋ピンク混合の短尺ノイズバッファ（各種クリック・油圧・エア抜き用）
   * およびシームレスループ対応の深海ASMR用ブラウン＋ピンク長尺バッファを生成する。
   */
  function buildNoiseBuffers(ctx) {
    var sr = ctx.sampleRate || 44100;

    // 1. ワンショットSE用短尺ノイズバッファ（0.6秒・ステレオ）
    var shortLen = Math.max(1024, Math.floor(sr * 0.6));
    var shortBuf = ctx.createBuffer(2, shortLen, sr);
    for (var ch = 0; ch < 2; ch += 1) {
      var sData = shortBuf.getChannelData(ch);
      var b0 = 0;
      var b1 = 0;
      var b2 = 0;
      for (var i = 0; i < shortLen; i += 1) {
        var white = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + white * 0.099046;
        b1 = 0.96300 * b1 + white * 0.2965164;
        b2 = 0.57000 * b2 + white * 1.0526913;
        var pink = (b0 + b1 + b2 + white * 0.1848) * 0.18;
        sData[i] = clamp(pink * 0.68 + white * 0.28, -0.95, 0.95);
      }
    }

    // 2. 深海ASMRアンビエント用長尺ノイズバッファ（8.0秒・ステレオ・両端シームレスループ）
    var ambSec = 8.0;
    var ambLen = Math.max(sr * 2, Math.floor(sr * ambSec));
    var ambBuf = ctx.createBuffer(2, ambLen, sr);
    var fadeSamples = Math.floor(sr * 0.65);

    for (var ach = 0; ach < 2; ach += 1) {
      var raw = new Float32Array(ambLen + fadeSamples);
      var brown = 0;
      var pb0 = 0;
      var pb1 = 0;
      var pb2 = 0;
      var pb3 = 0;
      var pb4 = 0;
      var pb5 = 0;
      var pb6 = 0;
      var maxAbs = 0.001;

      for (var j = 0; j < raw.length; j += 1) {
        var w = Math.random() * 2 - 1;
        // ブラウンノイズ成分（深海水圧の重厚な揺らぎ）
        brown = (brown + 0.022 * w) / 1.022;
        var brownScaled = brown * 3.4;

        // ピンクノイズ成分（Paul Kellet 7段近似：水中気泡・柔らかな潮流）
        pb0 = 0.99886 * pb0 + w * 0.0555179;
        pb1 = 0.99332 * pb1 + w * 0.0750759;
        pb2 = 0.96900 * pb2 + w * 0.1538520;
        pb3 = 0.86650 * pb3 + w * 0.3104856;
        pb4 = 0.55000 * pb4 + w * 0.5329522;
        pb5 = -0.7616 * pb5 - w * 0.0168980;
        var pinkFull = (pb0 + pb1 + pb2 + pb3 + pb4 + pb5 + pb6 + w * 0.5362) * 0.095;
        pb6 = w * 0.115926;

        var mixed = brownScaled * 0.72 + pinkFull * 0.28;
        raw[j] = mixed;
        var absVal = Math.abs(mixed);
        if (absVal > maxAbs) {
          maxAbs = absVal;
        }
      }

      var outData = ambBuf.getChannelData(ach);
      var norm = 0.65 / maxAbs;
      // 末尾と先頭を等パワー風クロスフェードし、ループ継ぎ目のノイズを完全に消す
      for (var k = 0; k < ambLen; k += 1) {
        if (k < fadeSamples) {
          var t = k / fadeSamples;
          var gainIn = Math.sin(t * Math.PI * 0.5);
          var gainOut = Math.cos(t * Math.PI * 0.5);
          outData[k] = (raw[k] * gainIn + raw[ambLen + k] * gainOut) * norm;
        } else {
          outData[k] = raw[k] * norm;
        }
      }
    }

    state.shortNoiseBuffer = shortBuf;
    state.ambientNoiseBuffer = ambBuf;
  }

  /**
   * 外部アセット不要のアルゴリズム深海リバーブ用インパルス応答を生成する。
   * 時間経過に応じて高域が減衰する水中残響カーブを模擬。
   */
  function buildDeepReverbIR(ctx) {
    var sr = ctx.sampleRate || 44100;
    var duration = 1.85;
    var len = Math.max(1024, Math.floor(sr * duration));
    var ir = ctx.createBuffer(2, len, sr);
    var attackSamples = Math.max(1, Math.floor(sr * 0.025));

    for (var ch = 0; ch < 2; ch += 1) {
      var data = ir.getChannelData(ch);
      var lp = 0;
      for (var i = 0; i < len; i += 1) {
        var progress = i / len;
        var env = Math.pow(1 - progress, 2.75);
        if (i < attackSamples) {
          env *= i / attackSamples;
        }
        var noise = (Math.random() * 2 - 1) * env;
        // 水中音響特性に合わせ、残響後半ほど暗く丸いトーンに減衰させる
        var alpha = 0.24 * (1 - progress * 0.72) + 0.04;
        lp = lp + alpha * (noise - lp);
        data[i] = lp * 0.9;
      }
    }
    return ir;
  }

  /**
   * AudioContext およびマスターバス／エフェクトバスを構築する。
   */
  function ensureContext() {
    if (!state.supported) {
      return null;
    }

    if (!state.ctx) {
      var AudioCtx = global.AudioContext || global.webkitAudioContext;
      if (!AudioCtx) {
        state.supported = false;
        return null;
      }

      try {
        var ctx = new AudioCtx();
        state.ctx = ctx;

        // マスターコンプレッサー（複数和音や連打時のクリッピング防止）
        var comp = ctx.createDynamicsCompressor();
        comp.threshold.setValueAtTime(-14, ctx.currentTime);
        comp.knee.setValueAtTime(18, ctx.currentTime);
        comp.ratio.setValueAtTime(4.0, ctx.currentTime);
        comp.attack.setValueAtTime(0.005, ctx.currentTime);
        comp.release.setValueAtTime(0.18, ctx.currentTime);

        // マスターゲイン（初期ミュート状態も即反映し音漏れを防ぐ）
        var master = ctx.createGain();
        var initialGain = state.muted ? EPSILON : MASTER_UNMUTED_GAIN;
        master.gain.setValueAtTime(initialGain, ctx.currentTime);

        // 効果音バス＆深海ASMRアンビエントバス
        var sfxBus = ctx.createGain();
        sfxBus.gain.setValueAtTime(1.0, ctx.currentTime);

        var ambientBus = ctx.createGain();
        ambientBus.gain.setValueAtTime(EPSILON, ctx.currentTime);

        // 共有深海リバーブバス
        var reverbSend = ctx.createGain();
        reverbSend.gain.setValueAtTime(1.0, ctx.currentTime);
        var convolver = ctx.createConvolver();
        convolver.normalize = true;
        convolver.buffer = buildDeepReverbIR(ctx);
        var reverbReturn = ctx.createGain();
        reverbReturn.gain.setValueAtTime(0.32, ctx.currentTime);

        // 共有深海ソナー＆空間マルチタップディレイバス（発振防止LPF内蔵）
        var delaySend = ctx.createGain();
        delaySend.gain.setValueAtTime(1.0, ctx.currentTime);
        var delayNode = ctx.createDelay(2.0);
        delayNode.delayTime.setValueAtTime(0.39, ctx.currentTime);
        var delayFilter = ctx.createBiquadFilter();
        delayFilter.type = 'lowpass';
        delayFilter.frequency.setValueAtTime(1550, ctx.currentTime);
        delayFilter.Q.setValueAtTime(0.6, ctx.currentTime);
        var delayFeedback = ctx.createGain();
        delayFeedback.gain.setValueAtTime(0.38, ctx.currentTime);
        var delayReturn = ctx.createGain();
        delayReturn.gain.setValueAtTime(0.42, ctx.currentTime);

        // ルーティング接続
        sfxBus.connect(comp);
        ambientBus.connect(comp);

        reverbSend.connect(convolver);
        convolver.connect(reverbReturn);
        reverbReturn.connect(comp);

        delaySend.connect(delayNode);
        delayNode.connect(delayFilter);
        delayFilter.connect(delayFeedback);
        delayFeedback.connect(delayNode);
        delayFilter.connect(delayReturn);
        delayReturn.connect(comp);
        delayFilter.connect(reverbSend);

        comp.connect(master);
        master.connect(ctx.destination);

        state.compressor = comp;
        state.masterGain = master;
        state.sfxBus = sfxBus;
        state.ambientBus = ambientBus;
        state.reverbSend = reverbSend;
        state.reverbNode = convolver;
        state.reverbReturn = reverbReturn;
        state.delaySend = delaySend;
        state.delayNode = delayNode;
        state.delayFeedback = delayFeedback;
        state.delayReturn = delayReturn;

        buildNoiseBuffers(ctx);
        state.initialized = true;
      } catch (_) {
        state.supported = false;
        state.ctx = null;
        return null;
      }
    }

    if (state.ctx && state.ctx.state === 'suspended' && typeof state.ctx.resume === 'function') {
      try {
        var resumePromise = state.ctx.resume();
        if (resumePromise && typeof resumePromise.catch === 'function') {
          resumePromise.catch(function () {
            // ユーザー操作前の自動再生制限による拒否は安全に無視する
          });
        }
      } catch (_) {
        // resume例外は安全に無視する
      }
    }

    return state.ctx;
  }

  /**
   * 効果音が実際に発音可能か判定する（初期化試行＋ミュート時はスキップ）。
   */
  function preparePlayableContext() {
    if (state.muted) {
      return null;
    }
    var ctx = ensureContext();
    if (!ctx) {
      return null;
    }
    return ctx;
  }

  /**
   * 初回ユーザー操作時の安全なオーディオエンジン初期化＆アンビエント自動復帰。
   */
  function init() {
    var ctx = ensureContext();
    if (!ctx) {
      return false;
    }
    if (state.ambientDesired && !state.ambientRunning) {
      startAmbient();
    }
    return true;
  }

  function isMuted() {
    return state.muted;
  }

  /**
   * マスターゲインを平滑フェードしてクリックノイズゼロでミュートを切り替える。
   */
  function setMuted(muted) {
    var nextMuted = Boolean(muted);
    state.muted = nextMuted;

    if (!state.ctx || !state.masterGain) {
      return state.muted;
    }

    var ctx = state.ctx;
    var now = ctx.currentTime;
    var target = nextMuted ? EPSILON : MASTER_UNMUTED_GAIN;
    var gainParam = state.masterGain.gain;

    try {
      var currentVal = clamp(gainParam.value, EPSILON, 1.0);
      gainParam.cancelScheduledValues(now);
      gainParam.setValueAtTime(currentVal, now);
      gainParam.setTargetAtTime(target, now, 0.045);
    } catch (_) {
      gainParam.value = target;
    }

    return state.muted;
  }

  function toggleMute() {
    return setMuted(!state.muted);
  }

  /**
   * 深海ASMRアンビエント水流音を起動する。
   * ブラウン＋ピンクノイズのLFO変調潮流・気泡揺らぎ・超低域ドローンの3層構造。
   */
  function startAmbient() {
    state.ambientDesired = true;

    if (state.ambientStopTimer) {
      global.clearTimeout(state.ambientStopTimer);
      state.ambientStopTimer = null;
    }

    var ctx = ensureContext();
    if (!ctx || !state.ambientBus || !state.ambientNoiseBuffer) {
      return false;
    }

    var now = ctx.currentTime;

    // 既に稼働中（またはフェードアウト途中から復帰）なら音量だけ滑らかに戻す
    if (state.ambientRunning && state.ambientNodes) {
      var ambGain = state.ambientBus.gain;
      ambGain.cancelScheduledValues(now);
      ambGain.setValueAtTime(clamp(ambGain.value, EPSILON, 1.0), now);
      ambGain.setTargetAtTime(AMBIENT_TARGET_GAIN, now, 0.45);
      return true;
    }

    // レイヤー1：深層潮流（ローパス＋緩やかなLFOフィルタ変調＋呼吸LFO）
    var flowSrc = ctx.createBufferSource();
    flowSrc.buffer = state.ambientNoiseBuffer;
    flowSrc.loop = true;

    var flowSubCut = ctx.createBiquadFilter();
    flowSubCut.type = 'highpass';
    flowSubCut.frequency.setValueAtTime(36, now);
    flowSubCut.Q.setValueAtTime(0.6, now);

    var flowLpf = ctx.createBiquadFilter();
    flowLpf.type = 'lowpass';
    flowLpf.frequency.setValueAtTime(245, now);
    flowLpf.Q.setValueAtTime(0.75, now);

    var flowLfo = ctx.createOscillator();
    flowLfo.type = 'sine';
    flowLfo.frequency.setValueAtTime(0.072, now);
    var flowLfoDepth = ctx.createGain();
    flowLfoDepth.gain.setValueAtTime(95, now);
    flowLfo.connect(flowLfoDepth);
    flowLfoDepth.connect(flowLpf.frequency);

    var flowGain = ctx.createGain();
    flowGain.gain.setValueAtTime(0.78, now);

    var breathLfo = ctx.createOscillator();
    breathLfo.type = 'sine';
    breathLfo.frequency.setValueAtTime(0.048, now);
    var breathDepth = ctx.createGain();
    breathDepth.gain.setValueAtTime(0.16, now);
    breathLfo.connect(breathDepth);
    breathDepth.connect(flowGain.gain);

    flowSrc.connect(flowSubCut);
    flowSubCut.connect(flowLpf);
    flowLpf.connect(flowGain);
    flowGain.connect(state.ambientBus);

    // レイヤー2：水中気泡・細やかな水圧の揺らぎ（別オフセット再生＋帯域通過フィルタ）
    var bubbleSrc = ctx.createBufferSource();
    bubbleSrc.buffer = state.ambientNoiseBuffer;
    bubbleSrc.loop = true;

    var bubbleBpf = ctx.createBiquadFilter();
    bubbleBpf.type = 'bandpass';
    bubbleBpf.frequency.setValueAtTime(510, now);
    bubbleBpf.Q.setValueAtTime(1.35, now);

    var bubbleLfo = ctx.createOscillator();
    bubbleLfo.type = 'sine';
    bubbleLfo.frequency.setValueAtTime(0.11, now);
    var bubbleLfoDepth = ctx.createGain();
    bubbleLfoDepth.gain.setValueAtTime(140, now);
    bubbleLfo.connect(bubbleLfoDepth);
    bubbleLfoDepth.connect(bubbleBpf.frequency);

    var bubbleGain = ctx.createGain();
    bubbleGain.gain.setValueAtTime(0.13, now);

    bubbleSrc.connect(bubbleBpf);
    bubbleBpf.connect(bubbleGain);
    bubbleGain.connect(state.ambientBus);

    // レイヤー3：深海プラント基底の極めて微かな超低域ドローン（純サイン波のみ）
    var droneOsc1 = ctx.createOscillator();
    droneOsc1.type = 'sine';
    droneOsc1.frequency.setValueAtTime(55.0, now); // A1

    var droneOsc2 = ctx.createOscillator();
    droneOsc2.type = 'sine';
    droneOsc2.frequency.setValueAtTime(82.41, now); // E2

    var droneGain = ctx.createGain();
    droneGain.gain.setValueAtTime(0.048, now);

    var droneOsc2Gain = ctx.createGain();
    droneOsc2Gain.gain.setValueAtTime(0.45, now);

    var droneLfo = ctx.createOscillator();
    droneLfo.type = 'sine';
    droneLfo.frequency.setValueAtTime(0.032, now);
    var droneLfoDepth = ctx.createGain();
    droneLfoDepth.gain.setValueAtTime(0.015, now);
    droneLfo.connect(droneLfoDepth);
    droneLfoDepth.connect(droneGain.gain);

    droneOsc1.connect(droneGain);
    droneOsc2.connect(droneOsc2Gain);
    droneOsc2Gain.connect(droneGain);
    droneGain.connect(state.ambientBus);

    // 各ソースを非同期オフセットで開始し位相干渉を避ける
    flowSrc.start(now, 0);
    bubbleSrc.start(now, 3.35);
    flowLfo.start(now);
    breathLfo.start(now);
    bubbleLfo.start(now);
    droneOsc1.start(now);
    droneOsc2.start(now);
    droneLfo.start(now);

    // 緩やかなフェードイン（1.8秒相当の時定数）
    state.ambientBus.gain.cancelScheduledValues(now);
    state.ambientBus.gain.setValueAtTime(EPSILON, now);
    state.ambientBus.gain.setTargetAtTime(AMBIENT_TARGET_GAIN, now, 0.55);

    state.ambientRunning = true;
    state.ambientNodes = {
      sources: [flowSrc, bubbleSrc, flowLfo, breathLfo, bubbleLfo, droneOsc1, droneOsc2, droneLfo],
      allNodes: [
        flowSrc, flowSubCut, flowLpf, flowLfo, flowLfoDepth, flowGain, breathLfo, breathDepth,
        bubbleSrc, bubbleBpf, bubbleLfo, bubbleLfoDepth, bubbleGain,
        droneOsc1, droneOsc2, droneOsc2Gain, droneGain, droneLfo, droneLfoDepth
      ]
    };

    return true;
  }

  /**
   * 深海ASMRアンビエント水流音を滑らかにフェードアウト停止する。
   */
  function stopAmbient() {
    state.ambientDesired = false;

    if (!state.ambientRunning || !state.ctx || !state.ambientBus) {
      return;
    }

    var ctx = state.ctx;
    var now = ctx.currentTime;
    var nodesSnapshot = state.ambientNodes;

    try {
      var gainParam = state.ambientBus.gain;
      gainParam.cancelScheduledValues(now);
      gainParam.setValueAtTime(clamp(gainParam.value, EPSILON, 1.0), now);
      gainParam.setTargetAtTime(EPSILON, now, 0.22);
    } catch (_) {
      // パラメータ操作失敗時は直接クリーンアップへ進む
    }

    if (state.ambientStopTimer) {
      global.clearTimeout(state.ambientStopTimer);
    }

    state.ambientStopTimer = global.setTimeout(function () {
      state.ambientStopTimer = null;
      if (state.ambientDesired) {
        return;
      }
      if (nodesSnapshot) {
        for (var i = 0; i < nodesSnapshot.sources.length; i += 1) {
          try {
            nodesSnapshot.sources[i].stop();
          } catch (_) {
            // 停止済み無視
          }
        }
        for (var j = 0; j < nodesSnapshot.allNodes.length; j += 1) {
          safeDisconnect(nodesSnapshot.allNodes[j]);
        }
      }
      state.ambientRunning = false;
      state.ambientNodes = null;
    }, 950);
  }

  /**
   * 遠くの深海から響くソナーピング音（正弦波＋微小ピッチベンド＋仮想ディレイ残響）。
   */
  function playSonar() {
    var ctx = preparePlayableContext();
    if (!ctx || !canTriggerCooldown('sonar', COOLDOWN_MS.sonar)) {
      return;
    }

    var now = ctx.currentTime;
    // 自然な揺らぎを持たせた澄んだソナー基準ピッチ（D6付近）
    var detuneRatio = 1 + (Math.random() * 0.024 - 0.012);
    var baseFreq = safeFreq(ctx, 1174.66 * detuneRatio);

    // 1. メイン・ソナーピング（純粋なサイン波）
    var mainOsc = ctx.createOscillator();
    mainOsc.type = 'sine';
    mainOsc.frequency.setValueAtTime(safeFreq(ctx, baseFreq * 1.012), now);
    mainOsc.frequency.exponentialRampToValueAtTime(baseFreq, now + 0.045);
    mainOsc.frequency.exponentialRampToValueAtTime(safeFreq(ctx, baseFreq * 0.992), now + 1.25);

    var mainGain = ctx.createGain();
    mainGain.gain.setValueAtTime(EPSILON, now);
    mainGain.gain.linearRampToValueAtTime(0.16, now + 0.012);
    mainGain.gain.exponentialRampToValueAtTime(0.032, now + 0.36);
    mainGain.gain.exponentialRampToValueAtTime(EPSILON, now + 1.28);

    // 2. チタン球殻の微かな2倍音キラめき
    var harmOsc = ctx.createOscillator();
    harmOsc.type = 'sine';
    harmOsc.frequency.setValueAtTime(safeFreq(ctx, baseFreq * 2.0), now);

    var harmGain = ctx.createGain();
    harmGain.gain.setValueAtTime(EPSILON, now);
    harmGain.gain.linearRampToValueAtTime(0.028, now + 0.008);
    harmGain.gain.exponentialRampToValueAtTime(EPSILON, now + 0.34);

    mainOsc.connect(mainGain);
    harmOsc.connect(harmGain);

    // ドライ音は控えめにし、ディレイ＆リバーブへ多めに送って遠方の深海感を出す
    var dryGain = ctx.createGain();
    dryGain.gain.setValueAtTime(0.55, now);
    var wetDelayGain = ctx.createGain();
    wetDelayGain.gain.setValueAtTime(0.68, now);
    var wetReverbGain = ctx.createGain();
    wetReverbGain.gain.setValueAtTime(0.75, now);

    mainGain.connect(dryGain);
    harmGain.connect(dryGain);
    dryGain.connect(state.sfxBus);

    mainGain.connect(wetDelayGain);
    wetDelayGain.connect(state.delaySend);

    mainGain.connect(wetReverbGain);
    harmGain.connect(wetReverbGain);
    wetReverbGain.connect(state.reverbSend);

    mainOsc.start(now);
    harmOsc.start(now);
    mainOsc.stop(now + 1.32);
    harmOsc.stop(now + 0.38);

    bindAutoCleanup(mainOsc, [mainOsc, mainGain, dryGain, wetDelayGain, wetReverbGain]);
    bindAutoCleanup(harmOsc, [harmOsc, harmGain]);
  }

  /**
   * ノード選択・UIボタン押下・スライダー操作用の小気味よいメカニカルクリック音。
   * @param {string|number} [variant] - 'node' | 'slider' | 'toggle' | 'ui' | 'default' 等
   */
  function playClick(variant) {
    var ctx = preparePlayableContext();
    if (!ctx) {
      return;
    }

    var key = typeof variant === 'string' ? variant.toLowerCase() : 'default';

    // スライダー連続操作時の耳障り防止クールダウン
    if (key === 'slider' || key === 'tick') {
      if (!canTriggerCooldown('clickSlider', COOLDOWN_MS.clickSlider)) {
        return;
      }
    }

    var now = ctx.currentTime;
    var startFreq = 920;
    var endFreq = 320;
    var toneDur = 0.028;
    var toneGainPeak = 0.11;
    var noiseFreq = 2500;
    var noiseGainPeak = 0.085;
    var noiseDur = 0.016;
    var oscType = 'triangle';

    if (key === 'slider' || key === 'tick') {
      startFreq = 1480;
      endFreq = 960;
      toneDur = 0.015;
      toneGainPeak = 0.055;
      noiseFreq = 3400;
      noiseGainPeak = 0.045;
      noiseDur = 0.010;
      oscType = 'sine';
    } else if (key === 'node' || key === 'select') {
      startFreq = 720;
      endFreq = 230;
      toneDur = 0.036;
      toneGainPeak = 0.14;
      noiseFreq = 1950;
      noiseGainPeak = 0.11;
      noiseDur = 0.020;
      oscType = 'triangle';
    } else if (key === 'toggle' || key === 'mode') {
      startFreq = 1080;
      endFreq = 410;
      toneDur = 0.034;
      toneGainPeak = 0.125;
      noiseFreq = 2900;
      noiseGainPeak = 0.095;
      noiseDur = 0.018;
      oscType = 'triangle';
    } else if (key === 'ui' || key === 'tab' || key === 'button') {
      startFreq = 1220;
      endFreq = 540;
      toneDur = 0.024;
      toneGainPeak = 0.10;
      noiseFreq = 3100;
      noiseGainPeak = 0.07;
      noiseDur = 0.014;
      oscType = 'sine';
    } else if (typeof variant === 'number' && Number.isFinite(variant)) {
      var ratio = clamp(1 + variant * 0.06, 0.65, 1.8);
      startFreq *= ratio;
      endFreq *= ratio;
    }

    // メカニカルソレノイド芯
    var osc = ctx.createOscillator();
    osc.type = oscType;
    osc.frequency.setValueAtTime(safeFreq(ctx, startFreq), now);
    osc.frequency.exponentialRampToValueAtTime(safeFreq(ctx, endFreq), now + toneDur);

    var toneGain = ctx.createGain();
    toneGain.gain.setValueAtTime(EPSILON, now);
    toneGain.gain.linearRampToValueAtTime(toneGainPeak, now + 0.002);
    toneGain.gain.exponentialRampToValueAtTime(EPSILON, now + toneDur);

    osc.connect(toneGain);
    toneGain.connect(state.sfxBus);

    osc.start(now);
    osc.stop(now + toneDur + 0.01);
    bindAutoCleanup(osc, [osc, toneGain]);

    // 精密スイッチの接触トランジェント
    if (state.shortNoiseBuffer) {
      var noiseSrc = ctx.createBufferSource();
      noiseSrc.buffer = state.shortNoiseBuffer;

      var bpf = ctx.createBiquadFilter();
      bpf.type = 'bandpass';
      bpf.frequency.setValueAtTime(safeFreq(ctx, noiseFreq), now);
      bpf.Q.setValueAtTime(2.2, now);

      var nGain = ctx.createGain();
      nGain.gain.setValueAtTime(EPSILON, now);
      nGain.gain.linearRampToValueAtTime(noiseGainPeak, now + 0.0015);
      nGain.gain.exponentialRampToValueAtTime(EPSILON, now + noiseDur);

      noiseSrc.connect(bpf);
      bpf.connect(nGain);
      nGain.connect(state.sfxBus);

      noiseSrc.start(now, Math.random() * 0.25, noiseDur + 0.015);
      bindAutoCleanup(noiseSrc, [noiseSrc, bpf, nGain]);
    }
  }

  /**
   * 深海プラント設置時の重厚な油圧着地音＋金属ロック音。
   */
  function playPlace() {
    var ctx = preparePlayableContext();
    if (!ctx) {
      return;
    }

    var now = ctx.currentTime;

    // 1. 油圧着地サブパンチ（ズシンと海底へ固定する重量感）
    var subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(165, now);
    subOsc.frequency.exponentialRampToValueAtTime(44, now + 0.16);

    var subGain = ctx.createGain();
    subGain.gain.setValueAtTime(EPSILON, now);
    subGain.gain.linearRampToValueAtTime(0.32, now + 0.008);
    subGain.gain.exponentialRampToValueAtTime(EPSILON, now + 0.21);

    subOsc.connect(subGain);
    subGain.connect(state.sfxBus);
    subOsc.start(now);
    subOsc.stop(now + 0.23);
    bindAutoCleanup(subOsc, [subOsc, subGain]);

    // 2. 水中油圧緩衝ノイズ（ドフッという水圧衝撃）
    if (state.shortNoiseBuffer) {
      var thudNoise = ctx.createBufferSource();
      thudNoise.buffer = state.shortNoiseBuffer;

      var lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.setValueAtTime(520, now);
      lpf.frequency.exponentialRampToValueAtTime(160, now + 0.18);
      lpf.Q.setValueAtTime(1.6, now);

      var nGain = ctx.createGain();
      nGain.gain.setValueAtTime(EPSILON, now);
      nGain.gain.linearRampToValueAtTime(0.24, now + 0.006);
      nGain.gain.exponentialRampToValueAtTime(EPSILON, now + 0.19);

      thudNoise.connect(lpf);
      lpf.connect(nGain);
      nGain.connect(state.sfxBus);
      nGain.connect(state.reverbSend);

      thudNoise.start(now, 0.05, 0.22);
      bindAutoCleanup(thudNoise, [thudNoise, lpf, nGain]);
    }

    // 3. チタン製クランプの2段階金属ロック音（+55ms遅延）
    var lockTime = now + 0.055;
    var metalFreqs = [540, 815, 1260];
    for (var i = 0; i < metalFreqs.length; i += 1) {
      var mOsc = ctx.createOscillator();
      mOsc.type = i === 0 ? 'triangle' : 'sine';
      mOsc.frequency.setValueAtTime(safeFreq(ctx, metalFreqs[i]), lockTime);
      mOsc.frequency.exponentialRampToValueAtTime(safeFreq(ctx, metalFreqs[i] * 0.94), lockTime + 0.085);

      var mGain = ctx.createGain();
      var peak = 0.095 / (i + 1);
      mGain.gain.setValueAtTime(EPSILON, lockTime);
      mGain.gain.linearRampToValueAtTime(peak, lockTime + 0.003);
      mGain.gain.exponentialRampToValueAtTime(EPSILON, lockTime + 0.11);

      mOsc.connect(mGain);
      mGain.connect(state.sfxBus);
      mGain.connect(state.reverbSend);

      mOsc.start(lockTime);
      mOsc.stop(lockTime + 0.12);
      bindAutoCleanup(mOsc, [mOsc, mGain]);
    }
  }

  /**
   * パイプ/ケーブル接続時の気密ラッチ音＋電子導通音。
   * @param {boolean} [isTidy] - 整頓状態（交差なし等）を満たしている場合 true で澄んだ倍音シマーを付加
   */
  function playConnect(isTidy) {
    var ctx = preparePlayableContext();
    if (!ctx) {
      return;
    }

    var now = ctx.currentTime;
    var tidyFlag = Boolean(isTidy);

    // 1. 気密ラッチ結合トランジェント（カシュッ！）
    if (state.shortNoiseBuffer) {
      var latchSrc = ctx.createBufferSource();
      latchSrc.buffer = state.shortNoiseBuffer;

      var bpf = ctx.createBiquadFilter();
      bpf.type = 'bandpass';
      bpf.frequency.setValueAtTime(2900, now);
      bpf.Q.setValueAtTime(2.6, now);

      var lGain = ctx.createGain();
      lGain.gain.setValueAtTime(EPSILON, now);
      lGain.gain.linearRampToValueAtTime(0.14, now + 0.002);
      lGain.gain.exponentialRampToValueAtTime(EPSILON, now + 0.032);

      latchSrc.connect(bpf);
      bpf.connect(lGain);
      lGain.connect(state.sfxBus);

      latchSrc.start(now, 0.1, 0.045);
      bindAutoCleanup(latchSrc, [latchSrc, bpf, lGain]);
    }

    var clackOsc = ctx.createOscillator();
    clackOsc.type = 'triangle';
    clackOsc.frequency.setValueAtTime(640, now);
    clackOsc.frequency.exponentialRampToValueAtTime(260, now + 0.035);
    var clackGain = ctx.createGain();
    clackGain.gain.setValueAtTime(EPSILON, now);
    clackGain.gain.linearRampToValueAtTime(0.15, now + 0.003);
    clackGain.gain.exponentialRampToValueAtTime(EPSILON, now + 0.042);

    clackOsc.connect(clackGain);
    clackGain.connect(state.sfxBus);
    clackOsc.start(now);
    clackOsc.stop(now + 0.05);
    bindAutoCleanup(clackOsc, [clackOsc, clackGain]);

    // 2. 電子導通チャイム（D5 -> A5）
    var notes = [587.33, 880.0];
    for (var i = 0; i < notes.length; i += 1) {
      var startT = now + 0.018 + i * 0.052;
      var cOsc = ctx.createOscillator();
      cOsc.type = 'sine';
      cOsc.frequency.setValueAtTime(safeFreq(ctx, notes[i]), startT);

      var cGain = ctx.createGain();
      cGain.gain.setValueAtTime(EPSILON, startT);
      cGain.gain.linearRampToValueAtTime(0.12, startT + 0.006);
      cGain.gain.exponentialRampToValueAtTime(EPSILON, startT + 0.16);

      cOsc.connect(cGain);
      cGain.connect(state.sfxBus);
      cGain.connect(state.reverbSend);

      cOsc.start(startT);
      cOsc.stop(startT + 0.18);
      bindAutoCleanup(cOsc, [cOsc, cGain]);
    }

    // 3. 整頓時（isTidy === true）の澄んだ倍音シマー
    if (tidyFlag) {
      var shimmerFreqs = [1174.66, 1479.98, 1760.0]; // D6, F#6, A6
      for (var s = 0; s < shimmerFreqs.length; s += 1) {
        var sTime = now + 0.055 + s * 0.038;
        var sOsc = ctx.createOscillator();
        sOsc.type = 'sine';
        sOsc.frequency.setValueAtTime(safeFreq(ctx, shimmerFreqs[s]), sTime);

        var sGain = ctx.createGain();
        sGain.gain.setValueAtTime(EPSILON, sTime);
        sGain.gain.linearRampToValueAtTime(0.065, sTime + 0.018);
        sGain.gain.exponentialRampToValueAtTime(EPSILON, sTime + 0.52);

        sOsc.connect(sGain);
        sGain.connect(state.sfxBus);
        sGain.connect(state.reverbSend);

        sOsc.start(sTime);
        sOsc.stop(sTime + 0.55);
        bindAutoCleanup(sOsc, [sOsc, sGain]);
      }
    }
  }

  /**
   * 配線解除時のエア抜き・減圧リリース＆解除クリック音。
   */
  function playDisconnect() {
    var ctx = preparePlayableContext();
    if (!ctx) {
      return;
    }

    var now = ctx.currentTime;

    // 1. ロック解除クリック（下降ソレノイド）
    var relOsc = ctx.createOscillator();
    relOsc.type = 'triangle';
    relOsc.frequency.setValueAtTime(490, now);
    relOsc.frequency.exponentialRampToValueAtTime(175, now + 0.055);

    var relGain = ctx.createGain();
    relGain.gain.setValueAtTime(EPSILON, now);
    relGain.gain.linearRampToValueAtTime(0.14, now + 0.003);
    relGain.gain.exponentialRampToValueAtTime(EPSILON, now + 0.065);

    relOsc.connect(relGain);
    relGain.connect(state.sfxBus);
    relOsc.start(now);
    relOsc.stop(now + 0.075);
    bindAutoCleanup(relOsc, [relOsc, relGain]);

    // 2. 気密エア抜きリリース（スウィープダウン・シューッ音）
    if (state.shortNoiseBuffer) {
      var airSrc = ctx.createBufferSource();
      airSrc.buffer = state.shortNoiseBuffer;

      var airFilter = ctx.createBiquadFilter();
      airFilter.type = 'bandpass';
      airFilter.frequency.setValueAtTime(3200, now + 0.008);
      airFilter.frequency.exponentialRampToValueAtTime(580, now + 0.16);
      airFilter.Q.setValueAtTime(1.5, now + 0.008);

      var airGain = ctx.createGain();
      airGain.gain.setValueAtTime(EPSILON, now + 0.008);
      airGain.gain.linearRampToValueAtTime(0.15, now + 0.018);
      airGain.gain.exponentialRampToValueAtTime(EPSILON, now + 0.17);

      airSrc.connect(airFilter);
      airFilter.connect(airGain);
      airGain.connect(state.sfxBus);
      airGain.connect(state.reverbSend);

      airSrc.start(now + 0.008, 0.15, 0.18);
      bindAutoCleanup(airSrc, [airSrc, airFilter, airGain]);
    }

    // 3. 微かな切断確認下降トーン
    var offOsc = ctx.createOscillator();
    offOsc.type = 'sine';
    offOsc.frequency.setValueAtTime(523.25, now + 0.02);
    offOsc.frequency.exponentialRampToValueAtTime(329.63, now + 0.11);

    var offGain = ctx.createGain();
    offGain.gain.setValueAtTime(EPSILON, now + 0.02);
    offGain.gain.linearRampToValueAtTime(0.065, now + 0.028);
    offGain.gain.exponentialRampToValueAtTime(EPSILON, now + 0.12);

    offOsc.connect(offGain);
    offGain.connect(state.sfxBus);
    offOsc.start(now + 0.02);
    offOsc.stop(now + 0.13);
    bindAutoCleanup(offOsc, [offOsc, offGain]);
  }

  /**
   * 相棒ロボ「ブギー（B.U.G.-01）」の愛嬌あるピポパポ・デジタル通信音。
   * @param {string} [mood] - 'happy' | 'curious' | 'alert' | 'excited'
   */
  function playBoogieTalk(mood) {
    var ctx = preparePlayableContext();
    if (!ctx || !canTriggerCooldown('boogie', COOLDOWN_MS.boogie)) {
      return;
    }

    var now = ctx.currentTime;
    var mode = typeof mood === 'string' ? mood.toLowerCase() : 'happy';

    var phrase = [];
    var stepSec = 0.062;
    var noteLen = 0.048;
    var filterCutoff = 2800;
    var peakVol = 0.105;

    if (mode === 'curious') {
      // 疑問・確認：「ピ・ポ・プィ？」と語尾が上がる愛嬌ある3音
      phrase = [
        { freq: 698.46, bend: 1.0 },
        { freq: 880.0, bend: 1.03 },
        { freq: 987.77, bend: 1.24 }
      ];
      stepSec = 0.075;
      noteLen = 0.062;
    } else if (mode === 'alert') {
      // 警告・注意：引き締まったロボットシグナル3音
      phrase = [
        { freq: 659.25, bend: 1.0 },
        { freq: 523.25, bend: 1.0 },
        { freq: 659.25, bend: 0.96 }
      ];
      stepSec = 0.068;
      noteLen = 0.052;
      filterCutoff = 2200;
      peakVol = 0.11;
    } else if (mode === 'excited') {
      // 興奮・大発見：軽快に駆け上がる5音
      var excScale = [783.99, 987.77, 1174.66, 1567.98, 1975.53];
      for (var e = 0; e < 4; e += 1) {
        phrase.push({
          freq: excScale[e + (e === 3 ? 1 : 0)] || excScale[e],
          bend: 1.08
        });
      }
      stepSec = 0.050;
      noteLen = 0.044;
      filterCutoff = 3400;
      peakVol = 0.11;
    } else {
      // 'happy' 既定：明るいペンタトニックのランダムなピポパポ4音
      var happyPool = [783.99, 880.0, 1046.5, 1174.66, 1318.51, 1567.98];
      for (var h = 0; h < 4; h += 1) {
        var idx = Math.floor(Math.random() * happyPool.length);
        phrase.push({
          freq: happyPool[idx],
          bend: h === 3 ? 1.12 : 1.02
        });
      }
      stepSec = 0.060;
      noteLen = 0.046;
    }

    for (var i = 0; i < phrase.length; i += 1) {
      var item = phrase[i];
      var t0 = now + i * stepSec;
      var fStart = safeFreq(ctx, item.freq);
      var fEnd = safeFreq(ctx, item.freq * item.bend);

      var oscMain = ctx.createOscillator();
      oscMain.type = 'triangle';
      oscMain.frequency.setValueAtTime(fStart, t0);
      oscMain.frequency.exponentialRampToValueAtTime(fEnd, t0 + noteLen);

      // ロボ声のデジタル感を追加する控えめな矩形波レイヤー
      var oscSub = ctx.createOscillator();
      oscSub.type = 'square';
      oscSub.frequency.setValueAtTime(fStart, t0);
      oscSub.frequency.exponentialRampToValueAtTime(fEnd, t0 + noteLen);

      var subMix = ctx.createGain();
      subMix.gain.setValueAtTime(0.18, t0);

      var voiceFilter = ctx.createBiquadFilter();
      voiceFilter.type = 'lowpass';
      voiceFilter.frequency.setValueAtTime(safeFreq(ctx, filterCutoff), t0);
      voiceFilter.Q.setValueAtTime(1.1, t0);

      var env = ctx.createGain();
      env.gain.setValueAtTime(EPSILON, t0);
      env.gain.linearRampToValueAtTime(peakVol, t0 + 0.005);
      env.gain.setValueAtTime(peakVol * 0.85, t0 + noteLen * 0.6);
      env.gain.exponentialRampToValueAtTime(EPSILON, t0 + noteLen + 0.015);

      oscMain.connect(voiceFilter);
      oscSub.connect(subMix);
      subMix.connect(voiceFilter);
      voiceFilter.connect(env);
      env.connect(state.sfxBus);
      env.connect(state.reverbSend);

      oscMain.start(t0);
      oscSub.start(t0);
      oscMain.stop(t0 + noteLen + 0.025);
      oscSub.stop(t0 + noteLen + 0.025);

      bindAutoCleanup(oscMain, [oscMain, voiceFilter, env]);
      bindAutoCleanup(oscSub, [oscSub, subMix]);
    }
  }

  /**
   * 地上アップリンク資金獲得時の電子コイン/データ送信チャイム。
   * 高倍率（高純度データ）ほど明るく煌びやかになり、連打時クールダウンと同時発音上限を持つ。
   * @param {number} [multiplier] - 単価倍率（1.0=生データ, 2.0=精製データ, 2.5+=高純度データ）
   */
  function playCash(multiplier) {
    var ctx = preparePlayableContext();
    if (!ctx) {
      return;
    }

    var nowMsVal = nowMs();
    var elapsedSinceLast = nowMsVal - (state.lastTimes.cash || 0);
    if (elapsedSinceLast < COOLDOWN_MS.cash) {
      return;
    }
    if (state.activeCashVoices >= 4) {
      return;
    }
    state.lastTimes.cash = nowMsVal;

    var mult = Number(multiplier);
    if (!Number.isFinite(mult) || mult <= 0) {
      mult = 1.0;
    }
    mult = clamp(mult, 0.5, 5.0);

    // 連続収入時は音量をわずかに抑えつつ僅かな音程変化で聴き疲れを防ぐ
    var isRapidStream = elapsedSinceLast < 380;
    var streamGainScale = isRapidStream ? 0.76 : 1.0;
    var comboSemiOffsets = [0, 0, 2, 0, 4, 2];
    var semiShift = isRapidStream ? comboSemiOffsets[state.cashComboIndex % comboSemiOffsets.length] : 0;
    state.cashComboIndex = (state.cashComboIndex + 1) % 60;
    var pitchScale = Math.pow(2, semiShift / 12);

    var now = ctx.currentTime;
    var notes;
    var reverbLevel;
    var duration;

    if (mult >= 2.2) {
      // 高純度データ：黄金に輝くクリスタル3音チャイム
      notes = [1174.66, 1760.0, 2349.32]; // D6, A6, D7
      reverbLevel = 0.55;
      duration = 0.34;
    } else if (mult >= 1.45) {
      // 精製データ：透明感ある2音＋キラリ倍音
      notes = [1046.5, 1567.98]; // C6, G6
      reverbLevel = 0.35;
      duration = 0.24;
    } else {
      // 生データ：軽快で清潔な送信チャイム
      notes = [880.0, 1318.51]; // A5, E6
      reverbLevel = 0.22;
      duration = 0.18;
    }

    state.activeCashVoices += 1;
    var voiceDecremented = false;
    function releaseVoice() {
      if (!voiceDecremented) {
        voiceDecremented = true;
        state.activeCashVoices = Math.max(0, state.activeCashVoices - 1);
      }
    }

    for (var i = 0; i < notes.length; i += 1) {
      var t0 = now + i * 0.042;
      var freq = safeFreq(ctx, notes[i] * pitchScale);

      var osc = ctx.createOscillator();
      osc.type = i === notes.length - 1 && mult >= 2.2 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, t0);

      var gain = ctx.createGain();
      var peak = (0.095 - i * 0.014) * streamGainScale;
      gain.gain.setValueAtTime(EPSILON, t0);
      gain.gain.linearRampToValueAtTime(peak, t0 + 0.004);
      gain.gain.exponentialRampToValueAtTime(EPSILON, t0 + duration);

      var sendGain = ctx.createGain();
      sendGain.gain.setValueAtTime(reverbLevel, t0);

      osc.connect(gain);
      gain.connect(state.sfxBus);
      gain.connect(sendGain);
      sendGain.connect(state.reverbSend);

      osc.start(t0);
      osc.stop(t0 + duration + 0.02);

      (function (oscNode, gNode, sNode, isLast) {
        oscNode.onended = function () {
          safeDisconnect(oscNode);
          safeDisconnect(gNode);
          safeDisconnect(sNode);
          if (isLast) {
            releaseVoice();
          }
        };
      })(osc, gain, sendGain, i === notes.length - 1);
    }
  }

  /**
   * 整頓ボーナス（+20% / TIDY SYNC）発動時の美しく未来的なメジャー9thシマー和音。
   */
  function playTidyChord() {
    var ctx = preparePlayableContext();
    if (!ctx || !canTriggerCooldown('tidyChord', COOLDOWN_MS.tidyChord)) {
      return;
    }

    var now = ctx.currentTime;
    // D Major 9th ボイシング（透明感と浮遊感の両立）
    var chordNotes = [
      { freq: 293.66, delay: 0.00, gain: 0.075, type: 'sine', dur: 1.9 },      // D4
      { freq: 440.00, delay: 0.03, gain: 0.068, type: 'triangle', dur: 1.95 }, // A4
      { freq: 554.37, delay: 0.06, gain: 0.062, type: 'sine', dur: 2.0 },      // C#5
      { freq: 659.25, delay: 0.09, gain: 0.060, type: 'triangle', dur: 2.05 }, // E5
      { freq: 739.99, delay: 0.12, gain: 0.056, type: 'sine', dur: 2.1 },      // F#5
      { freq: 1318.51, delay: 0.16, gain: 0.042, type: 'sine', dur: 2.2 }      // E6 シマー
    ];

    var filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(750, now);
    filter.frequency.exponentialRampToValueAtTime(3400, now + 0.28);
    filter.frequency.exponentialRampToValueAtTime(1400, now + 2.1);
    filter.Q.setValueAtTime(0.8, now);

    var chordBus = ctx.createGain();
    chordBus.gain.setValueAtTime(1.0, now);
    var verbGain = ctx.createGain();
    verbGain.gain.setValueAtTime(0.85, now);

    filter.connect(chordBus);
    chordBus.connect(state.sfxBus);
    chordBus.connect(verbGain);
    verbGain.connect(state.reverbSend);

    for (var i = 0; i < chordNotes.length; i += 1) {
      var n = chordNotes[i];
      var t0 = now + n.delay;

      // わずかなデチューンで温かいコーラス的広がりを付与
      var oscA = ctx.createOscillator();
      oscA.type = n.type;
      oscA.frequency.setValueAtTime(safeFreq(ctx, n.freq), t0);
      oscA.detune.setValueAtTime(-4, t0);

      var oscB = ctx.createOscillator();
      oscB.type = 'sine';
      oscB.frequency.setValueAtTime(safeFreq(ctx, n.freq), t0);
      oscB.detune.setValueAtTime(4, t0);

      var nGain = ctx.createGain();
      nGain.gain.setValueAtTime(EPSILON, t0);
      nGain.gain.linearRampToValueAtTime(n.gain, t0 + 0.055);
      nGain.gain.exponentialRampToValueAtTime(n.gain * 0.45, t0 + 0.65);
      nGain.gain.exponentialRampToValueAtTime(EPSILON, t0 + n.dur);

      oscA.connect(nGain);
      oscB.connect(nGain);
      nGain.connect(filter);

      oscA.start(t0);
      oscB.start(t0);
      oscA.stop(t0 + n.dur + 0.04);
      oscB.stop(t0 + n.dur + 0.04);

      (function (oA, oB, gN, isLast) {
        oA.onended = function () {
          safeDisconnect(oA);
          safeDisconnect(gN);
          if (isLast) {
            safeDisconnect(filter);
            safeDisconnect(chordBus);
            safeDisconnect(verbGain);
          }
        };
        oB.onended = function () {
          safeDisconnect(oB);
        };
      })(oscA, oscB, nGain, i === chordNotes.length - 1);
    }
  }

  /**
   * ボトルネックやオーバーヒート時のソフトな潜水艦警告パルス（厳格なクールダウン制御付き）。
   */
  function playWarning() {
    var ctx = preparePlayableContext();
    if (!ctx || !canTriggerCooldown('warning', COOLDOWN_MS.warning)) {
      return;
    }

    var now = ctx.currentTime;
    var pulses = [
      { offset: 0.0, freq: 349.23 },  // F4
      { offset: 0.21, freq: 293.66 }  // D4
    ];

    for (var i = 0; i < pulses.length; i += 1) {
      var p = pulses[i];
      var t0 = now + p.offset;

      var osc1 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(safeFreq(ctx, p.freq), t0);

      var osc2 = ctx.createOscillator();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(safeFreq(ctx, p.freq * 0.5), t0);

      var lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.setValueAtTime(880, t0);
      lpf.Q.setValueAtTime(0.9, t0);

      var pGain = ctx.createGain();
      pGain.gain.setValueAtTime(EPSILON, t0);
      pGain.gain.linearRampToValueAtTime(0.14, t0 + 0.024);
      pGain.gain.exponentialRampToValueAtTime(EPSILON, t0 + 0.17);

      osc1.connect(lpf);
      osc2.connect(lpf);
      lpf.connect(pGain);
      pGain.connect(state.sfxBus);
      pGain.connect(state.reverbSend);

      osc1.start(t0);
      osc2.start(t0);
      osc1.stop(t0 + 0.19);
      osc2.stop(t0 + 0.19);

      bindAutoCleanup(osc1, [osc1, lpf, pGain]);
      bindAutoCleanup(osc2, [osc2]);
    }
  }

  /**
   * ステップ達成・新パーツアンロック時の達成感ある上昇アルペジオ和音。
   */
  function playUnlock() {
    var ctx = preparePlayableContext();
    if (!ctx || !canTriggerCooldown('unlock', COOLDOWN_MS.unlock)) {
      return;
    }

    var now = ctx.currentTime;
    // 温かな低音ペダル（C3）
    var bassOsc = ctx.createOscillator();
    bassOsc.type = 'sine';
    bassOsc.frequency.setValueAtTime(130.81, now); // C3

    var bassGain = ctx.createGain();
    bassGain.gain.setValueAtTime(EPSILON, now);
    bassGain.gain.linearRampToValueAtTime(0.15, now + 0.04);
    bassGain.gain.exponentialRampToValueAtTime(EPSILON, now + 1.85);

    bassOsc.connect(bassGain);
    bassGain.connect(state.sfxBus);
    bassOsc.start(now);
    bassOsc.stop(now + 1.9);
    bindAutoCleanup(bassOsc, [bassOsc, bassGain]);

    // 光が射す上昇アルペジオ（Cmaj9: C5 -> E5 -> G5 -> B5 -> D6 -> G6）
    var arpNotes = [523.25, 659.25, 783.99, 987.77, 1174.66, 1567.98];
    var step = 0.072;

    for (var i = 0; i < arpNotes.length; i += 1) {
      var t0 = now + i * step;
      var isFinal = i === arpNotes.length - 1;
      var dur = isFinal ? 1.55 : 0.68;

      var osc = ctx.createOscillator();
      osc.type = i % 2 === 0 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(safeFreq(ctx, arpNotes[i]), t0);

      var sparkle = ctx.createOscillator();
      sparkle.type = 'sine';
      sparkle.frequency.setValueAtTime(safeFreq(ctx, arpNotes[i] * 2), t0);

      var sparkleGain = ctx.createGain();
      sparkleGain.gain.setValueAtTime(0.22, t0);

      var env = ctx.createGain();
      var peak = isFinal ? 0.125 : 0.095;
      env.gain.setValueAtTime(EPSILON, t0);
      env.gain.linearRampToValueAtTime(peak, t0 + 0.010);
      env.gain.exponentialRampToValueAtTime(EPSILON, t0 + dur);

      var verbSend = ctx.createGain();
      verbSend.gain.setValueAtTime(isFinal ? 0.85 : 0.55, t0);

      osc.connect(env);
      sparkle.connect(sparkleGain);
      sparkleGain.connect(env);
      env.connect(state.sfxBus);
      env.connect(verbSend);
      verbSend.connect(state.reverbSend);

      osc.start(t0);
      sparkle.start(t0);
      osc.stop(t0 + dur + 0.03);
      sparkle.stop(t0 + dur + 0.03);

      bindAutoCleanup(osc, [osc, env, verbSend]);
      bindAutoCleanup(sparkle, [sparkle, sparkleGain]);
    }
  }

  global.AbyssAudio = {
    init: init,
    isMuted: isMuted,
    setMuted: setMuted,
    toggleMute: toggleMute,
    startAmbient: startAmbient,
    stopAmbient: stopAmbient,
    playSonar: playSonar,
    playClick: playClick,
    playPlace: playPlace,
    playConnect: playConnect,
    playDisconnect: playDisconnect,
    playBoogieTalk: playBoogieTalk,
    playCash: playCash,
    playTidyChord: playTidyChord,
    playWarning: playWarning,
    playUnlock: playUnlock
  };
})(window);
