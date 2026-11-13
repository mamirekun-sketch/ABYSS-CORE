/**
 * ABYSS CORE（アビス・コア）Phase 1 ― 相棒ロボ「ブギー」＆動く技術図鑑モジュール（boogie.js）
 * 公開グローバル契約:
 *   - window.BoogieController
 *   - window.EncyclopediaPreview
 *
 * 外部画像・外部ライブラリを一切使用せず、インラインSVG＆高精細Canvas2D描画によって
 * 「B.U.G.-01 ブギー」の表情・音声波形・ホログラム誘導レーザーと、
 * 400x180 ライブ技術図解アニメーションを描き切る。
 */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var boogieInstanceCounter = 0;

  var DEFAULT_FONT_FAMILY =
    "'Noto Sans JP', 'Yu Gothic', 'Yu Gothic UI', 'Hiragino Kaku Gothic ProN', 'Meiryo', sans-serif";
  var DEFAULT_MONO_FAMILY =
    "'JetBrains Mono', 'Consolas', 'Noto Sans JP', monospace";

  function getFontFamily() {
    if (global.ABYSS_DATA && global.ABYSS_DATA.CONFIG && global.ABYSS_DATA.CONFIG.FONT_FAMILY) {
      return global.ABYSS_DATA.CONFIG.FONT_FAMILY;
    }
    return DEFAULT_FONT_FAMILY;
  }

  function getMonoFontFamily() {
    if (global.ABYSS_DATA && global.ABYSS_DATA.CONFIG && global.ABYSS_DATA.CONFIG.MONO_FONT_FAMILY) {
      return global.ABYSS_DATA.CONFIG.MONO_FONT_FAMILY;
    }
    return DEFAULT_MONO_FAMILY;
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

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function normalizeDt(dt, fallbackSec) {
    if (typeof dt !== 'number' || !Number.isFinite(dt) || dt < 0) {
      return fallbackSec;
    }
    // 秒想定だが、万が一ミリ秒値が渡された場合も安全に秒へ正規化する
    if (dt > 0.5) {
      return clamp(dt / 1000, 0, 0.05);
    }
    return clamp(dt, 0, 0.05);
  }

  function hexToRgba(hex, alpha) {
    if (typeof hex !== 'string') {
      return 'rgba(0, 240, 255, ' + alpha + ')';
    }
    var trimmed = hex.trim();
    if (trimmed.indexOf('rgba') === 0 || trimmed.indexOf('rgb') === 0) {
      return trimmed;
    }
    var clean = trimmed.charAt(0) === '#' ? trimmed.slice(1) : trimmed;
    if (clean.length === 3) {
      clean =
        clean.charAt(0) + clean.charAt(0) +
        clean.charAt(1) + clean.charAt(1) +
        clean.charAt(2) + clean.charAt(2);
    }
    if (clean.length !== 6) {
      return 'rgba(0, 240, 255, ' + alpha + ')';
    }
    var r = parseInt(clean.slice(0, 2), 16);
    var g = parseInt(clean.slice(2, 4), 16);
    var b = parseInt(clean.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
      return 'rgba(0, 240, 255, ' + alpha + ')';
    }
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + clamp(alpha, 0, 1) + ')';
  }

  function resolveElement(elOrSelector, fallbackId) {
    if (typeof elOrSelector === 'string') {
      return document.querySelector(elOrSelector);
    }
    if (elOrSelector && typeof elOrSelector === 'object' && elOrSelector.nodeType === 1) {
      return elOrSelector;
    }
    if (fallbackId) {
      return document.getElementById(fallbackId);
    }
    return null;
  }

  function createSvgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      var keys = Object.keys(attrs);
      for (var i = 0; i < keys.length; i += 1) {
        var key = keys[i];
        el.setAttribute(key, String(attrs[key]));
      }
    }
    return el;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    var radius = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  function chamferRectPath(ctx, x, y, w, h, cut) {
    var c = Math.min(cut, w * 0.25, h * 0.45);
    ctx.beginPath();
    ctx.moveTo(x + c, y);
    ctx.lineTo(x + w - c, y);
    ctx.lineTo(x + w, y + c);
    ctx.lineTo(x + w, y + h - c);
    ctx.lineTo(x + w - c, y + h);
    ctx.lineTo(x + c, y + h);
    ctx.lineTo(x, y + h - c);
    ctx.lineTo(x, y + c);
    ctx.closePath();
  }

  function cubicPointAt(p0x, p0y, c1x, c1y, c2x, c2y, p1x, p1y, t) {
    var u = 1 - t;
    var tt = t * t;
    var uu = u * u;
    var uuu = uu * u;
    var ttt = tt * t;
    return {
      x: uuu * p0x + 3 * uu * t * c1x + 3 * u * tt * c2x + ttt * p1x,
      y: uuu * p0y + 3 * uu * t * c1y + 3 * u * tt * c2y + ttt * p1y
    };
  }

  function cubicTangentAt(p0x, p0y, c1x, c1y, c2x, c2y, p1x, p1y, t) {
    var u = 1 - t;
    var dx =
      3 * u * u * (c1x - p0x) +
      6 * u * t * (c2x - c1x) +
      3 * t * t * (p1x - c2x);
    var dy =
      3 * u * u * (c1y - p0y) +
      6 * u * t * (c2y - c1y) +
      3 * t * t * (p1y - c2y);
    return { x: dx, y: dy };
  }

  function computeBezierPoints(sx, sy, ex, ey) {
    var dx = ex - sx;
    var dy = ey - sy;
    var dist = Math.hypot(dx, dy);
    var offset = Math.max(36, Math.min(180, Math.abs(dx) * 0.48 + dist * 0.14));
    return {
      p0x: sx,
      p0y: sy,
      c1x: sx + offset,
      c1y: sy + dy * 0.04,
      c2x: ex - offset,
      c2y: ey - dy * 0.04,
      p1x: ex,
      p1y: ey
    };
  }

  // =========================================================================
  // 1. BoogieController ― 相棒ロボ「ブギー（B.U.G.-01）」制御＆ホログラム誘導描画
  // =========================================================================
  var MOOD_CONFIG = {
    happy: {
      eyeColor: '#00f0ff',
      eyeHighlight: '#d9feff',
      beaconColor: '#3df5b4',
      beaconGlow: 'rgba(61, 245, 180, 0.85)',
      tiltDeg: -1.5,
      leftArmRest: -14,
      rightArmRest: 16,
      blinkRate: 3.4,
      bobAmp: 2.3,
      bobSpeed: 2.2
    },
    curious: {
      eyeColor: '#58f7ff',
      eyeHighlight: '#ffffff',
      beaconColor: '#00f0ff',
      beaconGlow: 'rgba(0, 240, 255, 0.90)',
      tiltDeg: -7.5,
      leftArmRest: 18,
      rightArmRest: 24,
      blinkRate: 4.1,
      bobAmp: 2.0,
      bobSpeed: 1.9
    },
    alert: {
      eyeColor: '#ff3b5c',
      eyeHighlight: '#ffd2db',
      beaconColor: '#ff3b5c',
      beaconGlow: 'rgba(255, 59, 92, 0.95)',
      tiltDeg: 3.5,
      leftArmRest: -36,
      rightArmRest: 36,
      blinkRate: 6.5,
      bobAmp: 1.4,
      bobSpeed: 5.5
    },
    excited: {
      eyeColor: '#ffd84d',
      eyeHighlight: '#ffffff',
      beaconColor: '#ffd84d',
      beaconGlow: 'rgba(255, 216, 77, 0.96)',
      tiltDeg: -3.0,
      leftArmRest: -52,
      rightArmRest: 52,
      blinkRate: 4.8,
      bobAmp: 3.2,
      bobSpeed: 3.4
    }
  };

  /**
   * 相棒ユーティリティロボ「ブギー（B.U.G.-01）」のインラインSVG表現、表情変化、
   * 音声波形アニメーション、およびメインCanvasへのホログラム誘導レーザー描画を担う。
   * @constructor
   * @param {HTMLElement|string} svgHostEl
   * @param {HTMLElement|string} waveformEl
   */
  function BoogieController(svgHostEl, waveformEl) {
    boogieInstanceCounter += 1;
    this._uid = 'bg' + boogieInstanceCounter;
    this.svgHostEl = resolveElement(svgHostEl, 'boogie-svg-host');
    this.waveformEl = resolveElement(waveformEl, 'boogie-waveform');
    this.avatarWrapEl = null;
    if (this.waveformEl && typeof this.waveformEl.closest === 'function') {
      this.avatarWrapEl = this.waveformEl.closest('.boogie-avatar-wrap');
    } else if (this.svgHostEl && typeof this.svgHostEl.closest === 'function') {
      this.avatarWrapEl = this.svgHostEl.closest('.boogie-avatar-wrap');
    }

    this.mood = 'happy';
    this.isTalking = false;
    this.talkRemainingMs = 0;
    this.talkDurationMs = 0;
    this.time = 0;
    this.blinkCooldown = 2.6;
    this.blinkPhase = 0;
    this.currentTilt = MOOD_CONFIG.happy.tiltDeg;
    this.currentLeftArm = MOOD_CONFIG.happy.leftArmRest;
    this.currentRightArm = MOOD_CONFIG.happy.rightArmRest;

    this._els = {};
    this._waveBars = [];

    this._buildSvg();
    this._buildWaveform();
    this.setExpression('happy');
  }

  BoogieController.prototype._buildSvg = function () {
    if (!this.svgHostEl) {
      return;
    }
    this.svgHostEl.innerHTML = '';

    var u = this._uid;
    var svg = createSvgEl('svg', {
      viewBox: '0 0 120 112',
      role: 'img',
      'aria-label': '相棒ロボ ブギー（B.U.G.-01）'
    });

    var defs = createSvgEl('defs');

    // 耐圧イエロー球体ボディ用メタリックラジアルグラデーション
    var bodyGrad = createSvgEl('radialGradient', {
      id: u + '-body-grad',
      cx: '38%',
      cy: '32%',
      r: '68%',
      fx: '34%',
      fy: '28%'
    });
    bodyGrad.appendChild(createSvgEl('stop', { offset: '0%', 'stop-color': '#fff4a8' }));
    bodyGrad.appendChild(createSvgEl('stop', { offset: '22%', 'stop-color': '#ffd447' }));
    bodyGrad.appendChild(createSvgEl('stop', { offset: '62%', 'stop-color': '#eeb122' }));
    bodyGrad.appendChild(createSvgEl('stop', { offset: '86%', 'stop-color': '#d99518' }));
    bodyGrad.appendChild(createSvgEl('stop', { offset: '100%', 'stop-color': '#855208' }));
    defs.appendChild(bodyGrad);

    // 球体金属リム用エッジハイライト
    var rimGrad = createSvgEl('linearGradient', {
      id: u + '-rim-grad',
      x1: '0%',
      y1: '0%',
      x2: '100%',
      y2: '100%'
    });
    rimGrad.appendChild(createSvgEl('stop', { offset: '0%', 'stop-color': '#fff1b5', 'stop-opacity': '0.9' }));
    rimGrad.appendChild(createSvgEl('stop', { offset: '50%', 'stop-color': '#d99518', 'stop-opacity': '0.45' }));
    rimGrad.appendChild(createSvgEl('stop', { offset: '100%', 'stop-color': '#523204', 'stop-opacity': '0.95' }));
    defs.appendChild(rimGrad);

    // 真鍮（ブラス）メタリックグラデーション
    var brassGrad = createSvgEl('linearGradient', {
      id: u + '-brass-grad',
      x1: '0%',
      y1: '0%',
      x2: '100%',
      y2: '100%'
    });
    brassGrad.appendChild(createSvgEl('stop', { offset: '0%', 'stop-color': '#ffe7a6' }));
    brassGrad.appendChild(createSvgEl('stop', { offset: '45%', 'stop-color': '#cfa043' }));
    brassGrad.appendChild(createSvgEl('stop', { offset: '100%', 'stop-color': '#6f4c14' }));
    defs.appendChild(brassGrad);

    // ガンメタル（関節・スラスター・台座）グラデーション
    var metalGrad = createSvgEl('linearGradient', {
      id: u + '-metal-grad',
      x1: '0%',
      y1: '0%',
      x2: '0%',
      y2: '100%'
    });
    metalGrad.appendChild(createSvgEl('stop', { offset: '0%', 'stop-color': '#718da8' }));
    metalGrad.appendChild(createSvgEl('stop', { offset: '45%', 'stop-color': '#30465e' }));
    metalGrad.appendChild(createSvgEl('stop', { offset: '100%', 'stop-color': '#101b29' }));
    defs.appendChild(metalGrad);

    // ダークバイザー内深淵グラデーション
    var visorGrad = createSvgEl('linearGradient', {
      id: u + '-visor-grad',
      x1: '15%',
      y1: '0%',
      x2: '85%',
      y2: '100%'
    });
    visorGrad.appendChild(createSvgEl('stop', { offset: '0%', 'stop-color': '#16314f' }));
    visorGrad.appendChild(createSvgEl('stop', { offset: '42%', 'stop-color': '#071426' }));
    visorGrad.appendChild(createSvgEl('stop', { offset: '100%', 'stop-color': '#020710' }));
    defs.appendChild(visorGrad);

    // 水中スラスター噴射ジェットグラデーション
    var plumeGrad = createSvgEl('linearGradient', {
      id: u + '-plume-grad',
      x1: '0%',
      y1: '0%',
      x2: '0%',
      y2: '100%'
    });
    plumeGrad.appendChild(createSvgEl('stop', { offset: '0%', 'stop-color': '#d9ffff', 'stop-opacity': '0.95' }));
    plumeGrad.appendChild(createSvgEl('stop', { offset: '42%', 'stop-color': '#00f0ff', 'stop-opacity': '0.68' }));
    plumeGrad.appendChild(createSvgEl('stop', { offset: '100%', 'stop-color': '#0088cc', 'stop-opacity': '0' }));
    defs.appendChild(plumeGrad);

    // ネオン発光フィルタ
    var neonFilter = createSvgEl('filter', {
      id: u + '-neon-glow',
      x: '-45%',
      y: '-45%',
      width: '190%',
      height: '190%'
    });
    neonFilter.appendChild(createSvgEl('feGaussianBlur', { stdDeviation: '2.2', result: 'blur' }));
    var merge = createSvgEl('feMerge');
    merge.appendChild(createSvgEl('feMergeNode', { in: 'blur' }));
    merge.appendChild(createSvgEl('feMergeNode', { in: 'SourceGraphic' }));
    neonFilter.appendChild(merge);
    defs.appendChild(neonFilter);

    // バイザー走査線パターン
    var scanPat = createSvgEl('pattern', {
      id: u + '-scan-pat',
      width: '4',
      height: '4',
      patternUnits: 'userSpaceOnUse'
    });
    scanPat.appendChild(createSvgEl('rect', {
      x: '0',
      y: '0',
      width: '4',
      height: '1.3',
      fill: 'rgba(0, 240, 255, 0.08)'
    }));
    defs.appendChild(scanPat);

    // バイザークリップパス
    var visorClip = createSvgEl('clipPath', { id: u + '-visor-clip' });
    visorClip.appendChild(createSvgEl('rect', {
      x: '32',
      y: '43',
      width: '56',
      height: '26',
      rx: '13',
      ry: '13'
    }));
    defs.appendChild(visorClip);

    svg.appendChild(defs);

    // --- 周囲を漂う微小な深海気泡グループ ---
    var bubblesGroup = createSvgEl('g', { opacity: '0.8' });
    var b1 = createSvgEl('circle', {
      cx: '16',
      cy: '28',
      r: '2.2',
      fill: 'rgba(130, 246, 255, 0.25)',
      stroke: 'rgba(180, 252, 255, 0.7)',
      'stroke-width': '0.8'
    });
    var b2 = createSvgEl('circle', {
      cx: '104',
      cy: '34',
      r: '1.7',
      fill: 'rgba(130, 246, 255, 0.22)',
      stroke: 'rgba(180, 252, 255, 0.65)',
      'stroke-width': '0.7'
    });
    var b3 = createSvgEl('circle', {
      cx: '98',
      cy: '88',
      r: '2.5',
      fill: 'rgba(130, 246, 255, 0.2)',
      stroke: 'rgba(180, 252, 255, 0.6)',
      'stroke-width': '0.8'
    });
    bubblesGroup.appendChild(b1);
    bubblesGroup.appendChild(b2);
    bubblesGroup.appendChild(b3);
    svg.appendChild(bubblesGroup);
    this._els.bubbles = [b1, b2, b3];

    // --- 浮遊＆姿勢制御ルート ---
    var rig = createSvgEl('g', { transform: 'translate(0, 0)' });
    this._els.rig = rig;

    // --- 下部水中スラスター（背面） ---
    var thrusterGroup = createSvgEl('g');
    // 左右サブスラスターポッド
    var leftPod = createSvgEl('g');
    leftPod.appendChild(createSvgEl('path', {
      d: 'M 33 84 L 25 94 L 37 97 L 42 88 Z',
      fill: 'url(#' + u + '-metal-grad)',
      stroke: '#88a7c4',
      'stroke-width': '0.9'
    }));
    var leftPlume = createSvgEl('path', {
      d: 'M 26 95 Q 29 107 32 108 Q 35 107 36 97 Z',
      fill: 'url(#' + u + '-plume-grad)'
    });
    leftPod.appendChild(leftPlume);

    var rightPod = createSvgEl('g');
    rightPod.appendChild(createSvgEl('path', {
      d: 'M 87 84 L 95 94 L 83 97 L 78 88 Z',
      fill: 'url(#' + u + '-metal-grad)',
      stroke: '#88a7c4',
      'stroke-width': '0.9'
    }));
    var rightPlume = createSvgEl('path', {
      d: 'M 94 95 Q 91 107 88 108 Q 85 107 84 97 Z',
      fill: 'url(#' + u + '-plume-grad)'
    });
    rightPod.appendChild(rightPlume);

    // 中央メインスクリューダクト
    thrusterGroup.appendChild(leftPod);
    thrusterGroup.appendChild(rightPod);
    thrusterGroup.appendChild(createSvgEl('path', {
      d: 'M 47 89 L 44 98 L 76 98 L 73 89 Z',
      fill: 'url(#' + u + '-metal-grad)',
      stroke: 'url(#' + u + '-brass-grad)',
      'stroke-width': '1.2'
    }));
    var centerPlume = createSvgEl('path', {
      d: 'M 47 98 Q 60 112 73 98 Z',
      fill: 'url(#' + u + '-plume-grad)'
    });
    thrusterGroup.appendChild(centerPlume);
    rig.appendChild(thrusterGroup);
    this._els.leftPlume = leftPlume;
    this._els.rightPlume = rightPlume;
    this._els.centerPlume = centerPlume;

    // --- 頭頂ビーコンアンテナ ---
    var antennaGroup = createSvgEl('g');
    // 真鍮マウントベース
    antennaGroup.appendChild(createSvgEl('path', {
      d: 'M 50 28 Q 60 22 70 28 L 68 33 L 52 33 Z',
      fill: 'url(#' + u + '-brass-grad)',
      stroke: '#5e3d0b',
      'stroke-width': '0.9'
    }));
    antennaGroup.appendChild(createSvgEl('circle', { cx: '54', cy: '29', r: '1.1', fill: '#fff1b5' }));
    antennaGroup.appendChild(createSvgEl('circle', { cx: '66', cy: '29', r: '1.1', fill: '#fff1b5' }));
    // ロッド＆コイル
    antennaGroup.appendChild(createSvgEl('line', {
      x1: '60',
      y1: '25',
      x2: '60',
      y2: '11',
      stroke: 'url(#' + u + '-metal-grad)',
      'stroke-width': '2.6',
      'stroke-linecap': 'round'
    }));
    antennaGroup.appendChild(createSvgEl('rect', {
      x: '57.6',
      y: '15.5',
      width: '4.8',
      height: '3.2',
      rx: '1',
      fill: 'url(#' + u + '-brass-grad)'
    }));
    var beaconRing = createSvgEl('circle', {
      cx: '60',
      cy: '9',
      r: '6.5',
      fill: 'none',
      stroke: '#3df5b4',
      'stroke-width': '1.2',
      opacity: '0.55'
    });
    var beaconCore = createSvgEl('circle', {
      cx: '60',
      cy: '9',
      r: '3.4',
      fill: '#3df5b4',
      stroke: '#ffffff',
      'stroke-width': '0.9',
      filter: 'url(#' + u + '-neon-glow)'
    });
    antennaGroup.appendChild(beaconRing);
    antennaGroup.appendChild(beaconCore);
    rig.appendChild(antennaGroup);
    this._els.beaconRing = beaconRing;
    this._els.beaconCore = beaconCore;

    // --- 耐圧イエロー球体ボディ ---
    var bodyGroup = createSvgEl('g');

    // メイン球体
    bodyGroup.appendChild(createSvgEl('circle', {
      cx: '60',
      cy: '59',
      r: '32',
      fill: 'url(#' + u + '-body-grad)',
      stroke: 'url(#' + u + '-rim-grad)',
      'stroke-width': '1.6'
    }));

    // 球体上部のスペキュラー光沢
    bodyGroup.appendChild(createSvgEl('ellipse', {
      cx: '49',
      cy: '38',
      rx: '13',
      ry: '5.5',
      transform: 'rotate(-20 49 38)',
      fill: 'rgba(255, 255, 232, 0.36)'
    }));

    // 球体中央を横切る真鍮補強バンド（上下2本のリベット帯）
    bodyGroup.appendChild(createSvgEl('path', {
      d: 'M 28.5 55 Q 60 61 91.5 55 L 91.5 60 Q 60 66 28.5 60 Z',
      fill: 'url(#' + u + '-brass-grad)',
      stroke: '#5e3d0a',
      'stroke-width': '0.8',
      opacity: '0.92'
    }));

    // 真鍮リベット群（耐圧ハッチ縁と下部ベルト）
    var rivetPositions = [
      [35, 42], [44, 34], [76, 34], [85, 42],
      [34, 74], [43, 82], [77, 82], [86, 74],
      [31, 58], [89, 58]
    ];
    for (var ri = 0; ri < rivetPositions.length; ri += 1) {
      var rp = rivetPositions[ri];
      bodyGroup.appendChild(createSvgEl('circle', {
        cx: rp[0],
        cy: rp[1],
        r: '1.65',
        fill: '#8f5d12',
        stroke: '#523406',
        'stroke-width': '0.5'
      }));
      bodyGroup.appendChild(createSvgEl('circle', {
        cx: rp[0] - 0.4,
        cy: rp[1] - 0.4,
        r: '0.75',
        fill: '#fff2ba'
      }));
    }

    // 下部フロントハッチ＆識別プレート（「01」計器ディテール）
    bodyGroup.appendChild(createSvgEl('rect', {
      x: '46',
      y: '74',
      width: '28',
      height: '12',
      rx: '4',
      fill: 'url(#' + u + '-metal-grad)',
      stroke: 'url(#' + u + '-brass-grad)',
      'stroke-width': '1.1'
    }));
    // 小型ステータスLED 3灯
    var led1 = createSvgEl('circle', { cx: '52', cy: '80', r: '1.6', fill: '#00f0ff' });
    var led2 = createSvgEl('circle', { cx: '60', cy: '80', r: '1.6', fill: '#ffd84d' });
    var led3 = createSvgEl('circle', { cx: '68', cy: '80', r: '1.6', fill: '#3df5b4' });
    bodyGroup.appendChild(led1);
    bodyGroup.appendChild(led2);
    bodyGroup.appendChild(led3);
    this._els.chestLeds = [led1, led2, led3];

    rig.appendChild(bodyGroup);

    // --- ダークバイザー＆発光ネオンアイ ---
    var visorGroup = createSvgEl('g');

    // 真鍮ベゼル外枠
    visorGroup.appendChild(createSvgEl('rect', {
      x: '29.5',
      y: '40.5',
      width: '61',
      height: '31',
      rx: '15.5',
      ry: '15.5',
      fill: 'url(#' + u + '-brass-grad)',
      stroke: '#4a2f05',
      'stroke-width': '1.2'
    }));

    // 暗い強化ガラス本体
    visorGroup.appendChild(createSvgEl('rect', {
      x: '32',
      y: '43',
      width: '56',
      height: '26',
      rx: '13',
      ry: '13',
      fill: 'url(#' + u + '-visor-grad)',
      stroke: '#2b557a',
      'stroke-width': '0.9'
    }));

    // バイザー内コンテンツ（クリップ付き）
    var visorContent = createSvgEl('g', { 'clip-path': 'url(#' + u + '-visor-clip)' });
    visorContent.appendChild(createSvgEl('rect', {
      x: '32',
      y: '43',
      width: '56',
      height: '26',
      fill: 'url(#' + u + '-scan-pat)'
    }));

    // 左右ネオンアイ（まばたき用スケールグループ）
    var eyesCarrier = createSvgEl('g', { transform: 'translate(60, 55)' });
    this._els.eyesCarrier = eyesCarrier;

    // (A) HAPPY: ^ ^
    var eyesHappy = createSvgEl('g', { filter: 'url(#' + u + '-neon-glow)' });
    eyesHappy.appendChild(createSvgEl('path', {
      d: 'M -18 2 Q -12 -7 -6 2',
      fill: 'none',
      stroke: '#00f0ff',
      'stroke-width': '3.2',
      'stroke-linecap': 'round'
    }));
    eyesHappy.appendChild(createSvgEl('path', {
      d: 'M 6 2 Q 12 -7 18 2',
      fill: 'none',
      stroke: '#00f0ff',
      'stroke-width': '3.2',
      'stroke-linecap': 'round'
    }));
    // チーク風ほのか発光
    eyesHappy.appendChild(createSvgEl('ellipse', {
      cx: '-17',
      cy: '5.5',
      rx: '3.2',
      ry: '1.4',
      fill: 'rgba(255, 132, 198, 0.5)'
    }));
    eyesHappy.appendChild(createSvgEl('ellipse', {
      cx: '17',
      cy: '5.5',
      rx: '3.2',
      ry: '1.4',
      fill: 'rgba(255, 132, 198, 0.5)'
    }));

    // (B) CURIOUS: o o
    var eyesCurious = createSvgEl('g', { filter: 'url(#' + u + '-neon-glow)' });
    eyesCurious.appendChild(createSvgEl('circle', {
      cx: '-12',
      cy: '0',
      r: '5.2',
      fill: 'none',
      stroke: '#58f7ff',
      'stroke-width': '2.6'
    }));
    eyesCurious.appendChild(createSvgEl('circle', {
      cx: '-11',
      cy: '-1',
      r: '1.8',
      fill: '#ffffff'
    }));
    eyesCurious.appendChild(createSvgEl('circle', {
      cx: '12',
      cy: '-0.8',
      r: '6.2',
      fill: 'none',
      stroke: '#58f7ff',
      'stroke-width': '2.6'
    }));
    eyesCurious.appendChild(createSvgEl('circle', {
      cx: '13',
      cy: '-1.6',
      r: '2.1',
      fill: '#ffffff'
    }));

    // (C) ALERT: > <
    var eyesAlert = createSvgEl('g', { filter: 'url(#' + u + '-neon-glow)' });
    eyesAlert.appendChild(createSvgEl('path', {
      d: 'M -18 -4.5 L -8 0 L -18 4.5',
      fill: 'none',
      stroke: '#ff3b5c',
      'stroke-width': '3.3',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round'
    }));
    eyesAlert.appendChild(createSvgEl('path', {
      d: 'M 18 -4.5 L 8 0 L 18 4.5',
      fill: 'none',
      stroke: '#ff3b5c',
      'stroke-width': '3.3',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round'
    }));
    eyesAlert.appendChild(createSvgEl('line', {
      x1: '-3',
      y1: '-7',
      x2: '3',
      y2: '-7',
      stroke: '#ffd84d',
      'stroke-width': '1.6',
      'stroke-linecap': 'round'
    }));

    // (D) EXCITED: ★ ★
    var eyesExcited = createSvgEl('g', { filter: 'url(#' + u + '-neon-glow)' });
    var starLeft = createSvgEl('path', {
      d: 'M 0 -7.5 L 2.1 -2.2 L 7.5 0 L 2.1 2.2 L 0 7.5 L -2.1 2.2 L -7.5 0 L -2.1 -2.2 Z',
      fill: '#ffd84d',
      stroke: '#ffffff',
      'stroke-width': '0.7',
      transform: 'translate(-12.5, 0)'
    });
    var starRight = createSvgEl('path', {
      d: 'M 0 -7.5 L 2.1 -2.2 L 7.5 0 L 2.1 2.2 L 0 7.5 L -2.1 2.2 L -7.5 0 L -2.1 -2.2 Z',
      fill: '#ffd84d',
      stroke: '#ffffff',
      'stroke-width': '0.7',
      transform: 'translate(12.5, 0)'
    });
    eyesExcited.appendChild(starLeft);
    eyesExcited.appendChild(starRight);
    this._els.starLeft = starLeft;
    this._els.starRight = starRight;

    eyesCarrier.appendChild(eyesHappy);
    eyesCarrier.appendChild(eyesCurious);
    eyesCarrier.appendChild(eyesAlert);
    eyesCarrier.appendChild(eyesExcited);
    visorContent.appendChild(eyesCarrier);

    // 会話時ボイスLEDインジケータ（バイザー下部）
    var voiceMouth = createSvgEl('rect', {
      x: '52',
      y: '64.5',
      width: '16',
      height: '2.2',
      rx: '1.1',
      fill: '#00f0ff',
      opacity: '0.35'
    });
    visorContent.appendChild(voiceMouth);
    this._els.voiceMouth = voiceMouth;

    // バイザーガラス曲面反射ハイライト
    visorContent.appendChild(createSvgEl('path', {
      d: 'M 33 48 Q 52 41 84 47 L 80 51 Q 53 45 34 52 Z',
      fill: 'rgba(255, 255, 255, 0.16)'
    }));

    visorGroup.appendChild(visorContent);
    rig.appendChild(visorGroup);

    this._els.eyeGroups = {
      happy: eyesHappy,
      curious: eyesCurious,
      alert: eyesAlert,
      excited: eyesExcited
    };

    // --- 多関節溶接アーム（左右） ---
    var leftArm = createSvgEl('g', { transform: 'translate(29, 63) rotate(-14)' });
    // 肩ジョイント
    leftArm.appendChild(createSvgEl('circle', {
      cx: '0',
      cy: '0',
      r: '4.6',
      fill: 'url(#' + u + '-brass-grad)',
      stroke: '#4e3308',
      'stroke-width': '0.9'
    }));
    // 上腕シリンダー
    leftArm.appendChild(createSvgEl('path', {
      d: 'M -2 -2 L -13 5 L -10 10 L 1 3 Z',
      fill: 'url(#' + u + '-metal-grad)',
      stroke: '#88a7c4',
      'stroke-width': '0.8'
    }));
    // 肘関節
    leftArm.appendChild(createSvgEl('circle', {
      cx: '-12',
      cy: '8',
      r: '3.2',
      fill: 'url(#' + u + '-brass-grad)',
      stroke: '#4e3308',
      'stroke-width': '0.7'
    }));
    // 前腕＋溶接トーチ
    leftArm.appendChild(createSvgEl('path', {
      d: 'M -13 8 L -21 -1 L -17 -4 L -9 5 Z',
      fill: 'url(#' + u + '-metal-grad)',
      stroke: '#88a7c4',
      'stroke-width': '0.8'
    }));
    // 溶接ノズル爪
    leftArm.appendChild(createSvgEl('path', {
      d: 'M -20 -1 L -24 -6 M -17 -3 L -19 -8',
      stroke: '#ffe299',
      'stroke-width': '1.6',
      'stroke-linecap': 'round'
    }));
    var leftSpark = createSvgEl('circle', {
      cx: '-22',
      cy: '-8',
      r: '2.2',
      fill: '#00f0ff',
      opacity: '0',
      filter: 'url(#' + u + '-neon-glow)'
    });
    leftArm.appendChild(leftSpark);
    rig.appendChild(leftArm);
    this._els.leftArm = leftArm;
    this._els.leftSpark = leftSpark;

    var rightArm = createSvgEl('g', { transform: 'translate(91, 63) rotate(16)' });
    rightArm.appendChild(createSvgEl('circle', {
      cx: '0',
      cy: '0',
      r: '4.6',
      fill: 'url(#' + u + '-brass-grad)',
      stroke: '#4e3308',
      'stroke-width': '0.9'
    }));
    rightArm.appendChild(createSvgEl('path', {
      d: 'M 2 -2 L 13 5 L 10 10 L -1 3 Z',
      fill: 'url(#' + u + '-metal-grad)',
      stroke: '#88a7c4',
      'stroke-width': '0.8'
    }));
    rightArm.appendChild(createSvgEl('circle', {
      cx: '12',
      cy: '8',
      r: '3.2',
      fill: 'url(#' + u + '-brass-grad)',
      stroke: '#4e3308',
      'stroke-width': '0.7'
    }));
    rightArm.appendChild(createSvgEl('path', {
      d: 'M 13 8 L 21 -1 L 17 -4 L 9 5 Z',
      fill: 'url(#' + u + '-metal-grad)',
      stroke: '#88a7c4',
      'stroke-width': '0.8'
    }));
    rightArm.appendChild(createSvgEl('path', {
      d: 'M 20 -1 L 24 -6 M 17 -3 L 19 -8',
      stroke: '#ffe299',
      'stroke-width': '1.6',
      'stroke-linecap': 'round'
    }));
    var rightSpark = createSvgEl('circle', {
      cx: '22',
      cy: '-8',
      r: '2.2',
      fill: '#ffd84d',
      opacity: '0',
      filter: 'url(#' + u + '-neon-glow)'
    });
    rightArm.appendChild(rightSpark);
    rig.appendChild(rightArm);
    this._els.rightArm = rightArm;
    this._els.rightSpark = rightSpark;

    svg.appendChild(rig);
    this._els.svg = svg;
    this.svgHostEl.appendChild(svg);
  };

  BoogieController.prototype._buildWaveform = function () {
    if (!this.waveformEl) {
      return;
    }
    this.waveformEl.innerHTML = '';
    this._waveBars = [];
    var barCount = 9;
    for (var i = 0; i < barCount; i += 1) {
      var bar = document.createElement('span');
      bar.className = 'wave-bar';
      this.waveformEl.appendChild(bar);
      this._waveBars.push(bar);
    }
  };

  /**
   * ブギーの表情と姿勢ニュアンスを切り替える。
   * @param {'happy'|'curious'|'alert'|'excited'} mood
   */
  BoogieController.prototype.setExpression = function (mood) {
    var nextMood = MOOD_CONFIG[mood] ? mood : 'happy';
    this.mood = nextMood;
    var cfg = MOOD_CONFIG[nextMood];

    if (this.svgHostEl) {
      this.svgHostEl.setAttribute('data-mood', nextMood);
    }

    var eyeKeys = Object.keys(this._els.eyeGroups || {});
    for (var i = 0; i < eyeKeys.length; i += 1) {
      var k = eyeKeys[i];
      var grp = this._els.eyeGroups[k];
      if (grp) {
        grp.style.display = k === nextMood ? 'inline' : 'none';
      }
    }

    if (this._els.beaconCore) {
      this._els.beaconCore.setAttribute('fill', cfg.beaconColor);
    }
    if (this._els.beaconRing) {
      this._els.beaconRing.setAttribute('stroke', cfg.beaconColor);
    }
    if (this._els.voiceMouth) {
      this._els.voiceMouth.setAttribute('fill', cfg.eyeColor);
    }
    if (this._els.svg) {
      this._els.svg.style.filter = 'drop-shadow(0 0 7px ' + cfg.beaconGlow + ')';
    }
  };

  /**
   * 指定ミリ秒だけ発話モードを起動し、音声波形をダイナミックに脈動させる。
   * @param {number} [durationMs=1800]
   */
  BoogieController.prototype.triggerTalk = function (durationMs) {
    var ms =
      typeof durationMs === 'number' && Number.isFinite(durationMs)
        ? Math.max(0, durationMs)
        : 1800;

    if (ms <= 0) {
      this.isTalking = false;
      this.talkRemainingMs = 0;
      this.talkDurationMs = 0;
      this._syncTalkClasses(false);
      return;
    }

    this.isTalking = true;
    this.talkRemainingMs = Math.max(this.talkRemainingMs, ms);
    this.talkDurationMs = Math.max(this.talkDurationMs, ms);
    this._syncTalkClasses(true);
  };

  BoogieController.prototype._syncTalkClasses = function (talking) {
    if (this.waveformEl) {
      this.waveformEl.classList.toggle('is-talking', talking);
    }
    if (this.avatarWrapEl) {
      this.avatarWrapEl.classList.toggle('is-talking', talking);
    }
  };

  /**
   * フレーム毎の表情アニメーション・浮遊・音声波形更新を行う。
   * @param {number} dt 経過時間（秒）
   */
  BoogieController.prototype.update = function (dt) {
    var safeDt = normalizeDt(dt, 1 / 60);
    this.time += safeDt;

    var cfg = MOOD_CONFIG[this.mood] || MOOD_CONFIG.happy;

    // 発話タイマー減算
    if (this.isTalking) {
      this.talkRemainingMs -= safeDt * 1000;
      if (this.talkRemainingMs <= 0) {
        this.talkRemainingMs = 0;
        this.talkDurationMs = 0;
        this.isTalking = false;
        this._syncTalkClasses(false);
      }
    }

    // まばたき制御（alert時は瞬き控えめ）
    this.blinkCooldown -= safeDt;
    if (this.blinkCooldown <= 0) {
      this.blinkPhase = 1.0;
      this.blinkCooldown = cfg.blinkRate + ((Math.sin(this.time * 7.3) + 1) * 0.9);
    }
    if (this.blinkPhase > 0) {
      this.blinkPhase = Math.max(0, this.blinkPhase - safeDt * 6.5);
    }
    var eyeScaleY = this.blinkPhase > 0 ? 1 - Math.sin(this.blinkPhase * Math.PI) * 0.88 : 1;

    // 姿勢・傾き・溶接アーム角度の滑らかな補間
    var smoothRate = Math.min(1, safeDt * 8.5);
    this.currentTilt = lerp(this.currentTilt, cfg.tiltDeg, smoothRate);
    this.currentLeftArm = lerp(this.currentLeftArm, cfg.leftArmRest, smoothRate);
    this.currentRightArm = lerp(this.currentRightArm, cfg.rightArmRest, smoothRate);

    var bobY = Math.sin(this.time * cfg.bobSpeed) * cfg.bobAmp;
    var alertShakeX = this.mood === 'alert' ? Math.sin(this.time * 32) * 0.9 : 0;
    var talkBounce = this.isTalking ? Math.sin(this.time * 18) * 0.9 : 0;

    if (this._els.rig) {
      this._els.rig.setAttribute(
        'transform',
        'translate(' +
          alertShakeX.toFixed(2) +
          ', ' +
          (bobY + talkBounce).toFixed(2) +
          ') rotate(' +
          (this.currentTilt + Math.sin(this.time * 1.4) * 1.2).toFixed(2) +
          ' 60 59)'
      );
    }

    if (this._els.eyesCarrier) {
      var eyeLookX = this.mood === 'curious' ? Math.sin(this.time * 1.8) * 1.6 : 0;
      this._els.eyesCarrier.setAttribute(
        'transform',
        'translate(' + (60 + eyeLookX).toFixed(2) + ', 55) scale(1, ' + eyeScaleY.toFixed(3) + ')'
      );
    }

    // excited 時の星形アイ回転＆脈動
    if (this.mood === 'excited' && this._els.starLeft && this._els.starRight) {
      var starRot = (this.time * 72) % 360;
      var starScale = 0.94 + Math.sin(this.time * 8) * 0.14;
      this._els.starLeft.setAttribute(
        'transform',
        'translate(-12.5, 0) rotate(' + starRot.toFixed(1) + ') scale(' + starScale.toFixed(3) + ')'
      );
      this._els.starRight.setAttribute(
        'transform',
        'translate(12.5, 0) rotate(' + (-starRot).toFixed(1) + ') scale(' + starScale.toFixed(3) + ')'
      );
    }

    // 溶接アームモーション＆スパーク
    var armOsc = Math.sin(this.time * (this.isTalking ? 8.0 : 2.6)) * (this.isTalking ? 8.5 : 4.0);
    if (this._els.leftArm) {
      this._els.leftArm.setAttribute(
        'transform',
        'translate(29, 63) rotate(' + (this.currentLeftArm + armOsc).toFixed(2) + ')'
      );
    }
    if (this._els.rightArm) {
      this._els.rightArm.setAttribute(
        'transform',
        'translate(91, 63) rotate(' + (this.currentRightArm - armOsc * 0.9).toFixed(2) + ')'
      );
    }

    var sparkAlpha =
      this.mood === 'excited' || this.isTalking
        ? Math.max(0, Math.sin(this.time * 17) * 0.9)
        : 0;
    if (this._els.leftSpark) {
      this._els.leftSpark.setAttribute('opacity', sparkAlpha.toFixed(2));
    }
    if (this._els.rightSpark) {
      this._els.rightSpark.setAttribute('opacity', (sparkAlpha * 0.85).toFixed(2));
    }

    // ビーコン脈動波紋
    var beaconPulse = (this.time * (this.mood === 'alert' ? 2.6 : 1.15)) % 1;
    if (this._els.beaconRing) {
      this._els.beaconRing.setAttribute('r', (3.8 + beaconPulse * 6.5).toFixed(2));
      this._els.beaconRing.setAttribute('opacity', ((1 - beaconPulse) * 0.85).toFixed(2));
    }

    // 胸LED明滅
    if (this._els.chestLeds && this._els.chestLeds.length === 3) {
      for (var li = 0; li < 3; li += 1) {
        var ledOp = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(this.time * 4.2 + li * 1.7));
        this._els.chestLeds[li].setAttribute('opacity', ledOp.toFixed(2));
      }
    }

    // スラスター推進ジェット脈動
    var jetScaleY = 0.82 + 0.28 * Math.sin(this.time * 19);
    if (this._els.centerPlume) {
      this._els.centerPlume.setAttribute(
        'transform',
        'translate(60, 98) scale(1, ' + jetScaleY.toFixed(3) + ') translate(-60, -98)'
      );
    }
    if (this._els.leftPlume) {
      this._els.leftPlume.setAttribute(
        'transform',
        'translate(31, 96) scale(1, ' + (0.86 + 0.2 * Math.cos(this.time * 16)).toFixed(3) + ') translate(-31, -96)'
      );
    }
    if (this._els.rightPlume) {
      this._els.rightPlume.setAttribute(
        'transform',
        'translate(89, 96) scale(1, ' + (0.86 + 0.2 * Math.sin(this.time * 16)).toFixed(3) + ') translate(-89, -96)'
      );
    }

    // 気泡浮遊
    if (this._els.bubbles && this._els.bubbles.length === 3) {
      for (var bi = 0; bi < 3; bi += 1) {
        var dy = Math.sin(this.time * (1.8 + bi * 0.4) + bi * 2.1) * 3.5;
        this._els.bubbles[bi].setAttribute('transform', 'translate(0, ' + dy.toFixed(2) + ')');
      }
    }

    // ボイスLED口元
    if (this._els.voiceMouth) {
      var mouthWidth = this.isTalking
        ? 8 + Math.abs(Math.sin(this.time * 24)) * 16
        : 10 + Math.sin(this.time * 2.2) * 2;
      this._els.voiceMouth.setAttribute('width', mouthWidth.toFixed(1));
      this._els.voiceMouth.setAttribute('x', (60 - mouthWidth * 0.5).toFixed(1));
      this._els.voiceMouth.setAttribute('opacity', this.isTalking ? '0.95' : '0.32');
    }

    // 音声波形バー（CSSアニメーションのheightと干渉しない scaleY＋opacity で滑らか制御）
    if (this._waveBars.length > 0) {
      var count = this._waveBars.length;
      var mid = (count - 1) * 0.5;
      for (var wi = 0; wi < count; wi += 1) {
        var bar = this._waveBars[wi];
        var centerWeight = 1 - Math.abs(wi - mid) / (mid + 1.1);
        if (this.isTalking) {
          var wave1 = Math.sin(this.time * 16.5 + wi * 0.95);
          var wave2 = Math.cos(this.time * 23.0 - wi * 1.35);
          var amp = 0.58 + (0.55 + 0.45 * (wave1 * 0.6 + wave2 * 0.4)) * (0.6 + centerWeight * 0.65);
          bar.style.transform = 'scaleY(' + amp.toFixed(3) + ')';
          bar.style.opacity = clamp(0.75 + centerWeight * 0.25, 0.7, 1).toFixed(2);
        } else {
          var idleWave = 0.85 + 0.25 * Math.sin(this.time * 2.4 + wi * 0.65);
          bar.style.transform = 'scaleY(' + idleWave.toFixed(3) + ')';
          bar.style.opacity = '';
        }
      }
    }
  };

  BoogieController.prototype._resolveDockAnchor = function (ctx, dockAnchor) {
    if (
      dockAnchor &&
      typeof dockAnchor.x === 'number' &&
      Number.isFinite(dockAnchor.x) &&
      typeof dockAnchor.y === 'number' &&
      Number.isFinite(dockAnchor.y)
    ) {
      return { x: dockAnchor.x, y: dockAnchor.y };
    }

    var canvas = ctx.canvas;
    var canvasRect = canvas ? canvas.getBoundingClientRect() : null;

    var sourceEl = this.avatarWrapEl || this.svgHostEl || document.getElementById('boogie-dock');
    if (sourceEl && canvasRect && canvasRect.width > 0) {
      var r = sourceEl.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return {
          x: r.left - canvasRect.left + r.width * 0.46,
          y: r.top - canvasRect.top + r.height * 0.34
        };
      }
    }

    var cw = canvasRect && canvasRect.width > 0 ? canvasRect.width : (canvas ? canvas.width : 1280);
    var ch = canvasRect && canvasRect.height > 0 ? canvasRect.height : (canvas ? canvas.height : 720);
    return {
      x: Math.max(40, cw - 190),
      y: Math.max(40, ch - 150)
    };
  };

  /**
   * 画面右下のブギー通信ドック付近から照射されるホログラム誘導レーザーと、
   * ポート間誘導点線・矢印・浮遊ホログラムタグを高精細にCanvas描画する。
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array<Object>} guideLinks
   * @param {{x:number, y:number}} [dockAnchor]
   * @param {number} [time]
   */
  BoogieController.prototype.drawHologramGuides = function (ctx, guideLinks, dockAnchor, time) {
    if (!ctx || !Array.isArray(guideLinks) || guideLinks.length === 0) {
      return;
    }

    var t = typeof time === 'number' && Number.isFinite(time) ? time : this.time;
    var anchor = this._resolveDockAnchor(ctx, dockAnchor);

    ctx.save();

    // 1. ドック側のホログラム発射レンズリング
    this._drawDockEmitter(ctx, anchor.x, anchor.y, t);

    for (var i = 0; i < guideLinks.length; i += 1) {
      var item = guideLinks[i];
      if (!item) {
        continue;
      }

      var kind = item.kind || item.type || 'connect';
      var color = item.color || (kind === 'inspect' || kind === 'node' ? '#ffd84d' : '#00f0ff');

      if (kind === 'connect' && typeof item.fromX === 'number' && typeof item.toX === 'number') {
        var fx = item.fromX;
        var fy = item.fromY;
        var tx = item.toX;
        var ty = item.toY;
        var labelText =
          item.label !== undefined && item.label !== null
            ? item.label
            : 'ここをドラッグ接続！';

        // ブギーからの走査レーザービーム（始点・終点へ薄い投影コーン）
        this._drawScanningBeam(ctx, anchor.x, anchor.y, fx, fy, color, t, i === 0 ? 1.0 : 0.55);
        this._drawScanningBeam(ctx, anchor.x, anchor.y, tx, ty, color, t + 0.6, 0.45);

        // ターゲットポート間の光るシアン点線フロー＋動く矢印＋浮遊タグ
        this._drawConnectionGuide(ctx, fx, fy, tx, ty, color, labelText, t);
      } else if (
        (kind === 'node' || kind === 'inspect' || kind === 'inspect_slider' || kind === 'mode_filter') &&
        typeof item.x === 'number' &&
        typeof item.y === 'number'
      ) {
        var nw = typeof item.width === 'number' && item.width > 0 ? item.width : 188;
        var nh = typeof item.height === 'number' && item.height > 0 ? item.height : 148;
        var ncx = item.x + nw * 0.5;
        var ncy = item.y + nh * 0.5;
        var nodeLabel =
          item.label !== undefined && item.label !== null
            ? item.label
            : 'クリックして詳細調整！';

        this._drawScanningBeam(ctx, anchor.x, anchor.y, ncx, ncy, color, t, 0.9);
        this._drawNodeHighlightBox(ctx, item.x, item.y, nw, nh, color, nodeLabel, t);
      } else if (kind === 'hint') {
        var hintLabel =
          item.label !== undefined && item.label !== null ? item.label : '';
        if (hintLabel) {
          var tagW = this._measureHologramTagWidth(ctx, hintLabel);
          var rightLimit = anchor.x - 16;
          var dockEl =
            typeof global.document !== 'undefined' && typeof global.document.getElementById === 'function'
              ? global.document.getElementById('boogie-dock')
              : null;
          if (
            dockEl &&
            ctx.canvas &&
            typeof dockEl.getBoundingClientRect === 'function' &&
            typeof ctx.canvas.getBoundingClientRect === 'function'
          ) {
            var dRect = dockEl.getBoundingClientRect();
            var cRect = ctx.canvas.getBoundingClientRect();
            if (dRect && dRect.width > 0 && cRect && cRect.width > 0) {
              var dockLeft = dRect.left - cRect.left;
              if (dockLeft > tagW + 24 && dockLeft < anchor.x + 80) {
                rightLimit = Math.min(rightLimit, dockLeft - 12);
              }
            }
          }
          var minCenterX = tagW * 0.5 + 10;
          var maxCenterX = Math.max(minCenterX, rightLimit - tagW * 0.5);
          var hx = maxCenterX;
          var hy = Math.max(96, anchor.y - 84) + Math.sin(t * 2.8) * 3;
          var tagBottomY = hy + 13;
          this._drawScanningBeam(ctx, anchor.x, anchor.y, hx, tagBottomY, color, t, 0.65);
          this._drawHologramTag(ctx, hx, hy, hintLabel, color, t);
        }
      } else {
        var targetX =
          typeof item.targetX === 'number'
            ? item.targetX
            : typeof item.toX === 'number'
              ? item.toX
              : typeof item.x === 'number'
                ? item.x
                : item.fromX;
        var targetY =
          typeof item.targetY === 'number'
            ? item.targetY
            : typeof item.toY === 'number'
              ? item.toY
              : typeof item.y === 'number'
                ? item.y
                : item.fromY;

        if (typeof targetX !== 'number' || typeof targetY !== 'number') {
          continue;
        }

        var defaultLabel =
          kind === 'place'
            ? 'ここをクリックして配置！'
            : kind === 'inspect' || kind === 'inspect_slider'
              ? 'クリックして詳細調整！'
              : 'ここを確認！';
        var tagLabel =
          item.label !== undefined && item.label !== null
            ? item.label
            : defaultLabel;

        this._drawScanningBeam(ctx, anchor.x, anchor.y, targetX, targetY, color, t, 0.9);
        this._drawTargetReticle(ctx, targetX, targetY, color, tagLabel, t);
      }
    }

    ctx.restore();
  };

  BoogieController.prototype._drawDockEmitter = function (ctx, x, y, t) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var pulse = 0.5 + 0.5 * Math.sin(t * 4.5);

    var rad = ctx.createRadialGradient(x, y, 2, x, y, 26 + pulse * 6);
    rad.addColorStop(0, 'rgba(200, 254, 255, 0.72)');
    rad.addColorStop(0.45, 'rgba(0, 240, 255, 0.28)');
    rad.addColorStop(1, 'rgba(0, 240, 255, 0)');
    ctx.fillStyle = rad;
    ctx.beginPath();
    ctx.arc(x, y, 28 + pulse * 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(0, 240, 255, 0.65)';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(x, y, 13, t * 2.2, t * 2.2 + Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  };

  BoogieController.prototype._drawScanningBeam = function (ctx, ax, ay, tx, ty, color, t, intensity) {
    var dx = tx - ax;
    var dy = ty - ay;
    var dist = Math.hypot(dx, dy);
    if (dist < 4) {
      return;
    }

    var nx = -dy / dist;
    var ny = dx / dist;
    var spread = clamp(12 + dist * 0.032, 14, 34);
    var scanSwing = Math.sin(t * 2.8) * 3.5;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // 投影コーン（薄いシアン走査光）
    var beamGrad = ctx.createLinearGradient(ax, ay, tx, ty);
    beamGrad.addColorStop(0, hexToRgba(color, 0.26 * intensity));
    beamGrad.addColorStop(0.55, hexToRgba('#00f0ff', 0.08 * intensity));
    beamGrad.addColorStop(1, hexToRgba(color, 0.02));

    ctx.fillStyle = beamGrad;
    ctx.beginPath();
    ctx.moveTo(ax + nx * 2.5, ay + ny * 2.5);
    ctx.lineTo(tx + nx * (spread + scanSwing), ty + ny * (spread + scanSwing));
    ctx.lineTo(tx - nx * (spread - scanSwing), ty - ny * (spread - scanSwing));
    ctx.lineTo(ax - nx * 2.5, ay - ny * 2.5);
    ctx.closePath();
    ctx.fill();

    // 中心の極細レーザー光軸
    var axisGrad = ctx.createLinearGradient(ax, ay, tx, ty);
    axisGrad.addColorStop(0, hexToRgba('#d8ffff', 0.45 * intensity));
    axisGrad.addColorStop(0.6, hexToRgba(color, 0.22 * intensity));
    axisGrad.addColorStop(1, hexToRgba(color, 0.42 * intensity));

    ctx.strokeStyle = axisGrad;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([8, 7]);
    ctx.lineDashOffset = -t * 72;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.setLineDash([]);

    // ビーム上を走る走査光パケット
    var scanU = (t * 0.95) % 1;
    var sx = lerp(ax, tx, scanU);
    var sy = lerp(ay, ty, scanU);
    ctx.fillStyle = hexToRgba('#e6feff', 0.72 * intensity);
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(sx, sy, 2.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  };

  BoogieController.prototype._drawConnectionGuide = function (ctx, fx, fy, tx, ty, color, label, t) {
    var dist = Math.hypot(tx - fx, ty - fy);
    if (dist < 4) {
      this._drawTargetReticle(ctx, tx, ty, color, label, t);
      return;
    }

    var bz = computeBezierPoints(fx, fy, tx, ty);

    // 1. 外層シアンネオン発光オーラ
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = hexToRgba(color, 0.28);
    ctx.lineWidth = 8.5;
    ctx.lineCap = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.moveTo(bz.p0x, bz.p0y);
    ctx.bezierCurveTo(bz.c1x, bz.c1y, bz.c2x, bz.c2y, bz.p1x, bz.p1y);
    ctx.stroke();

    // 2. 光るシアン点線フローアニメーション
    ctx.strokeStyle = hexToRgba(color, 0.92);
    ctx.lineWidth = 2.8;
    ctx.setLineDash([11, 8]);
    ctx.lineDashOffset = -t * 58;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(bz.p0x, bz.p0y);
    ctx.bezierCurveTo(bz.c1x, bz.c1y, bz.c2x, bz.c2y, bz.p1x, bz.p1y);
    ctx.stroke();

    // 3. 高輝度センター芯点線
    ctx.strokeStyle = 'rgba(232, 254, 255, 0.9)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([6, 13]);
    ctx.lineDashOffset = -t * 58;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(bz.p0x, bz.p0y);
    ctx.bezierCurveTo(bz.c1x, bz.c1y, bz.c2x, bz.c2y, bz.p1x, bz.p1y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 4. 曲線に沿って移動するドラッグお手本パルス光球
    var demoU = (t * 0.62) % 1;
    var demoPt = cubicPointAt(
      bz.p0x, bz.p0y, bz.c1x, bz.c1y, bz.c2x, bz.c2y, bz.p1x, bz.p1y, demoU
    );
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(demoPt.x, demoPt.y, 4.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = hexToRgba(color, 0.85);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(demoPt.x, demoPt.y, 8 + Math.sin(t * 9) * 1.8, 0, Math.PI * 2);
    ctx.stroke();

    // 5. 先端の動く矢印（終端少し手前で前後脈動するダブルシェブロン）
    var arrowSlide = Math.sin(t * 5.4) * 0.025;
    var arrowT = clamp(0.92 + arrowSlide, 0.82, 0.96);
    var aPt = cubicPointAt(
      bz.p0x, bz.p0y, bz.c1x, bz.c1y, bz.c2x, bz.c2y, bz.p1x, bz.p1y, arrowT
    );
    var aTan = cubicTangentAt(
      bz.p0x, bz.p0y, bz.c1x, bz.c1y, bz.c2x, bz.c2y, bz.p1x, bz.p1y, arrowT
    );
    var angle = Math.atan2(aTan.y, aTan.x);

    ctx.save();
    ctx.translate(aPt.x, aPt.y);
    ctx.rotate(angle);
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;

    // 塗り矢尻
    ctx.fillStyle = '#e8ffff';
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-5, -6.5);
    ctx.lineTo(-2, 0);
    ctx.lineTo(-5, 6.5);
    ctx.closePath();
    ctx.fill();

    // 追従シェブロンリング
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.1;
    ctx.beginPath();
    ctx.moveTo(-6, -7.5);
    ctx.lineTo(1.5, 0);
    ctx.lineTo(-6, 7.5);
    ctx.stroke();
    ctx.restore();

    // 6. 始点・終点のターゲットリングマーカ
    this._drawPortMarker(ctx, fx, fy, color, t, true);
    this._drawPortMarker(ctx, tx, ty, color, t, false);
    ctx.restore();

    // 7. 浮遊ホログラムタグ（中点上方）
    if (label) {
      var midPt = cubicPointAt(
        bz.p0x, bz.p0y, bz.c1x, bz.c1y, bz.c2x, bz.c2y, bz.p1x, bz.p1y, 0.5
      );
      var floatY = midPt.y - 26 + Math.sin(t * 3.1) * 3.0;
      this._drawHologramTag(ctx, midPt.x, floatY, label, color, t, midPt.y);
    }
  };

  BoogieController.prototype._drawPortMarker = function (ctx, x, y, color, t, isOrigin) {
    var wave = (t * 1.4 + (isOrigin ? 0 : 0.5)) % 1;
    var rOuter = isOrigin ? 11 + wave * 11 : 19 - wave * 9;
    var alpha = (1 - wave) * 0.85;

    ctx.save();
    ctx.strokeStyle = hexToRgba(color, alpha);
    ctx.lineWidth = 1.8;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(x, y, rOuter, 0, Math.PI * 2);
    ctx.stroke();

    // 回転照準4ノッチ
    var rot = t * (isOrigin ? 1.8 : -1.8);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    for (var k = 0; k < 4; k += 1) {
      var ang = rot + (k * Math.PI) / 2;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(ang) * 9, y + Math.sin(ang) * 9);
      ctx.lineTo(x + Math.cos(ang) * 13.5, y + Math.sin(ang) * 13.5);
      ctx.stroke();
    }
    ctx.restore();
  };

  BoogieController.prototype._drawTargetReticle = function (ctx, x, y, color, label, t) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    var pulse = 0.5 + 0.5 * Math.sin(t * 4.2);
    var radius = 22 + pulse * 4;

    // 放射グロー
    var rad = ctx.createRadialGradient(x, y, 2, x, y, radius + 12);
    rad.addColorStop(0, hexToRgba(color, 0.34));
    rad.addColorStop(0.65, hexToRgba(color, 0.1));
    rad.addColorStop(1, hexToRgba(color, 0));
    ctx.fillStyle = rad;
    ctx.beginPath();
    ctx.arc(x, y, radius + 12, 0, Math.PI * 2);
    ctx.fill();

    // 回転破線リング
    ctx.strokeStyle = hexToRgba(color, 0.88);
    ctx.lineWidth = 2.0;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.arc(x, y, radius, t * 1.6, t * 1.6 + Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 内側収束リング
    var wave = (t * 1.15) % 1;
    ctx.strokeStyle = hexToRgba('#ffffff', (1 - wave) * 0.78);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 28 - wave * 18, 0, Math.PI * 2);
    ctx.stroke();

    // コーナーブラケット [ ]
    var b = 15 + pulse * 2.5;
    var c = 6;
    ctx.strokeStyle = '#ffd84d';
    ctx.lineWidth = 2.0;
    var corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1]
    ];
    for (var ci = 0; ci < 4; ci += 1) {
      var sx = corners[ci][0];
      var sy = corners[ci][1];
      ctx.beginPath();
      ctx.moveTo(x + sx * (b - c), y + sy * b);
      ctx.lineTo(x + sx * b, y + sy * b);
      ctx.lineTo(x + sx * b, y + sy * (b - c));
      ctx.stroke();
    }

    // 上下でバウンスする下向き誘導矢印 ▼
    var bounceY = y - radius - 9 + Math.sin(t * 5.8) * 3.5;
    ctx.fillStyle = '#e8ffff';
    ctx.beginPath();
    ctx.moveTo(x, bounceY + 7);
    ctx.lineTo(x - 6, bounceY - 3);
    ctx.lineTo(x + 6, bounceY - 3);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    if (label) {
      var tagY = y - radius - 26 + Math.sin(t * 3.2) * 2.5;
      this._drawHologramTag(ctx, x, tagY, label, color, t, y - radius - 2);
    }
  };

  BoogieController.prototype._drawNodeHighlightBox = function (ctx, x, y, w, h, color, label, t) {
    var pulse = 0.5 + 0.5 * Math.sin(t * 4.4);
    var pad = 6 + pulse * 3;
    var bx = x - pad;
    var by = y - pad;
    var bw = w + pad * 2;
    var bh = h + pad * 2;
    var cx = x + w * 0.5;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // 回転パルス破線フレーム
    roundRectPath(ctx, bx, by, bw, bh, 14);
    ctx.strokeStyle = hexToRgba(color, 0.78 + pulse * 0.2);
    ctx.lineWidth = 2.0;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.setLineDash([10, 6]);
    ctx.lineDashOffset = -t * 40;
    ctx.stroke();
    ctx.setLineDash([]);

    // 四隅コーナーブラケット
    var cLen = 13;
    ctx.strokeStyle = '#ffd84d';
    ctx.lineWidth = 2.4;
    var pts = [
      [bx, by, 1, 1],
      [bx + bw, by, -1, 1],
      [bx + bw, by + bh, -1, -1],
      [bx, by + bh, 1, -1]
    ];
    for (var i = 0; i < pts.length; i += 1) {
      var px = pts[i][0];
      var py = pts[i][1];
      var sx = pts[i][2];
      var sy = pts[i][3];
      ctx.beginPath();
      ctx.moveTo(px + sx * cLen, py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py + sy * cLen);
      ctx.stroke();
    }

    // 上方でバウンスする誘導矢印 ▼
    var bounceY = by - 9 + Math.sin(t * 5.8) * 3.5;
    ctx.fillStyle = '#e8ffff';
    ctx.beginPath();
    ctx.moveTo(cx, bounceY + 7);
    ctx.lineTo(cx - 6, bounceY - 3);
    ctx.lineTo(cx + 6, bounceY - 3);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    if (label) {
      var tagY = by - 26 + Math.sin(t * 3.2) * 2.5;
      this._drawHologramTag(ctx, cx, tagY, label, color, t, by - 2);
    }
  };

  BoogieController.prototype._measureHologramTagWidth = function (ctx, text) {
    ctx.save();
    ctx.font = '700 12px ' + getFontFamily();
    var metrics = ctx.measureText(text);
    ctx.restore();
    var textW = metrics && typeof metrics.width === 'number' ? metrics.width : 0;
    return Math.max(88, textW + 28);
  };

  BoogieController.prototype._drawHologramTag = function (ctx, cx, cy, text, color, t, anchorY) {
    ctx.save();
    ctx.font = '700 12px ' + getFontFamily();
    var boxW = this._measureHologramTagWidth(ctx, text);
    var boxH = 26;

    // 画面端クランプ
    var cw = ctx.canvas ? ctx.canvas.clientWidth || ctx.canvas.width : 1280;
    var clampedX = clamp(cx, boxW * 0.5 + 10, Math.max(boxW * 0.5 + 10, cw - boxW * 0.5 - 10));
    var clampedY = Math.max(boxH * 0.5 + 10, cy);

    var bx = clampedX - boxW * 0.5;
    var by = clampedY - boxH * 0.5;

    // 指示連結線
    if (typeof anchorY === 'number' && anchorY > by + boxH) {
      ctx.strokeStyle = hexToRgba(color, 0.6);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(clampedX, by + boxH);
      ctx.lineTo(cx, anchorY);
      ctx.stroke();
    }

    // ホログラムプレート背景
    chamferRectPath(ctx, bx, by, boxW, boxH, 6);
    var bgGrad = ctx.createLinearGradient(bx, by, bx, by + boxH);
    bgGrad.addColorStop(0, 'rgba(7, 29, 54, 0.92)');
    bgGrad.addColorStop(1, 'rgba(3, 14, 30, 0.95)');
    ctx.fillStyle = bgGrad;
    ctx.shadowColor = hexToRgba(color, 0.55);
    ctx.shadowBlur = 12;
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = hexToRgba(color, 0.85);
    ctx.lineWidth = 1.3;
    ctx.stroke();

    // 左端のアクセントドット（点滅）
    var dotPulse = 0.55 + 0.45 * Math.sin(t * 6);
    ctx.fillStyle = hexToRgba('#ffd84d', dotPulse);
    ctx.beginPath();
    ctx.arc(bx + 8, clampedY, 2.3, 0, Math.PI * 2);
    ctx.fill();

    // テキスト本体
    ctx.fillStyle = '#effbff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, clampedX + 3, clampedY + 0.5);

    ctx.restore();
  };

  // =========================================================================
  // 2. EncyclopediaPreview ― 400x180 動く技術図鑑ライブシミュレーションCanvas
  // =========================================================================
  var ENC_WIDTH = 400;
  var ENC_HEIGHT = 180;

  /**
   * 技術図鑑モーダル内の 400x180 ミニCanvasを駆動し、選択パーツの構造図解を
   * 60fpsで生き生きとループ再生するクラス。
   * @constructor
   * @param {HTMLCanvasElement|string} canvasEl
   */
  function EncyclopediaPreview(canvasEl) {
    this.canvas = resolveElement(canvasEl, 'encyclopedia-canvas');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this._dpr = 0;

    this.partId = null;
    this.variantKey = null;
    this._diagram = null;

    this._running = false;
    this._rafId = null;
    this._lastFrameMs = 0;

    this._time = 0;
    this._simNodes = {};
    this._simNodeList = [];
    this._simLinks = [];
    this._vfxParticles = [];
    this._bgBubbles = [];

    this._initBgBubbles();
    this._ensureResolution();
  }

  EncyclopediaPreview.prototype._initBgBubbles = function () {
    this._bgBubbles = [];
    for (var i = 0; i < 16; i += 1) {
      this._bgBubbles.push({
        x: (i * 31 + 17) % ENC_WIDTH,
        y: (i * 23 + 11) % ENC_HEIGHT,
        r: 1.0 + (i % 3) * 0.65,
        speed: 8 + (i % 4) * 3.5,
        phase: i * 1.1
      });
    }
  };

  EncyclopediaPreview.prototype._ensureResolution = function () {
    if (!this.canvas || !this.ctx) {
      return;
    }
    var dpr = Math.min(global.devicePixelRatio || 1, 3);
    var targetW = Math.round(ENC_WIDTH * dpr);
    var targetH = Math.round(ENC_HEIGHT * dpr);
    if (this._dpr !== dpr || this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this._dpr = dpr;
      this.canvas.width = targetW;
      this.canvas.height = targetH;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  };

  /**
   * プレビュー対象のパーツIDを設定し、シミュレーションを再構築する。
   * @param {string} partId
   */
  EncyclopediaPreview.prototype.setPart = function (partId) {
    var encMap = global.ABYSS_DATA && global.ABYSS_DATA.ENCYCLOPEDIA;
    if (!encMap || !encMap[partId]) {
      this.partId = partId;
      this.variantKey = null;
      this._diagram = null;
      this._simNodes = {};
      this._simNodeList = [];
      this._simLinks = [];
      return;
    }

    this.partId = partId;
    var entry = encMap[partId];
    if (Array.isArray(entry.variants) && entry.variants.length > 0) {
      this.variantKey = entry.variants[0].key;
    } else {
      this.variantKey = null;
    }

    this._rebuildSimulation();
    this.renderFrame(1 / 60);
  };

  /**
   * 汎用モジュール等のシミュレーションバリアントを切り替える。
   * @param {string} variantKey
   */
  EncyclopediaPreview.prototype.setVariant = function (variantKey) {
    this.variantKey = variantKey;
    this._rebuildSimulation();
    this.renderFrame(1 / 60);
  };

  EncyclopediaPreview.prototype._resolveDiagram = function () {
    var encMap = global.ABYSS_DATA && global.ABYSS_DATA.ENCYCLOPEDIA;
    if (!encMap || !this.partId || !encMap[this.partId]) {
      return null;
    }
    var entry = encMap[this.partId];
    if (Array.isArray(entry.variants) && entry.variants.length > 0) {
      for (var i = 0; i < entry.variants.length; i += 1) {
        if (entry.variants[i].key === this.variantKey) {
          return entry.variants[i];
        }
      }
      return entry.variants[0];
    }
    return entry.diagram || null;
  };

  EncyclopediaPreview.prototype._getPortOffset = function (partId, portId, isOutput) {
    var partsMap = global.ABYSS_DATA && global.ABYSS_DATA.PARTS_MAP;
    var partDef = partsMap ? partsMap[partId] : null;
    if (partDef && partDef.ports) {
      var list = isOutput ? partDef.ports.outputs : partDef.ports.inputs;
      if (Array.isArray(list)) {
        for (var i = 0; i < list.length; i += 1) {
          if (list[i].id === portId && list[i].offset) {
            return {
              x: list[i].offset.x,
              y: list[i].offset.y,
              color: list[i].color
            };
          }
        }
      }
    }
    return {
      x: isOutput ? 1 : 0,
      y: 0.5,
      color: '#00f0ff'
    };
  };

  EncyclopediaPreview.prototype._rebuildSimulation = function () {
    this._diagram = this._resolveDiagram();
    this._simNodes = {};
    this._simNodeList = [];
    this._simLinks = [];
    this._vfxParticles = [];
    this._time = 0;

    if (!this._diagram) {
      return;
    }

    var rawNodes = Array.isArray(this._diagram.nodes) ? this._diagram.nodes : [];
    for (var ni = 0; ni < rawNodes.length; ni += 1) {
      var n = rawNodes[ni];
      var initTemp = 26;
      if (n.partId === 'generic_module') {
        if (n.mode === 'filter') {
          initTemp = 34;
        } else if (typeof n.precision === 'number' && n.precision < 35) {
          initTemp = 68;
        } else {
          initTemp = 44;
        }
      }
      var simNode = {
        id: n.id,
        partId: n.partId,
        label: n.label || n.id,
        x: n.x,
        y: n.y,
        w: n.w,
        h: n.h,
        mode: n.mode || 'data',
        precision: typeof n.precision === 'number' ? n.precision : 50,
        isFocus: Boolean(n.isFocus),
        heat: initTemp,
        coolTimer: this.variantKey === 'filter_coolant' && n.id === 'd_hot' ? 4.0 : 0,
        spinAngle: ni * 0.8,
        spinSpeed: n.partId === 'hydrothermal_turbine' ? 4.2 : 1.8,
        activityPulse: 0.35,
        uplinkFlash: 0,
        ventTimer: 0,
        portsIn: [],
        portsOut: []
      };
      this._simNodes[simNode.id] = simNode;
      this._simNodeList.push(simNode);
    }

    var rawLinks = Array.isArray(this._diagram.links) ? this._diagram.links : [];
    var resources = (global.ABYSS_DATA && global.ABYSS_DATA.RESOURCES) || {};

    for (var li = 0; li < rawLinks.length; li += 1) {
      var l = rawLinks[li];
      var fromNode = this._simNodes[l.fromNode];
      var toNode = this._simNodes[l.toNode];
      if (!fromNode || !toNode) {
        continue;
      }

      var outInfo = this._getPortOffset(fromNode.partId, l.fromPort, true);
      var inInfo = this._getPortOffset(toNode.partId, l.toPort, false);

      var sx = fromNode.x + outInfo.x * fromNode.w;
      var sy = fromNode.y + outInfo.y * fromNode.h;
      var ex = toNode.x + inInfo.x * toNode.w;
      var ey = toNode.y + inInfo.y * toNode.h;

      var resDef = resources[l.resource] || resources.raw_data || {
        id: l.resource,
        color: '#00f0ff',
        secondaryColor: '#ffffff',
        coreColor: '#ffffff',
        pipeColor: '#0e4c61',
        pipeBorderColor: 'rgba(0, 240, 255, 0.5)',
        pipeWidth: 3.5,
        speed: 145,
        particleShape: 'orb',
        particleRadius: 4.5,
        emitSteam: false
      };

      fromNode.portsOut.push({
        id: l.fromPort,
        x: sx,
        y: sy,
        color: resDef.color || outInfo.color
      });
      toNode.portsIn.push({
        id: l.toPort,
        x: ex,
        y: ey,
        color: resDef.color || inInfo.color
      });

      var isBottleneck = Boolean(l.bottleneckDemo);
      var spawnInterval = isBottleneck ? 0.30 : (l.resource === 'power' ? 0.48 : 0.62);

      var simLink = {
        fromNode: fromNode,
        toNode: toNode,
        fromPort: l.fromPort,
        toPort: l.toPort,
        resource: l.resource,
        resDef: resDef,
        bottleneckDemo: isBottleneck,
        bz: computeBezierPoints(sx, sy, ex, ey),
        sx: sx,
        sy: sy,
        ex: ex,
        ey: ey,
        spawnInterval: spawnInterval,
        spawnTimer: 0,
        particles: [],
        bulgePhase: 0
      };

      // 開いた瞬間に空にならないよう初期粒をプリポピュレート
      var preCount = isBottleneck ? 6 : 3;
      for (var pi = 0; pi < preCount; pi += 1) {
        var u = isBottleneck ? 0.14 + pi * 0.15 : 0.16 + pi * 0.30;
        simLink.particles.push({
          t: clamp(u, 0.04, 0.96),
          jitterSeed: pi * 1.7 + li * 0.9,
          steamAccum: 0
        });
      }

      this._simLinks.push(simLink);
    }
  };

  /**
   * 60fpsのプレビューループを開始する。
   */
  EncyclopediaPreview.prototype.start = function () {
    if (this._running) {
      return;
    }
    this._running = true;
    this._lastFrameMs = global.performance ? global.performance.now() : Date.now();
    var self = this;

    function loop(nowMs) {
      if (!self._running) {
        return;
      }
      var current = typeof nowMs === 'number' ? nowMs : Date.now();
      var rawDt = (current - self._lastFrameMs) / 1000;
      self._lastFrameMs = current;
      self.renderFrame(rawDt);
      self._rafId = global.requestAnimationFrame(loop);
    }

    this._rafId = global.requestAnimationFrame(loop);
  };

  /**
   * プレビューループを停止する。
   */
  EncyclopediaPreview.prototype.stop = function () {
    this._running = false;
    if (this._rafId !== null && typeof global.cancelAnimationFrame === 'function') {
      global.cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  };

  /**
   * 1フレーム分の物理進行と高精細描画を実行する。
   * @param {number} [dt] 経過時間（秒）
   */
  EncyclopediaPreview.prototype.renderFrame = function (dt) {
    if (!this.canvas || !this.ctx) {
      return;
    }
    this._ensureResolution();

    var safeDt = normalizeDt(dt, 1 / 60);
    this._updateSim(safeDt);

    var ctx = this.ctx;
    ctx.save();
    ctx.clearRect(0, 0, ENC_WIDTH, ENC_HEIGHT);

    this._drawBackground(ctx);
    this._drawLinks(ctx);
    this._drawNodes(ctx);
    this._drawVfxParticles(ctx);
    this._drawForegroundOverlay(ctx);

    ctx.restore();
  };

  EncyclopediaPreview.prototype._updateSim = function (dt) {
    this._time += dt;

    // 背景気泡
    for (var bi = 0; bi < this._bgBubbles.length; bi += 1) {
      var bb = this._bgBubbles[bi];
      bb.y -= bb.speed * dt;
      if (bb.y < -4) {
        bb.y = ENC_HEIGHT + 4;
      }
    }

    // ノード状態の継続進行
    for (var ni = 0; ni < this._simNodeList.length; ni += 1) {
      var node = this._simNodeList[ni];
      node.activityPulse = Math.max(0.18, node.activityPulse - dt * 0.65);
      node.uplinkFlash = Math.max(0, node.uplinkFlash - dt * 1.9);

      if (node.partId === 'hydrothermal_turbine') {
        node.spinAngle += node.spinSpeed * dt;
        node.spinSpeed = Math.max(2.6, node.spinSpeed - dt * 0.9);
      } else if (node.partId === 'generic_module') {
        node.spinAngle += (node.mode === 'filter' ? 2.4 : (node.precision < 35 ? 4.4 : 2.1)) * dt;
        if (node.coolTimer > 0) {
          node.coolTimer = Math.max(0, node.coolTimer - dt);
          node.heat = lerp(node.heat, 25, dt * 1.6);
        } else if (node.mode === 'data' && node.precision < 35) {
          // 速度特化は発熱上昇を分かりやすく表現（62〜85℃を循環表現）
          var cycleTemp = 66 + Math.sin(this._time * 1.15) * 18;
          node.heat = lerp(node.heat, cycleTemp, dt * 2.5);
        } else {
          node.heat = lerp(node.heat, node.mode === 'filter' ? 32 : 44, dt * 1.5);
        }
      } else if (node.partId === 'drain_vent') {
        node.ventTimer += dt;
        if (node.ventTimer > 0.24) {
          node.ventTimer = 0;
          this._spawnSteamBurst(node.x + node.w * 0.5, node.y + 8, 2, false);
        }
      }
    }

    // リンクと粒子の移動更新
    for (var li = 0; li < this._simLinks.length; li += 1) {
      var link = this._simLinks[li];
      link.spawnTimer += dt;
      if (link.spawnTimer >= link.spawnInterval && link.particles.length < 10) {
        link.spawnTimer = 0;
        link.particles.push({
          t: 0,
          jitterSeed: this._time * 3.1 + li,
          steamAccum: 0
        });
      }

      if (link.bottleneckDemo) {
        link.bulgePhase += dt * 5.2;
      }

      var baseNormSpeed = clamp((link.resDef.speed || 130) / 145, 0.55, 1.85);
      for (var pi = link.particles.length - 1; pi >= 0; pi -= 1) {
        var p = link.particles[pi];
        var speedMul = baseNormSpeed;
        if (link.bottleneckDemo && p.t > 0.48) {
          // ボトルネック後半で渋滞減速し粒子が詰まる
          speedMul *= 0.34;
        }
        p.t += dt * 0.68 * speedMul;

        // 温排水は道中で湯気パーティクルを放出
        if (link.resDef.emitSteam) {
          p.steamAccum += dt;
          if (p.steamAccum > 0.14) {
            p.steamAccum = 0;
            var pt = cubicPointAt(
              link.bz.p0x, link.bz.p0y, link.bz.c1x, link.bz.c1y,
              link.bz.c2x, link.bz.c2y, link.bz.p1x, link.bz.p1y, clamp(p.t, 0, 1)
            );
            this._vfxParticles.push({
              kind: 'steam',
              x: pt.x + (Math.sin(p.t * 17) * 2),
              y: pt.y - 2,
              vx: Math.sin(this._time * 3 + pi) * 5,
              vy: -16 - (pi % 3) * 4,
              r: 2.2,
              life: 0,
              maxLife: 0.72,
              color: '#ffab78'
            });
          }
        }

        if (p.t >= 1.0) {
          link.particles.splice(pi, 1);
          this._onParticleArrive(link);
        }
      }
    }

    // VFX小パーティクル更新
    for (var vi = this._vfxParticles.length - 1; vi >= 0; vi -= 1) {
      var vp = this._vfxParticles[vi];
      vp.life += dt;
      if (vp.life >= vp.maxLife) {
        this._vfxParticles.splice(vi, 1);
        continue;
      }
      vp.x += (vp.vx || 0) * dt;
      vp.y += (vp.vy || 0) * dt;
    }
  };

  EncyclopediaPreview.prototype._onParticleArrive = function (link) {
    var target = link.toNode;
    target.activityPulse = 1.0;

    if (link.resource === 'purified_coolant' || link.resource === 'deep_water') {
      if (target.partId === 'generic_module' && link.toPort === 'in_coolant') {
        target.coolTimer = 2.6;
        target.heat = Math.max(22, target.heat - (link.resource === 'purified_coolant' ? 14 : 7));
        this._spawnCryoSpark(link.ex + 10, link.ey);
      }
    } else if (target.partId === 'surface_uplink') {
      target.uplinkFlash = 1.0;
      var cashText =
        link.resource === 'high_purity_data'
          ? '+$7.5'
          : link.resource === 'refined_data'
            ? (link.bottleneckDemo ? '渋滞!' : '+$6.0')
            : '+$3.0';
      if (this._vfxParticles.length < 48) {
        this._vfxParticles.push({
          kind: 'text',
          x: target.x + target.w * 0.5,
          y: target.y - 6,
          vx: 0,
          vy: -18,
          text: cashText,
          life: 0,
          maxLife: 0.95,
          color: link.bottleneckDemo ? '#ff5978' : '#ffd84d'
        });
      }
    } else if (target.partId === 'hydrothermal_turbine' && link.resource === 'hot_water') {
      target.spinSpeed = Math.min(10.5, target.spinSpeed + 2.4);
      this._spawnSpark(target.x + target.w * 0.5, target.y + target.h * 0.55, '#ffd84d');
    } else if (target.partId === 'drain_vent' && link.resource === 'hot_water') {
      this._spawnSteamBurst(target.x + target.w * 0.5, target.y + 4, 4, true);
    }
  };

  EncyclopediaPreview.prototype._spawnSteamBurst = function (x, y, count, warm) {
    for (var i = 0; i < count; i += 1) {
      if (this._vfxParticles.length >= 48) {
        return;
      }
      var spread = (i - (count - 1) * 0.5) * 8;
      this._vfxParticles.push({
        kind: warm ? 'steam_bubble' : 'bubble',
        x: x + spread * 0.6,
        y: y,
        vx: spread * 0.7,
        vy: -20 - (i % 3) * 6,
        r: 2.0 + (i % 3) * 0.9,
        life: 0,
        maxLife: 0.9 + (i % 2) * 0.3,
        color: warm ? '#ff8b52' : '#9eeeff'
      });
    }
  };

  EncyclopediaPreview.prototype._spawnCryoSpark = function (x, y) {
    for (var i = 0; i < 4; i += 1) {
      if (this._vfxParticles.length >= 48) {
        return;
      }
      var ang = (i * Math.PI) / 2 + this._time;
      this._vfxParticles.push({
        kind: 'cryo',
        x: x,
        y: y,
        vx: Math.cos(ang) * 16,
        vy: Math.sin(ang) * 16,
        r: 2.2,
        life: 0,
        maxLife: 0.55,
        color: '#b8ffff'
      });
    }
  };

  EncyclopediaPreview.prototype._spawnSpark = function (x, y, color) {
    for (var i = 0; i < 3; i += 1) {
      if (this._vfxParticles.length >= 48) {
        return;
      }
      var ang = this._time * 5 + i * 2.1;
      this._vfxParticles.push({
        kind: 'spark',
        x: x,
        y: y,
        vx: Math.cos(ang) * 22,
        vy: Math.sin(ang) * 22,
        r: 1.8,
        life: 0,
        maxLife: 0.42,
        color: color || '#ffd84d'
      });
    }
  };

  EncyclopediaPreview.prototype._drawBackground = function (ctx) {
    // 1. 深海設計図背景グラデーション
    var bgGrad = ctx.createLinearGradient(0, 0, 0, ENC_HEIGHT);
    bgGrad.addColorStop(0, '#07203d');
    bgGrad.addColorStop(0.5, '#041429');
    bgGrad.addColorStop(1, '#020915');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, ENC_WIDTH, ENC_HEIGHT);

    // 2. 揺らぐ深海コースティクス光条
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var ri = 0; ri < 3; ri += 1) {
      var rx = 70 + ri * 125 + Math.sin(this._time * 0.7 + ri * 1.9) * 18;
      var rayGrad = ctx.createLinearGradient(rx - 20, 0, rx + 42, ENC_HEIGHT);
      rayGrad.addColorStop(0, 'rgba(0, 240, 255, 0.065)');
      rayGrad.addColorStop(0.6, 'rgba(56, 214, 255, 0.02)');
      rayGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = rayGrad;
      ctx.beginPath();
      ctx.moveTo(rx - 24, 0);
      ctx.lineTo(rx + 28, 0);
      ctx.lineTo(rx + 68, ENC_HEIGHT);
      ctx.lineTo(rx + 4, ENC_HEIGHT);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // 3. ブループリントグリッド（20px小グリッド + 80px主グリッド）
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(56, 214, 255, 0.055)';
    ctx.beginPath();
    for (var gx = 20; gx < ENC_WIDTH; gx += 20) {
      ctx.moveTo(gx + 0.5, 0);
      ctx.lineTo(gx + 0.5, ENC_HEIGHT);
    }
    for (var gy = 20; gy < ENC_HEIGHT; gy += 20) {
      ctx.moveTo(0, gy + 0.5);
      ctx.lineTo(ENC_WIDTH, gy + 0.5);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(56, 214, 255, 0.12)';
    ctx.beginPath();
    for (var mx = 80; mx < ENC_WIDTH; mx += 80) {
      ctx.moveTo(mx + 0.5, 0);
      ctx.lineTo(mx + 0.5, ENC_HEIGHT);
    }
    for (var my = 80; my < ENC_HEIGHT; my += 80) {
      ctx.moveTo(0, my + 0.5);
      ctx.lineTo(ENC_WIDTH, my + 0.5);
    }
    ctx.stroke();

    // 設計図交差点クロス記号
    ctx.strokeStyle = 'rgba(122, 252, 255, 0.22)';
    for (var cx = 80; cx < ENC_WIDTH; cx += 80) {
      for (var cy = 80; cy < ENC_HEIGHT; cy += 80) {
        ctx.beginPath();
        ctx.moveTo(cx - 3, cy + 0.5);
        ctx.lineTo(cx + 4, cy + 0.5);
        ctx.moveTo(cx + 0.5, cy - 3);
        ctx.lineTo(cx + 0.5, cy + 4);
        ctx.stroke();
      }
    }

    // 4. 環境深海気泡
    ctx.save();
    for (var bi = 0; bi < this._bgBubbles.length; bi += 1) {
      var bb = this._bgBubbles[bi];
      var wobbleX = bb.x + Math.sin(this._time * 1.5 + bb.phase) * 2.5;
      ctx.fillStyle = 'rgba(130, 240, 255, 0.12)';
      ctx.strokeStyle = 'rgba(160, 248, 255, 0.35)';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.arc(wobbleX, bb.y, bb.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    // 5. 四隅ブループリントブラケットと右下タグ
    ctx.save();
    ctx.strokeStyle = 'rgba(216, 166, 72, 0.45)';
    ctx.lineWidth = 1.2;
    var pad = 6;
    var len = 10;
    // 左上
    ctx.beginPath();
    ctx.moveTo(pad, pad + len);
    ctx.lineTo(pad, pad);
    ctx.lineTo(pad + len, pad);
    // 右上
    ctx.moveTo(ENC_WIDTH - pad - len, pad);
    ctx.lineTo(ENC_WIDTH - pad, pad);
    ctx.lineTo(ENC_WIDTH - pad, pad + len);
    // 左下
    ctx.moveTo(pad, ENC_HEIGHT - pad - len);
    ctx.lineTo(pad, ENC_HEIGHT - pad);
    ctx.lineTo(pad + len, ENC_HEIGHT - pad);
    // 右下
    ctx.moveTo(ENC_WIDTH - pad - len, ENC_HEIGHT - pad);
    ctx.lineTo(ENC_WIDTH - pad, ENC_HEIGHT - pad);
    ctx.lineTo(ENC_WIDTH - pad, ENC_HEIGHT - pad - len);
    ctx.stroke();

    ctx.font = '600 9px ' + getMonoFontFamily();
    ctx.fillStyle = 'rgba(138, 180, 204, 0.55)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('SCHEMATIC // LIVE PREVIEW', 12, 9);
    ctx.restore();
  };

  EncyclopediaPreview.prototype._drawLinks = function (ctx) {
    for (var li = 0; li < this._simLinks.length; li += 1) {
      var link = this._simLinks[li];
      if (link.bottleneckDemo) {
        this._drawBottleneckPipe(ctx, link);
      } else {
        this._drawStandardPipe(ctx, link);
      }
      this._drawLinkParticles(ctx, link);
    }
  };

  EncyclopediaPreview.prototype._drawStandardPipe = function (ctx, link) {
    var bz = link.bz;
    var res = link.resDef;
    var width = clamp((res.pipeWidth || 3.5) * 0.88, 2.2, 6.2);

    ctx.save();
    ctx.lineCap = 'round';

    // 外側ネオンボーダー
    ctx.strokeStyle = res.pipeBorderColor || hexToRgba(res.color, 0.5);
    ctx.lineWidth = width + 2.4;
    ctx.shadowColor = hexToRgba(res.color, 0.45);
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(bz.p0x, bz.p0y);
    ctx.bezierCurveTo(bz.c1x, bz.c1y, bz.c2x, bz.c2y, bz.p1x, bz.p1y);
    ctx.stroke();

    // 管ベース本体
    ctx.shadowBlur = 0;
    ctx.strokeStyle = res.pipeColor || '#124663';
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(bz.p0x, bz.p0y);
    ctx.bezierCurveTo(bz.c1x, bz.c1y, bz.c2x, bz.c2y, bz.p1x, bz.p1y);
    ctx.stroke();

    // 内部ガラスハイライト／エネルギー脈動ライン
    ctx.strokeStyle = hexToRgba(res.secondaryColor || res.color, 0.42);
    ctx.lineWidth = Math.max(1, width * 0.32);
    ctx.setLineDash(link.resource === 'power' ? [6, 6] : [14, 10]);
    ctx.lineDashOffset = -this._time * (link.resource === 'power' ? 68 : 34);
    ctx.beginPath();
    ctx.moveTo(bz.p0x, bz.p0y);
    ctx.bezierCurveTo(bz.c1x, bz.c1y, bz.c2x, bz.c2y, bz.p1x, bz.p1y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.restore();
  };

  EncyclopediaPreview.prototype._drawBottleneckPipe = function (ctx, link) {
    var bz = link.bz;
    var res = link.resDef;
    var baseW = clamp((res.pipeWidth || 4.0) * 0.9, 3.2, 5.5);
    var segs = 26;
    var pulse = 0.5 + 0.5 * Math.sin(link.bulgePhase);

    ctx.save();
    ctx.lineCap = 'round';

    // 区間ごとに物理的膨張幅を変化させて赤い脈動ボトルネックを描画
    for (var s = 0; s < segs; s += 1) {
      var t0 = s / segs;
      var t1 = (s + 1) / segs;
      var tm = (t0 + t1) * 0.5;
      var p0 = cubicPointAt(bz.p0x, bz.p0y, bz.c1x, bz.c1y, bz.c2x, bz.c2y, bz.p1x, bz.p1y, t0);
      var p1 = cubicPointAt(bz.p0x, bz.p0y, bz.c1x, bz.c1y, bz.c2x, bz.c2y, bz.p1x, bz.p1y, t1);

      // 後半 (tm > 0.35) がぷっくり膨張し赤く脈動
      var bulgeFactor = clamp((tm - 0.32) / 0.68, 0, 1);
      var wave = Math.sin(tm * Math.PI) * (0.65 + pulse * 0.55);
      var extraW = bulgeFactor * (5.2 + wave * 4.4);
      var segW = baseW + extraW;

      var isAlertZone = tm > 0.38;
      ctx.strokeStyle = isAlertZone
        ? 'rgba(255, ' + Math.round(52 + (1 - bulgeFactor) * 40) + ', 92, ' + (0.65 + pulse * 0.3) + ')'
        : (res.pipeBorderColor || '#b848b8');
      ctx.lineWidth = segW + 2.2;
      ctx.shadowColor = isAlertZone ? 'rgba(255, 58, 94, 0.85)' : 'rgba(255, 79, 216, 0.4)';
      ctx.shadowBlur = isAlertZone ? 10 : 4;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.strokeStyle = isAlertZone ? '#5e1424' : (res.pipeColor || '#541a52');
      ctx.lineWidth = segW;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }

    // 膨張箇所の警告ラベルピル
    var warnPt = cubicPointAt(bz.p0x, bz.p0y, bz.c1x, bz.c1y, bz.c2x, bz.c2y, bz.p1x, bz.p1y, 0.72);
    var labelY = warnPt.y - 16;
    ctx.fillStyle = 'rgba(130, 16, 38, 0.92)';
    ctx.strokeStyle = '#ff5978';
    ctx.lineWidth = 1;
    roundRectPath(ctx, warnPt.x - 24, labelY - 7, 48, 14, 4);
    ctx.fill();
    ctx.stroke();

    ctx.font = '700 8.5px ' + getFontFamily();
    ctx.fillStyle = '#ffe5ea';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('詰まり膨張', warnPt.x, labelY);

    ctx.restore();
  };

  EncyclopediaPreview.prototype._drawLinkParticles = function (ctx, link) {
    var bz = link.bz;
    var res = link.resDef;

    for (var pi = 0; pi < link.particles.length; pi += 1) {
      var p = link.particles[pi];
      var pt = cubicPointAt(bz.p0x, bz.p0y, bz.c1x, bz.c1y, bz.c2x, bz.c2y, bz.p1x, bz.p1y, p.t);
      var tan = cubicTangentAt(bz.p0x, bz.p0y, bz.c1x, bz.c1y, bz.c2x, bz.c2y, bz.p1x, bz.p1y, p.t);
      var ang = Math.atan2(tan.y, tan.x);
      var radius = clamp((res.particleRadius || 4.8) * 0.85, 3.2, 5.4);

      ctx.save();
      ctx.translate(pt.x, pt.y);

      if (res.particleShape === 'bolt') {
        // 電力：黄色い稲妻状パルス
        ctx.rotate(ang);
        ctx.shadowColor = res.color;
        ctx.shadowBlur = 11;
        ctx.strokeStyle = res.color;
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(-7, 0);
        ctx.lineTo(-2, -3.2);
        ctx.lineTo(1, 3.2);
        ctx.lineTo(6, -1);
        ctx.stroke();

        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else if (res.particleShape === 'diamond') {
        // 精製データ：マゼンタ〜シアンひし形粒
        ctx.rotate(ang);
        ctx.shadowColor = res.color;
        ctx.shadowBlur = 10;
        var g = ctx.createLinearGradient(-radius, 0, radius, 0);
        g.addColorStop(0, res.secondaryColor || '#00f0ff');
        g.addColorStop(1, res.color);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(radius + 1.5, 0);
        ctx.lineTo(0, radius * 0.72);
        ctx.lineTo(-radius - 1.5, 0);
        ctx.lineTo(0, -radius * 0.72);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, 1.5, 0, Math.PI * 2);
        ctx.fill();
      } else if (res.particleShape === 'crystal') {
        // 高純度データ：黄金〜マゼンタ高速結晶粒
        ctx.rotate(ang);
        ctx.shadowColor = '#ffb830';
        ctx.shadowBlur = 13;
        // 残像テール
        ctx.strokeStyle = 'rgba(255, 184, 48, 0.55)';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(-11, 0);
        ctx.lineTo(-2, 0);
        ctx.stroke();

        var cg = ctx.createLinearGradient(-radius, -radius, radius, radius);
        cg.addColorStop(0, '#fff7cc');
        cg.addColorStop(0.55, '#ffb830');
        cg.addColorStop(1, '#ff55d8');
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.moveTo(radius + 2.5, 0);
        ctx.lineTo(1, radius * 0.8);
        ctx.lineTo(-radius - 1, 0);
        ctx.lineTo(1, -radius * 0.8);
        ctx.closePath();
        ctx.fill();
      } else if (res.particleShape === 'snowflake') {
        // 高純度冷却液：氷青〜白銀結晶粒
        ctx.rotate(this._time * 2.2 + p.jitterSeed);
        ctx.shadowColor = '#7afcff';
        ctx.shadowBlur = 10;
        ctx.strokeStyle = '#e8ffff';
        ctx.lineWidth = 1.4;
        for (var sp = 0; sp < 3; sp += 1) {
          var a = (sp * Math.PI) / 3;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * radius, Math.sin(a) * radius);
          ctx.lineTo(-Math.cos(a) * radius, -Math.sin(a) * radius);
          ctx.stroke();
        }
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, 1.8, 0, Math.PI * 2);
        ctx.fill();
      } else if (res.particleShape === 'droplet' || res.particleShape === 'steam_drop') {
        // 深層水／温排水：流体粒
        ctx.rotate(ang);
        ctx.shadowColor = res.color;
        ctx.shadowBlur = 9;
        var fg = ctx.createRadialGradient(-1, -1, 0.5, 0, 0, radius + 1);
        fg.addColorStop(0, res.coreColor || '#ffffff');
        fg.addColorStop(0.6, res.color);
        fg.addColorStop(1, res.secondaryColor || res.color);
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.ellipse(0, 0, radius + 1.2, radius * 0.78, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // 生データ等：シアンネオン粒
        ctx.shadowColor = res.color;
        ctx.shadowBlur = 10;
        var og = ctx.createRadialGradient(0, 0, 0.5, 0, 0, radius);
        og.addColorStop(0, '#ffffff');
        og.addColorStop(0.55, res.color);
        og.addColorStop(1, hexToRgba(res.color, 0.2));
        ctx.fillStyle = og;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  };

  EncyclopediaPreview.prototype._drawNodes = function (ctx) {
    var partsMap = (global.ABYSS_DATA && global.ABYSS_DATA.PARTS_MAP) || {};

    for (var ni = 0; ni < this._simNodeList.length; ni += 1) {
      var node = this._simNodeList[ni];
      var partDef = partsMap[node.partId];
      var theme = (partDef && partDef.theme) || {
        accent: '#00f0ff',
        bg: '#0c2033',
        border: '#1fa9c7',
        glow: 'rgba(0, 240, 255, 0.34)'
      };

      ctx.save();

      // フォーカスノードの強調オーラ
      if (node.isFocus) {
        var focusPulse = 0.5 + 0.5 * Math.sin(this._time * 3.4);
        roundRectPath(ctx, node.x - 3, node.y - 3, node.w + 6, node.h + 6, 10);
        ctx.strokeStyle = hexToRgba('#ffd84d', 0.35 + focusPulse * 0.45);
        ctx.lineWidth = 1.5;
        ctx.shadowColor = hexToRgba(theme.accent, 0.65);
        ctx.shadowBlur = 12;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // ノード外枠（多層ダークメタリックグラデーション）
      roundRectPath(ctx, node.x, node.y, node.w, node.h, 8);
      var bodyGrad = ctx.createLinearGradient(node.x, node.y, node.x, node.y + node.h);
      bodyGrad.addColorStop(0, '#142a46');
      bodyGrad.addColorStop(0.45, theme.bg || '#0c2033');
      bodyGrad.addColorStop(1, '#061120');
      ctx.fillStyle = bodyGrad;
      ctx.shadowColor = 'rgba(0, 4, 14, 0.78)';
      ctx.shadowBlur = 10;
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.strokeStyle = node.isFocus ? theme.accent : (theme.border || '#2e9ec9');
      ctx.lineWidth = node.isFocus ? 1.6 : 1.15;
      ctx.stroke();

      // 上部ヘッダープレート
      ctx.save();
      roundRectPath(ctx, node.x, node.y, node.w, node.h, 8);
      ctx.clip();
      var hdrGrad = ctx.createLinearGradient(node.x, node.y, node.x, node.y + 17);
      hdrGrad.addColorStop(0, 'rgba(26, 62, 102, 0.92)');
      hdrGrad.addColorStop(1, 'rgba(9, 26, 48, 0.92)');
      ctx.fillStyle = hdrGrad;
      ctx.fillRect(node.x, node.y, node.w, 17);

      ctx.strokeStyle = hexToRgba(theme.accent, 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(node.x, node.y + 17.5);
      ctx.lineTo(node.x + node.w, node.y + 17.5);
      ctx.stroke();
      ctx.restore();

      // 4隅の真鍮リベット
      var rivets = [
        [node.x + 5, node.y + 5],
        [node.x + node.w - 5, node.y + 5],
        [node.x + 5, node.y + node.h - 5],
        [node.x + node.w - 5, node.y + node.h - 5]
      ];
      for (var r = 0; r < rivets.length; r += 1) {
        ctx.fillStyle = '#d8a648';
        ctx.beginPath();
        ctx.arc(rivets[r][0], rivets[r][1], 1.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // ノード日本語ラベル
      ctx.font = '700 9.2px ' + getFontFamily();
      ctx.fillStyle = '#eaf7ff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(node.label, node.x + node.w * 0.5, node.y + 9.2, node.w - 16);

      // パーツ別内部アニメーション描画領域 (y + 18 〜 y + h - 4)
      this._drawNodeGimmick(ctx, node);

      // 入出力ポート端子
      this._drawNodePorts(ctx, node);

      ctx.restore();
    }
  };

  EncyclopediaPreview.prototype._drawNodeGimmick = function (ctx, node) {
    var ix = node.x + 7;
    var iy = node.y + 20;
    var iw = node.w - 14;
    var ih = node.h - 25;
    var cx = ix + iw * 0.5;
    var cy = iy + ih * 0.5;

    if (node.partId === 'emergency_battery') {
      // 非常用バッテリー：蓄電セルゲージ＆稲妻コア
      var cellCount = 4;
      var cellW = (iw - 14) / cellCount;
      var chargePhase = (this._time * 2.2) % (cellCount + 1);
      var cellH = Math.max(10, ih - 18);
      for (var c = 0; c < cellCount; c += 1) {
        var bx = ix + 7 + c * cellW;
        var active = c < Math.floor(chargePhase) + 1;
        ctx.fillStyle = active ? '#ffd84d' : 'rgba(255, 216, 77, 0.16)';
        if (active) {
          ctx.shadowColor = '#ffd84d';
          ctx.shadowBlur = 7;
        }
        roundRectPath(ctx, bx + 1.5, iy + 4, cellW - 3, cellH, 2.5);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.font = '700 8px ' + getMonoFontFamily();
      ctx.fillStyle = '#fff2a8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AUTO 12MW', cx, iy + ih - 5);
    } else if (node.partId === 'submarine_cable') {
      // 海底光ケーブル：シアン信号オシロスコープ波形
      ctx.fillStyle = 'rgba(2, 14, 28, 0.85)';
      ctx.strokeStyle = 'rgba(0, 240, 255, 0.35)';
      ctx.lineWidth = 1;
      roundRectPath(ctx, ix + 2, iy + 3, iw - 4, ih - 8, 4);
      ctx.fill();
      ctx.stroke();

      ctx.save();
      ctx.strokeStyle = '#00f0ff';
      ctx.lineWidth = 1.6;
      ctx.shadowColor = '#00f0ff';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      var steps = 22;
      for (var s = 0; s <= steps; s += 1) {
        var sx = ix + 5 + ((iw - 10) * s) / steps;
        var sy =
          cy -
          1 +
          Math.sin(this._time * 7.5 + s * 0.55) * (ih * 0.22) * (0.6 + node.activityPulse * 0.4);
        if (s === 0) {
          ctx.moveTo(sx, sy);
        } else {
          ctx.lineTo(sx, sy);
        }
      }
      ctx.stroke();
      ctx.restore();
    } else if (node.partId === 'generic_module') {
      // 汎用モジュール：モードバッジ＋回転コア＋温度表示（コンパクトサイズでも非重複）
      var isFilter = node.mode === 'filter';
      var isPrecision = !isFilter && node.precision >= 65;
      var isSpeed = !isFilter && node.precision < 35;
      var isCompact = ih < 46;

      // モードバッジ
      var badgeText = isFilter ? 'FILTER' : isPrecision ? '精度圧縮' : isSpeed ? '速度重視' : 'DATA';
      var badgeColor = isFilter ? '#3df5b4' : isPrecision ? '#ffb830' : '#ff4fd8';
      var badgeH = isCompact ? 11 : 13;
      ctx.fillStyle = hexToRgba(badgeColor, 0.2);
      ctx.strokeStyle = hexToRgba(badgeColor, 0.85);
      ctx.lineWidth = 1;
      roundRectPath(ctx, ix + 2, iy + 1, iw * 0.56, badgeH, 3);
      ctx.fill();
      ctx.stroke();

      ctx.font = '700 ' + (isCompact ? '7.5' : '8') + 'px ' + getFontFamily();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(badgeText, ix + 2 + iw * 0.28, iy + 1 + badgeH * 0.52);

      // 温度数値表示（右上）
      var tempInt = Math.round(node.heat);
      var isHot = tempInt >= 75;
      var isCooled = node.coolTimer > 0;
      ctx.font = '700 8.5px ' + getMonoFontFamily();
      ctx.fillStyle = isHot ? '#ff647f' : isCooled ? '#7afcff' : '#b7e8ff';
      ctx.textAlign = 'right';
      ctx.fillText(tempInt + '℃', ix + iw - 2, iy + 1 + badgeH * 0.52);

      // 回転演算／濾過リング（バッジと温度バーの中間領域にフィット）
      var barY = iy + ih - 6.5;
      var ringSpaceTop = iy + badgeH + 3;
      var ringSpaceBottom = isCooled ? barY - 9 : barY - 2;
      var coreY = (ringSpaceTop + ringSpaceBottom) * 0.5;
      var ringR = clamp((ringSpaceBottom - ringSpaceTop) * 0.36, 5.5, 10.5);

      ctx.save();
      ctx.translate(cx, coreY);
      if (isCooled) {
        // 冷却オーラリング
        ctx.strokeStyle = 'rgba(122, 252, 255, 0.65)';
        ctx.lineWidth = 1.5;
        ctx.shadowColor = '#7afcff';
        ctx.shadowBlur = 9;
        ctx.beginPath();
        ctx.arc(0, 0, ringR + 3.2, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.rotate(node.spinAngle);
      ctx.strokeStyle = badgeColor;
      ctx.lineWidth = 1.9;
      ctx.setLineDash([5, 3.5]);
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      if (isFilter) {
        // 物理濾過モード：内部に氷青の濾過十字羽根
        ctx.strokeStyle = '#c8ffff';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(-ringR * 0.65, 0);
        ctx.lineTo(ringR * 0.65, 0);
        ctx.moveTo(0, -ringR * 0.65);
        ctx.lineTo(0, ringR * 0.65);
        ctx.stroke();
      }

      ctx.fillStyle = isHot ? '#ff5978' : badgeColor;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(2.6, ringR * 0.38), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 下部温度バー／冷却ブースト表示
      ctx.fillStyle = 'rgba(2, 10, 22, 0.9)';
      roundRectPath(ctx, ix + 3, barY, iw - 6, 4.5, 2);
      ctx.fill();

      var heatRatio = clamp((node.heat - 20) / 90, 0.08, 1);
      ctx.fillStyle = isHot ? '#ff3a5e' : isCooled ? '#7afcff' : '#00f0ff';
      roundRectPath(ctx, ix + 3, barY, (iw - 6) * heatRatio, 4.5, 2);
      ctx.fill();

      if (isCooled) {
        ctx.font = '700 7.5px ' + getMonoFontFamily();
        ctx.fillStyle = '#a8ffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('COOL 120%', cx, barY - 4.5);
      }
    } else if (node.partId === 'surface_uplink') {
      // 地上アップリンク：パラボラ皿＋海上送信ビーム波
      var dishX = cx;
      var dishY = iy + ih * 0.64;

      // 上空への通信レーザー柱
      if (node.uplinkFlash > 0.05) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        var beamG = ctx.createLinearGradient(dishX, node.y, dishX, 4);
        beamG.addColorStop(0, hexToRgba('#2ef2a4', node.uplinkFlash * 0.72));
        beamG.addColorStop(1, 'rgba(0, 240, 255, 0)');
        ctx.fillStyle = beamG;
        ctx.fillRect(dishX - 4, 4, 8, node.y - 4);
        ctx.restore();
      }

      // パラボラ皿シルエット＆焦点レシーバー
      ctx.strokeStyle = '#7bf5cb';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(dishX, dishY - 7, 13, Math.PI * 0.18, Math.PI * 0.82);
      ctx.stroke();

      ctx.strokeStyle = '#d8a648';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(dishX, dishY + 7);
      ctx.lineTo(dishX, dishY - 6);
      ctx.stroke();

      ctx.fillStyle = '#00f0ff';
      ctx.shadowColor = '#00f0ff';
      ctx.shadowBlur = 7;
      ctx.beginPath();
      ctx.arc(dishX, dishY - 7, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // 送信リング波紋
      var wave = (this._time * 1.4) % 1;
      ctx.strokeStyle = hexToRgba('#2ef2a4', (1 - wave) * 0.85);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(dishX, dishY - 9, 4 + wave * 12, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    } else if (node.partId === 'deep_water_intake') {
      // 深層水インテーク：水タンク揺れ表現＋インペラ
      var tkX = ix + 4;
      var tkY = iy + 3;
      var tkW = iw - 8;
      var tkH = ih - 6;

      ctx.save();
      roundRectPath(ctx, tkX, tkY, tkW, tkH, 4);
      ctx.fillStyle = 'rgba(4, 18, 34, 0.88)';
      ctx.fill();
      ctx.clip();

      // 揺れる水面
      var waterTop = tkY + tkH * 0.36;
      ctx.fillStyle = 'rgba(56, 214, 255, 0.45)';
      ctx.beginPath();
      ctx.moveTo(tkX, tkY + tkH);
      for (var wx = 0; wx <= tkW; wx += 4) {
        var wy = waterTop + Math.sin(this._time * 4.5 + wx * 0.16) * 2.4;
        ctx.lineTo(tkX + wx, wy);
      }
      ctx.lineTo(tkX + tkW, tkY + tkH);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = '#aef4ff';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (var wx2 = 0; wx2 <= tkW; wx2 += 4) {
        var wy2 = waterTop + Math.sin(this._time * 4.5 + wx2 * 0.16) * 2.4;
        if (wx2 === 0) {
          ctx.moveTo(tkX + wx2, wy2);
        } else {
          ctx.lineTo(tkX + wx2, wy2);
        }
      }
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = 'rgba(56, 214, 255, 0.55)';
      ctx.lineWidth = 1;
      roundRectPath(ctx, tkX, tkY, tkW, tkH, 4);
      ctx.stroke();
    } else if (node.partId === 'drain_vent') {
      // 排水ベント：耐熱排気スリット＆排気圧インジケータ
      for (var sl = 0; sl < 3; sl += 1) {
        var sy = iy + 7 + sl * 9;
        ctx.fillStyle = 'rgba(255, 118, 60, ' + (0.45 + 0.3 * Math.sin(this._time * 5 + sl)) + ')';
        roundRectPath(ctx, ix + 8, sy, iw - 16, 4.5, 2);
        ctx.fill();
      }
    } else if (node.partId === 'hydrothermal_turbine') {
      // 熱水タービン：高速回転する真鍮タービン羽根＋発電ゲージ
      var r = Math.min(iw, ih) * 0.34;
      ctx.save();
      ctx.translate(cx - 8, cy);

      // タービン外輪
      ctx.strokeStyle = '#ff9436';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, r + 3, 0, Math.PI * 2);
      ctx.stroke();

      // 回転羽根（6枚）
      ctx.rotate(node.spinAngle);
      for (var bl = 0; bl < 6; bl += 1) {
        ctx.rotate(Math.PI / 3);
        ctx.fillStyle = bl % 2 === 0 ? '#ffd84d' : '#f29f38';
        ctx.beginPath();
        ctx.moveTo(0, -1.5);
        ctx.quadraticCurveTo(r * 0.6, -5.5, r, -1.5);
        ctx.lineTo(r, 1.5);
        ctx.quadraticCurveTo(r * 0.6, -1.5, 0, 1.5);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = '#fff3bf';
      ctx.beginPath();
      ctx.arc(0, 0, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 右側出力ゲージ
      var gx = ix + iw - 14;
      var gh = ih - 12;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      roundRectPath(ctx, gx, iy + 6, 8, gh, 2);
      ctx.fill();
      var fillRatio = clamp((node.spinSpeed - 2.0) / 8.5, 0.25, 1.0);
      ctx.fillStyle = '#ffd84d';
      roundRectPath(ctx, gx + 1, iy + 6 + gh * (1 - fillRatio), 6, gh * fillRatio, 1.5);
      ctx.fill();
    }
  };

  EncyclopediaPreview.prototype._drawNodePorts = function (ctx, node) {
    var allPorts = node.portsIn.concat(node.portsOut);
    for (var i = 0; i < allPorts.length; i += 1) {
      var pt = allPorts[i];
      ctx.save();
      ctx.fillStyle = '#071526';
      ctx.strokeStyle = '#d8a648';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = pt.color || '#00f0ff';
      ctx.shadowColor = pt.color || '#00f0ff';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };

  EncyclopediaPreview.prototype._drawVfxParticles = function (ctx) {
    for (var i = 0; i < this._vfxParticles.length; i += 1) {
      var vp = this._vfxParticles[i];
      var progress = vp.life / vp.maxLife;
      var alpha = clamp(1 - progress, 0, 1);

      ctx.save();
      if (vp.kind === 'text') {
        ctx.font = '800 10.5px ' + getMonoFontFamily();
        ctx.fillStyle = hexToRgba(vp.color, alpha);
        ctx.shadowColor = hexToRgba(vp.color, 0.7);
        ctx.shadowBlur = 6;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(vp.text, vp.x, vp.y);
      } else if (vp.kind === 'steam' || vp.kind === 'steam_bubble') {
        ctx.fillStyle = hexToRgba(vp.color, alpha * 0.48);
        ctx.strokeStyle = hexToRgba('#ffd7bd', alpha * 0.7);
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(vp.x, vp.y, vp.r + progress * 2.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (vp.kind === 'bubble') {
        ctx.fillStyle = hexToRgba('#b8f5ff', alpha * 0.3);
        ctx.strokeStyle = hexToRgba('#dffbff', alpha * 0.75);
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.arc(vp.x, vp.y, vp.r + progress * 1.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillStyle = hexToRgba(vp.color, alpha);
        ctx.shadowColor = vp.color;
        ctx.shadowBlur = 7;
        ctx.beginPath();
        ctx.arc(vp.x, vp.y, vp.r * (1 - progress * 0.4), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  };

  EncyclopediaPreview.prototype._drawForegroundOverlay = function (ctx) {
    // 計器モニター風の薄い水平スキャンラインと外周ビネット
    ctx.save();
    ctx.fillStyle = 'rgba(0, 240, 255, 0.022)';
    for (var y = 0; y < ENC_HEIGHT; y += 4) {
      ctx.fillRect(0, y, ENC_WIDTH, 1);
    }

    var vig = ctx.createRadialGradient(
      ENC_WIDTH * 0.5, ENC_HEIGHT * 0.5, ENC_WIDTH * 0.25,
      ENC_WIDTH * 0.5, ENC_HEIGHT * 0.5, ENC_WIDTH * 0.65
    );
    vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vig.addColorStop(1, 'rgba(1, 5, 14, 0.34)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, ENC_WIDTH, ENC_HEIGHT);
    ctx.restore();
  };

  // =========================================================================
  // グローバル公開
  // =========================================================================
  global.BoogieController = BoogieController;
  global.EncyclopediaPreview = EncyclopediaPreview;
})(window);
