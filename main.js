/**
 * ABYSS CORE（アビス・コア）Phase 1 ― メインゲームエンジン（main.js）
 * 公開グローバル契約: window.AbyssGame
 *
 * 第1工程：コア物理・配線グラフ・熱冷却・ボトルネック・整頓ボーナス・
 *          チュートリアル・オートセーブエンジン層（core-logic-engineer 実装）
 *
 * 注意：次工程で vfx-ui-artist が下部の RENDER & UI LAYER に高精細Canvas描画と
 *       DOM操作統合を実装するため、状態モデル・公開API・幾何関数の契約を厳密に保持する。
 */
(function (global) {
  'use strict';

  var DATA = global.ABYSS_DATA;
  if (!DATA) {
    throw new Error('ABYSS_DATA が読み込まれていません。data.js を先に読み込んでください。');
  }

  var CONFIG = DATA.CONFIG;
  var RESOURCES = DATA.RESOURCES;
  var PARTS = DATA.PARTS;
  var PARTS_MAP = DATA.PARTS_MAP;
  var INITIAL_LAYOUT = DATA.INITIAL_LAYOUT;
  var TUTORIAL_STEPS = DATA.TUTORIAL_STEPS;
  var ENCYCLOPEDIA = DATA.ENCYCLOPEDIA;
  var BOOGIE_QUIPS = DATA.BOOGIE_QUIPS;

  var MAX_DT = 0.05;
  var SAVE_SCHEMA_VERSION = 1;
  var OVERHEAT_HYSTERESIS_DELTA = 6;
  var INCOME_WINDOW_SEC = 4.0;
  var MAX_FX_EVENTS = 160;
  var NODE_CLEARANCE = 12;

  // =========================================================================
  // 1. 汎用数値安全・オーディオ・ストレージユーティリティ
  // =========================================================================

  function clamp(value, min, max) {
    var num = Number(value);
    if (!Number.isFinite(num)) {
      return min;
    }
    if (num < min) {
      return min;
    }
    if (num > max) {
      return max;
    }
    return num;
  }

  function lerp(a, b, t) {
    var clampedT = clamp(t, 0, 1);
    return a + (b - a) * clampedT;
  }

  function roundMoney(amount) {
    var num = Number(amount);
    if (!Number.isFinite(num)) {
      return 0;
    }
    return Math.round(num * 100) / 100;
  }

  function safeAudio(methodName) {
    var audio = global.AbyssAudio;
    if (!audio || typeof audio[methodName] !== 'function') {
      return undefined;
    }
    var args = [];
    for (var i = 1; i < arguments.length; i += 1) {
      args.push(arguments[i]);
    }
    try {
      return audio[methodName].apply(audio, args);
    } catch (_) {
      return undefined;
    }
  }

  function getSafeStorage() {
    try {
      if (global.localStorage && typeof global.localStorage.getItem === 'function') {
        return global.localStorage;
      }
    } catch (_) {
      // ストレージ利用不可環境では null を返しフォールバックする
    }
    return null;
  }

  function pickQuip(list, seedIndex) {
    if (!Array.isArray(list) || list.length === 0) {
      return null;
    }
    var idx = typeof seedIndex === 'number'
      ? Math.abs(Math.floor(seedIndex)) % list.length
      : Math.floor(Math.random() * list.length);
    return list[idx];
  }

  // =========================================================================
  // 2. 状態モデル定義（window.AbyssGame.state）
  // =========================================================================

  function createEmptyState() {
    return {
      funds: CONFIG.INITIAL_FUNDS,
      totalEarned: 0,
      tutorialStep: 1,
      unlockedParts: TUTORIAL_STEPS[0].unlocks.slice(),
      grantedSteps: [1],
      cableMode: CONFIG.DEFAULT_CABLE_STYLE,
      muted: false,
      guideLaserEnabled: true,
      activeEncyclopediaGuidePartId: null,
      selectedNodeId: null,
      nodes: [],
      connections: [],
      packets: [],
      fxEvents: [],
      isTidySync: false,
      tidyStats: {
        linkCount: 0,
        crossingCount: 0,
        nodeOverlapCount: 0,
        alignmentScore: 1,
        backwardLinks: 0,
        isTidy: false,
        reason: '配線が2本未満です'
      },
      incomeRate: 0,
      powerMetrics: {
        totalGeneration: 0,
        batteryMW: 0,
        turbineMW: 0,
        activeConsumers: 0,
        poweredConsumers: 0,
        activePowerLinks: 0,
        satisfactionRatio: 1
      },
      maxHeat: CONFIG.BASE_TEMP,
      simTime: 0,
      viewport: {
        width: INITIAL_LAYOUT.referenceViewport.width,
        height: INITIAL_LAYOUT.referenceViewport.height
      },
      boogieMood: TUTORIAL_STEPS[0].mood || 'curious',
      boogieMessage: TUTORIAL_STEPS[0].message || '',
      boogieOverrideMessage: null,
      checklistStatus: {},
      guideLinks: [],
      tutorialFlags: {
        bottleneckObserved: false,
        highPurityDelivered: false,
        cooledObserved: false,
        overheatObserved: false,
        turbineStarted: false,
        filterProduced: false,
        tidyNotified: false
      },
      uplinkHistory: [],
      nextIdSeq: 1,
      lastSaveAt: 0,
      autosaveAccumulatorSec: 0,
      isDirty: false
    };
  }

  var state = createEmptyState();

  var runtime = {
    initialized: false,
    running: false,
    rafId: null,
    lastFrameMs: 0,
    wireCache: {},
    boogieController: null,
    encyclopediaPreview: null,
    uiRefs: {}
  };

  function generateId(prefix) {
    var id = prefix + '_' + state.nextIdSeq;
    state.nextIdSeq += 1;
    return id;
  }

  function syncNextIdSeq() {
    var maxNum = 0;
    function scanId(idStr) {
      if (typeof idStr !== 'string') {
        return;
      }
      var match = idStr.match(/_(\d+)$/);
      if (match) {
        var n = parseInt(match[1], 10);
        if (Number.isFinite(n) && n > maxNum) {
          maxNum = n;
        }
      }
    }
    for (var i = 0; i < state.nodes.length; i += 1) {
      scanId(state.nodes[i].id);
    }
    for (var j = 0; j < state.connections.length; j += 1) {
      scanId(state.connections[j].id);
    }
    for (var k = 0; k < state.packets.length; k += 1) {
      scanId(state.packets[k].id);
    }
    if (state.nextIdSeq <= maxNum) {
      state.nextIdSeq = maxNum + 1;
    }
  }

  function pushFxEvent(evt) {
    if (!evt || typeof evt !== 'object') {
      return;
    }
    var item = Object.assign({
      id: generateId('fx'),
      simTime: state.simTime
    }, evt);
    state.fxEvents.push(item);
    if (state.fxEvents.length > MAX_FX_EVENTS) {
      state.fxEvents.splice(0, state.fxEvents.length - MAX_FX_EVENTS);
    }
  }

  function consumeFxEvents() {
    var list = state.fxEvents.slice();
    state.fxEvents.length = 0;
    return list;
  }

  function setBoogieOverride(text, mood, durationSec) {
    if (!text) {
      return;
    }
    state.boogieOverrideMessage = {
      text: String(text),
      mood: mood || 'happy',
      untilSimTime: state.simTime + (durationSec || 5.5)
    };
    state.boogieMessage = String(text);
    state.boogieMood = mood || 'happy';
    if (runtime.boogieController) {
      if (typeof runtime.boogieController.setExpression === 'function') {
        runtime.boogieController.setExpression(state.boogieMood);
      }
      if (typeof runtime.boogieController.triggerTalk === 'function') {
        runtime.boogieController.triggerTalk(1800);
      }
    }
  }

  // =========================================================================
  // 3. ビューポート安全領域・スケーリング・クランプ
  // =========================================================================

  function getSafePlayArea(viewportWidth, viewportHeight) {
    var vw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : state.viewport.width;
    var vh = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : state.viewport.height;
    vw = Math.max(640, vw);
    vh = Math.max(460, vh);

    var left = CONFIG.SAFE_MARGIN_SIDE;
    var top = CONFIG.SAFE_MARGIN_TOP;
    var right = Math.max(left + 360, vw - CONFIG.SAFE_MARGIN_SIDE);
    var bottom = Math.max(top + 240, vh - CONFIG.SAFE_MARGIN_BOTTOM);

    // 右下ブギー通信ドック占有領域（右下隅からの除外ゾーン）
    var boogieWidth = clamp(Math.round(vw * 0.285), 280, 376);
    var boogieHeight = clamp(Math.round(vh * 0.44), 240, 356);
    var boogieRect = {
      left: vw - boogieWidth - 12,
      top: vh - boogieHeight - 12,
      right: vw,
      bottom: vh
    };

    return {
      viewportWidth: vw,
      viewportHeight: vh,
      left: left,
      top: top,
      right: right,
      bottom: bottom,
      width: right - left,
      height: bottom - top,
      boogieRect: boogieRect
    };
  }

  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh, padding) {
    var pad = padding || 0;
    return (
      ax < bx + bw + pad &&
      ax + aw + pad > bx &&
      ay < by + bh + pad &&
      ay + ah + pad > by
    );
  }

  function getOverlappingNode(x, y, width, height, excludeNodeId, clearance) {
    var pad = Number.isFinite(clearance) ? clearance : NODE_CLEARANCE;
    for (var i = 0; i < state.nodes.length; i += 1) {
      var n = state.nodes[i];
      if (excludeNodeId && n.id === excludeNodeId) {
        continue;
      }
      if (rectsOverlap(x, y, width, height, n.x, n.y, n.width, n.height, pad)) {
        return n;
      }
    }
    return null;
  }

  function hasNodeOverlap(x, y, width, height, excludeNodeId, clearance) {
    return getOverlappingNode(x, y, width, height, excludeNodeId, clearance) !== null;
  }

  function clampNodePosition(x, y, width, height, viewport) {
    var vw = viewport && viewport.width ? viewport.width : state.viewport.width;
    var vh = viewport && viewport.height ? viewport.height : state.viewport.height;
    var area = getSafePlayArea(vw, vh);

    var w = Number.isFinite(width) && width > 0 ? width : 160;
    var h = Number.isFinite(height) && height > 0 ? height : 100;

    var minX = area.left;
    var maxX = Math.max(minX, area.right - w);
    var minY = area.top;
    var maxY = Math.max(minY, area.bottom - h);

    var nx = clamp(x, minX, maxX);
    var ny = clamp(y, minY, maxY);

    // 右下ブギーパネルとの重なり回避
    var br = area.boogieRect;
    var bw = br.right - br.left;
    var bh = br.bottom - br.top;
    if (rectsOverlap(nx, ny, w, h, br.left, br.top, bw, bh, 8)) {
      var candidateUpY = br.top - h - 10;
      var candidateLeftX = br.left - w - 12;
      if (candidateUpY >= minY) {
        ny = candidateUpY;
      } else if (candidateLeftX >= minX) {
        nx = candidateLeftX;
      } else {
        ny = clamp(candidateUpY, minY, maxY);
      }
    }

    return {
      x: Math.round(nx),
      y: Math.round(ny)
    };
  }

  function overlapsPlacedList(x, y, width, height, placedNodes, clearance) {
    var pad = Number.isFinite(clearance) ? clearance : NODE_CLEARANCE;
    for (var i = 0; i < placedNodes.length; i += 1) {
      var p = placedNodes[i];
      if (rectsOverlap(x, y, width, height, p.x, p.y, p.width, p.height, pad)) {
        return p;
      }
    }
    return null;
  }

  function resolveViewportNodePosition(targetX, targetY, width, height, placedNodes, viewport) {
    var vp = viewport || state.viewport;
    var w = Number.isFinite(width) && width > 0 ? width : 160;
    var h = Number.isFinite(height) && height > 0 ? height : 100;
    var base = clampNodePosition(targetX, targetY, w, h, vp);

    if (!overlapsPlacedList(base.x, base.y, w, h, placedNodes, NODE_CLEARANCE)) {
      return { x: base.x, y: base.y, relocated: false };
    }

    var area = getSafePlayArea(vp.width, vp.height);
    var minX = area.left;
    var maxX = Math.max(minX, area.right - w);
    var minY = area.top;
    var maxY = Math.max(minY, area.bottom - h);
    var pad = NODE_CLEARANCE;

    var best = null;
    var bestScore = Infinity;
    var bestEuclid = Infinity;
    var seen = {};

    function tryCandidate(rawX, rawY) {
      var c = clampNodePosition(rawX, rawY, w, h, vp);
      var key = c.x + ',' + c.y;
      if (seen[key]) {
        return;
      }
      seen[key] = true;
      if (overlapsPlacedList(c.x, c.y, w, h, placedNodes, pad)) {
        return;
      }
      var euclid = Math.hypot(c.x - base.x, c.y - base.y);
      var score = euclid + Math.hypot(c.x - targetX, c.y - targetY) * 0.15;
      if (score < bestScore) {
        bestScore = score;
        bestEuclid = euclid;
        best = c;
      }
    }

    // 1. 衝突中ノードの上下左右外縁＋軸スライド候補を優先評価
    for (var p = 0; p < placedNodes.length; p += 1) {
      var hit = placedNodes[p];
      if (!rectsOverlap(base.x, base.y, w, h, hit.x, hit.y, hit.width, hit.height, pad)) {
        continue;
      }
      var ys = [base.y, targetY, hit.y, hit.y + (hit.height - h) * 0.5];
      var xs = [base.x, targetX, hit.x, hit.x + (hit.width - w) * 0.5];
      for (var yi = 0; yi < ys.length; yi += 1) {
        tryCandidate(hit.x - w - pad, ys[yi]);
        tryCandidate(hit.x + hit.width + pad, ys[yi]);
      }
      for (var xi = 0; xi < xs.length; xi += 1) {
        tryCandidate(xs[xi], hit.y - h - pad);
        tryCandidate(xs[xi], hit.y + hit.height + pad);
      }
    }

    // 2. 螺旋・同心矩形リング探索でクランプ済み最近傍の空き座標を探索
    var step = 24;
    var maxRadius = Math.max(area.width, area.height) + step;
    for (var r = step; r <= maxRadius; r += step) {
      for (var dx = -r; dx <= r; dx += step) {
        tryCandidate(base.x + dx, base.y - r);
        tryCandidate(base.x + dx, base.y + r);
      }
      for (var dy = -r + step; dy <= r - step; dy += step) {
        tryCandidate(base.x - r, base.y + dy);
        tryCandidate(base.x + r, base.y + dy);
      }
      if (best && r > bestEuclid + step) {
        break;
      }
    }

    // 3. 16px グリッド＋境界線上の網羅フォールバック
    if (!best) {
      var fineStep = 16;
      var yTicks = [];
      for (var gy = minY; gy < maxY; gy += fineStep) {
        yTicks.push(gy);
      }
      yTicks.push(maxY);
      var xTicks = [];
      for (var gx = minX; gx < maxX; gx += fineStep) {
        xTicks.push(gx);
      }
      xTicks.push(maxX);

      for (var ti = 0; ti < yTicks.length; ti += 1) {
        for (var tj = 0; tj < xTicks.length; tj += 1) {
          tryCandidate(xTicks[tj], yTicks[ti]);
        }
      }
    }

    if (best) {
      return {
        x: best.x,
        y: best.y,
        relocated: best.x !== base.x || best.y !== base.y,
        failed: false
      };
    }

    return {
      x: base.x,
      y: base.y,
      relocated: false,
      failed: true
    };
  }

  function packNodesInSafeArea(entries, viewport) {
    var vp = viewport || state.viewport;
    var area = getSafePlayArea(vp.width, vp.height);
    var pad = NODE_CLEARANCE;
    var ordered = entries.slice().sort(function (a, b) {
      if (b.node.height !== a.node.height) {
        return b.node.height - a.node.height;
      }
      if (a.srcY !== b.srcY) {
        return a.srcY - b.srcY;
      }
      return a.srcX - b.srcX;
    });

    var placedRects = [];
    var results = [];
    for (var i = 0; i < ordered.length; i += 1) {
      var item = ordered[i];
      var w = item.node.width;
      var h = item.node.height;
      var ys = [area.top];
      var xs = [area.left];
      for (var p = 0; p < placedRects.length; p += 1) {
        xs.push(placedRects[p].x + placedRects[p].width + pad);
        ys.push(placedRects[p].y + placedRects[p].height + pad);
      }
      ys.sort(function (u, v) { return u - v; });
      xs.sort(function (u, v) { return u - v; });

      var chosen = null;
      var chosenScore = Infinity;
      for (var yi = 0; yi < ys.length; yi += 1) {
        for (var xi = 0; xi < xs.length; xi += 1) {
          var cand = clampNodePosition(xs[xi], ys[yi], w, h, vp);
          if (overlapsPlacedList(cand.x, cand.y, w, h, placedRects, pad)) {
            continue;
          }
          // 上段・左詰めを優先しつつ元位置との距離が近いスロットを評価
          var score = cand.y * 10 + cand.x + Math.hypot(cand.x - item.srcX, cand.y - item.srcY) * 0.05;
          if (score < chosenScore) {
            chosenScore = score;
            chosen = cand;
          }
        }
      }

      if (!chosen) {
        return { ok: false, results: null };
      }
      var rect = { x: chosen.x, y: chosen.y, width: w, height: h };
      placedRects.push(rect);
      results.push({ node: item.node, x: chosen.x, y: chosen.y });
    }
    return { ok: true, results: results };
  }

  function resolveAllNodesInViewport(viewport, rawCoordsList) {
    var vp = viewport || state.viewport;
    if (!state.nodes || state.nodes.length === 0) {
      return;
    }

    var entries = [];
    for (var i = 0; i < state.nodes.length; i += 1) {
      var node = state.nodes[i];
      var srcX = rawCoordsList && rawCoordsList[i] ? rawCoordsList[i].x : node.x;
      var srcY = rawCoordsList && rawCoordsList[i] ? rawCoordsList[i].y : node.y;
      var clamped = clampNodePosition(srcX, srcY, node.width, node.height, vp);
      var movedDist = Math.hypot(clamped.x - srcX, clamped.y - srcY);
      entries.push({
        node: node,
        srcX: srcX,
        srcY: srcY,
        area: node.width * node.height,
        movedByClamp: movedDist > 0.5,
        movedDist: movedDist,
        index: i
      });
    }

    function trySettlementOrder(ordered) {
      var placedRects = [];
      var settled = [];
      var failedCount = 0;
      for (var k = 0; k < ordered.length; k += 1) {
        var it = ordered[k];
        var res = resolveViewportNodePosition(
          it.srcX,
          it.srcY,
          it.node.width,
          it.node.height,
          placedRects,
          vp
        );
        if (res.failed) {
          failedCount += 1;
        }
        placedRects.push({
          x: res.x,
          y: res.y,
          width: it.node.width,
          height: it.node.height
        });
        settled.push({ node: it.node, x: res.x, y: res.y });
      }
      return { failedCount: failedCount, settled: settled };
    }

    // Pass A: 安全域内に収まっている既存ノードを先に固定し、押し込まれたノードを移動量順に逃がす
    var orderA = entries.slice().sort(function (a, b) {
      if (a.movedByClamp !== b.movedByClamp) {
        return a.movedByClamp ? 1 : -1;
      }
      if (a.movedByClamp && Math.abs(a.movedDist - b.movedDist) > 1) {
        return a.movedDist - b.movedDist;
      }
      return a.index - b.index;
    });
    var attempt = trySettlementOrder(orderA);

    // Pass B: 断片化で大きいノードが置き場を失った場合は面積降順で再試行
    if (attempt.failedCount > 0) {
      var orderB = entries.slice().sort(function (a, b) {
        if (a.movedByClamp !== b.movedByClamp) {
          return a.movedByClamp ? 1 : -1;
        }
        if (b.area !== a.area) {
          return b.area - a.area;
        }
        return a.index - b.index;
      });
      var attemptB = trySettlementOrder(orderB);
      if (attemptB.failedCount < attempt.failedCount) {
        attempt = attemptB;
      }
    }

    // Pass C: 極小リサイズ等で局所退避が詰まった場合、安全域全体への高密度パッキングで非重複保証
    if (attempt.failedCount > 0) {
      var packed = packNodesInSafeArea(entries, vp);
      if (packed.ok && packed.results) {
        for (var p = 0; p < packed.results.length; p += 1) {
          packed.results[p].node.x = packed.results[p].x;
          packed.results[p].node.y = packed.results[p].y;
        }
        return;
      }
    }

    for (var j = 0; j < attempt.settled.length; j += 1) {
      attempt.settled[j].node.x = attempt.settled[j].x;
      attempt.settled[j].node.y = attempt.settled[j].y;
    }
  }

  // =========================================================================
  // 4. ノード生成・ハイブリッド設定・ポート座標
  // =========================================================================

  function createNodeInstance(partId, x, y, options) {
    var part = PARTS_MAP[partId];
    if (!part) {
      return null;
    }
    var opts = options || {};
    var clamped = clampNodePosition(x, y, part.width, part.height, state.viewport);

    var defaultMode = 'data';
    var defaultPrecision = 20;
    if (part.isHybrid && part.process && part.process.hybridConfig) {
      defaultMode = part.process.hybridConfig.defaultMode || 'data';
      defaultPrecision = part.process.hybridConfig.defaultPrecision !== undefined
        ? part.process.hybridConfig.defaultPrecision
        : 20;
    }

    var rawConfig = opts.config && typeof opts.config === 'object' ? opts.config : {};
    var mode = rawConfig.mode === 'filter' ? 'filter' : defaultMode;
    var precision = rawConfig.precision !== undefined
      ? clamp(Math.round(rawConfig.precision), 0, 100)
      : defaultPrecision;

    var node = {
      id: typeof opts.id === 'string' && opts.id.length > 0 ? opts.id : generateId('node'),
      partId: partId,
      x: clamped.x,
      y: clamped.y,
      width: part.width,
      height: part.height,
      isStarter: Boolean(opts.isStarter),
      allowDelete: opts.allowDelete !== undefined ? Boolean(opts.allowDelete) : true,
      config: part.isHybrid ? { mode: mode, precision: precision } : {},
      powerBuffer: Number.isFinite(opts.powerBuffer) ? clamp(opts.powerBuffer, 0, 20) : 0,
      inputBuffer: Number.isFinite(opts.inputBuffer) ? clamp(opts.inputBuffer, 0, 20) : 0,
      coolantItems: Array.isArray(opts.coolantItems) ? opts.coolantItems.slice(0, 6) : [],
      coolantBuffer: 0,
      coolCycleTimer: 0,
      processTimer: Number.isFinite(opts.processTimer) ? clamp(opts.processTimer, 0, 10) : 0,
      heat: Number.isFinite(opts.heat)
        ? clamp(opts.heat, CONFIG.BASE_TEMP, CONFIG.MAX_TEMP)
        : (part.heat && Number.isFinite(part.heat.baseHeat) ? part.heat.baseHeat : CONFIG.BASE_TEMP),
      coolBoostTimer: Number.isFinite(opts.coolBoostTimer) ? clamp(opts.coolBoostTimer, 0, 20) : 0,
      isCoolBoosted: false,
      isOverheated: Boolean(opts.isOverheated),
      status: 'idle',
      statusLabel: '待機中',
      efficiency: 1.0,
      effectiveInterval: part.process && part.process.processInterval ? part.process.processInterval : 1.0,
      lastOutputResource: null,
      producedCount: Number.isFinite(opts.producedCount) ? Math.max(0, opts.producedCount) : 0,
      // surface_uplink 専用
      queueItems: [],
      queueLoad: 0,
      beamTimer: 0,
      bottleneckRatio: 0,
      recentHighPurityTime: -999,
      // hydrothermal_turbine 専用
      pendingPowerOutputs: 0,
      turbineRpm: 0,
      turbineAngle: 0,
      hotWaterRecentRate: 0,
      // 表示補助
      activeFlashTimer: 0,
      lastActiveTime: -999
    };

    node.coolantBuffer = node.coolantItems.length;
    return node;
  }

  function findNode(nodeId) {
    for (var i = 0; i < state.nodes.length; i += 1) {
      if (state.nodes[i].id === nodeId) {
        return state.nodes[i];
      }
    }
    return null;
  }

  function findConnection(connId) {
    for (var i = 0; i < state.connections.length; i += 1) {
      if (state.connections[i].id === connId) {
        return state.connections[i];
      }
    }
    return null;
  }

  function getPortDef(partId, portId) {
    var part = PARTS_MAP[partId];
    if (!part || !part.ports) {
      return null;
    }
    var inputs = part.ports.inputs || [];
    for (var i = 0; i < inputs.length; i += 1) {
      if (inputs[i].id === portId) {
        return { dir: 'in', portDef: inputs[i] };
      }
    }
    var outputs = part.ports.outputs || [];
    for (var j = 0; j < outputs.length; j += 1) {
      if (outputs[j].id === portId) {
        return { dir: 'out', portDef: outputs[j] };
      }
    }
    return null;
  }

  function getPortPosition(nodeOrId, portId) {
    var node = typeof nodeOrId === 'string' ? findNode(nodeOrId) : nodeOrId;
    if (!node) {
      return null;
    }
    var found = getPortDef(node.partId, portId);
    if (!found) {
      return null;
    }
    var def = found.portDef;
    return {
      x: node.x + def.offset.x * node.width,
      y: node.y + def.offset.y * node.height,
      dir: found.dir,
      portDef: def
    };
  }

  function getModuleDataProfile(precision) {
    var genericPart = PARTS_MAP.generic_module;
    var bands = genericPart.process.hybridConfig.modes.data.sliderBands;
    var p = clamp(Math.round(precision === undefined ? 20 : precision), 0, 100);

    var band;
    var t;
    if (p <= bands.speed.max) {
      band = bands.speed;
      t = p / Math.max(1, bands.speed.max - bands.speed.min);
    } else if (p <= bands.balanced.max) {
      band = bands.balanced;
      t = (p - bands.balanced.min) / Math.max(1, bands.balanced.max - bands.balanced.min);
    } else {
      band = bands.precision;
      t = (p - bands.precision.min) / Math.max(1, bands.precision.max - bands.precision.min);
    }

    var processInterval = lerp(band.intervalStart, band.intervalEnd, t);
    var valueMultiplier = lerp(band.valueMultStart, band.valueMultEnd, t);
    var heatPerCycle = lerp(band.heatStart, band.heatEnd, t);
    var rawBase = RESOURCES.raw_data.baseValue;

    return {
      precision: p,
      bandId: band.id,
      bandLabel: band.label,
      outputResource: band.outputResource,
      processInterval: Math.round(processInterval * 1000) / 1000,
      valueMultiplier: Math.round(valueMultiplier * 100) / 100,
      unitValue: roundMoney(rawBase * valueMultiplier),
      bandwidthLoad: band.bandwidthLoad,
      heatPerCycle: Math.round(heatPerCycle * 100) / 100
    };
  }

  function getEffectiveOutputType(node, portId) {
    if (!node) {
      return null;
    }
    var found = getPortDef(node.partId, portId);
    if (!found || found.dir !== 'out') {
      return null;
    }
    if (node.partId === 'generic_module' && portId === 'out_main') {
      var mode = node.config && node.config.mode === 'filter' ? 'filter' : 'data';
      if (mode === 'filter') {
        return 'purified_coolant';
      }
      var prof = getModuleDataProfile(node.config ? node.config.precision : 20);
      return prof.outputResource;
    }
    return found.portDef.type;
  }

  function getEffectiveAcceptedTypes(node, portId) {
    if (!node) {
      return [];
    }
    var found = getPortDef(node.partId, portId);
    if (!found || found.dir !== 'in') {
      return [];
    }
    var def = found.portDef;
    if (def.acceptsByMode && node.config) {
      var mode = node.config.mode === 'filter' ? 'filter' : 'data';
      if (Array.isArray(def.acceptsByMode[mode])) {
        return def.acceptsByMode[mode].slice();
      }
    }
    return Array.isArray(def.accepts) ? def.accepts.slice() : [];
  }

  // =========================================================================
  // 5. 配線形状ポリライン生成（'bezier' & 'ortho'）
  // =========================================================================

  function computePolylineLength(points) {
    var total = 0;
    for (var i = 1; i < points.length; i += 1) {
      var dx = points[i].x - points[i - 1].x;
      var dy = points[i].y - points[i - 1].y;
      total += Math.sqrt(dx * dx + dy * dy);
    }
    return total;
  }

  function buildBezierControlPoints(p0, p1) {
    var dx = p1.x - p0.x;
    var dy = p1.y - p0.y;
    var c0;
    var c1;
    if (dx >= 20) {
      var ctrl = clamp(Math.abs(dx) * 0.48 + Math.abs(dy) * 0.12, 40, 180);
      c0 = { x: p0.x + ctrl, y: p0.y };
      c1 = { x: p1.x - ctrl, y: p1.y };
    } else {
      var stub = clamp(60 + Math.abs(dx) * 0.25, 52, 140);
      var vertShift = Math.abs(dy) < 40 ? (p0.y <= p1.y ? -56 : 56) : dy * 0.18;
      c0 = { x: p0.x + stub, y: p0.y + vertShift };
      c1 = { x: p1.x - stub, y: p1.y - vertShift };
    }
    return { p0: p0, c0: c0, c1: c1, p1: p1 };
  }

  function sampleCubicBezier(p0, c0, c1, p1, segments) {
    var segCount = segments || 24;
    var points = [];
    for (var i = 0; i <= segCount; i += 1) {
      var t = i / segCount;
      var omt = 1 - t;
      var omt2 = omt * omt;
      var t2 = t * t;
      var x = omt2 * omt * p0.x + 3 * omt2 * t * c0.x + 3 * omt * t2 * c1.x + t2 * t * p1.x;
      var y = omt2 * omt * p0.y + 3 * omt2 * t * c0.y + 3 * omt * t2 * c1.y + t2 * t * p1.y;
      points.push({ x: x, y: y });
    }
    return points;
  }

  function buildOrthoPoints(p0, p1, fromNode, toNode) {
    var dy = p1.y - p0.y;
    var dx = p1.x - p0.x;

    if (Math.abs(dy) < 1.5 && dx >= 0) {
      return [
        { x: p0.x, y: p0.y },
        { x: p1.x, y: p1.y }
      ];
    }

    if (dx >= 12) {
      var midX = (p0.x + p1.x) * 0.5;
      return [
        { x: p0.x, y: p0.y },
        { x: midX, y: p0.y },
        { x: midX, y: p1.y },
        { x: p1.x, y: p1.y }
      ];
    }

    // 逆向きまたは極近接接続：上下へ迂回する直交ルート
    var stub = 24;
    var sx = p0.x + stub;
    var ex = p1.x - stub;
    var topEdge = Math.min(fromNode.y, toNode.y) - 26;
    var bottomEdge = Math.max(fromNode.y + fromNode.height, toNode.y + toNode.height) + 26;
    var safeTop = CONFIG.SAFE_MARGIN_TOP + 8;
    var detourY;
    if (Math.abs(dy) > Math.max(fromNode.height, toNode.height) + 32) {
      detourY = (p0.y + p1.y) * 0.5;
    } else if (topEdge >= safeTop) {
      detourY = topEdge;
    } else {
      detourY = bottomEdge;
    }

    return [
      { x: p0.x, y: p0.y },
      { x: sx, y: p0.y },
      { x: sx, y: detourY },
      { x: ex, y: detourY },
      { x: ex, y: p1.y },
      { x: p1.x, y: p1.y }
    ];
  }

  function getWirePolyline(conn, cableMode) {
    if (!conn) {
      return { points: [], totalLength: 0, mode: state.cableMode, controlPoints: null };
    }
    var mode = cableMode || state.cableMode || CONFIG.DEFAULT_CABLE_STYLE;
    var fromNode = findNode(conn.fromNodeId);
    var toNode = findNode(conn.toNodeId);
    if (!fromNode || !toNode) {
      return { points: [], totalLength: 0, mode: mode, controlPoints: null };
    }

    var p0 = getPortPosition(fromNode, conn.fromPortId);
    var p1 = getPortPosition(toNode, conn.toPortId);
    if (!p0 || !p1) {
      return { points: [], totalLength: 0, mode: mode, controlPoints: null };
    }

    var startPt = { x: p0.x, y: p0.y };
    var endPt = { x: p1.x, y: p1.y };
    var points;
    var controlPoints = null;

    if (mode === 'ortho') {
      points = buildOrthoPoints(startPt, endPt, fromNode, toNode);
    } else {
      controlPoints = buildBezierControlPoints(startPt, endPt);
      points = sampleCubicBezier(
        controlPoints.p0,
        controlPoints.c0,
        controlPoints.c1,
        controlPoints.p1,
        24
      );
    }

    var totalLength = computePolylineLength(points);
    return {
      points: points,
      totalLength: totalLength,
      mode: mode,
      controlPoints: controlPoints,
      p0: startPt,
      p1: endPt
    };
  }

  function samplePointAtProgress(polylineData, progress) {
    var pts = polylineData.points;
    if (!pts || pts.length === 0) {
      return { x: 0, y: 0, angle: 0 };
    }
    if (pts.length === 1) {
      return { x: pts[0].x, y: pts[0].y, angle: 0 };
    }
    var targetDist = clamp(progress, 0, 1) * polylineData.totalLength;
    var walked = 0;
    for (var i = 1; i < pts.length; i += 1) {
      var ax = pts[i - 1].x;
      var ay = pts[i - 1].y;
      var bx = pts[i].x;
      var by = pts[i].y;
      var dx = bx - ax;
      var dy = by - ay;
      var segLen = Math.sqrt(dx * dx + dy * dy);
      if (walked + segLen >= targetDist || i === pts.length - 1) {
        var remain = targetDist - walked;
        var ratio = segLen > 1e-6 ? clamp(remain / segLen, 0, 1) : 0;
        return {
          x: ax + dx * ratio,
          y: ay + dy * ratio,
          angle: Math.atan2(dy, dx)
        };
      }
      walked += segLen;
    }
    var last = pts[pts.length - 1];
    return { x: last.x, y: last.y, angle: 0 };
  }

  // =========================================================================
  // 6. 幾何学的配線交差判定＆整頓シンクロ（+20%）評価
  // =========================================================================

  function orient2d(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function distSq(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  function segmentBoundingBoxesOverlap(a, b, c, d, eps) {
    var e = eps || 0;
    return (
      Math.max(a.x, b.x) + e >= Math.min(c.x, d.x) &&
      Math.max(c.x, d.x) + e >= Math.min(a.x, b.x) &&
      Math.max(a.y, b.y) + e >= Math.min(c.y, d.y) &&
      Math.max(c.y, d.y) + e >= Math.min(a.y, b.y)
    );
  }

  function computeProperIntersectionPoint(a, b, c, d) {
    if (!segmentBoundingBoxesOverlap(a, b, c, d, 1e-4)) {
      return null;
    }
    var o1 = orient2d(a, b, c);
    var o2 = orient2d(a, b, d);
    var o3 = orient2d(c, d, a);
    var o4 = orient2d(c, d, b);

    var eps = 1e-3;
    if (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
        ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))) {
      var denom = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
      if (Math.abs(denom) < 1e-9) {
        return null;
      }
      var t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / denom;
      return {
        x: a.x + t * (b.x - a.x),
        y: a.y + t * (b.y - a.y)
      };
    }
    return null;
  }

  function collinearOverlapLength(a, b, c, d) {
    if (!segmentBoundingBoxesOverlap(a, b, c, d, 1.5)) {
      return 0;
    }
    var dx1 = b.x - a.x;
    var dy1 = b.y - a.y;
    var len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    var dx2 = d.x - c.x;
    var dy2 = d.y - c.y;
    var len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    if (len1 < 1e-3 || len2 < 1e-3) {
      return 0;
    }

    var ux = dx1 / len1;
    var uy = dy1 / len1;
    var crossDir = Math.abs(ux * (dy2 / len2) - uy * (dx2 / len2));
    if (crossDir > 0.025) {
      return 0;
    }

    // 直線 a->b からの c の垂直距離
    var perpDist = Math.abs((c.x - a.x) * (-uy) + (c.y - a.y) * ux);
    if (perpDist > 2.0) {
      return 0;
    }

    var pC = (c.x - a.x) * ux + (c.y - a.y) * uy;
    var pD = (d.x - a.x) * ux + (d.y - a.y) * uy;
    var min1 = 0;
    var max1 = len1;
    var min2 = Math.min(pC, pD);
    var max2 = Math.max(pC, pD);
    var overlap = Math.min(max1, max2) - Math.max(min1, min2);
    return overlap > 0 ? overlap : 0;
  }

  function doWirePolylinesCross(connA, polyA, connB, polyB) {
    var ptsA = polyA.points;
    var ptsB = polyB.points;
    if (ptsA.length < 2 || ptsB.length < 2) {
      return false;
    }

    var shareStart = connA.fromNodeId === connB.fromNodeId && connA.fromPortId === connB.fromPortId;
    var shareEnd = connA.toNodeId === connB.toNodeId && connA.toPortId === connB.toPortId;
    var sharedEndpointRadiusSq = 14 * 14;

    var lastIdxA = ptsA.length - 2;
    var lastIdxB = ptsB.length - 2;

    for (var i = 0; i <= lastIdxA; i += 1) {
      var a1 = ptsA[i];
      var a2 = ptsA[i + 1];
      for (var j = 0; j <= lastIdxB; j += 1) {
        var b1 = ptsB[j];
        var b2 = ptsB[j + 1];

        var hit = computeProperIntersectionPoint(a1, a2, b1, b2);
        if (hit) {
          var ignoreNearShared = false;
          if (shareStart && distSq(hit, polyA.p0) < sharedEndpointRadiusSq) {
            ignoreNearShared = true;
          }
          if (shareEnd && distSq(hit, polyA.p1) < sharedEndpointRadiusSq) {
            ignoreNearShared = true;
          }
          if (!ignoreNearShared) {
            return true;
          }
        }

        // 同一ルートへの共線重なり（タスキ掛け垂直線すり抜け等）を検知する。
        // ただし同一ポート共有に伴う分岐・合流の先端セグメント同士は許容する。
        var isSharedStartTrunk = shareStart && i === 0 && j === 0;
        var isSharedEndTrunk = shareEnd && i === lastIdxA && j === lastIdxB;
        if (!isSharedStartTrunk && !isSharedEndTrunk) {
          var overlap = collinearOverlapLength(a1, a2, b1, b2);
          if (overlap > 6.0) {
            return true;
          }
        }
      }
    }
    return false;
  }

  function evaluateTidySync(options) {
    var opts = options || {};
    var links = state.connections;
    var linkCount = links.length;
    var prevTidy = state.isTidySync;

    // ポリラインを事前計算（描画層からも参照可能にキャッシュ更新）
    var polylines = [];
    runtime.wireCache = {};
    for (var i = 0; i < linkCount; i += 1) {
      var conn = links[i];
      var poly = getWirePolyline(conn, state.cableMode);
      polylines.push(poly);
      runtime.wireCache[conn.id] = poly;
    }

    var crossingCount = 0;
    for (var a = 0; a < linkCount; a += 1) {
      for (var b = a + 1; b < linkCount; b += 1) {
        if (doWirePolylinesCross(links[a], polylines[a], links[b], polylines[b])) {
          crossingCount += 1;
        }
      }
    }

    // ノード同士の重なりチェック（ズル重なり防止・整頓基準）
    var nodeOverlapCount = 0;
    for (var n1 = 0; n1 < state.nodes.length; n1 += 1) {
      var na = state.nodes[n1];
      for (var n2 = n1 + 1; n2 < state.nodes.length; n2 += 1) {
        var nb = state.nodes[n2];
        if (rectsOverlap(na.x, na.y, na.width, na.height, nb.x, nb.y, nb.width, nb.height, -8)) {
          nodeOverlapCount += 1;
        }
      }
    }

    // 並行度・順流スコアの計算（0.0 ~ 1.0）
    var backwardLinks = 0;
    var flowScoreSum = 0;
    for (var k = 0; k < linkCount; k += 1) {
      var pl = polylines[k];
      if (!pl.p0 || !pl.p1) {
        continue;
      }
      var dx = pl.p1.x - pl.p0.x;
      var dy = pl.p1.y - pl.p0.y;
      if (dx < -10) {
        backwardLinks += 1;
      }
      var dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      var directness = clamp(dx / dist, -0.5, 1.0);
      flowScoreSum += (directness + 0.5) / 1.5;
    }

    var alignmentScore = linkCount > 0 ? clamp(flowScoreSum / linkCount, 0, 1) : 1;
    var hasMinLinks = linkCount >= CONFIG.TIDY_MIN_LINKS;
    var hasNoCrossings = crossingCount <= CONFIG.TIDY_MAX_CROSSINGS;
    var hasNoOverlaps = nodeOverlapCount === 0;
    var isTidy = hasMinLinks && hasNoCrossings && hasNoOverlaps;

    var reason = '整頓シンクロ発動中（+20%加速）';
    if (!hasMinLinks) {
      reason = '有効配線が2本以上で判定開始';
    } else if (!hasNoCrossings) {
      reason = '配線交差 ' + crossingCount + ' 箇所を解消すると発動';
    } else if (!hasNoOverlaps) {
      reason = '重なっている装置を離すと発動';
    }

    state.isTidySync = isTidy;
    state.tidyStats = {
      linkCount: linkCount,
      crossingCount: crossingCount,
      nodeOverlapCount: nodeOverlapCount,
      alignmentScore: Math.round(alignmentScore * 100) / 100,
      backwardLinks: backwardLinks,
      isTidy: isTidy,
      reason: reason
    };

    var transitionedToTidy = !prevTidy && isTidy;
    var brokenFromTidy = prevTidy && !isTidy;

    if (!opts.silent) {
      if (transitionedToTidy) {
        pushFxEvent({
          type: 'tidy_sync_on',
          linkCount: linkCount
        });
        safeAudio('playTidyChord');
        if (!state.tutorialFlags.tidyNotified) {
          state.tutorialFlags.tidyNotified = true;
          var tidyQuip = pickQuip(BOOGIE_QUIPS.tidySync);
          if (tidyQuip) {
            setBoogieOverride(tidyQuip.text, tidyQuip.mood, 6.0);
          }
        }
      } else if (brokenFromTidy && linkCount >= CONFIG.TIDY_MIN_LINKS) {
        pushFxEvent({
          type: 'tidy_sync_off',
          crossingCount: crossingCount
        });
        var brokenQuip = pickQuip(BOOGIE_QUIPS.tidyBroken);
        if (brokenQuip) {
          setBoogieOverride(brokenQuip.text, brokenQuip.mood, 5.0);
        }
      }
    }

    return {
      isTidySync: isTidy,
      transitionedToTidy: transitionedToTidy,
      brokenFromTidy: brokenFromTidy,
      stats: state.tidyStats
    };
  }

  // =========================================================================
  // 7. ノード＆配線操作API
  // =========================================================================

  function isPartUnlocked(partId) {
    return state.unlockedParts.indexOf(partId) !== -1;
  }

  function addNode(partId, x, y, options) {
    var opts = options || {};
    var part = PARTS_MAP[partId];
    if (!part) {
      return { ok: false, reason: 'INVALID_PART', message: '未定義の設備パーツです。' };
    }
    if (!opts.free && !isPartUnlocked(partId)) {
      return { ok: false, reason: 'PART_LOCKED', message: part.name + ' はまだ解放されていません。' };
    }
    var cost = opts.free ? 0 : part.cost;
    if (state.funds < cost) {
      return {
        ok: false,
        reason: 'INSUFFICIENT_FUNDS',
        message: '資金が不足しています（必要: $' + cost + ' / 所持: $' + Math.floor(state.funds) + '）。'
      };
    }

    var targetX = Number.isFinite(x) ? x : state.viewport.width * 0.45;
    var targetY = Number.isFinite(y) ? y : state.viewport.height * 0.42;
    var clamped = clampNodePosition(targetX, targetY, part.width, part.height, state.viewport);
    if (!opts.ignoreOverlap && hasNodeOverlap(clamped.x, clamped.y, part.width, part.height, null, NODE_CLEARANCE)) {
      return {
        ok: false,
        reason: 'NODE_OVERLAP',
        message: '他の装置と重なる場所には設置できません。少し空いた海域を選んでください。'
      };
    }

    var node = createNodeInstance(partId, clamped.x, clamped.y, opts);
    if (!node) {
      return { ok: false, reason: 'INVALID_PART', message: '設備生成に失敗しました。' };
    }

    state.funds = roundMoney(state.funds - cost);
    state.nodes.push(node);
    state.selectedNodeId = node.id;
    state.isDirty = true;

    pushFxEvent({
      type: 'node_placed',
      nodeId: node.id,
      partId: partId,
      x: node.x + node.width * 0.5,
      y: node.y + node.height * 0.5,
      color: part.theme ? part.theme.accent : CONFIG.PALETTE.CYAN_NEON
    });

    if (!opts.silent) {
      safeAudio('playPlace');
      var pool = BOOGIE_QUIPS.place[partId] || BOOGIE_QUIPS.place.default;
      var q = pickQuip(pool);
      if (q) {
        setBoogieOverride(q.text, q.mood, 4.5);
      }
    }

    evaluateTidySync({ silent: Boolean(opts.silent) });
    evaluateTutorialProgress({ silent: Boolean(opts.silent) });
    computeGuideLinks();

    return { ok: true, node: node, cost: cost };
  }

  function removeNode(nodeId, options) {
    var opts = options || {};
    var idx = -1;
    for (var i = 0; i < state.nodes.length; i += 1) {
      if (state.nodes[i].id === nodeId) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      return { ok: false, reason: 'NODE_NOT_FOUND', message: '対象ノードが見つかりません。' };
    }

    var node = state.nodes[idx];
    if (!opts.force && node.allowDelete === false) {
      return { ok: false, reason: 'NODE_LOCKED', message: '初期基幹設備は解体できません。' };
    }

    var part = PARTS_MAP[node.partId];
    var refund = part ? roundMoney(part.cost * CONFIG.REFUND_RATE) : 0;

    // 関連接続と走行中パケットの削除
    var removedConnIds = {};
    var keptConnections = [];
    for (var c = 0; c < state.connections.length; c += 1) {
      var conn = state.connections[c];
      if (conn.fromNodeId === nodeId || conn.toNodeId === nodeId) {
        removedConnIds[conn.id] = true;
      } else {
        keptConnections.push(conn);
      }
    }
    state.connections = keptConnections;

    var keptPackets = [];
    for (var p = 0; p < state.packets.length; p += 1) {
      if (!removedConnIds[state.packets[p].connId]) {
        keptPackets.push(state.packets[p]);
      }
    }
    state.packets = keptPackets;

    state.nodes.splice(idx, 1);
    if (state.selectedNodeId === nodeId) {
      state.selectedNodeId = null;
    }
    state.funds = roundMoney(state.funds + refund);
    state.isDirty = true;

    pushFxEvent({
      type: 'node_removed',
      nodeId: nodeId,
      partId: node.partId,
      x: node.x + node.width * 0.5,
      y: node.y + node.height * 0.5,
      refund: refund
    });

    if (!opts.silent) {
      safeAudio('playDisconnect');
    }

    evaluateTidySync({ silent: Boolean(opts.silent) });
    evaluateTutorialProgress({ silent: Boolean(opts.silent) });
    computeGuideLinks();

    return { ok: true, removedNodeId: nodeId, refund: refund };
  }

  function moveNode(nodeId, x, y, options) {
    var opts = options || {};
    var node = findNode(nodeId);
    if (!node) {
      return { ok: false, reason: 'NODE_NOT_FOUND', message: '対象ノードが見つかりません。' };
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, reason: 'INVALID_COORDS', message: '座標が不正です。' };
    }

    var origX = node.x;
    var origY = node.y;
    var w = node.width;
    var h = node.height;
    var pad = Number.isFinite(opts.clearance) ? opts.clearance : NODE_CLEARANCE;
    var target = clampNodePosition(x, y, w, h, state.viewport);

    var finalX = target.x;
    var finalY = target.y;
    var adjusted = false;

    if (!opts.ignoreOverlap) {
      var hit = getOverlappingNode(target.x, target.y, w, h, node.id, pad);
      if (hit) {
        var candidates = [];

        // 1. 単軸スライド（Xのみ移動／Yのみ移動）で他ノードの脇を滑らかに回避
        var slideX = clampNodePosition(target.x, origY, w, h, state.viewport);
        if (
          (slideX.x !== origX || slideX.y !== origY) &&
          !hasNodeOverlap(slideX.x, slideX.y, w, h, node.id, pad)
        ) {
          candidates.push({
            x: slideX.x,
            y: slideX.y,
            priority: 1,
            dist: Math.hypot(slideX.x - target.x, slideX.y - target.y)
          });
        }

        var slideY = clampNodePosition(origX, target.y, w, h, state.viewport);
        if (
          (slideY.x !== origX || slideY.y !== origY) &&
          !hasNodeOverlap(slideY.x, slideY.y, w, h, node.id, pad)
        ) {
          candidates.push({
            x: slideY.x,
            y: slideY.y,
            priority: 1,
            dist: Math.hypot(slideY.x - target.x, slideY.y - target.y)
          });
        }

        // 2. 単軸スライドでも重なる場合は衝突相手の上下左右の外縁へ最小移動距離で押し出す
        if (candidates.length === 0) {
          var edgeRaw = [
            { x: hit.x - w - pad, y: target.y },
            { x: hit.x + hit.width + pad, y: target.y },
            { x: target.x, y: hit.y - h - pad },
            { x: target.x, y: hit.y + hit.height + pad }
          ];
          for (var e = 0; e < edgeRaw.length; e += 1) {
            var ec = clampNodePosition(edgeRaw[e].x, edgeRaw[e].y, w, h, state.viewport);
            if (!hasNodeOverlap(ec.x, ec.y, w, h, node.id, pad)) {
              candidates.push({
                x: ec.x,
                y: ec.y,
                priority: 2,
                dist: Math.hypot(ec.x - target.x, ec.y - target.y)
              });
            }
          }
        }

        if (candidates.length > 0) {
          candidates.sort(function (a, b) {
            if (a.dist !== b.dist) {
              return a.dist - b.dist;
            }
            return a.priority - b.priority;
          });
          finalX = candidates[0].x;
          finalY = candidates[0].y;
          adjusted = true;
        } else {
          // 3. 隙間に入りきらない等で全候補が重なる場合は元位置を維持しブロックを返す
          return {
            ok: false,
            reason: 'NODE_OVERLAP',
            message: '他の装置と重なる位置には移動できません。',
            x: origX,
            y: origY
          };
        }
      }
    }

    node.x = finalX;
    node.y = finalY;
    state.isDirty = true;

    var tidyResult = evaluateTidySync({ silent: Boolean(opts.silent) });
    computeGuideLinks();

    return {
      ok: true,
      node: node,
      x: node.x,
      y: node.y,
      adjusted: adjusted,
      isTidySync: tidyResult.isTidySync
    };
  }

  function selectNode(nodeId) {
    if (nodeId === null || nodeId === undefined) {
      state.selectedNodeId = null;
      return { ok: true, selectedNodeId: null };
    }
    var node = findNode(nodeId);
    if (!node) {
      return { ok: false, reason: 'NODE_NOT_FOUND', message: '選択対象が見つかりません。' };
    }
    state.selectedNodeId = node.id;
    safeAudio('playClick', 'node');
    return { ok: true, selectedNodeId: node.id, node: node };
  }

  function canConnect(fromNodeId, fromPortId, toNodeId, toPortId) {
    if (!fromNodeId || !toNodeId) {
      return { ok: false, reason: 'NODE_NOT_FOUND', message: '接続ノードが指定されていません。' };
    }
    if (fromNodeId === toNodeId) {
      return { ok: false, reason: 'SAME_NODE', message: '同じ設備のポート同士は接続できません。' };
    }

    var fromNode = findNode(fromNodeId);
    var toNode = findNode(toNodeId);
    if (!fromNode || !toNode) {
      return { ok: false, reason: 'NODE_NOT_FOUND', message: '接続対象の設備が見つかりません。' };
    }

    var fromPortInfo = getPortDef(fromNode.partId, fromPortId);
    var toPortInfo = getPortDef(toNode.partId, toPortId);
    if (!fromPortInfo || !toPortInfo) {
      return { ok: false, reason: 'INVALID_PORT', message: '指定されたポートが見つかりません。' };
    }

    if (fromPortInfo.dir !== 'out' || toPortInfo.dir !== 'in') {
      return { ok: false, reason: 'PORT_DIRECTION_MISMATCH', message: '出力ポートから入力ポートへ接続してください。' };
    }

    // 重複接続の防止
    for (var i = 0; i < state.connections.length; i += 1) {
      var existing = state.connections[i];
      if (
        existing.fromNodeId === fromNodeId &&
        existing.fromPortId === fromPortId &&
        existing.toNodeId === toNodeId &&
        existing.toPortId === toPortId
      ) {
        return { ok: false, reason: 'DUPLICATE_CONNECTION', message: 'このポート同士はすでに接続されています。' };
      }
    }

    // 互換リソースチェック（acceptsByMode・出力動的型・dualPurposeInFilter すべて考慮）
    var outResource = getEffectiveOutputType(fromNode, fromPortId);
    var acceptedTypes = getEffectiveAcceptedTypes(toNode, toPortId);

    // 汎用モジュールの in_coolant が物理濾過モードかつ深層水を受ける場合も accepts=['deep_water','purified_coolant'] に含まれるが、
    // 明示的に dualPurposeInFilter を検証する
    var compatible = acceptedTypes.indexOf(outResource) !== -1;
    if (!compatible && toPortInfo.portDef.dualPurposeInFilter && toNode.config && toNode.config.mode === 'filter') {
      compatible = outResource === 'deep_water' || outResource === 'purified_coolant';
    }

    if (!compatible) {
      var outName = RESOURCES[outResource] ? RESOURCES[outResource].name : outResource;
      return {
        ok: false,
        reason: 'INCOMPATIBLE_RESOURCE',
        message: outName + ' はこの入力ポート（' + toPortInfo.portDef.label + '）に接続できません。'
      };
    }

    return {
      ok: true,
      resourceId: outResource,
      fromNode: fromNode,
      toNode: toNode
    };
  }

  function resolvePortPair(nodeIdA, portIdA, nodeIdB, portIdB) {
    var nodeA = findNode(nodeIdA);
    var nodeB = findNode(nodeIdB);
    if (!nodeA || !nodeB) {
      return { ok: false, reason: 'NODE_NOT_FOUND', message: '接続ノードが見つかりません。' };
    }
    var infoA = getPortDef(nodeA.partId, portIdA);
    var infoB = getPortDef(nodeB.partId, portIdB);
    if (!infoA || !infoB) {
      return { ok: false, reason: 'INVALID_PORT', message: '指定ポートが見つかりません。' };
    }
    if (infoA.dir === 'out' && infoB.dir === 'in') {
      return {
        ok: true,
        fromNodeId: nodeIdA,
        fromPortId: portIdA,
        toNodeId: nodeIdB,
        toPortId: portIdB
      };
    }
    if (infoA.dir === 'in' && infoB.dir === 'out') {
      return {
        ok: true,
        fromNodeId: nodeIdB,
        fromPortId: portIdB,
        toNodeId: nodeIdA,
        toPortId: portIdA
      };
    }
    return { ok: false, reason: 'PORT_DIRECTION_MISMATCH', message: '出力ポートと入力ポートを繋いでください。' };
  }

  function connectPorts(fromNodeId, fromPortId, toNodeId, toPortId, options) {
    var opts = options || {};
    var check = canConnect(fromNodeId, fromPortId, toNodeId, toPortId);
    if (!check.ok) {
      return check;
    }

    var conn = {
      id: typeof opts.id === 'string' && opts.id.length > 0 ? opts.id : generateId('conn'),
      fromNodeId: fromNodeId,
      fromPortId: fromPortId,
      toNodeId: toNodeId,
      toPortId: toPortId,
      resourceId: check.resourceId,
      bottleneckRatio: 0,
      lastPulseTime: -999
    };

    state.connections.push(conn);
    state.isDirty = true;

    var tidyResult = evaluateTidySync({ silent: Boolean(opts.silent) });

    var p0 = getPortPosition(check.fromNode, fromPortId);
    var p1 = getPortPosition(check.toNode, toPortId);
    pushFxEvent({
      type: 'wire_connected',
      connId: conn.id,
      resourceId: conn.resourceId,
      fromX: p0 ? p0.x : 0,
      fromY: p0 ? p0.y : 0,
      toX: p1 ? p1.x : 0,
      toY: p1 ? p1.y : 0,
      isTidy: tidyResult.isTidySync
    });

    if (!opts.silent) {
      safeAudio('playConnect', tidyResult.isTidySync);
      var cat = RESOURCES[conn.resourceId] ? RESOURCES[conn.resourceId].category : 'default';
      var quipCategory = 'default';
      if (conn.resourceId === 'power') {
        quipCategory = 'power';
      } else if (conn.resourceId === 'hot_water') {
        quipCategory = 'waste';
      } else if (conn.resourceId === 'deep_water' || conn.resourceId === 'purified_coolant') {
        quipCategory = 'coolant';
      } else if (cat === 'data') {
        quipCategory = 'data';
      }
      var quipPool = BOOGIE_QUIPS.connect[quipCategory] || BOOGIE_QUIPS.connect.default;
      var q = pickQuip(quipPool);
      if (q && !tidyResult.transitionedToTidy) {
        setBoogieOverride(q.text, q.mood, 4.0);
      }
    }

    evaluateTutorialProgress({ silent: Boolean(opts.silent) });
    computeGuideLinks();

    return {
      ok: true,
      connection: conn,
      isTidySync: tidyResult.isTidySync
    };
  }

  function disconnectWire(connId, options) {
    var opts = options || {};
    var idx = -1;
    for (var i = 0; i < state.connections.length; i += 1) {
      if (state.connections[i].id === connId) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      return { ok: false, reason: 'CONNECTION_NOT_FOUND', message: '指定の配線が見つかりません。' };
    }

    var removed = state.connections[idx];
    state.connections.splice(idx, 1);

    var keptPackets = [];
    for (var p = 0; p < state.packets.length; p += 1) {
      if (state.packets[p].connId !== connId) {
        keptPackets.push(state.packets[p]);
      }
    }
    state.packets = keptPackets;
    state.isDirty = true;

    pushFxEvent({
      type: 'wire_disconnected',
      connId: connId
    });

    if (!opts.silent) {
      safeAudio('playDisconnect');
    }

    evaluateTidySync({ silent: Boolean(opts.silent) });
    evaluateTutorialProgress({ silent: Boolean(opts.silent) });
    computeGuideLinks();

    return { ok: true, removedConnection: removed };
  }

  function disconnectPort(nodeId, portId, options) {
    var opts = options || {};
    var node = findNode(nodeId);
    if (!node) {
      return { ok: false, reason: 'NODE_NOT_FOUND', message: '対象ノードが見つかりません。' };
    }
    var portInfo = getPortDef(node.partId, portId);
    if (!portInfo) {
      return { ok: false, reason: 'INVALID_PORT', message: '対象ポートが見つかりません。' };
    }

    var removedIds = [];
    var removedSet = {};
    var keptConnections = [];
    for (var i = 0; i < state.connections.length; i += 1) {
      var c = state.connections[i];
      var matchFrom = c.fromNodeId === nodeId && c.fromPortId === portId;
      var matchTo = c.toNodeId === nodeId && c.toPortId === portId;
      if (matchFrom || matchTo) {
        removedIds.push(c.id);
        removedSet[c.id] = true;
      } else {
        keptConnections.push(c);
      }
    }

    if (removedIds.length === 0) {
      return { ok: false, reason: 'CONNECTION_NOT_FOUND', message: 'このポートに接続されている配線はありません。' };
    }

    state.connections = keptConnections;
    var keptPackets = [];
    for (var p = 0; p < state.packets.length; p += 1) {
      if (!removedSet[state.packets[p].connId]) {
        keptPackets.push(state.packets[p]);
      }
    }
    state.packets = keptPackets;
    state.isDirty = true;

    if (!opts.silent) {
      safeAudio('playDisconnect');
    }

    evaluateTidySync({ silent: Boolean(opts.silent) });
    evaluateTutorialProgress({ silent: Boolean(opts.silent) });
    computeGuideLinks();

    return { ok: true, removedCount: removedIds.length, removedIds: removedIds };
  }

  function setNodeMode(nodeId, mode, options) {
    var opts = options || {};
    var node = findNode(nodeId);
    if (!node) {
      return { ok: false, reason: 'NODE_NOT_FOUND', message: '対象ノードが見つかりません。' };
    }
    var part = PARTS_MAP[node.partId];
    if (!part || !part.isHybrid) {
      return { ok: false, reason: 'NOT_HYBRID_NODE', message: 'この設備はモード切替に対応していません。' };
    }
    if (mode !== 'data' && mode !== 'filter') {
      return { ok: false, reason: 'INVALID_MODE', message: '無効な動作モードです。' };
    }

    var prevMode = node.config.mode;
    node.config.mode = mode;
    if (prevMode !== mode) {
      // モード変更時、不一致原料バッファをクリアして安全に再始動
      node.inputBuffer = 0;
      node.processTimer = 0;
    }
    state.isDirty = true;

    if (!opts.silent) {
      safeAudio('playClick', 'toggle');
      var qList = mode === 'filter' ? BOOGIE_QUIPS.modeSwitch.toFilter : BOOGIE_QUIPS.modeSwitch.toData;
      var q = pickQuip(qList);
      if (q) {
        setBoogieOverride(q.text, q.mood, 4.5);
      }
    }

    evaluateTutorialProgress({ silent: Boolean(opts.silent) });
    computeGuideLinks();

    return { ok: true, node: node, mode: mode };
  }

  function setNodePrecision(nodeId, precision, options) {
    var opts = options || {};
    var node = findNode(nodeId);
    if (!node) {
      return { ok: false, reason: 'NODE_NOT_FOUND', message: '対象ノードが見つかりません。' };
    }
    var part = PARTS_MAP[node.partId];
    if (!part || !part.isHybrid) {
      return { ok: false, reason: 'NOT_HYBRID_NODE', message: 'この設備は精度調整に対応していません。' };
    }

    var prevProf = getModuleDataProfile(node.config.precision);
    var nextVal = clamp(Math.round(Number(precision)), 0, 100);
    node.config.precision = nextVal;
    var nextProf = getModuleDataProfile(nextVal);
    state.isDirty = true;

    if (!opts.silent) {
      safeAudio('playClick', 'slider');
      if (prevProf.bandId !== nextProf.bandId && node.config.mode === 'data') {
        var qPool = nextProf.bandId === 'precision'
          ? BOOGIE_QUIPS.modeSwitch.toPrecisionBand
          : (nextProf.bandId === 'balanced' ? BOOGIE_QUIPS.modeSwitch.toBalancedBand : BOOGIE_QUIPS.modeSwitch.toSpeedBand);
        var q = pickQuip(qPool);
        if (q) {
          setBoogieOverride(q.text, q.mood, 4.5);
        }
      }
    }

    evaluateTutorialProgress({ silent: Boolean(opts.silent) });
    computeGuideLinks();

    return { ok: true, node: node, precision: nextVal, profile: nextProf };
  }

  function setCableMode(cableMode, options) {
    var opts = options || {};
    if (cableMode !== 'bezier' && cableMode !== 'ortho') {
      return { ok: false, reason: 'INVALID_CABLE_MODE', message: '無効な配線形状モードです。' };
    }
    state.cableMode = cableMode;
    state.isDirty = true;

    if (!opts.silent) {
      safeAudio('playClick', 'toggle');
    }

    var tidyResult = evaluateTidySync({ silent: Boolean(opts.silent) });
    return { ok: true, cableMode: cableMode, isTidySync: tidyResult.isTidySync };
  }

  function toggleCableMode() {
    var next = state.cableMode === 'bezier' ? 'ortho' : 'bezier';
    return setCableMode(next);
  }

  function setMuted(muted) {
    state.muted = Boolean(muted);
    safeAudio('setMuted', state.muted);
    state.isDirty = true;
    return state.muted;
  }

  function toggleMute() {
    return setMuted(!state.muted);
  }

  function setGuideLaserEnabled(enabled) {
    state.guideLaserEnabled = Boolean(enabled);
    safeAudio('playClick', 'toggle');
    state.isDirty = true;
    return state.guideLaserEnabled;
  }

  function toggleGuideLaser() {
    return setGuideLaserEnabled(!state.guideLaserEnabled);
  }

  function setGuidePart(partId) {
    if (partId && !PARTS_MAP[partId]) {
      return { ok: false, reason: 'INVALID_PART', message: '対象パーツが見つかりません。' };
    }
    state.activeEncyclopediaGuidePartId = partId || null;
    if (partId) {
      state.guideLaserEnabled = true;
    }
    computeGuideLinks();
    return { ok: true, activeEncyclopediaGuidePartId: state.activeEncyclopediaGuidePartId };
  }

  // =========================================================================
  // 8. 60fps 物理・リソース流・ボトルネック・熱冷却シミュレーション
  // =========================================================================

  function getOutgoingConnections(nodeId, portId) {
    var list = [];
    for (var i = 0; i < state.connections.length; i += 1) {
      var c = state.connections[i];
      if (c.fromNodeId === nodeId && c.fromPortId === portId) {
        list.push(c);
      }
    }
    return list;
  }

  function getIncomingConnections(nodeId, portId) {
    var list = [];
    for (var i = 0; i < state.connections.length; i += 1) {
      var c = state.connections[i];
      if (c.toNodeId === nodeId && (!portId || c.toPortId === portId)) {
        list.push(c);
      }
    }
    return list;
  }

  function countPacketsOnConnection(connId) {
    var count = 0;
    for (var i = 0; i < state.packets.length; i += 1) {
      if (state.packets[i].connId === connId) {
        count += 1;
      }
    }
    return count;
  }

  function emitPacketFromPort(sourceNode, portId, resourceId, payload) {
    var outs = getOutgoingConnections(sourceNode.id, portId);
    if (outs.length === 0) {
      return 0;
    }

    var resDef = RESOURCES[resourceId];
    if (!resDef) {
      return 0;
    }

    var extra = payload || {};
    var emitted = 0;
    sourceNode.producedCount += 1;
    sourceNode.activeFlashTimer = 0.28;
    sourceNode.lastActiveTime = state.simTime;

    for (var i = 0; i < outs.length; i += 1) {
      var conn = outs[i];
      conn.resourceId = resourceId;
      conn.lastPulseTime = state.simTime;

      if (countPacketsOnConnection(conn.id) >= CONFIG.MAX_PARTICLES_ON_CABLE) {
        continue;
      }

      state.packets.push({
        id: generateId('pkt'),
        connId: conn.id,
        resourceId: resourceId,
        progress: 0,
        speed: resDef.speed,
        value: extra.value !== undefined ? extra.value : resDef.baseValue,
        bandwidthLoad: extra.bandwidthLoad !== undefined ? extra.bandwidthLoad : resDef.bandwidthLoad,
        powerAmount: extra.powerAmount !== undefined ? extra.powerAmount : 1.0,
        coolingAmount: extra.coolingAmount !== undefined ? extra.coolingAmount : resDef.coolingAmount,
        coolingBoostSec: extra.coolingBoostSec !== undefined
          ? extra.coolingBoostSec
          : CONFIG.COOL_BOOST_DURATION_SEC * (resDef.coolingPower || 1),
        sourceNodeId: sourceNode.id,
        sourcePartId: sourceNode.partId
      });
      emitted += 1;
    }

    return emitted;
  }

  function deliverPacketToNode(pkt, toNode, conn) {
    var part = PARTS_MAP[toNode.partId];
    if (!part) {
      return;
    }

    var proc = part.process || {};
    var resId = pkt.resourceId;
    var toPortId = conn.toPortId;

    if (toPortId === 'in_power' && resId === 'power') {
      var maxPower = proc.powerBufferMax || 6;
      toNode.powerBuffer = Math.min(maxPower, toNode.powerBuffer + (pkt.powerAmount || 1));
      return;
    }

    if (toNode.partId === 'generic_module') {
      var mode = toNode.config && toNode.config.mode === 'filter' ? 'filter' : 'data';
      if (toPortId === 'in_primary') {
        var expected = mode === 'filter' ? 'deep_water' : 'raw_data';
        if (resId === expected) {
          var maxIn = proc.inputBufferMax || 8;
          toNode.inputBuffer = Math.min(maxIn, toNode.inputBuffer + 1);
        }
        return;
      }
      if (toPortId === 'in_coolant' && (resId === 'deep_water' || resId === 'purified_coolant')) {
        var maxCool = proc.coolantBufferMax || 6;
        if (toNode.coolantItems.length < maxCool) {
          toNode.coolantItems.push(resId);
          toNode.coolantBuffer = toNode.coolantItems.length;
        } else if (resId === 'purified_coolant') {
          // 既に満杯でも高純度冷却液を優先して差し替える
          for (var ci = 0; ci < toNode.coolantItems.length; ci += 1) {
            if (toNode.coolantItems[ci] === 'deep_water') {
              toNode.coolantItems[ci] = 'purified_coolant';
              break;
            }
          }
        }
        return;
      }
      return;
    }

    if (toNode.partId === 'surface_uplink' && toPortId === 'in_data') {
      if (resId === 'raw_data' || resId === 'refined_data' || resId === 'high_purity_data') {
        var load = Number.isFinite(pkt.bandwidthLoad) && pkt.bandwidthLoad > 0 ? pkt.bandwidthLoad : 1.0;
        var val = Number.isFinite(pkt.value) && pkt.value >= 0 ? pkt.value : 3.0;
        if (toNode.queueLoad < CONFIG.UPLINK_QUEUE_MAX * 1.15) {
          toNode.queueItems.push({
            resourceId: resId,
            value: val,
            load: load,
            remainingLoad: load
          });
          toNode.queueLoad += load;
        }
        if (resId === 'high_purity_data') {
          toNode.recentHighPurityTime = state.simTime;
          state.tutorialFlags.highPurityDelivered = true;
        }
      }
      return;
    }

    if ((toNode.partId === 'drain_vent' || toNode.partId === 'hydrothermal_turbine') && toPortId === 'in_hot') {
      if (resId === 'hot_water') {
        var maxHot = proc.inputBufferMax || 8;
        toNode.inputBuffer = Math.min(maxHot, toNode.inputBuffer + 1);
        if (toNode.partId === 'hydrothermal_turbine') {
          toNode.hotWaterRecentRate += 1;
        }
      }
    }
  }

  function stepPackets(dt) {
    var connMap = {};
    for (var c = 0; c < state.connections.length; c += 1) {
      connMap[state.connections[c].id] = state.connections[c];
    }

    var tidyMult = state.isTidySync ? CONFIG.TIDY_BONUS_MULTIPLIER : 1.0;
    var activePackets = [];

    for (var i = 0; i < state.packets.length; i += 1) {
      var pkt = state.packets[i];
      var conn = connMap[pkt.connId];
      if (!conn) {
        continue;
      }
      var toNode = findNode(conn.toNodeId);
      if (!toNode) {
        continue;
      }

      var poly = runtime.wireCache[conn.id];
      if (!poly || poly.totalLength <= 0) {
        poly = getWirePolyline(conn, state.cableMode);
        runtime.wireCache[conn.id] = poly;
      }

      var wireLen = Math.max(40, poly.totalLength);
      var bRatio = clamp(conn.bottleneckRatio || 0, 0, 1);
      var flowSlowdown = 1.0 - bRatio * 0.65;
      var resSpeed = RESOURCES[pkt.resourceId] ? RESOURCES[pkt.resourceId].speed : 140;

      pkt.progress += (resSpeed * tidyMult * flowSlowdown * dt) / wireLen;
      if (pkt.progress >= 1.0) {
        deliverPacketToNode(pkt, toNode, conn);
      } else {
        activePackets.push(pkt);
      }
    }

    state.packets = activePackets;
  }

  function updateGenericModuleHeatAndCooling(node, part, dt) {
    var heatConf = part.heat;
    node.heat = Math.max(CONFIG.BASE_TEMP, node.heat - heatConf.ambientCoolRate * dt);
    node.coolBoostTimer = Math.max(0, node.coolBoostTimer - dt);
    node.coolCycleTimer = Math.max(0, node.coolCycleTimer - dt);

    // 冷却液が到着していれば定期サイクルで熱交換して温排水を排出
    var mode = node.config && node.config.mode === 'filter' ? 'filter' : 'data';
    var hasHeatOrRunning = node.heat > CONFIG.BASE_TEMP + 1.2 || node.powerBuffer > 0 || (state.simTime - node.lastActiveTime < 2.0);
    var shouldCool =
      node.coolantItems.length > 0 &&
      node.coolCycleTimer <= 0 &&
      (node.heat > CONFIG.BASE_TEMP + 4 || node.coolBoostTimer <= 2.0 || (hasHeatOrRunning && getOutgoingConnections(node.id, 'out_waste').length > 0));

    // filter モードで主原料ポートが未接続かつ冷却ポートが唯一の深層水供給なら、
    // inputBuffer 向けに温存しつつ必要に応じて冷却も行う
    if (shouldCool && mode === 'filter' && node.inputBuffer < 1 && getIncomingConnections(node.id, 'in_primary').length === 0) {
      shouldCool = node.heat > CONFIG.COOL_BOOST_TEMP || node.coolantItems.length >= 2;
    }

    if (shouldCool) {
      var coolRes = node.coolantItems.shift();
      node.coolantBuffer = node.coolantItems.length;
      var coolAmount = (heatConf.coolantCoolingAmount && heatConf.coolantCoolingAmount[coolRes]) || 16;
      var mult = coolRes === 'purified_coolant' ? CONFIG.PURIFIED_COOLANT_MULTIPLIER : 1.0;
      var boostDuration = heatConf.coolBoostDurationSec * mult;

      node.heat = Math.max(CONFIG.BASE_TEMP, node.heat - coolAmount);
      var prevBoost = node.isCoolBoosted;
      node.coolBoostTimer = Math.max(node.coolBoostTimer, boostDuration);
      node.coolCycleTimer = 0.78;
      state.tutorialFlags.cooledObserved = true;

      emitPacketFromPort(node, 'out_waste', 'hot_water', { thermalEnergy: 1.0 });

      if (!prevBoost && node.heat <= CONFIG.COOL_BOOST_TEMP) {
        pushFxEvent({
          type: 'cool_boost',
          nodeId: node.id,
          x: node.x + node.width * 0.5,
          y: node.y + node.height * 0.5,
          coolant: coolRes
        });
      }
    }

    // オーバーヒート判定（ヒステリシス付き：80℃超で突入、74℃以下で回復）
    var wasOverheated = node.isOverheated;
    if (!wasOverheated && node.heat > heatConf.overheatTemp) {
      node.isOverheated = true;
      pushFxEvent({
        type: 'overheat',
        nodeId: node.id,
        x: node.x + node.width * 0.5,
        y: node.y + node.height * 0.5,
        heat: node.heat
      });
      safeAudio('playWarning');
      if (!state.tutorialFlags.overheatObserved) {
        state.tutorialFlags.overheatObserved = true;
        var ohQuip = pickQuip(BOOGIE_QUIPS.overheat);
        if (ohQuip) {
          setBoogieOverride(ohQuip.text, ohQuip.mood, 6.0);
        }
      }
    } else if (wasOverheated && node.heat <= heatConf.overheatTemp - OVERHEAT_HYSTERESIS_DELTA) {
      node.isOverheated = false;
      var cooledQuip = pickQuip(BOOGIE_QUIPS.cooled);
      if (cooledQuip) {
        setBoogieOverride(cooledQuip.text, cooledQuip.mood, 4.5);
      }
    }

    node.isCoolBoosted = !node.isOverheated && node.coolBoostTimer > 0 && node.heat <= heatConf.coolBoostTemp;
  }

  function stepNode(node, dt) {
    var part = PARTS_MAP[node.partId];
    if (!part) {
      return;
    }

    node.activeFlashTimer = Math.max(0, node.activeFlashTimer - dt);
    node.beamTimer = Math.max(0, node.beamTimer - dt);

    var tidyMult = state.isTidySync ? CONFIG.TIDY_BONUS_MULTIPLIER : 1.0;
    var proc = part.process || {};

    if (node.partId === 'emergency_battery') {
      node.efficiency = tidyMult;
      node.effectiveInterval = proc.processInterval / Math.max(0.1, node.efficiency);
      node.processTimer += dt;
      if (node.processTimer >= node.effectiveInterval) {
        node.processTimer -= node.effectiveInterval;
        emitPacketFromPort(node, 'out_power', 'power', { powerAmount: 1.0 });
      }
      node.status = 'running';
      node.statusLabel = '稼働中 (' + proc.powerGeneration + ' MW)';
      return;
    }

    if (node.partId === 'submarine_cable') {
      node.efficiency = tidyMult;
      node.effectiveInterval = proc.processInterval / Math.max(0.1, node.efficiency);
      var hasPower = node.powerBuffer >= proc.powerCostPerCycle;
      if (hasPower) {
        node.processTimer += dt;
        if (node.processTimer >= node.effectiveInterval) {
          node.processTimer -= node.effectiveInterval;
          node.powerBuffer = Math.max(0, node.powerBuffer - proc.powerCostPerCycle);
          emitPacketFromPort(node, 'out_raw', 'raw_data', {
            value: RESOURCES.raw_data.baseValue,
            bandwidthLoad: RESOURCES.raw_data.bandwidthLoad
          });
        }
        node.status = 'running';
        node.statusLabel = 'データ受信中';
      } else {
        node.processTimer = Math.min(node.processTimer, node.effectiveInterval * 0.5);
        node.status = 'no_power';
        node.statusLabel = '電力待機';
      }
      return;
    }

    if (node.partId === 'generic_module') {
      updateGenericModuleHeatAndCooling(node, part, dt);

      var heatMult = node.isOverheated
        ? part.heat.overheatMultiplier
        : (node.isCoolBoosted ? part.heat.coolBoostMultiplier : 1.0);
      node.efficiency = Math.round(heatMult * tidyMult * 1000) / 1000;

      var mode = node.config && node.config.mode === 'filter' ? 'filter' : 'data';
      if (mode === 'data') {
        var prof = getModuleDataProfile(node.config ? node.config.precision : 20);
        node.effectiveInterval = prof.processInterval / Math.max(0.1, node.efficiency);
        var hasPow = node.powerBuffer >= 1;
        var hasData = node.inputBuffer >= 1;

        if (hasPow && hasData) {
          node.processTimer += dt;
          if (node.processTimer >= node.effectiveInterval) {
            node.processTimer -= node.effectiveInterval;
            node.powerBuffer = Math.max(0, node.powerBuffer - 1);
            node.inputBuffer = Math.max(0, node.inputBuffer - 1);
            node.heat = clamp(node.heat + prof.heatPerCycle, CONFIG.BASE_TEMP, CONFIG.MAX_TEMP);
            node.lastOutputResource = prof.outputResource;
            emitPacketFromPort(node, 'out_main', prof.outputResource, {
              value: prof.unitValue,
              bandwidthLoad: prof.bandwidthLoad
            });
          }
        } else {
          node.processTimer = Math.min(node.processTimer, node.effectiveInterval * 0.5);
        }

        if (node.isOverheated) {
          node.status = 'overheat';
          node.statusLabel = '過熱警報 (50%)';
        } else if (!hasPow) {
          node.status = 'no_power';
          node.statusLabel = '電力待機';
        } else if (!hasData) {
          node.status = 'no_input';
          node.statusLabel = '生データ待機';
        } else if (node.isCoolBoosted) {
          node.status = 'boosted';
          node.statusLabel = '冷却ブースト (120%)';
        } else if (node.heat >= CONFIG.HEAT_WARN_TEMP) {
          node.status = 'warning';
          node.statusLabel = '高温注意';
        } else {
          node.status = 'running';
          node.statusLabel = '稼働中 (' + prof.bandLabel + ')';
        }
      } else {
        // 物理濾過モード
        var filterConf = proc.hybridConfig.modes.filter;
        node.effectiveInterval = filterConf.processInterval / Math.max(0.1, node.efficiency);
        var hasFilterPower = node.powerBuffer >= filterConf.powerCost;

        // 主原料ポートまたは冷却ポートの深層水を原料として使用可能（dualPurposeInFilter）
        var deepWaterInCoolantIdx = -1;
        if (node.inputBuffer < 1 && filterConf.acceptsCoolantPortAsRaw) {
          deepWaterInCoolantIdx = node.coolantItems.indexOf('deep_water');
        }
        var hasDeepWater = node.inputBuffer >= 1 || deepWaterInCoolantIdx !== -1;

        if (hasFilterPower && hasDeepWater) {
          node.processTimer += dt;
          if (node.processTimer >= node.effectiveInterval) {
            node.processTimer -= node.effectiveInterval;
            node.powerBuffer = Math.max(0, node.powerBuffer - filterConf.powerCost);
            if (node.inputBuffer >= 1) {
              node.inputBuffer -= 1;
            } else {
              var idxToUse = node.coolantItems.indexOf('deep_water');
              if (idxToUse !== -1) {
                node.coolantItems.splice(idxToUse, 1);
                node.coolantBuffer = node.coolantItems.length;
              }
            }
            node.heat = clamp(node.heat + filterConf.heatPerCycle, CONFIG.BASE_TEMP, CONFIG.MAX_TEMP);
            node.lastOutputResource = 'purified_coolant';
            state.tutorialFlags.filterProduced = true;
            emitPacketFromPort(node, 'out_main', 'purified_coolant', {
              coolingAmount: RESOURCES.purified_coolant.coolingAmount,
              coolingBoostSec: CONFIG.COOL_BOOST_DURATION_SEC * CONFIG.PURIFIED_COOLANT_MULTIPLIER
            });
          }
        } else {
          node.processTimer = Math.min(node.processTimer, node.effectiveInterval * 0.5);
        }

        if (node.isOverheated) {
          node.status = 'overheat';
          node.statusLabel = '過熱警報 (50%)';
        } else if (!hasFilterPower) {
          node.status = 'no_power';
          node.statusLabel = '電力待機';
        } else if (!hasDeepWater) {
          node.status = 'no_input';
          node.statusLabel = '深層水待機';
        } else if (node.isCoolBoosted) {
          node.status = 'boosted';
          node.statusLabel = '濾過ブースト (120%)';
        } else {
          node.status = 'running';
          node.statusLabel = '物理濾過中';
        }
      }
      return;
    }

    if (node.partId === 'surface_uplink') {
      node.efficiency = 1.0;
      var capPerSec = proc.bandwidthCapacityPerSec || CONFIG.UPLINK_BANDWIDTH_CAPACITY;
      var budget = capPerSec * dt;

      while (budget > 1e-6 && node.queueItems.length > 0) {
        var head = node.queueItems[0];
        if (head.remainingLoad <= budget + 1e-6) {
          budget -= head.remainingLoad;
          node.queueItems.shift();
          var earned = roundMoney(head.value);
          state.funds = roundMoney(state.funds + earned);
          state.totalEarned = roundMoney(state.totalEarned + earned);
          state.uplinkHistory.push({ time: state.simTime, amount: earned });
          node.producedCount += 1;
          node.beamTimer = proc.beamDurationSec || 0.55;
          node.activeFlashTimer = 0.35;
          node.lastActiveTime = state.simTime;
          if (head.resourceId === 'high_purity_data') {
            node.recentHighPurityTime = state.simTime;
            state.tutorialFlags.highPurityDelivered = true;
          }

          pushFxEvent({
            type: 'cash',
            nodeId: node.id,
            x: node.x + node.width * 0.5,
            y: node.y,
            amount: earned,
            resourceId: head.resourceId
          });
          safeAudio('playCash', earned / RESOURCES.raw_data.baseValue);
        } else {
          head.remainingLoad -= budget;
          budget = 0;
        }
      }

      // 残り負荷総量を再集計
      var totalQ = 0;
      for (var qIdx = 0; qIdx < node.queueItems.length; qIdx += 1) {
        totalQ += Math.max(0, node.queueItems[qIdx].remainingLoad);
      }
      node.queueLoad = Math.round(totalQ * 1000) / 1000;

      // ボトルネック比率（queueLoad >= 2.50 で 0.35 超）
      var threshold = proc.bottleneckQueueThreshold || CONFIG.UPLINK_BOTTLENECK_THRESHOLD;
      var maxQ = proc.maxQueueLoad || CONFIG.UPLINK_QUEUE_MAX;
      var prevRatio = node.bottleneckRatio;
      var ratio;
      if (node.queueLoad <= 0.5) {
        ratio = 0;
      } else if (node.queueLoad < threshold) {
        ratio = ((node.queueLoad - 0.5) / Math.max(0.1, threshold - 0.5)) * 0.35;
      } else {
        ratio = 0.35 + ((node.queueLoad - threshold) / Math.max(1.0, maxQ * 0.55 - threshold)) * 0.65;
      }
      node.bottleneckRatio = clamp(Math.round(ratio * 1000) / 1000, 0, 1);

      if (prevRatio <= 0.35 && node.bottleneckRatio > 0.35) {
        pushFxEvent({
          type: 'bottleneck',
          nodeId: node.id,
          x: node.x,
          y: node.y + node.height * 0.5,
          ratio: node.bottleneckRatio
        });
        safeAudio('playWarning');
        if (!state.tutorialFlags.bottleneckObserved) {
          state.tutorialFlags.bottleneckObserved = true;
          var bnQuip = pickQuip(BOOGIE_QUIPS.bottleneck);
          if (bnQuip) {
            setBoogieOverride(bnQuip.text, bnQuip.mood, 6.0);
          }
        }
      }

      if (node.bottleneckRatio > 0.35) {
        node.status = 'bottleneck';
        node.statusLabel = '帯域渋滞 (' + Math.round(node.bottleneckRatio * 100) + '%)';
      } else if (node.beamTimer > 0 || node.queueItems.length > 0) {
        node.status = 'running';
        node.statusLabel = '送信換金中';
      } else {
        node.status = 'idle';
        node.statusLabel = '受信待機';
      }
      return;
    }

    if (node.partId === 'deep_water_intake') {
      node.efficiency = tidyMult;
      node.effectiveInterval = proc.processInterval / Math.max(0.1, node.efficiency);
      if (node.powerBuffer >= proc.powerCostPerCycle) {
        node.processTimer += dt;
        if (node.processTimer >= node.effectiveInterval) {
          node.processTimer -= node.effectiveInterval;
          node.powerBuffer = Math.max(0, node.powerBuffer - proc.powerCostPerCycle);
          emitPacketFromPort(node, 'out_water', 'deep_water', {
            coolingAmount: RESOURCES.deep_water.coolingAmount,
            coolingBoostSec: CONFIG.COOL_BOOST_DURATION_SEC
          });
        }
        node.status = 'running';
        node.statusLabel = '深層水汲上中';
      } else {
        node.processTimer = Math.min(node.processTimer, node.effectiveInterval * 0.5);
        node.status = 'no_power';
        node.statusLabel = '電力待機';
      }
      return;
    }

    if (node.partId === 'drain_vent') {
      node.efficiency = tidyMult;
      node.effectiveInterval = proc.processInterval / Math.max(0.1, node.efficiency);
      if (node.inputBuffer >= 1) {
        node.processTimer += dt;
        if (node.processTimer >= node.effectiveInterval) {
          node.processTimer -= node.effectiveInterval;
          node.inputBuffer -= 1;
          node.producedCount += 1;
          node.activeFlashTimer = 0.25;
          node.lastActiveTime = state.simTime;
          pushFxEvent({
            type: 'vent_steam',
            nodeId: node.id,
            x: node.x + node.width * 0.5,
            y: node.y,
            count: proc.ventBurstCount || 6
          });
        }
        node.status = 'running';
        node.statusLabel = '温排水放出中';
      } else {
        node.status = 'idle';
        node.statusLabel = '排水待機';
      }
      return;
    }

    if (node.partId === 'hydrothermal_turbine') {
      node.efficiency = tidyMult;
      node.effectiveInterval = proc.processInterval / Math.max(0.1, node.efficiency);
      var outPerHot = proc.outputPerHotWater || 2;

      if (node.pendingPowerOutputs <= 0 && node.inputBuffer >= 1) {
        node.inputBuffer -= 1;
        node.pendingPowerOutputs += outPerHot;
      }

      var isSpinning = node.pendingPowerOutputs > 0 || node.inputBuffer > 0;
      if (node.pendingPowerOutputs > 0) {
        node.processTimer += dt;
        if (node.processTimer >= node.effectiveInterval) {
          node.processTimer -= node.effectiveInterval;
          node.pendingPowerOutputs -= 1;
          if (node.pendingPowerOutputs <= 0 && node.inputBuffer >= 1) {
            node.inputBuffer -= 1;
            node.pendingPowerOutputs += outPerHot;
          }
          emitPacketFromPort(node, 'out_power', 'power', { powerAmount: 1.5 });
          if (!state.tutorialFlags.turbineStarted) {
            state.tutorialFlags.turbineStarted = true;
            pushFxEvent({
              type: 'turbine_start',
              nodeId: node.id,
              x: node.x + node.width * 0.5,
              y: node.y + node.height * 0.5
            });
            var tbQuip = pickQuip(BOOGIE_QUIPS.turbineStart);
            if (tbQuip) {
              setBoogieOverride(tbQuip.text, tbQuip.mood, 5.5);
            }
          }
        }
      } else {
        node.processTimer = 0;
      }

      var maxRpm = proc.maxTurbineRpm || 360;
      var targetRpm = isSpinning
        ? clamp(150 + node.inputBuffer * 40 + node.hotWaterRecentRate * 32, 160, maxRpm)
        : 0;
      node.turbineRpm += (targetRpm - node.turbineRpm) * Math.min(1, dt * 3.5);
      if (node.turbineRpm < 1 && targetRpm === 0) {
        node.turbineRpm = 0;
      }
      node.turbineAngle = (node.turbineAngle + (node.turbineRpm / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
      node.hotWaterRecentRate = Math.max(0, node.hotWaterRecentRate - dt * 0.8);

      if (isSpinning || node.turbineRpm > 20) {
        node.status = 'running';
        node.statusLabel = '発電回転 (' + Math.round(node.turbineRpm) + ' RPM)';
      } else {
        node.status = 'idle';
        node.statusLabel = '温排水待機';
      }
    }
  }

  function updateWireBottleneckFeedback() {
    var uplinkRatios = {};
    for (var i = 0; i < state.nodes.length; i += 1) {
      var n = state.nodes[i];
      if (n.partId === 'surface_uplink') {
        uplinkRatios[n.id] = n.bottleneckRatio || 0;
      }
    }
    for (var c = 0; c < state.connections.length; c += 1) {
      var conn = state.connections[c];
      if (uplinkRatios[conn.toNodeId] !== undefined) {
        var targetRatio = uplinkRatios[conn.toNodeId];
        // 高純度データに切り替わっているケーブルは視覚的にも軽負荷であることが伝わるよう少し緩和する
        var fromNode = findNode(conn.fromNodeId);
        var currentRes = fromNode ? getEffectiveOutputType(fromNode, conn.fromPortId) : conn.resourceId;
        if (currentRes === 'high_purity_data' && targetRatio > 0) {
          conn.bottleneckRatio = Math.round(targetRatio * 0.45 * 1000) / 1000;
        } else {
          conn.bottleneckRatio = targetRatio;
        }
      } else {
        conn.bottleneckRatio = 0;
      }
    }
  }

  function updateGlobalMetrics() {
    // 収益レート（移動平均）
    var cutoff = state.simTime - INCOME_WINDOW_SEC;
    var kept = [];
    var sumEarned = 0;
    for (var i = 0; i < state.uplinkHistory.length; i += 1) {
      var entry = state.uplinkHistory[i];
      if (entry.time >= cutoff) {
        kept.push(entry);
        sumEarned += entry.amount;
      }
    }
    state.uplinkHistory = kept;
    var denom = Math.max(1.0, Math.min(INCOME_WINDOW_SEC, state.simTime || 1.0));
    state.incomeRate = Math.round((sumEarned / denom) * 100) / 100;

    // 電力・最高温度集計
    var batteryMW = 0;
    var turbineMW = 0;
    var activeConsumers = 0;
    var poweredConsumers = 0;
    var maxHeat = CONFIG.BASE_TEMP;

    for (var n = 0; n < state.nodes.length; n += 1) {
      var node = state.nodes[n];
      var part = PARTS_MAP[node.partId];
      if (!part) {
        continue;
      }
      if (node.partId === 'emergency_battery') {
        batteryMW += part.process.powerGeneration || 12;
      } else if (node.partId === 'hydrothermal_turbine') {
        if (node.turbineRpm > 20 || node.pendingPowerOutputs > 0 || node.inputBuffer > 0) {
          turbineMW += part.process.powerGeneration || 18;
        }
      } else if (part.ports && part.ports.inputs) {
        for (var p = 0; p < part.ports.inputs.length; p += 1) {
          if (part.ports.inputs[p].id === 'in_power') {
            activeConsumers += 1;
            if (node.powerBuffer >= 1 || (state.simTime - node.lastActiveTime < 1.5)) {
              poweredConsumers += 1;
            }
            break;
          }
        }
      }
      if (part.heat && part.heat.hasHeat && node.heat > maxHeat) {
        maxHeat = node.heat;
      }
    }

    var activePowerLinks = 0;
    for (var c = 0; c < state.connections.length; c += 1) {
      if (state.connections[c].resourceId === 'power') {
        activePowerLinks += 1;
      }
    }

    state.maxHeat = Math.round(maxHeat * 10) / 10;
    state.powerMetrics = {
      totalGeneration: batteryMW + turbineMW,
      batteryMW: batteryMW,
      turbineMW: turbineMW,
      activeConsumers: activeConsumers,
      poweredConsumers: poweredConsumers,
      activePowerLinks: activePowerLinks,
      satisfactionRatio: activeConsumers > 0 ? clamp(poweredConsumers / activeConsumers, 0, 1) : 1
    };
  }

  function stepSimulation(dt) {
    var safeDt = Number(dt);
    if (!Number.isFinite(safeDt) || safeDt <= 0) {
      return;
    }
    safeDt = Math.min(safeDt, MAX_DT);
    state.simTime += safeDt;

    // 配線ポリラインキャッシュを更新しつつパケット移動
    for (var c = 0; c < state.connections.length; c += 1) {
      var conn = state.connections[c];
      runtime.wireCache[conn.id] = getWirePolyline(conn, state.cableMode);
    }

    stepPackets(safeDt);

    for (var i = 0; i < state.nodes.length; i += 1) {
      stepNode(state.nodes[i], safeDt);
    }

    updateWireBottleneckFeedback();
    updateGlobalMetrics();
    evaluateTutorialProgress({ silent: false });
    computeGuideLinks();

    // オートセーブ積算（5秒ごと、変更があるか動作中のみ）
    state.autosaveAccumulatorSec += safeDt;
    if (state.autosaveAccumulatorSec * 1000 >= CONFIG.AUTOSAVE_INTERVAL_MS) {
      state.autosaveAccumulatorSec = 0;
      saveGame();
    }
  }

  // =========================================================================
  // 9. チュートリアル全チェックリスト評価＆ブギーガイド誘導算出
  // =========================================================================

  function getMetricValue(metricName) {
    switch (metricName) {
      case 'funds':
        return state.funds;
      case 'totalEarned':
        return state.totalEarned;
      case 'incomePerSec':
      case 'incomeRate':
        return state.incomeRate;
      case 'isTidySync':
        return state.isTidySync;
      case 'maxHeat':
        return state.maxHeat;
      default:
        return state[metricName];
    }
  }

  function hasConnectionMatching(fromPart, fromPort, toPart, toPort) {
    for (var i = 0; i < state.connections.length; i += 1) {
      var c = state.connections[i];
      var fn = findNode(c.fromNodeId);
      var tn = findNode(c.toNodeId);
      if (!fn || !tn) {
        continue;
      }
      if (fn.partId === fromPart && c.fromPortId === fromPort && tn.partId === toPart && c.toPortId === toPort) {
        return true;
      }
    }
    return false;
  }

  function hasConnectionFromPart(fromPart, fromPort) {
    for (var i = 0; i < state.connections.length; i += 1) {
      var c = state.connections[i];
      var fn = findNode(c.fromNodeId);
      if (fn && fn.partId === fromPart && c.fromPortId === fromPort) {
        return true;
      }
    }
    return false;
  }

  function countPartNodes(partId) {
    var count = 0;
    for (var i = 0; i < state.nodes.length; i += 1) {
      if (state.nodes[i].partId === partId) {
        count += 1;
      }
    }
    return count;
  }

  function isNodeActiveAndConnectedTo(node, targetPartId) {
    var part = PARTS_MAP[node.partId];
    if (!part) {
      return false;
    }

    // 冷却ポート以外の必須入力に1本以上接続があるか確認
    var inputs = (part.ports && part.ports.inputs) || [];
    for (var i = 0; i < inputs.length; i += 1) {
      var inp = inputs[i];
      if (inp.role === 'coolant') {
        continue;
      }
      if (getIncomingConnections(node.id, inp.id).length === 0) {
        return false;
      }
    }

    // 指定先パーツへの出力接続があるか確認
    for (var c = 0; c < state.connections.length; c += 1) {
      var conn = state.connections[c];
      if (conn.fromNodeId === node.id) {
        var tn = findNode(conn.toNodeId);
        if (tn && tn.partId === targetPartId) {
          return true;
        }
      }
    }
    return false;
  }

  function getMaxUplinkBottleneckRatio() {
    var maxRatio = 0;
    for (var i = 0; i < state.nodes.length; i += 1) {
      var n = state.nodes[i];
      if (n.partId === 'surface_uplink' && n.bottleneckRatio > maxRatio) {
        maxRatio = n.bottleneckRatio;
      }
    }
    return maxRatio;
  }

  function isHighPurityFlowingToUplink() {
    if (state.tutorialFlags.highPurityDelivered) {
      return true;
    }
    // 現在パケットが送信中、または高純度設定モジュールがアップリンクに接続済み
    for (var p = 0; p < state.packets.length; p += 1) {
      if (state.packets[p].resourceId === 'high_purity_data') {
        return true;
      }
    }
    for (var c = 0; c < state.connections.length; c += 1) {
      var conn = state.connections[c];
      var fn = findNode(conn.fromNodeId);
      var tn = findNode(conn.toNodeId);
      if (fn && tn && tn.partId === 'surface_uplink') {
        if (getEffectiveOutputType(fn, conn.fromPortId) === 'high_purity_data') {
          return true;
        }
      }
    }
    return false;
  }

  function evaluateChecklistItem(item) {
    if (!item || !item.type) {
      return false;
    }

    switch (item.type) {
      case 'connection':
        return hasConnectionMatching(item.fromPart, item.fromPort, item.toPart, item.toPort);

      case 'metric':
        return Number(getMetricValue(item.metric)) >= Number(item.target || 0);

      case 'count':
        return countPartNodes(item.partId) >= Number(item.target || 1);

      case 'active_connected_count': {
        var activeCount = 0;
        for (var i = 0; i < state.nodes.length; i += 1) {
          var node = state.nodes[i];
          if (node.partId === item.partId && isNodeActiveAndConnectedTo(node, item.targetPartId)) {
            activeCount += 1;
          }
        }
        return activeCount >= Number(item.target || 1);
      }

      case 'module_precision': {
        var minP = Number(item.minPrecision || 65);
        var reqCount = Number(item.targetCount || 1);
        var matched = 0;
        for (var m = 0; m < state.nodes.length; m += 1) {
          var mod = state.nodes[m];
          if (
            mod.partId === 'generic_module' &&
            (!mod.config || mod.config.mode !== 'filter') &&
            Number(mod.config ? mod.config.precision : 20) >= minP
          ) {
            matched += 1;
          }
        }
        return matched >= reqCount;
      }

      case 'clear_bottleneck_with_purity': {
        var maxBn = getMaxUplinkBottleneckRatio();
        if (maxBn > 0.35) {
          return false;
        }
        // 高純度データが一度でもアップリンクに届いた（または現在高純度接続稼働中）かつ、
        // 2台以上がアップリンク接続されていること
        var connectedModules = 0;
        for (var k = 0; k < state.nodes.length; k += 1) {
          if (state.nodes[k].partId === 'generic_module' && isNodeActiveAndConnectedTo(state.nodes[k], 'surface_uplink')) {
            connectedModules += 1;
          }
        }
        return connectedModules >= 2 && isHighPurityFlowingToUplink() && state.tutorialFlags.highPurityDelivered;
      }

      case 'parts_present': {
        var ids = item.partIds || [];
        for (var pIdx = 0; pIdx < ids.length; pIdx += 1) {
          if (countPartNodes(ids[pIdx]) < 1) {
            return false;
          }
        }
        return ids.length > 0;
      }

      case 'connection_from_part':
        return hasConnectionFromPart(item.fromPart, item.fromPort);

      case 'metric_bool':
        return Boolean(getMetricValue(item.metric));

      case 'filter_mode_active': {
        var hasFilterNode = false;
        for (var f = 0; f < state.nodes.length; f += 1) {
          var fn = state.nodes[f];
          if (fn.partId === 'generic_module' && fn.config && fn.config.mode === 'filter') {
            hasFilterNode = true;
            break;
          }
        }
        return hasFilterNode && state.tutorialFlags.filterProduced;
      }

      case 'metric_or': {
        var checks = item.checks || [];
        for (var q = 0; q < checks.length; q += 1) {
          if (Number(getMetricValue(checks[q].metric)) >= Number(checks[q].target || 0)) {
            return true;
          }
        }
        return false;
      }

      default:
        return false;
    }
  }

  function refreshBoogieMessageForStep(stepDef) {
    if (!stepDef) {
      return;
    }
    if (state.boogieOverrideMessage && state.simTime < state.boogieOverrideMessage.untilSimTime) {
      state.boogieMessage = state.boogieOverrideMessage.text;
      state.boogieMood = state.boogieOverrideMessage.mood;
      return;
    }
    state.boogieOverrideMessage = null;

    var msg = stepDef.message;
    var mood = stepDef.mood || 'happy';
    var sub = stepDef.subMessages || {};

    if (stepDef.step === 1) {
      var powerCable = state.checklistStatus.s1_power_cable;
      var powerMod = state.checklistStatus.s1_power_module;
      var rawToMod = state.checklistStatus.s1_raw_to_module;
      if (rawToMod && !state.checklistStatus.s1_module_to_uplink && sub.dataReady) {
        msg = sub.dataReady;
        mood = 'excited';
      } else if (powerCable && powerMod && !rawToMod && sub.powerReady) {
        msg = sub.powerReady;
        mood = 'happy';
      }
    } else if (stepDef.step === 2) {
      if (getMaxUplinkBottleneckRatio() > 0.35 && !state.checklistStatus.s2_set_precision && sub.bottleneckDetected) {
        msg = sub.bottleneckDetected;
        mood = 'alert';
      } else if (state.checklistStatus.s2_set_precision && !state.checklistStatus.s2_clear_bottleneck && sub.precisionReady) {
        msg = sub.precisionReady;
        mood = 'excited';
      }
    } else if (stepDef.step === 3) {
      if (state.checklistStatus.s3_cool_module && !state.checklistStatus.s3_drain_waste && sub.waterConnected) {
        msg = sub.waterConnected;
        mood = 'happy';
      }
    } else if (stepDef.step === 4) {
      if (state.tutorialFlags.turbineStarted && !state.checklistStatus.s4_turbine_power && sub.turbineSpinning) {
        msg = sub.turbineSpinning;
        mood = 'excited';
      }
    } else if (stepDef.step === 5) {
      if (state.isTidySync && sub.tidyAchieved) {
        msg = sub.tidyAchieved;
        mood = 'excited';
      }
    }

    state.boogieMessage = msg;
    state.boogieMood = mood;
  }

  function evaluateTutorialProgress(options) {
    var opts = options || {};
    var stepIndex = clamp(state.tutorialStep, 1, TUTORIAL_STEPS.length) - 1;
    var stepDef = TUTORIAL_STEPS[stepIndex];
    if (!stepDef) {
      return { advanced: false, step: state.tutorialStep };
    }

    var allDone = true;
    var statusMap = {};
    for (var i = 0; i < stepDef.checklist.length; i += 1) {
      var item = stepDef.checklist[i];
      var done = evaluateChecklistItem(item);
      statusMap[item.id] = done;
      if (!done) {
        allDone = false;
      }
    }
    state.checklistStatus = statusMap;

    var advanced = false;
    if (allDone && state.tutorialStep < TUTORIAL_STEPS.length) {
      var nextStep = state.tutorialStep + 1;
      var nextDef = TUTORIAL_STEPS[nextStep - 1];
      state.tutorialStep = nextStep;
      advanced = true;

      // 新規パーツのアンロックをマージ
      if (nextDef && Array.isArray(nextDef.unlocks)) {
        for (var u = 0; u < nextDef.unlocks.length; u += 1) {
          var pid = nextDef.unlocks[u];
          if (state.unlockedParts.indexOf(pid) === -1) {
            state.unlockedParts.push(pid);
          }
        }
      }

      // 助成金の重複なし付与
      var grant = nextDef && Number.isFinite(nextDef.grantFunds) ? nextDef.grantFunds : 0;
      if (grant > 0 && state.grantedSteps.indexOf(nextStep) === -1) {
        state.funds = roundMoney(state.funds + grant);
        state.grantedSteps.push(nextStep);
      } else if (state.grantedSteps.indexOf(nextStep) === -1) {
        state.grantedSteps.push(nextStep);
      }

      state.boogieOverrideMessage = null;
      stepDef = nextDef || stepDef;
      // 遷移直後のチェックリストも更新
      var nextStatusMap = {};
      for (var j = 0; j < stepDef.checklist.length; j += 1) {
        nextStatusMap[stepDef.checklist[j].id] = evaluateChecklistItem(stepDef.checklist[j]);
      }
      state.checklistStatus = nextStatusMap;
      state.isDirty = true;

      pushFxEvent({
        type: 'step_unlock',
        step: nextStep,
        title: stepDef.title,
        grantFunds: grant,
        unlocks: stepDef.unlocks ? stepDef.unlocks.slice() : []
      });

      if (!opts.silent) {
        safeAudio('playUnlock');
        safeAudio('playBoogieTalk', stepDef.mood || 'excited');
        saveGame();
      }
    }

    refreshBoogieMessageForStep(stepDef);

    return {
      advanced: advanced,
      step: state.tutorialStep,
      checklistStatus: state.checklistStatus
    };
  }

  function findPairNodesForGuide(fromPart, fromPort, toPart, toPort) {
    var fromCandidates = [];
    var toCandidates = [];
    for (var i = 0; i < state.nodes.length; i += 1) {
      var n = state.nodes[i];
      if (n.partId === fromPart) {
        fromCandidates.push(n);
      }
      if (n.partId === toPart) {
        toCandidates.push(n);
      }
    }
    if (fromCandidates.length === 0 || toCandidates.length === 0) {
      return null;
    }

    // まだ (fromNode, fromPort) -> (toNode, toPort) が未接続のペア、かつ受け口が少ないノードを優先
    for (var t = toCandidates.length - 1; t >= 0; t -= 1) {
      var tn = toCandidates[t];
      var existingIncoming = getIncomingConnections(tn.id, toPort).length;
      if (existingIncoming === 0) {
        for (var f = 0; f < fromCandidates.length; f += 1) {
          var fn = fromCandidates[f];
          if (fn.id !== tn.id && canConnect(fn.id, fromPort, tn.id, toPort).ok) {
            return { fromNode: fn, toNode: tn };
          }
        }
      }
    }

    for (var t2 = toCandidates.length - 1; t2 >= 0; t2 -= 1) {
      var tn2 = toCandidates[t2];
      for (var f2 = 0; f2 < fromCandidates.length; f2 += 1) {
        var fn2 = fromCandidates[f2];
        if (fn2.id !== tn2.id && canConnect(fn2.id, fromPort, tn2.id, toPort).ok) {
          return { fromNode: fn2, toNode: tn2 };
        }
      }
    }
    return null;
  }

  function compactGuidePortLabel(portLabel) {
    if (typeof portLabel !== 'string') {
      return '';
    }
    var parenIdx = portLabel.indexOf('（');
    if (parenIdx > 0) {
      return portLabel.slice(0, parenIdx);
    }
    return portLabel;
  }

  function buildConnectGuideLink(fromNode, fromPort, toNode, toPort, hintText, isEncyclopedia) {
    var p0 = getPortPosition(fromNode, fromPort);
    var p1 = getPortPosition(toNode, toPort);
    if (!p0 || !p1) {
      return null;
    }
    var resId = getEffectiveOutputType(fromNode, fromPort);
    var color = (RESOURCES[resId] && RESOURCES[resId].color) || p0.portDef.color || CONFIG.PALETTE.CYAN_NEON;
    var shortFrom = compactGuidePortLabel(p0.portDef.label);
    var shortTo = compactGuidePortLabel(p1.portDef.label);
    return {
      kind: 'connect',
      fromNodeId: fromNode.id,
      fromPortId: fromPort,
      fromX: p0.x,
      fromY: p0.y,
      toNodeId: toNode.id,
      toPortId: toPort,
      toX: p1.x,
      toY: p1.y,
      color: color,
      resourceId: resId,
      label: shortFrom + ' ➔ ' + shortTo,
      hintText: hintText || '',
      isEncyclopediaGuide: Boolean(isEncyclopedia)
    };
  }

  function findGuidePlacementSpot(partId) {
    var vw = state.viewport.width;
    var vh = state.viewport.height;
    var area = getSafePlayArea(vw, vh);
    var part = PARTS_MAP[partId];
    var pw = part && Number.isFinite(part.width) ? part.width : 168;
    var ph = part && Number.isFinite(part.height) ? part.height : 112;

    var preferredXRatio = 0.48;
    var preferredYRatio = 0.76;
    if (partId === 'deep_water_intake' || partId === 'emergency_battery' || partId === 'submarine_cable') {
      preferredXRatio = 0.38;
    } else if (partId === 'drain_vent') {
      preferredXRatio = 0.62;
    } else if (partId === 'hydrothermal_turbine' || partId === 'surface_uplink') {
      preferredXRatio = 0.58;
    } else if (partId === 'generic_module') {
      preferredXRatio = 0.48;
    }

    var xRatios = [preferredXRatio, 0.48, 0.38, 0.58, 0.64, 0.32, 0.72, 0.24];
    var yRatios = [preferredYRatio, 0.72, 0.82, 0.64, 0.52, 0.34];
    var inspRight = vw >= 1121 ? getInspectorReservedWidth(vw) + 12 : 0;

    var bestCenter = null;
    var bestScore = Infinity;

    for (var yi = 0; yi < yRatios.length; yi += 1) {
      for (var xi = 0; xi < xRatios.length; xi += 1) {
        var rawX = area.left + area.width * xRatios[xi] - pw * 0.5;
        var rawY = area.top + area.height * yRatios[yi] - ph * 0.5;
        var clamped = clampNodePosition(rawX, rawY, pw, ph, state.viewport);

        var overlapScore = 0;
        for (var n = 0; n < state.nodes.length; n += 1) {
          var existing = state.nodes[n];
          if (rectsOverlap(clamped.x, clamped.y, pw, ph, existing.x, existing.y, existing.width, existing.height, 18)) {
            var ox = Math.max(0, Math.min(clamped.x + pw + 18, existing.x + existing.width) - Math.max(clamped.x - 18, existing.x));
            var oy = Math.max(0, Math.min(clamped.y + ph + 18, existing.y + existing.height) - Math.max(clamped.y - 18, existing.y));
            overlapScore += Math.max(1, ox * oy);
          }
        }

        // 1121px以上では既存ノードと非重複かつ #node-inspector 右端外にある候補を最優先
        var inspectorPenalty = inspRight > 0 && clamped.x < inspRight ? 500 : 0;
        var totalScore = overlapScore + inspectorPenalty;

        if (totalScore === 0) {
          return {
            x: Math.round(clamped.x + pw * 0.5),
            y: Math.round(clamped.y + ph * 0.5)
          };
        }

        if (totalScore < bestScore) {
          bestScore = totalScore;
          bestCenter = {
            x: Math.round(clamped.x + pw * 0.5),
            y: Math.round(clamped.y + ph * 0.5)
          };
        }
      }
    }

    if (bestCenter) {
      return bestCenter;
    }
    return {
      x: Math.round(area.left + area.width * preferredXRatio),
      y: Math.round(area.top + area.height * preferredYRatio)
    };
  }

  function computeGuideLinks() {
    var links = [];

    // 1. 図鑑のお手本ガイドが有効ならそちらを最優先で組み立てる
    var guidePartId = state.activeEncyclopediaGuidePartId;
    if (guidePartId && ENCYCLOPEDIA[guidePartId]) {
      var encEntry = ENCYCLOPEDIA[guidePartId];
      var guidePartDef = PARTS_MAP[guidePartId];
      var preset = Array.isArray(encEntry.guidePreset) ? encEntry.guidePreset : [];
      for (var g = 0; g < preset.length; g += 1) {
        var pr = preset[g];
        var pair = findPairNodesForGuide(pr.fromPart, pr.fromPort, pr.toPart, pr.toPort);
        if (pair) {
          var gl = buildConnectGuideLink(
            pair.fromNode,
            pr.fromPort,
            pair.toNode,
            pr.toPort,
            encEntry.title + ' のお手本接続',
            true
          );
          if (gl) {
            links.push(gl);
          }
        }
      }

      // 対象パーツまたは接続先が盤面に未配置で接続ガイドが作れない場合、
      // 下部ドックからの配置案内・空き配置候補座標を指すフォールバックガイドを必ず1件以上生成
      if (links.length === 0) {
        var targetOnBoard = null;
        for (var hn = state.nodes.length - 1; hn >= 0; hn -= 1) {
          if (state.nodes[hn].partId === guidePartId) {
            targetOnBoard = state.nodes[hn];
            break;
          }
        }

        if (!targetOnBoard) {
          var spot = findGuidePlacementSpot(guidePartId);
          var unlocked = isPartUnlocked(guidePartId);
          var accentColor = (guidePartDef && guidePartDef.theme && guidePartDef.theme.accent) || CONFIG.PALETTE.CYAN_NEON;
          var partName = (guidePartDef && guidePartDef.name) || encEntry.title;
          var costLabel = guidePartDef ? '$' + guidePartDef.cost : '';
          var unlockStepNum = guidePartDef && guidePartDef.unlockStep ? guidePartDef.unlockStep : 1;

          var fallbackLabel = unlocked
            ? partName + ' (' + costLabel + ') を配置'
            : 'STEP ' + unlockStepNum + '解放: ' + partName + 'を配置';
          var fallbackHint = unlocked
            ? '「' + partName + '」がまだ盤面にありません。下部パーツドックから ' + costLabel + ' でこの付近へ配置すると、お手本接続を案内します。'
            : '「' + partName + '」は STEP ' + unlockStepNum + ' で解放されます。解放後、下部パーツドックからこの付近へ配置できます。';

          links.push({
            kind: 'place',
            partId: guidePartId,
            targetX: spot.x,
            targetY: spot.y,
            color: accentColor,
            label: fallbackLabel,
            hintText: fallbackHint,
            isEncyclopediaGuide: true,
            isFallbackPlace: true,
            isUnlocked: unlocked
          });
        } else {
          var missingPartnerId = null;
          for (var mp = 0; mp < preset.length; mp += 1) {
            if (preset[mp].fromPart !== guidePartId && countPartNodes(preset[mp].fromPart) === 0) {
              missingPartnerId = preset[mp].fromPart;
              break;
            }
            if (preset[mp].toPart !== guidePartId && countPartNodes(preset[mp].toPart) === 0) {
              missingPartnerId = preset[mp].toPart;
              break;
            }
          }

          if (missingPartnerId && PARTS_MAP[missingPartnerId]) {
            var partnerPart = PARTS_MAP[missingPartnerId];
            var pSpot = findGuidePlacementSpot(missingPartnerId);
            var partnerUnlocked = isPartUnlocked(missingPartnerId);
            links.push({
              kind: 'place',
              partId: missingPartnerId,
              targetX: pSpot.x,
              targetY: pSpot.y,
              color: (partnerPart.theme && partnerPart.theme.accent) || CONFIG.PALETTE.CYAN_NEON,
              label: partnerUnlocked
                ? partnerPart.name + ' ($' + partnerPart.cost + ') を配置'
                : 'STEP ' + partnerPart.unlockStep + '解放: ' + partnerPart.name + 'を配置',
              hintText: '「' + encEntry.title + '」と接続する「' + partnerPart.name + '」をこの付近へ配置してください。',
              isEncyclopediaGuide: true,
              isFallbackPlace: true,
              isUnlocked: partnerUnlocked
            });
          } else {
            links.push({
              kind: 'node',
              nodeId: targetOnBoard.id,
              partId: guidePartId,
              x: targetOnBoard.x,
              y: targetOnBoard.y,
              width: targetOnBoard.width,
              height: targetOnBoard.height,
              color: (guidePartDef && guidePartDef.theme && guidePartDef.theme.accent) || CONFIG.PALETTE.CYAN_NEON,
              label: encEntry.title + '（お手本対象）',
              hintText: '「' + encEntry.title + '」のポート接続状況や動作モードを詳細パネルで確認しましょう。',
              isEncyclopediaGuide: true
            });
          }
        }
      }

      state.guideLinks = links;
      return links;
    }

    // 2. 現在のチュートリアルステップに基づく動的ガイド
    var stepDef = TUTORIAL_STEPS[clamp(state.tutorialStep, 1, TUTORIAL_STEPS.length) - 1];
    if (!stepDef || !Array.isArray(stepDef.guideTargets)) {
      state.guideLinks = links;
      return links;
    }

    for (var i = 0; i < stepDef.guideTargets.length; i += 1) {
      var gt = stepDef.guideTargets[i];
      if (gt.checklistId && state.checklistStatus[gt.checklistId]) {
        continue;
      }

      if (gt.type === 'connect') {
        // Step 2 で2台目モジュールへの電力・生データが未接続なら、まずそちらを補足誘導
        if (gt.checklistId === 's2_connect_second_module') {
          var modules = [];
          for (var m = 0; m < state.nodes.length; m += 1) {
            if (state.nodes[m].partId === 'generic_module') {
              modules.push(state.nodes[m]);
            }
          }
          var targetMod = modules.length >= 2 ? modules[modules.length - 1] : null;
          if (targetMod) {
            if (getIncomingConnections(targetMod.id, 'in_power').length === 0) {
              var batPair = findPairNodesForGuide('emergency_battery', 'out_power', 'generic_module', 'in_power');
              if (batPair) {
                var powGl = buildConnectGuideLink(batPair.fromNode, 'out_power', targetMod, 'in_power', '2台目の汎用モジュールへ電力を分岐してください', false);
                if (powGl) {
                  links.push(powGl);
                }
              }
            }
            if (getIncomingConnections(targetMod.id, 'in_primary').length === 0) {
              var cabPair = findPairNodesForGuide('submarine_cable', 'out_raw', 'generic_module', 'in_primary');
              if (cabPair) {
                var rawGl = buildConnectGuideLink(cabPair.fromNode, 'out_raw', targetMod, 'in_primary', '海底光ケーブルから2台目へ生データを分岐してください', false);
                if (rawGl) {
                  links.push(rawGl);
                }
              }
            }
          }
        }

        var cPair = findPairNodesForGuide(gt.fromPart, gt.fromPort, gt.toPart, gt.toPort);
        if (cPair) {
          var linkObj = buildConnectGuideLink(cPair.fromNode, gt.fromPort, cPair.toNode, gt.toPort, gt.hintText, false);
          if (linkObj) {
            links.push(linkObj);
            break;
          }
        }
      } else if (gt.type === 'place') {
        var placeSpot = findGuidePlacementSpot(gt.partId);
        var part = PARTS_MAP[gt.partId];
        links.push({
          kind: 'place',
          partId: gt.partId,
          targetX: placeSpot.x,
          targetY: placeSpot.y,
          color: (part && part.theme && part.theme.accent) || CONFIG.PALETTE.CYAN_NEON,
          label: (part ? part.name : gt.partId) + ' を配置',
          hintText: gt.hintText,
          isEncyclopediaGuide: false
        });
        break;
      } else if (gt.type === 'inspect_slider' || gt.type === 'mode_filter') {
        var targetNode = null;
        for (var n = state.nodes.length - 1; n >= 0; n -= 1) {
          if (state.nodes[n].partId === gt.partId) {
            targetNode = state.nodes[n];
            break;
          }
        }
        if (targetNode) {
          links.push({
            kind: 'node',
            nodeId: targetNode.id,
            partId: targetNode.partId,
            x: targetNode.x,
            y: targetNode.y,
            width: targetNode.width,
            height: targetNode.height,
            color: CONFIG.PALETTE.TIDY_GOLD,
            label: gt.type === 'mode_filter' ? '物理濾過モードへ切替' : '精度65%以上へ調整',
            hintText: gt.hintText,
            isEncyclopediaGuide: false
          });
          break;
        }
      } else if (gt.type === 'tidy_hint') {
        links.push({
          kind: 'hint',
          color: CONFIG.PALETTE.TIDY_GLOW,
          label: '整頓シンクロを目指そう',
          hintText: gt.hintText,
          isEncyclopediaGuide: false
        });
        break;
      }
    }

    state.guideLinks = links;
    return links;
  }

  function getGuideLinks() {
    if (!state.guideLaserEnabled && !state.activeEncyclopediaGuidePartId) {
      return [];
    }
    return state.guideLinks;
  }

  function pokeBoogie() {
    var q = pickQuip(BOOGIE_QUIPS.poke);
    if (q) {
      setBoogieOverride(q.text, q.mood, 5.5);
      safeAudio('playBoogieTalk', q.mood);
    }
    return {
      ok: true,
      message: state.boogieMessage,
      mood: state.boogieMood
    };
  }

  // =========================================================================
  // 10. 初期レイアウト生成＆セーブ／ロード／リセット
  // =========================================================================

  function getInspectorReservedWidth(viewportWidth) {
    var vw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : state.viewport.width;
    // style.css 各ブレークポイントの padding-left + #node-inspector 幅（右端基準）
    if (vw >= 1281) {
      return 12 + 286;
    }
    if (vw >= 1121) {
      return 10 + 278;
    }
    if (vw >= 821) {
      return 8 + 274;
    }
    return 8 + Math.min(286, Math.max(220, vw - 16));
  }

  function buildInitialLayoutNodes(viewport) {
    var vw = viewport && viewport.width ? viewport.width : state.viewport.width;
    var vh = viewport && viewport.height ? viewport.height : state.viewport.height;
    var refH = INITIAL_LAYOUT.referenceViewport.height;
    var area = getSafePlayArea(vw, vh);

    // 初期4ノードをX順に整列し、固定幅を保ったままギャップだけスケーリングする
    var specs = INITIAL_LAYOUT.nodes.slice().sort(function (a, b) {
      return a.x - b.x;
    });

    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    var totalNodeWidth = 0;

    for (var i = 0; i < specs.length; i += 1) {
      var spec = specs[i];
      var part = PARTS_MAP[spec.partId];
      var pw = part ? part.width : 160;
      var ph = part ? part.height : 100;
      totalNodeWidth += pw;
      if (spec.x < minX) minX = spec.x;
      if (spec.y < minY) minY = spec.y;
      if (spec.x + pw > maxX) maxX = spec.x + pw;
      if (spec.y + ph > maxY) maxY = spec.y + ph;
    }

    var groupW = Math.max(1, maxX - minX);
    var groupH = Math.max(1, maxY - minY);
    var refGapTotal = Math.max(1, groupW - totalNodeWidth);
    var gapScaleX = 1.0;
    var targetOriginX = area.left;

    if (vw >= 1121) {
      // 1121px以上では左パネル #node-inspector を開いた場合も init_battery（左ポート突出約10px込み）と被らない位置へ配置
      var inspectorRight = getInspectorReservedWidth(vw);
      var inspectorClearX = inspectorRight + (vw >= 1281 ? 18 : 22);
      var safeLeftMin = Math.max(area.left, inspectorClearX);
      var rightBreath = clamp(Math.round(vw * 0.036), 28, 56);
      var preferredRight = Math.min(
        area.right - 8,
        Math.max(safeLeftMin + totalNodeWidth + 36, area.right - rightBreath)
      );
      var clearSpan = Math.max(totalNodeWidth + 36, preferredRight - safeLeftMin);
      var maxGapScale = vw > 1440 ? 1.15 : 1.0;
      gapScaleX = clamp((clearSpan - totalNodeWidth) / refGapTotal, 0.30, maxGapScale);

      var spanAfterScale = totalNodeWidth + refGapTotal * gapScaleX;
      var centeredOriginX = area.left + Math.max(0, (area.width - spanAfterScale) * 0.44);
      targetOriginX = Math.max(centeredOriginX, safeLeftMin);
      if (targetOriginX + spanAfterScale > area.right - 8) {
        targetOriginX = Math.max(area.left, area.right - 8 - spanAfterScale);
      }
    } else {
      // 1120px以下（1000×720帯域含む）は getSafePlayArea() 内の左右余白バランスを保って収める
      var sideBreath = clamp(Math.round(area.width * 0.042), 14, 38);
      var balancedSpan = Math.max(totalNodeWidth + 36, area.width - sideBreath * 2);
      gapScaleX = clamp((balancedSpan - totalNodeWidth) / refGapTotal, 0.25, 1.0);
      var narrowGroupW = totalNodeWidth + refGapTotal * gapScaleX;
      targetOriginX = area.left + Math.max(0, (area.width - narrowGroupW) * 0.5);
    }

    var scaleY = clamp(
      area.height / Math.max(300, refH - CONFIG.SAFE_MARGIN_TOP - CONFIG.SAFE_MARGIN_BOTTOM),
      0.58,
      1.18
    );
    if (vh <= refH) {
      scaleY = Math.min(scaleY, 1.0);
    }

    // 計算上の各ノード位置（グループローカル座標）
    var localPositions = [];
    var cursorX = 0;
    var prevRefRight = minX;
    for (var k = 0; k < specs.length; k += 1) {
      var sp = specs[k];
      var pt = PARTS_MAP[sp.partId];
      var w = pt ? pt.width : 160;
      var h = pt ? pt.height : 100;
      if (k === 0) {
        cursorX = 0;
      } else {
        var refGap = Math.max(18, sp.x - prevRefRight);
        cursorX += refGap * gapScaleX;
      }
      localPositions.push({
        spec: sp,
        lx: cursorX,
        ly: (sp.y - minY) * scaleY,
        w: w,
        h: h
      });
      cursorX += w;
      prevRefRight = sp.x + w;
    }

    var actualGroupH = groupH * scaleY;
    var targetOriginY = area.top + Math.max(10, Math.min((area.height - actualGroupH) * 0.28, vh * 0.115));

    // 右側ノード（uplink等）が右下ブギー領域の上端より上に収まるようY基準を調整
    var br = area.boogieRect;
    for (var m = 0; m < localPositions.length; m += 1) {
      var lp = localPositions[m];
      var testX = targetOriginX + lp.lx;
      var testY = targetOriginY + lp.ly;
      if (testX + lp.w + 8 > br.left && testY + lp.h + 10 > br.top) {
        var shiftUp = (testY + lp.h + 10) - br.top;
        targetOriginY = Math.max(area.top + 4, targetOriginY - shiftUp);
      }
    }

    var createdNodes = [];
    for (var j = 0; j < localPositions.length; j += 1) {
      var item = localPositions[j];
      var nx = targetOriginX + item.lx;
      var ny = targetOriginY + item.ly;
      var node = createNodeInstance(item.spec.partId, nx, ny, {
        id: item.spec.id,
        isStarter: item.spec.isStarter,
        allowDelete: item.spec.allowDelete,
        config: item.spec.config
      });
      if (node) {
        createdNodes.push(node);
      }
    }
    return createdNodes;
  }

  function applyInitialGameState(options) {
    var opts = options || {};
    var keepViewport = {
      width: (opts.viewport && opts.viewport.width) || state.viewport.width || INITIAL_LAYOUT.referenceViewport.width,
      height: (opts.viewport && opts.viewport.height) || state.viewport.height || INITIAL_LAYOUT.referenceViewport.height
    };
    var keepMuted = opts.preserveMute ? state.muted : false;

    state = createEmptyState();
    state.viewport = keepViewport;
    state.muted = keepMuted;
    state.nodes = buildInitialLayoutNodes(keepViewport);
    state.connections = [];
    state.packets = [];

    if (Array.isArray(INITIAL_LAYOUT.cables)) {
      for (var i = 0; i < INITIAL_LAYOUT.cables.length; i += 1) {
        var c = INITIAL_LAYOUT.cables[i];
        connectPorts(c.fromNodeId, c.fromPortId, c.toNodeId, c.toPortId, { silent: true });
      }
    }

    syncNextIdSeq();
    evaluateTidySync({ silent: true });
    evaluateTutorialProgress({ silent: true });
    updateGlobalMetrics();
    computeGuideLinks();
    state.isDirty = false;
  }

  function serializeSaveData() {
    return {
      version: SAVE_SCHEMA_VERSION,
      savedAt: Date.now(),
      funds: roundMoney(state.funds),
      totalEarned: roundMoney(state.totalEarned),
      tutorialStep: clamp(state.tutorialStep, 1, TUTORIAL_STEPS.length),
      unlockedParts: state.unlockedParts.slice(),
      grantedSteps: state.grantedSteps.slice(),
      cableMode: state.cableMode === 'ortho' ? 'ortho' : 'bezier',
      muted: Boolean(state.muted),
      guideLaserEnabled: Boolean(state.guideLaserEnabled),
      activeEncyclopediaGuidePartId: state.activeEncyclopediaGuidePartId || null,
      tutorialFlags: Object.assign({}, state.tutorialFlags),
      nodes: state.nodes.map(function (n) {
        return {
          id: n.id,
          partId: n.partId,
          x: Math.round(n.x),
          y: Math.round(n.y),
          isStarter: Boolean(n.isStarter),
          allowDelete: Boolean(n.allowDelete),
          config: Object.assign({}, n.config),
          heat: Math.round(n.heat * 100) / 100,
          powerBuffer: Math.round(n.powerBuffer * 100) / 100,
          inputBuffer: Math.round(n.inputBuffer * 100) / 100,
          coolantItems: n.coolantItems.slice(),
          coolBoostTimer: Math.round(n.coolBoostTimer * 100) / 100,
          isOverheated: Boolean(n.isOverheated),
          producedCount: n.producedCount || 0
        };
      }),
      connections: state.connections.map(function (c) {
        return {
          id: c.id,
          fromNodeId: c.fromNodeId,
          fromPortId: c.fromPortId,
          toNodeId: c.toNodeId,
          toPortId: c.toPortId,
          resourceId: c.resourceId
        };
      })
    };
  }

  function saveGame() {
    var storage = getSafeStorage();
    var payload = serializeSaveData();
    var jsonStr = JSON.stringify(payload);
    state.lastSaveAt = payload.savedAt;
    state.isDirty = false;
    if (storage) {
      try {
        storage.setItem(CONFIG.SAVE_KEY, jsonStr);
        pushFxEvent({ type: 'autosave', savedAt: payload.savedAt });
        return { ok: true, savedAt: payload.savedAt, size: jsonStr.length };
      } catch (err) {
        return { ok: false, reason: 'STORAGE_WRITE_ERROR', message: String(err && err.message ? err.message : err) };
      }
    }
    return { ok: true, savedAt: payload.savedAt, inMemoryOnly: true };
  }

  function hydrateFromParsedSave(parsed, options) {
    var opts = options || {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'CORRUPT_SCHEMA', message: 'セーブデータ形式が不正です。' };
    }
    if (!Number.isFinite(parsed.version) || parsed.version < 1 || parsed.version > SAVE_SCHEMA_VERSION) {
      return { ok: false, reason: 'UNSUPPORTED_VERSION', message: '未対応のセーブバージョンです。' };
    }
    if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
      return { ok: false, reason: 'EMPTY_NODES', message: 'ノードデータが空または破損しています。' };
    }

    var viewport = {
      width: (opts.viewport && opts.viewport.width) || state.viewport.width || INITIAL_LAYOUT.referenceViewport.width,
      height: (opts.viewport && opts.viewport.height) || state.viewport.height || INITIAL_LAYOUT.referenceViewport.height
    };

    var fresh = createEmptyState();
    fresh.viewport = viewport;
    fresh.funds = Number.isFinite(parsed.funds) && parsed.funds >= 0 ? roundMoney(parsed.funds) : CONFIG.INITIAL_FUNDS;
    fresh.totalEarned = Number.isFinite(parsed.totalEarned) && parsed.totalEarned >= 0 ? roundMoney(parsed.totalEarned) : 0;
    fresh.tutorialStep = clamp(Math.floor(Number(parsed.tutorialStep) || 1), 1, TUTORIAL_STEPS.length);
    fresh.cableMode = parsed.cableMode === 'ortho' ? 'ortho' : 'bezier';
    fresh.muted = Boolean(parsed.muted);
    fresh.guideLaserEnabled = parsed.guideLaserEnabled !== undefined ? Boolean(parsed.guideLaserEnabled) : true;
    fresh.activeEncyclopediaGuidePartId =
      typeof parsed.activeEncyclopediaGuidePartId === 'string' && PARTS_MAP[parsed.activeEncyclopediaGuidePartId]
        ? parsed.activeEncyclopediaGuidePartId
        : null;

    // ステップまでの解放済みパーツを保証
    var unlockSet = {};
    for (var s = 0; s < fresh.tutorialStep; s += 1) {
      var st = TUTORIAL_STEPS[s];
      if (st && Array.isArray(st.unlocks)) {
        for (var u = 0; u < st.unlocks.length; u += 1) {
          unlockSet[st.unlocks[u]] = true;
        }
      }
    }
    if (Array.isArray(parsed.unlockedParts)) {
      for (var up = 0; up < parsed.unlockedParts.length; up += 1) {
        if (PARTS_MAP[parsed.unlockedParts[up]]) {
          unlockSet[parsed.unlockedParts[up]] = true;
        }
      }
    }
    fresh.unlockedParts = Object.keys(unlockSet);

    if (Array.isArray(parsed.grantedSteps)) {
      fresh.grantedSteps = parsed.grantedSteps.filter(function (v) {
        return Number.isFinite(v) && v >= 1 && v <= TUTORIAL_STEPS.length;
      });
    }
    for (var gs = 1; gs <= fresh.tutorialStep; gs += 1) {
      if (fresh.grantedSteps.indexOf(gs) === -1) {
        fresh.grantedSteps.push(gs);
      }
    }

    if (parsed.tutorialFlags && typeof parsed.tutorialFlags === 'object') {
      fresh.tutorialFlags = Object.assign(fresh.tutorialFlags, {
        bottleneckObserved: Boolean(parsed.tutorialFlags.bottleneckObserved),
        highPurityDelivered: Boolean(parsed.tutorialFlags.highPurityDelivered),
        cooledObserved: Boolean(parsed.tutorialFlags.cooledObserved),
        overheatObserved: Boolean(parsed.tutorialFlags.overheatObserved),
        turbineStarted: Boolean(parsed.tutorialFlags.turbineStarted),
        filterProduced: Boolean(parsed.tutorialFlags.filterProduced),
        tidyNotified: Boolean(parsed.tutorialFlags.tidyNotified)
      });
    }

    state = fresh;

    // ノードの安全復元（未知の partId はスキップ）
    var validNodeIds = {};
    var rawPositions = [];
    for (var i = 0; i < parsed.nodes.length; i += 1) {
      var rawNode = parsed.nodes[i];
      if (!rawNode || typeof rawNode !== 'object' || !PARTS_MAP[rawNode.partId]) {
        continue;
      }
      var safeX = Number.isFinite(rawNode.x) ? rawNode.x : 180 + i * 160;
      var safeY = Number.isFinite(rawNode.y) ? rawNode.y : 200;
      var safeCoolantItems = Array.isArray(rawNode.coolantItems)
        ? rawNode.coolantItems.filter(function (r) { return r === 'deep_water' || r === 'purified_coolant'; })
        : [];
      var created = createNodeInstance(rawNode.partId, safeX, safeY, {
        id: typeof rawNode.id === 'string' && !validNodeIds[rawNode.id] ? rawNode.id : undefined,
        isStarter: Boolean(rawNode.isStarter),
        allowDelete: rawNode.allowDelete !== undefined ? Boolean(rawNode.allowDelete) : true,
        config: rawNode.config,
        heat: rawNode.heat,
        powerBuffer: rawNode.powerBuffer,
        inputBuffer: rawNode.inputBuffer,
        coolantItems: safeCoolantItems,
        coolBoostTimer: rawNode.coolBoostTimer,
        isOverheated: Boolean(rawNode.isOverheated),
        producedCount: rawNode.producedCount
      });
      if (created) {
        validNodeIds[created.id] = true;
        state.nodes.push(created);
        rawPositions.push({ x: Math.round(safeX), y: Math.round(safeY) });
      }
    }

    if (state.nodes.length === 0) {
      return { ok: false, reason: 'NO_VALID_NODES', message: '有効な設備データが見つかりませんでした。' };
    }

    // 異なる画面サイズで保存された配置を復元した場合でも、既存重なりがない限り維持しつつ重なりだけを自動解消
    resolveAllNodesInViewport(state.viewport, rawPositions);

    // 接続の安全復元（破損接続・不整合ポートはスキップ）
    if (Array.isArray(parsed.connections)) {
      for (var j = 0; j < parsed.connections.length; j += 1) {
        var rc = parsed.connections[j];
        if (!rc || typeof rc !== 'object') {
          continue;
        }
        if (!validNodeIds[rc.fromNodeId] || !validNodeIds[rc.toNodeId]) {
          continue;
        }
        connectPorts(rc.fromNodeId, rc.fromPortId, rc.toNodeId, rc.toPortId, {
          id: typeof rc.id === 'string' ? rc.id : undefined,
          silent: true
        });
      }
    }

    syncNextIdSeq();
    safeAudio('setMuted', state.muted);
    evaluateTidySync({ silent: true });
    evaluateTutorialProgress({ silent: true });
    updateGlobalMetrics();
    computeGuideLinks();
    state.isDirty = false;

    return { ok: true, restoredNodes: state.nodes.length, restoredConnections: state.connections.length };
  }

  function loadGame(options) {
    var opts = options || {};
    var storage = getSafeStorage();
    if (storage) {
      try {
        var raw = storage.getItem(CONFIG.SAVE_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          var res = hydrateFromParsedSave(parsed, opts);
          if (res.ok) {
            return { ok: true, loadedFromSave: true, details: res };
          }
        }
      } catch (_) {
        // JSON破損時は安全に初期状態へフォールバックする
      }
    }

    applyInitialGameState(opts);
    return { ok: true, loadedFromSave: false, fallbackToInitial: true };
  }

  function resetGame(options) {
    var opts = options || {};
    applyInitialGameState(opts);
    if (!opts.skipSave) {
      saveGame();
    }
    pushFxEvent({ type: 'game_reset' });
    return { ok: true };
  }

  function resetSave() {
    var storage = getSafeStorage();
    if (storage) {
      try {
        storage.removeItem(CONFIG.SAVE_KEY);
      } catch (_) {
        // 無視して初期状態を再構築
      }
    }
    return resetGame({ skipSave: false });
  }

  function exportSaveJSON() {
    return JSON.stringify(serializeSaveData(), null, 2);
  }

  function importSaveJSON(jsonText) {
    if (typeof jsonText !== 'string' || jsonText.trim().length === 0) {
      return { ok: false, reason: 'EMPTY_INPUT', message: 'セーブJSONが空です。' };
    }
    try {
      var parsed = JSON.parse(jsonText);
      var res = hydrateFromParsedSave(parsed, { viewport: state.viewport });
      if (!res.ok) {
        return res;
      }
      saveGame();
      return { ok: true, details: res };
    } catch (err) {
      return { ok: false, reason: 'INVALID_JSON', message: 'JSON解析に失敗しました: ' + String(err.message || err) };
    }
  }

  // =========================================================================
  // 11. インスペクタ＆HUD 読み取り専用スナップショット API
  // =========================================================================

  function getNodeInspectorSnapshot(nodeId) {
    var node = findNode(nodeId);
    if (!node) {
      return null;
    }
    var part = PARTS_MAP[node.partId];
    if (!part) {
      return null;
    }

    var breakdown = [{ label: '基礎稼働', multiplier: 1.0 }];
    if (part.heat && part.heat.hasHeat) {
      if (node.isOverheated) {
        breakdown.push({ label: 'オーバーヒート (80℃超)', multiplier: part.heat.overheatMultiplier });
      } else if (node.isCoolBoosted) {
        breakdown.push({ label: '冷却ブースト', multiplier: part.heat.coolBoostMultiplier });
      }
    }
    if (state.isTidySync) {
      breakdown.push({ label: '整頓シンクロ', multiplier: CONFIG.TIDY_BONUS_MULTIPLIER });
    }

    var hybridInfo = null;
    if (part.isHybrid) {
      var mode = node.config && node.config.mode === 'filter' ? 'filter' : 'data';
      var precision = node.config && node.config.precision !== undefined ? node.config.precision : 20;
      if (mode === 'data') {
        var prof = getModuleDataProfile(precision);
        var outDef = RESOURCES[prof.outputResource];
        hybridInfo = {
          mode: 'data',
          precision: prof.precision,
          bandId: prof.bandId,
          bandLabel: prof.bandLabel,
          outputResource: prof.outputResource,
          outputResourceName: outDef ? outDef.name : prof.outputResource,
          processInterval: prof.processInterval,
          effectiveInterval: Math.round((prof.processInterval / Math.max(0.1, node.efficiency)) * 100) / 100,
          valueMultiplier: prof.valueMultiplier,
          unitValue: prof.unitValue,
          bandwidthLoad: prof.bandwidthLoad,
          heatPerCycle: prof.heatPerCycle,
          readoutText:
            '出力: ' + (outDef ? outDef.name : prof.outputResource) +
            ' / 単価倍率: ' + prof.valueMultiplier.toFixed(2) + 'x' +
            ' / 帯域負荷: ' + prof.bandwidthLoad.toFixed(2) +
            ' / 発熱: +' + prof.heatPerCycle.toFixed(1) + '℃'
        };
      } else {
        var fConf = part.process.hybridConfig.modes.filter;
        hybridInfo = {
          mode: 'filter',
          precision: precision,
          bandId: 'filter',
          bandLabel: '物理濾過',
          outputResource: 'purified_coolant',
          outputResourceName: RESOURCES.purified_coolant.name,
          processInterval: fConf.processInterval,
          effectiveInterval: Math.round((fConf.processInterval / Math.max(0.1, node.efficiency)) * 100) / 100,
          valueMultiplier: 0,
          unitValue: 0,
          bandwidthLoad: 0,
          heatPerCycle: fConf.heatPerCycle,
          readoutText: '出力: 高純度冷却液（冷却力2倍・他ノードの冷却ブースト維持に最適）'
        };
      }
    }

    var portSummaries = [];
    var allInputDefs = (part.ports && part.ports.inputs) || [];
    for (var i = 0; i < allInputDefs.length; i += 1) {
      var inDef = allInputDefs[i];
      var inConns = getIncomingConnections(node.id, inDef.id).map(function (c) {
        var peer = findNode(c.fromNodeId);
        var peerPart = peer ? PARTS_MAP[peer.partId] : null;
        return {
          connId: c.id,
          peerNodeId: c.fromNodeId,
          peerNodeName: peerPart ? peerPart.shortName : c.fromNodeId,
          peerPortId: c.fromPortId,
          resourceId: c.resourceId,
          bottleneckRatio: c.bottleneckRatio
        };
      });
      portSummaries.push({
        id: inDef.id,
        dir: 'in',
        label: inDef.label,
        color: inDef.color,
        accepts: getEffectiveAcceptedTypes(node, inDef.id),
        connections: inConns
      });
    }

    var allOutputDefs = (part.ports && part.ports.outputs) || [];
    for (var j = 0; j < allOutputDefs.length; j += 1) {
      var outDefPort = allOutputDefs[j];
      var outConns = getOutgoingConnections(node.id, outDefPort.id).map(function (c) {
        var peer = findNode(c.toNodeId);
        var peerPart = peer ? PARTS_MAP[peer.partId] : null;
        return {
          connId: c.id,
          peerNodeId: c.toNodeId,
          peerNodeName: peerPart ? peerPart.shortName : c.toNodeId,
          peerPortId: c.toPortId,
          resourceId: c.resourceId,
          bottleneckRatio: c.bottleneckRatio
        };
      });
      portSummaries.push({
        id: outDefPort.id,
        dir: 'out',
        label: outDefPort.label,
        color: outDefPort.color,
        type: getEffectiveOutputType(node, outDefPort.id),
        connections: outConns
      });
    }

    return {
      id: node.id,
      partId: node.partId,
      name: part.name,
      category: part.category,
      status: node.status,
      statusLabel: node.statusLabel,
      hasHeat: Boolean(part.heat && part.heat.hasHeat),
      heat: Math.round(node.heat * 10) / 10,
      maxTemp: CONFIG.MAX_TEMP,
      overheatTemp: CONFIG.OVERHEAT_TEMP,
      isOverheated: node.isOverheated,
      isCoolBoosted: node.isCoolBoosted,
      coolBoostTimer: Math.round(node.coolBoostTimer * 10) / 10,
      efficiency: node.efficiency,
      efficiencyPct: Math.round(node.efficiency * 100),
      efficiencyBreakdown: breakdown,
      allowDelete: node.allowDelete,
      hybrid: hybridInfo,
      ports: portSummaries
    };
  }

  function getSnapshot() {
    var stepDef = TUTORIAL_STEPS[clamp(state.tutorialStep, 1, TUTORIAL_STEPS.length) - 1];
    return {
      funds: state.funds,
      totalEarned: state.totalEarned,
      incomeRate: state.incomeRate,
      powerMetrics: Object.assign({}, state.powerMetrics),
      maxHeat: state.maxHeat,
      isTidySync: state.isTidySync,
      tidyStats: Object.assign({}, state.tidyStats),
      tutorialStep: state.tutorialStep,
      stepBadge: stepDef ? stepDef.badge : 'STEP 1/4',
      boogieStepLabel: stepDef ? stepDef.boogieStepLabel : 'STEP 1',
      boogieMood: state.boogieMood,
      boogieMessage: state.boogieMessage,
      checklist: stepDef
        ? stepDef.checklist.map(function (c) {
            return {
              id: c.id,
              label: c.label,
              done: Boolean(state.checklistStatus[c.id])
            };
          })
        : [],
      unlockedParts: state.unlockedParts.slice(),
      cableMode: state.cableMode,
      muted: state.muted,
      guideLaserEnabled: state.guideLaserEnabled,
      selectedNodeId: state.selectedNodeId,
      nodeCount: state.nodes.length,
      connectionCount: state.connections.length,
      packetCount: state.packets.length
    };
  }

  function updateViewportSize(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return;
    }
    state.viewport.width = width;
    state.viewport.height = height;
    resolveAllNodesInViewport(state.viewport);
    evaluateTidySync({ silent: true });
    computeGuideLinks();
  }

  // === RENDER & UI LAYER (vfx-ui-artist 統合領域) ===

  var uiState = {
    domBound: false,
    audioUnlocked: false,
    dpr: 1,
    cssW: INITIAL_LAYOUT.referenceViewport.width,
    cssH: INITIAL_LAYOUT.referenceViewport.height,
    renderTime: 0,
    lastRenderMs: 0,
    ambientInitialized: false,
    ambientSnow: [],
    ambientBubbles: [],
    ambientPlankton: [],
    ambientFauna: [],
    sonarWaves: [],
    sonarCooldown: 8.5,
    vfxParticles: [],
    vfxRipples: [],
    vfxPopups: [],
    vfxWireFlashes: [],
    tidyBannerTimer: 0,
    unlockBanner: null,
    autosaveFlashTimer: 0,
    newlyUnlockedSet: {},
    lastUnlockedList: [],
    lastBoogieMessage: '',
    lastChecklistSig: '',
    lastInspectorSig: '',
    lastPortsSig: '',
    hoveredNodeId: null,
    hoveredPort: null,
    hoveredWireId: null,
    pointer: {
      inside: false,
      x: 0,
      y: 0,
      clientX: 0,
      clientY: 0
    },
    placingPartId: null,
    dockDrag: null,
    nodeDrag: null,
    dragOverlapBlocked: false,
    dragOverlapAdjusted: false,
    dragOverlapTimer: 0,
    wiringDrag: null,
    pendingWirePort: null,
    isSliderDragging: false,
    encPartId: CONFIG.PART_ORDER[0],
    encVariantKey: null,
    boogieCollapsed: false,
    resizeObserver: null
  };

  function hexToRgba(hex, alpha) {
    if (typeof hex !== 'string') {
      return 'rgba(0, 240, 255, ' + clamp(alpha, 0, 1) + ')';
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
      return 'rgba(0, 240, 255, ' + clamp(alpha, 0, 1) + ')';
    }
    var r = parseInt(clean.slice(0, 2), 16);
    var g = parseInt(clean.slice(2, 4), 16);
    var b = parseInt(clean.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
      return 'rgba(0, 240, 255, ' + clamp(alpha, 0, 1) + ')';
    }
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + clamp(alpha, 0, 1) + ')';
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    var radius = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
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
    var c = Math.max(0, Math.min(cut, w * 0.35, h * 0.35));
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

  function drawWirePath(ctx, poly) {
    if (!poly || !Array.isArray(poly.points) || poly.points.length < 2) {
      return false;
    }
    ctx.beginPath();
    if (poly.mode === 'bezier' && poly.controlPoints) {
      var cp = poly.controlPoints;
      ctx.moveTo(cp.p0.x, cp.p0.y);
      ctx.bezierCurveTo(cp.c0.x, cp.c0.y, cp.c1.x, cp.c1.y, cp.p1.x, cp.p1.y);
      return true;
    }

    var pts = poly.points;
    ctx.moveTo(pts[0].x, pts[0].y);
    if (poly.mode === 'ortho' && pts.length > 2) {
      var baseR = CONFIG.ORTHO_CORNER_RADIUS || 14;
      for (var i = 1; i < pts.length - 1; i += 1) {
        var prev = pts[i - 1];
        var curr = pts[i];
        var next = pts[i + 1];
        var len1 = Math.hypot(curr.x - prev.x, curr.y - prev.y);
        var len2 = Math.hypot(next.x - curr.x, next.y - curr.y);
        var r = Math.min(baseR, len1 * 0.45, len2 * 0.45);
        if (r > 1.0) {
          ctx.arcTo(curr.x, curr.y, next.x, next.y, r);
        } else {
          ctx.lineTo(curr.x, curr.y);
        }
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      return true;
    }

    for (var j = 1; j < pts.length; j += 1) {
      ctx.lineTo(pts[j].x, pts[j].y);
    }
    return true;
  }

  function pointToSegmentDistance(px, py, ax, ay, bx, by) {
    var dx = bx - ax;
    var dy = by - ay;
    var lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-6) {
      return Math.hypot(px - ax, py - ay);
    }
    var t = clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1);
    var projX = ax + t * dx;
    var projY = ay + t * dy;
    return Math.hypot(px - projX, py - projY);
  }

  function unlockAudioOnGesture() {
    if (uiState.audioUnlocked) {
      return;
    }
    uiState.audioUnlocked = true;
    safeAudio('init');
    safeAudio('setMuted', state.muted);
    if (!state.muted) {
      safeAudio('startAmbient');
      safeAudio('playSonar');
    }
  }

  function createPartMiniSvgIcon(partId) {
    var svg = '';
    if (partId === 'emergency_battery') {
      svg =
        '<svg viewBox="0 0 28 28" width="22" height="22" aria-hidden="true">' +
        '<rect x="5" y="7" width="16" height="14" rx="2.5" fill="#1b3048" stroke="#ffd84d" stroke-width="1.6"/>' +
        '<rect x="21" y="11" width="3" height="6" rx="1" fill="#d8a648"/>' +
        '<rect x="7.5" y="10" width="3" height="8" rx="0.8" fill="#ffd84d"/>' +
        '<rect x="11.5" y="10" width="3" height="8" rx="0.8" fill="#ffd84d"/>' +
        '<path d="M16.5 9.5 L14.5 14 L17.5 14 L15.5 18.5" fill="none" stroke="#fff7c2" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>';
    } else if (partId === 'submarine_cable') {
      svg =
        '<svg viewBox="0 0 28 28" width="22" height="22" aria-hidden="true">' +
        '<rect x="3" y="6" width="22" height="16" rx="3" fill="#091f33" stroke="#00f0ff" stroke-width="1.5"/>' +
        '<path d="M5.5 15 Q9 8 12 14 T18 13 T22.5 14" fill="none" stroke="#00f0ff" stroke-width="1.8" stroke-linecap="round"/>' +
        '<circle cx="7" cy="9" r="1.3" fill="#ffd84d"/>' +
        '<circle cx="21" cy="19" r="1.4" fill="#00f0ff"/>' +
        '</svg>';
    } else if (partId === 'generic_module') {
      svg =
        '<svg viewBox="0 0 28 28" width="22" height="22" aria-hidden="true">' +
        '<polygon points="14,3 24,8.5 24,19.5 14,25 4,19.5 4,8.5" fill="#172442" stroke="#ff4fd8" stroke-width="1.5"/>' +
        '<circle cx="14" cy="14" r="5.2" fill="none" stroke="#7afcff" stroke-width="1.6" stroke-dasharray="3 2"/>' +
        '<circle cx="14" cy="14" r="2.2" fill="#ffd84d"/>' +
        '</svg>';
    } else if (partId === 'surface_uplink') {
      svg =
        '<svg viewBox="0 0 28 28" width="22" height="22" aria-hidden="true">' +
        '<path d="M7 15 A8 8 0 0 0 21 15" fill="none" stroke="#2ef2a4" stroke-width="2" stroke-linecap="round"/>' +
        '<line x1="14" y1="24" x2="14" y2="12" stroke="#d8a648" stroke-width="1.8"/>' +
        '<line x1="10" y1="24" x2="18" y2="24" stroke="#d8a648" stroke-width="1.8" stroke-linecap="round"/>' +
        '<circle cx="14" cy="11" r="2" fill="#00f0ff"/>' +
        '<path d="M9.5 8 A6 6 0 0 1 18.5 8" fill="none" stroke="#7cf7ff" stroke-width="1.3" stroke-linecap="round"/>' +
        '<path d="M7 5.2 A9.5 9.5 0 0 1 21 5.2" fill="none" stroke="#2ef2a4" stroke-width="1.2" stroke-linecap="round" opacity="0.7"/>' +
        '</svg>';
    } else if (partId === 'deep_water_intake') {
      svg =
        '<svg viewBox="0 0 28 28" width="22" height="22" aria-hidden="true">' +
        '<rect x="5" y="5" width="18" height="18" rx="3.5" fill="#0a2036" stroke="#38d6ff" stroke-width="1.5"/>' +
        '<path d="M6 15 Q10 12.5 14 15 T22 15 L22 22 L6 22 Z" fill="rgba(56,214,255,0.45)"/>' +
        '<path d="M6 15 Q10 12.5 14 15 T22 15" fill="none" stroke="#b8f2ff" stroke-width="1.3"/>' +
        '<circle cx="11" cy="10" r="1.4" fill="#aef4ff"/>' +
        '<circle cx="17" cy="9" r="1" fill="#aef4ff"/>' +
        '</svg>';
    } else if (partId === 'drain_vent') {
      svg =
        '<svg viewBox="0 0 28 28" width="22" height="22" aria-hidden="true">' +
        '<path d="M6 14 L22 14 L20 23 L8 23 Z" fill="#291d28" stroke="#ff7a45" stroke-width="1.5"/>' +
        '<line x1="9" y1="17" x2="19" y2="17" stroke="#ff9a5a" stroke-width="1.6" stroke-linecap="round"/>' +
        '<line x1="10" y1="20" x2="18" y2="20" stroke="#ff6b2b" stroke-width="1.6" stroke-linecap="round"/>' +
        '<circle cx="11" cy="9" r="2" fill="none" stroke="#ffb48a" stroke-width="1.2"/>' +
        '<circle cx="16.5" cy="7" r="2.4" fill="none" stroke="#ff8b52" stroke-width="1.2"/>' +
        '</svg>';
    } else {
      svg =
        '<svg viewBox="0 0 28 28" width="22" height="22" aria-hidden="true">' +
        '<circle cx="14" cy="14" r="9.5" fill="#231a26" stroke="#ff9436" stroke-width="1.5"/>' +
        '<path d="M14 6 L16 12 L22 14 L16 16 L14 22 L12 16 L6 14 L12 12 Z" fill="#ffd84d"/>' +
        '<circle cx="14" cy="14" r="2.3" fill="#fff6cc"/>' +
        '</svg>';
    }
    return svg;
  }

  // -------------------------------------------------------------------------
  // A. 高DPIリサイズ＆深海水槽環境プール初期化
  // -------------------------------------------------------------------------

  function initAmbientField(w, h) {
    var snowCount = 68;
    uiState.ambientSnow = [];
    for (var i = 0; i < snowCount; i += 1) {
      var layer = i % 3;
      uiState.ambientSnow.push({
        x: ((i * 197 + 43) % 1000) / 1000 * w,
        y: ((i * 313 + 79) % 1000) / 1000 * h,
        r: layer === 0 ? 0.9 : (layer === 1 ? 1.45 : 2.15),
        speedY: 4 + layer * 4.5 + (i % 5) * 0.9,
        drift: 6 + layer * 5,
        phase: i * 0.87,
        alpha: 0.16 + layer * 0.11,
        hue: i % 5 === 0 ? 'rgba(116, 252, 240, ' : (i % 9 === 0 ? 'rgba(166, 224, 255, ' : 'rgba(202, 244, 255, ')
      });
    }

    var planktonCount = 26;
    uiState.ambientPlankton = [];
    var pColors = ['#4fffe4', '#64d8ff', '#9bf8ff', '#6dffb4', '#b49aff'];
    for (var pk = 0; pk < planktonCount; pk += 1) {
      uiState.ambientPlankton.push({
        nx: ((pk * 373 + 61) % 1000) / 1000,
        ny: 0.14 + ((pk * 241 + 19) % 720) / 1000,
        r: 1.2 + (pk % 3) * 0.75,
        phase: pk * 1.43,
        speed: 0.45 + (pk % 4) * 0.22,
        color: pColors[pk % pColors.length]
      });
    }

    var bubbleCount = CONFIG.MAX_AMBIENT_BUBBLES || 42;
    uiState.ambientBubbles = [];
    for (var b = 0; b < bubbleCount; b += 1) {
      uiState.ambientBubbles.push({
        x: ((b * 263 + 91) % 1000) / 1000 * w,
        y: ((b * 419 + 37) % 1000) / 1000 * h,
        r: 1.4 + (b % 4) * 1.15,
        speedY: 16 + (b % 5) * 7.5,
        phase: b * 1.31,
        alpha: 0.18 + (b % 3) * 0.09
      });
    }

    uiState.ambientFauna = [
      { kind: 'manta', ny: 0.23, speed: 0.017, dir: 1, phase: 0.4, scale: 1.05 },
      { kind: 'manta', ny: 0.34, speed: 0.012, dir: -1, phase: 2.3, scale: 0.72 },
      { kind: 'rov', ny: 0.56, speed: 0.014, dir: 1, phase: 1.1, scale: 1.0 }
    ];

    uiState.ambientInitialized = true;
  }

  function syncCanvasResolution() {
    var canvas = runtime.uiRefs.canvas;
    var ctx = runtime.uiRefs.ctx;
    if (!canvas || !ctx) {
      return;
    }

    var rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    var rawW = rect && rect.width > 0 ? rect.width : (global.innerWidth || state.viewport.width || 1280);
    var rawH = rect && rect.height > 0 ? rect.height : (global.innerHeight || state.viewport.height || 720);
    var cssW = Math.max(320, Math.round(rawW));
    var cssH = Math.max(240, Math.round(rawH));
    var dpr = Math.min(Math.max(1, global.devicePixelRatio || 1), 3);
    var targetW = Math.round(cssW * dpr);
    var targetH = Math.round(cssH * dpr);

    var sizeChanged = cssW !== uiState.cssW || cssH !== uiState.cssH;
    if (canvas.width !== targetW || canvas.height !== targetH || uiState.dpr !== dpr || sizeChanged) {
      canvas.width = targetW;
      canvas.height = targetH;
      uiState.dpr = dpr;
      uiState.cssW = cssW;
      uiState.cssH = cssH;
      if (sizeChanged) {
        updateViewportSize(cssW, cssH);
      }
      if (!uiState.ambientInitialized) {
        initAmbientField(cssW, cssH);
      }
    }
  }

  function spawnSonarWave(x, y, maxRadius, color) {
    if (uiState.sonarWaves.length >= 6) {
      uiState.sonarWaves.shift();
    }
    uiState.sonarWaves.push({
      x: x,
      y: y,
      radius: 16,
      maxRadius: maxRadius || Math.max(uiState.cssW, uiState.cssH) * 0.72,
      life: 0,
      maxLife: 3.4,
      color: color || '#00f0ff'
    });
  }

  // -------------------------------------------------------------------------
  // B. 深海水槽背景（コースティクス・海底シルエット・グリッド・マリンスノー）
  // -------------------------------------------------------------------------

  function renderBackground(ctx, w, h, time) {
    // 1. 深海アビス多層グラデーション＋散乱光ドーム（水深2,400mのマリンアビスブルー）
    var bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, '#0c3b66');
    bgGrad.addColorStop(0.24, '#082b4d');
    bgGrad.addColorStop(0.56, '#061f3b');
    bgGrad.addColorStop(0.82, '#041428');
    bgGrad.addColorStop(1, '#07233b');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // 海上からの柔らかな深海散乱光ドーム
    var domeR = Math.max(w, h) * 0.78;
    var topGlow = ctx.createRadialGradient(w * 0.45, -h * 0.08, 24, w * 0.45, h * 0.16, domeR);
    topGlow.addColorStop(0, 'rgba(34, 174, 238, 0.34)');
    topGlow.addColorStop(0.4, 'rgba(14, 96, 158, 0.17)');
    topGlow.addColorStop(0.75, 'rgba(6, 44, 82, 0.06)');
    topGlow.addColorStop(1, 'rgba(4, 20, 40, 0)');
    ctx.fillStyle = topGlow;
    ctx.fillRect(0, 0, w, h);

    // 深層海底からのほのかな地熱・青緑反射グロウ
    var floorGlow = ctx.createRadialGradient(w * 0.5, h * 0.94, 40, w * 0.5, h * 0.86, w * 0.65);
    floorGlow.addColorStop(0, 'rgba(18, 92, 128, 0.18)');
    floorGlow.addColorStop(0.55, 'rgba(10, 56, 86, 0.08)');
    floorGlow.addColorStop(1, 'rgba(4, 20, 40, 0)');
    ctx.fillStyle = floorGlow;
    ctx.fillRect(0, h * 0.45, w, h * 0.55);

    // 緩やかな水深層帯の濃淡うねり
    ctx.save();
    for (var sb = 0; sb < 3; sb += 1) {
      var bandY = h * (0.28 + sb * 0.21);
      ctx.fillStyle = 'rgba(46, 172, 226, ' + (0.028 - sb * 0.005).toFixed(3) + ')';
      ctx.beginPath();
      ctx.moveTo(0, bandY);
      for (var bx0 = 0; bx0 <= 10; bx0 += 1) {
        var px0 = (w * bx0) / 10;
        var py0 = bandY + Math.sin(time * (0.25 + sb * 0.06) + bx0 * 0.8 + sb) * 14;
        ctx.lineTo(px0, py0);
      }
      ctx.lineTo(w, bandY + 42);
      ctx.lineTo(0, bandY + 42);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // 2. 視認できる揺らぐコースティクス＆ゴッドレイ（加算合成）
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var rayCount = 6;
    for (var ri = 0; ri < rayCount; ri += 1) {
      var baseX = w * (0.08 + ri * 0.165) + Math.sin(time * (0.24 + ri * 0.04) + ri * 1.5) * 46;
      var topWidth = 42 + (ri % 3) * 26;
      var botShift = 105 + Math.cos(time * 0.21 + ri * 1.1) * 42;
      var botWidth = topWidth * 2.6;
      var intensity = 0.065 + 0.032 * Math.sin(time * 0.62 + ri * 2.1);

      var rayGrad = ctx.createLinearGradient(baseX, 0, baseX + botShift * 0.65, h * 0.88);
      rayGrad.addColorStop(0, 'rgba(72, 232, 255, ' + intensity.toFixed(3) + ')');
      rayGrad.addColorStop(0.45, 'rgba(22, 168, 224, ' + (intensity * 0.48).toFixed(3) + ')');
      rayGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = rayGrad;
      ctx.beginPath();
      ctx.moveTo(baseX - topWidth * 0.5, 0);
      ctx.lineTo(baseX + topWidth * 0.5, 0);
      ctx.lineTo(baseX + botShift + botWidth * 0.5, h * 0.92);
      ctx.lineTo(baseX + botShift - botWidth * 0.5, h * 0.92);
      ctx.closePath();
      ctx.fill();
    }

    // 上層コースティクス網状リボン（水面波の屈折光帯）
    for (var cr = 0; cr < 2; cr += 1) {
      ctx.strokeStyle = 'rgba(92, 236, 255, ' + (0.065 - cr * 0.02).toFixed(3) + ')';
      ctx.lineWidth = 18 - cr * 6;
      ctx.beginPath();
      for (var cs = 0; cs <= 16; cs += 1) {
        var cx0 = (w * cs) / 16;
        var cy0 = h * (0.07 + cr * 0.06) + Math.sin(time * (0.75 + cr * 0.25) + cs * 0.72 + cr) * 16;
        if (cs === 0) ctx.moveTo(cx0, cy0);
        else ctx.lineTo(cx0, cy0);
      }
      ctx.stroke();
    }
    ctx.restore();

    // 3. ドック（下部125px）に隠れない立体3層海底地形＆遠景深海ランドスケープ
    var dockClearY = h - 134;

    // 3a. 最遠景：深海海嶺＆海溝シルエット（左右岸壁から中央h-195..h-155へ連なる）
    ctx.save();
    ctx.fillStyle = 'rgba(5, 22, 42, 0.86)';
    ctx.beginPath();
    ctx.moveTo(0, h);
    var farPts = [
      [0, h * 0.34],
      [w * 0.07, h * 0.50],
      [w * 0.14, dockClearY - 68],
      [w * 0.23, dockClearY - 46],
      [w * 0.35, dockClearY - 60],
      [w * 0.47, dockClearY - 38],
      [w * 0.58, dockClearY - 56],
      [w * 0.70, dockClearY - 44],
      [w * 0.82, dockClearY - 72],
      [w * 0.92, h * 0.48],
      [w, h * 0.36]
    ];
    for (var fi = 0; fi < farPts.length; fi += 1) {
      ctx.lineTo(farPts[fi][0], farPts[fi][1]);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();

    // 遠景海嶺リムハイライト
    ctx.strokeStyle = 'rgba(72, 186, 232, 0.22)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (var fi2 = 0; fi2 < farPts.length; fi2 += 1) {
      if (fi2 === 0) ctx.moveTo(farPts[fi2][0], farPts[fi2][1]);
      else ctx.lineTo(farPts[fi2][0], farPts[fi2][1]);
    }
    ctx.stroke();

    // 3b. 中景：遠景ケーブル＆中継鉄塔トラス（海嶺と段丘の間に架設）
    ctx.strokeStyle = 'rgba(42, 134, 178, 0.34)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(w * 0.04, dockClearY - 52);
    ctx.quadraticCurveTo(w * 0.22, dockClearY - 22, w * 0.39, dockClearY - 46);
    ctx.quadraticCurveTo(w * 0.55, dockClearY - 18, w * 0.72, dockClearY - 48);
    ctx.quadraticCurveTo(w * 0.86, dockClearY - 28, w * 0.97, dockClearY - 56);
    ctx.stroke();

    // ケーブル沿いにゆっくり走る遠景信号パルス点
    var cablePulseU = (time * 0.11) % 1;
    var cpX = w * (0.04 + cablePulseU * 0.93);
    var cpY = dockClearY - 38 - Math.sin(cablePulseU * Math.PI * 3) * 10;
    ctx.fillStyle = 'rgba(0, 240, 255, 0.65)';
    ctx.beginPath();
    ctx.arc(cpX, cpY, 2.2, 0, Math.PI * 2);
    ctx.fill();

    // 中継鉄塔トラス（3基：視認範囲内に頂部が突き出す高さ）
    var towerSpecs = [
      { x: w * 0.18, topY: dockClearY - 64 },
      { x: w * 0.53, topY: dockClearY - 52 },
      { x: w * 0.84, topY: dockClearY - 68 }
    ];
    for (var ti = 0; ti < towerSpecs.length; ti += 1) {
      var tw = towerSpecs[ti];
      ctx.strokeStyle = 'rgba(48, 138, 182, 0.36)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(tw.x - 11, h - 110);
      ctx.lineTo(tw.x - 3, tw.topY);
      ctx.lineTo(tw.x + 3, tw.topY);
      ctx.lineTo(tw.x + 11, h - 110);
      // クロスブレース
      ctx.moveTo(tw.x - 8, tw.topY + 22);
      ctx.lineTo(tw.x + 6, tw.topY + 11);
      ctx.moveTo(tw.x + 8, tw.topY + 22);
      ctx.lineTo(tw.x - 6, tw.topY + 11);
      ctx.stroke();

      var beaconAlpha = 0.35 + 0.55 * Math.max(0, Math.sin(time * 2.2 + ti * 1.9));
      ctx.fillStyle = 'rgba(0, 240, 255, ' + beaconAlpha.toFixed(2) + ')';
      ctx.beginPath();
      ctx.arc(tw.x, tw.topY - 2, 2.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3c. 近景：玄武岩の段丘＆左右海溝岩壁（ドック上に出る段丘＋柱状節理エッジ）
    var nearTerraces = [
      [
        [0, h * 0.44],
        [w * 0.055, h * 0.56],
        [w * 0.095, h * 0.68],
        [w * 0.16, dockClearY - 26],
        [w * 0.28, dockClearY - 14],
        [w * 0.38, dockClearY - 30],
        [w * 0.49, dockClearY - 4],
        [w * 0.61, dockClearY - 24],
        [w * 0.72, dockClearY - 12],
        [w * 0.83, dockClearY - 34],
        [w * 0.91, h * 0.67],
        [w * 0.95, h * 0.54],
        [w, h * 0.45]
      ]
    ];
    for (var nti = 0; nti < nearTerraces.length; nti += 1) {
      var pts = nearTerraces[nti];
      var rockGrad = ctx.createLinearGradient(0, h * 0.44, 0, h);
      rockGrad.addColorStop(0, '#071b30');
      rockGrad.addColorStop(0.55, '#041222');
      rockGrad.addColorStop(1, '#020a14');
      ctx.fillStyle = rockGrad;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (var pi = 0; pi < pts.length; pi += 1) {
        ctx.lineTo(pts[pi][0], pts[pi][1]);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();

      // 玄武岩上面のリムライト（海面青光を受ける岩棚エッジ）
      ctx.strokeStyle = 'rgba(84, 198, 238, 0.32)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (var pi2 = 0; pi2 < pts.length; pi2 += 1) {
        if (pi2 === 0) ctx.moveTo(pts[pi2][0], pts[pi2][1]);
        else ctx.lineTo(pts[pi2][0], pts[pi2][1]);
      }
      ctx.stroke();

      // 柱状節理の斜めクラック線
      ctx.strokeStyle = 'rgba(32, 108, 152, 0.22)';
      ctx.lineWidth = 1;
      for (var ck = 1; ck < pts.length - 1; ck += 2) {
        ctx.beginPath();
        ctx.moveTo(pts[ck][0], pts[ck][1]);
        ctx.lineTo(pts[ck][0] + (ck % 4 === 1 ? -14 : 14), pts[ck][1] + 28);
        ctx.stroke();
      }
    }

    // 3d. 深海熱水噴出孔チムニー（ほのかなオレンジ〜シアンの揺らめき熱光と細煙）
    var chimneys = [
      { x: w * 0.145, baseY: dockClearY - 22, h: 36, w: 15, phase: 0.3 },
      { x: w * 0.255, baseY: dockClearY - 12, h: 28, w: 12, phase: 2.1 },
      { x: w * 0.675, baseY: dockClearY - 16, h: 34, w: 14, phase: 4.0 }
    ];
    for (var ci = 0; ci < chimneys.length; ci += 1) {
      var ch = chimneys[ci];
      var topY = ch.baseY - ch.h;
      var pulse = 0.6 + 0.4 * Math.sin(time * 3.1 + ch.phase);

      // チムニー鉱物煙突シルエット
      ctx.fillStyle = '#071526';
      ctx.strokeStyle = 'rgba(88, 178, 214, 0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ch.x - ch.w * 0.65, ch.baseY + 12);
      ctx.lineTo(ch.x - ch.w * 0.45, topY + ch.h * 0.4);
      ctx.lineTo(ch.x - ch.w * 0.28, topY);
      ctx.lineTo(ch.x + ch.w * 0.28, topY);
      ctx.lineTo(ch.x + ch.w * 0.48, topY + ch.h * 0.45);
      ctx.lineTo(ch.x + ch.w * 0.72, ch.baseY + 12);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // 火口の熱水発光コア（オレンジ＋シアン）
      var ventGlow = ctx.createRadialGradient(ch.x, topY, 1, ch.x, topY - 4, 24);
      ventGlow.addColorStop(0, 'rgba(255, 138, 62, ' + (0.48 * pulse).toFixed(2) + ')');
      ventGlow.addColorStop(0.45, 'rgba(42, 206, 232, ' + (0.22 * pulse).toFixed(2) + ')');
      ventGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = ventGlow;
      ctx.beginPath();
      ctx.arc(ch.x, topY - 2, 24, 0, Math.PI * 2);
      ctx.fill();

      // 揺らめき立ち昇る細煙プリューム
      for (var sm = 0; sm < 4; sm += 1) {
        var smU = ((time * 0.28 + sm * 0.25 + ch.phase * 0.1) % 1);
        var smX = ch.x + Math.sin(time * 1.9 + smU * 5 + ch.phase) * (5 + smU * 8);
        var smY = topY - 4 - smU * 48;
        var smR = 2.5 + smU * 6.5;
        ctx.fillStyle = 'rgba(130, 198, 228, ' + ((1 - smU) * 0.16).toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(smX, smY, smR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 3e. 発光珊瑚＆深海チューブワーム微発光点群
    var floraSpots = [
      { x: w * 0.075, y: h * 0.62, col: '#3df5b4', count: 5 },
      { x: w * 0.215, y: dockClearY - 19, col: '#00f0ff', count: 6 },
      { x: w * 0.355, y: dockClearY - 25, col: '#7b8cff', count: 5 },
      { x: w * 0.625, y: dockClearY - 21, col: '#3df5b4', count: 6 },
      { x: w * 0.785, y: dockClearY - 22, col: '#4adfff', count: 5 },
      { x: w * 0.925, y: h * 0.61, col: '#69f0ff', count: 5 }
    ];
    for (var fl = 0; fl < floraSpots.length; fl += 1) {
      var fs = floraSpots[fl];
      for (var st = 0; st < fs.count; st += 1) {
        var stemOff = (st - (fs.count - 1) * 0.5) * 4.5;
        var stemH = 7 + ((fl + st) % 3) * 4;
        var sway = Math.sin(time * 1.6 + fl * 1.2 + st * 0.8) * 2.2;
        var tipX = fs.x + stemOff + sway;
        var tipY = fs.y - stemH;

        ctx.strokeStyle = 'rgba(24, 96, 120, 0.55)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(fs.x + stemOff, fs.y + 3);
        ctx.quadraticCurveTo(fs.x + stemOff + sway * 0.4, fs.y - stemH * 0.5, tipX, tipY);
        ctx.stroke();

        var bioPulse = 0.45 + 0.55 * Math.sin(time * 2.4 + fl + st * 1.3);
        ctx.fillStyle = hexToRgba(fs.col, bioPulse * 0.72);
        ctx.beginPath();
        ctx.arc(tipX, tipY, 1.7, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // 4. 海中をゆっくり巡回する遠景シルエット（回遊エイ＆小型探査ROVサーチライト）
    var faunaList = uiState.ambientFauna || [];
    ctx.save();
    for (var af = 0; af < faunaList.length; af += 1) {
      var fn = faunaList[af];
      var prog = (time * fn.speed + fn.phase * 0.17) % 1.28;
      var fx = fn.dir > 0 ? (prog - 0.14) * w : (1.14 - prog) * w;
      var fy = h * fn.ny + Math.sin(time * 0.65 + fn.phase) * 14;

      ctx.save();
      ctx.translate(fx, fy);
      ctx.scale(fn.dir * fn.scale, fn.scale);

      if (fn.kind === 'manta') {
        var wingFlap = Math.sin(time * 2.4 + fn.phase) * 7;
        ctx.fillStyle = 'rgba(6, 26, 48, 0.56)';
        ctx.strokeStyle = 'rgba(78, 198, 240, 0.18)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(20, 0);
        ctx.quadraticCurveTo(6, -8, -4, -22 + wingFlap);
        ctx.quadraticCurveTo(-12, -8, -14, 0);
        ctx.lineTo(-34, Math.sin(time * 3 + fn.phase) * 3);
        ctx.lineTo(-14, 2);
        ctx.quadraticCurveTo(-10, 10, -4, 20 - wingFlap * 0.7);
        ctx.quadraticCurveTo(7, 8, 20, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (fn.kind === 'rov') {
        // 小型探査ROV機体シルエット
        ctx.fillStyle = 'rgba(9, 32, 56, 0.72)';
        ctx.strokeStyle = 'rgba(96, 216, 255, 0.28)';
        ctx.lineWidth = 1;
        roundRectPath(ctx, -12, -6, 22, 11, 3);
        ctx.fill();
        ctx.stroke();

        // ROV サーチライト光円錐
        var coneGrad = ctx.createLinearGradient(10, 0, 108, 0);
        coneGrad.addColorStop(0, 'rgba(130, 248, 255, 0.18)');
        coneGrad.addColorStop(0.55, 'rgba(56, 214, 255, 0.06)');
        coneGrad.addColorStop(1, 'rgba(56, 214, 255, 0)');
        ctx.fillStyle = coneGrad;
        ctx.beginPath();
        ctx.moveTo(10, -2);
        ctx.lineTo(108, -22);
        ctx.lineTo(108, 24);
        ctx.lineTo(10, 3);
        ctx.closePath();
        ctx.fill();

        // ヘッドライト点＆後部スラスター微小光
        ctx.fillStyle = 'rgba(184, 254, 255, 0.65)';
        ctx.beginPath();
        ctx.arc(10, 0.5, 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255, 184, 77, 0.45)';
        ctx.beginPath();
        ctx.arc(-13, -1, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();

    // 5. 最背面の控えめな深海環境テレメトリ水深目盛り
    ctx.save();
    ctx.strokeStyle = 'rgba(84, 198, 238, 0.16)';
    ctx.fillStyle = 'rgba(132, 222, 252, 0.24)';
    ctx.font = '600 9px ' + CONFIG.MONO_FONT_FAMILY;
    ctx.textBaseline = 'middle';

    // 左端水深スケール
    var depthMarks = [
      { yFrac: 0.30, label: '-2,300m' },
      { yFrac: 0.46, label: '-2,350m' },
      { yFrac: 0.62, label: '-2,400m' },
      { yFrac: 0.76, label: '4.0℃ / 24.1MPa' }
    ];
    ctx.textAlign = 'left';
    for (var dm = 0; dm < depthMarks.length; dm += 1) {
      var dy = Math.round(h * depthMarks[dm].yFrac) + 0.5;
      if (dy > h - 142) continue;
      ctx.beginPath();
      ctx.moveTo(8, dy);
      ctx.lineTo(18, dy);
      ctx.stroke();
      ctx.fillText(depthMarks[dm].label, 22, dy);
    }

    // 右端水圧・潮流サブスケール
    var rightMarks = [
      { yFrac: 0.34, label: 'CUR 0.4kt' },
      { yFrac: 0.52, label: 'SAL 34.7PSU' }
    ];
    ctx.textAlign = 'right';
    for (var rm = 0; rm < rightMarks.length; rm += 1) {
      var rdy = Math.round(h * rightMarks[rm].yFrac) + 0.5;
      ctx.beginPath();
      ctx.moveTo(w - 18, rdy);
      ctx.lineTo(w - 8, rdy);
      ctx.stroke();
      ctx.fillText(rightMarks[rm].label, w - 22, rdy);
    }
    ctx.restore();

    // 6. 控えめな戦術グリッド
    var grid = CONFIG.GRID_SIZE || 24;
    var major = grid * 4;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = CONFIG.PALETTE.GRID_LINE || 'rgba(56, 214, 255, 0.05)';
    ctx.beginPath();
    for (var gx = grid; gx < w; gx += grid) {
      ctx.moveTo(gx + 0.5, 0);
      ctx.lineTo(gx + 0.5, h);
    }
    for (var gy = grid; gy < h; gy += grid) {
      ctx.moveTo(0, gy + 0.5);
      ctx.lineTo(w, gy + 0.5);
    }
    ctx.stroke();

    ctx.strokeStyle = state.isTidySync
      ? 'rgba(110, 248, 255, 0.11)'
      : (CONFIG.PALETTE.GRID_ACCENT || 'rgba(56, 214, 255, 0.11)');
    ctx.beginPath();
    for (var mx = major; mx < w; mx += major) {
      ctx.moveTo(mx + 0.5, 0);
      ctx.lineTo(mx + 0.5, h);
    }
    for (var my = major; my < h; my += major) {
      ctx.moveTo(0, my + 0.5);
      ctx.lineTo(w, my + 0.5);
    }
    ctx.stroke();

    // 主グリッド交差＋マーカー
    ctx.strokeStyle = state.isTidySync ? 'rgba(255, 216, 77, 0.22)' : 'rgba(56, 214, 255, 0.16)';
    for (var cx = major; cx < w; cx += major) {
      for (var cy = major; cy < h; cy += major) {
        ctx.beginPath();
        ctx.moveTo(cx - 3, cy + 0.5);
        ctx.lineTo(cx + 4, cy + 0.5);
        ctx.moveTo(cx + 0.5, cy - 3);
        ctx.lineTo(cx + 0.5, cy + 4);
        ctx.stroke();
      }
    }
    ctx.restore();

    // 7. 背景ソナー波紋
    ctx.save();
    for (var si = 0; si < uiState.sonarWaves.length; si += 1) {
      var sw = uiState.sonarWaves[si];
      var prog = clamp(sw.life / sw.maxLife, 0, 1);
      var alpha = (1 - prog) * 0.28;
      ctx.strokeStyle = hexToRgba(sw.color, alpha);
      ctx.lineWidth = 1.6 * (1 - prog * 0.5);
      ctx.beginPath();
      ctx.arc(sw.x, sw.y, sw.radius, 0, Math.PI * 2);
      ctx.stroke();

      if (sw.radius > 34) {
        ctx.strokeStyle = hexToRgba(sw.color, alpha * 0.45);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(sw.x, sw.y, sw.radius - 26, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();

    // 8. 多層マリンスノー・微発光プランクトン・上昇気泡
    ctx.save();
    for (var mi = 0; mi < uiState.ambientSnow.length; mi += 1) {
      var sn = uiState.ambientSnow[mi];
      var sx = ((sn.x + Math.sin(time * 0.45 + sn.phase) * sn.drift) % w + w) % w;
      var sy = sn.y % h;
      ctx.fillStyle = sn.hue + sn.alpha.toFixed(2) + ')';
      ctx.beginPath();
      ctx.arc(sx, sy, sn.r, 0, Math.PI * 2);
      ctx.fill();
    }

    var planktons = uiState.ambientPlankton || [];
    for (var pki = 0; pki < planktons.length; pki += 1) {
      var pk = planktons[pki];
      var px = (((pk.nx * w) + Math.sin(time * pk.speed + pk.phase) * 18) % w + w) % w;
      var py = (((pk.ny * h) + Math.cos(time * pk.speed * 0.7 + pk.phase) * 12) % h + h) % h;
      var pGlow = 0.22 + 0.34 * (0.5 + 0.5 * Math.sin(time * 2.1 + pk.phase));
      ctx.fillStyle = hexToRgba(pk.color, pGlow);
      ctx.beginPath();
      ctx.arc(px, py, pk.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (var bi = 0; bi < uiState.ambientBubbles.length; bi += 1) {
      var bb = uiState.ambientBubbles[bi];
      var bx = ((bb.x + Math.sin(time * 1.1 + bb.phase) * 7) % w + w) % w;
      var by = bb.y % h;
      ctx.fillStyle = 'rgba(130, 240, 255, ' + (bb.alpha * 0.36).toFixed(2) + ')';
      ctx.strokeStyle = 'rgba(176, 250, 255, ' + bb.alpha.toFixed(2) + ')';
      ctx.lineWidth = 0.85;
      ctx.beginPath();
      ctx.arc(bx, by, bb.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // 気泡表面のハイライト弧
      if (bb.r >= 2.2) {
        ctx.fillStyle = 'rgba(255, 255, 255, ' + (bb.alpha * 1.2).toFixed(2) + ')';
        ctx.beginPath();
        ctx.arc(bx - bb.r * 0.34, by - bb.r * 0.34, bb.r * 0.24, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // C. 配線ケーブル・ボトルネック膨張・整頓シンクロ・資源粒
  // -------------------------------------------------------------------------

  function renderConnections(ctx, time) {
    var tidyPulse = 0.5 + 0.5 * Math.sin(time * 3.8);

    for (var c = 0; c < state.connections.length; c += 1) {
      var conn = state.connections[c];
      var poly = runtime.wireCache[conn.id] || getWirePolyline(conn, state.cableMode);
      if (!poly || poly.points.length < 2) {
        continue;
      }

      var res = RESOURCES[conn.resourceId] || RESOURCES.raw_data;
      var baseWidth = res.pipeWidth || 3.5;
      var bRatio = clamp(conn.bottleneckRatio || 0, 0, 1);
      var isBottleneck = bRatio > 0.35;
      var isHovered = uiState.hoveredWireId === conn.id;
      var isFluid = baseWidth >= 6.5;

      // 整頓シンクロオーラ（シアン〜ゴールドの輝き）
      if (state.isTidySync && !isBottleneck) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        drawWirePath(ctx, poly);
        ctx.strokeStyle = tidyPulse > 0.5
          ? 'rgba(76, 243, 255, ' + (0.20 + tidyPulse * 0.14).toFixed(2) + ')'
          : 'rgba(255, 216, 77, ' + (0.18 + (1 - tidyPulse) * 0.14).toFixed(2) + ')';
        ctx.lineWidth = baseWidth + 10;
        ctx.shadowColor = tidyPulse > 0.5 ? '#4cf3ff' : '#ffd84d';
        ctx.shadowBlur = 16;
        ctx.stroke();
        ctx.restore();
      }

      // ホバー時ハイライト（切断対象明示）
      if (isHovered) {
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        drawWirePath(ctx, poly);
        ctx.strokeStyle = 'rgba(255, 88, 120, 0.45)';
        ctx.lineWidth = baseWidth + 11;
        ctx.shadowColor = '#ff3b5c';
        ctx.shadowBlur = 14;
        ctx.stroke();
        ctx.restore();
      }

      if (isBottleneck) {
        // ボトルネック時：区分セグメント描画で下流へ向かい物理的にぷっくり膨張＆赤く脈動
        renderBottleneckWire(ctx, poly, res, baseWidth, bRatio, time, isHovered);
      } else {
        // 通常時：2層外装シース＋発光コア＋ガラスハイライト
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // 1. 外装エッジ／ボーダー発光
        drawWirePath(ctx, poly);
        ctx.strokeStyle = isHovered
          ? '#ff7a92'
          : (res.pipeBorderColor || hexToRgba(res.color, 0.55));
        ctx.lineWidth = baseWidth + 3.2;
        ctx.shadowColor = isHovered ? '#ff3b5c' : (res.glowColor || res.color);
        ctx.shadowBlur = isHovered ? 12 : (state.isTidySync ? 11 : 6);
        ctx.stroke();

        // 2. パイプ/ケーブル外装ボディ
        ctx.shadowBlur = 0;
        drawWirePath(ctx, poly);
        ctx.strokeStyle = res.pipeColor || '#124663';
        ctx.lineWidth = baseWidth + 0.6;
        ctx.stroke();

        // 3. 流れるエネルギーコア（点線パルス）
        var flowSpeed = (res.id === 'power' ? 92 : (isFluid ? 38 : 54)) * (state.isTidySync ? 1.2 : 1.0);
        drawWirePath(ctx, poly);
        ctx.strokeStyle = state.isTidySync
          ? (res.id === 'power' ? '#fff4a8' : res.color)
          : hexToRgba(res.secondaryColor || res.color, isFluid ? 0.55 : 0.72);
        ctx.lineWidth = isFluid ? Math.max(2.0, baseWidth * 0.36) : Math.max(1.2, baseWidth * 0.42);
        ctx.setLineDash(res.id === 'power' ? [8, 8] : (isFluid ? [16, 12] : [12, 10]));
        ctx.lineDashOffset = -time * flowSpeed;
        ctx.stroke();
        ctx.setLineDash([]);

        // 4. 太い工業パイプ用ガラスハイライト筋
        if (isFluid) {
          drawWirePath(ctx, poly);
          ctx.strokeStyle = 'rgba(235, 252, 255, 0.22)';
          ctx.lineWidth = 1.1;
          ctx.stroke();
        }
        ctx.restore();
      }

      // 接続フラッシュ（新規接続時の走る光波）
      for (var fi = 0; fi < uiState.vfxWireFlashes.length; fi += 1) {
        var wf = uiState.vfxWireFlashes[fi];
        if (wf.connId === conn.id) {
          var fp = clamp(wf.life / wf.maxLife, 0, 1);
          var fPt = samplePointAtProgress(poly, fp);
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = '#ffffff';
          ctx.shadowColor = wf.color;
          ctx.shadowBlur = 18;
          ctx.beginPath();
          ctx.arc(fPt.x, fPt.y, 6.5 * (1 - fp * 0.4), 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }

      // 始点・終点の真鍮ジョイントカラー
      if (poly.p0 && poly.p1) {
        drawWireFerrule(ctx, poly.p0.x, poly.p0.y, res.color, isBottleneck);
        drawWireFerrule(ctx, poly.p1.x, poly.p1.y, isBottleneck ? '#ff3b5c' : res.color, isBottleneck);
      }
    }
  }

  function renderBottleneckWire(ctx, poly, res, baseWidth, bRatio, time, isHovered) {
    var pts = poly.points;
    if (pts.length < 2) {
      return;
    }
    var pulse = 0.5 + 0.5 * Math.sin(time * 7.8);
    var maxBulge = CONFIG.BOTTLENECK_BULGE_MAX_PX || 11;
    var segCount = pts.length - 1;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (var i = 0; i < segCount; i += 1) {
      var a = pts[i];
      var b = pts[i + 1];
      var tm = (i + 0.5) / segCount;
      // 後半〜終端側に向けてぷっくり膨張する物理プロフィール
      var bulgeProfile = clamp((tm - 0.18) / 0.82, 0, 1);
      var swell = Math.sin(bulgeProfile * Math.PI * 0.82) * (0.72 + pulse * 0.36);
      var extraW = bRatio * maxBulge * swell;
      var w = baseWidth + extraW;

      var isRedZone = tm > 0.28;
      ctx.strokeStyle = isHovered
        ? '#ff85a1'
        : (isRedZone
          ? 'rgba(255, ' + Math.round(54 - bRatio * 20) + ', 92, ' + (0.72 + pulse * 0.28).toFixed(2) + ')'
          : (res.pipeBorderColor || '#ff4fd8'));
      ctx.lineWidth = w + 3.2;
      ctx.shadowColor = isRedZone ? 'rgba(255, 59, 92, 0.92)' : res.color;
      ctx.shadowBlur = isRedZone ? 14 : 6;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.strokeStyle = isRedZone ? '#661326' : (res.pipeColor || '#541a52');
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // 中心の赤熱警告脈動芯
    drawWirePath(ctx, poly);
    ctx.strokeStyle = 'rgba(255, 130, 152, ' + (0.45 + pulse * 0.4).toFixed(2) + ')';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 7]);
    ctx.lineDashOffset = -time * 24;
    ctx.stroke();
    ctx.setLineDash([]);

    // 膨張ピーク付近に警告インジケータリング
    var warnPt = samplePointAtProgress(poly, 0.72);
    ctx.fillStyle = 'rgba(255, 59, 92, ' + (0.65 + pulse * 0.35).toFixed(2) + ')';
    ctx.shadowColor = '#ff3b5c';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(warnPt.x, warnPt.y, 4.2 + pulse * 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawWireFerrule(ctx, x, y, color, isAlert) {
    ctx.save();
    ctx.fillStyle = '#1d2d42';
    ctx.strokeStyle = isAlert ? '#ff5978' : '#d8a648';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(x, y, 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = isAlert ? '#ff3b5c' : color;
    ctx.beginPath();
    ctx.arc(x, y, 2.0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function renderWiringPreview(ctx, time) {
    var activeStart = uiState.wiringDrag || uiState.pendingWirePort;
    if (!activeStart) {
      return;
    }
    var fromPos = getPortPosition(activeStart.fromNodeId, activeStart.fromPortId);
    if (!fromPos) {
      return;
    }

    var sx = fromPos.x;
    var sy = fromPos.y;
    var tx = uiState.wiringDrag && uiState.wiringDrag.snapTarget
      ? uiState.wiringDrag.snapTarget.x
      : uiState.pointer.x;
    var ty = uiState.wiringDrag && uiState.wiringDrag.snapTarget
      ? uiState.wiringDrag.snapTarget.y
      : uiState.pointer.y;

    var fromNode = findNode(activeStart.fromNodeId);
    var previewColor = fromPos.portDef.color || '#00f0ff';
    if (activeStart.dir === 'out' && fromNode) {
      var resId = getEffectiveOutputType(fromNode, activeStart.fromPortId);
      if (resId && RESOURCES[resId]) {
        previewColor = RESOURCES[resId].color;
      }
    }

    var isSnapped = Boolean(uiState.wiringDrag && uiState.wiringDrag.snapTarget);
    if (uiState.wiringDrag && uiState.wiringDrag.incompatibleHover) {
      previewColor = '#ff3b5c';
    }

    // 始点・終点の向きを出力→入力風に調整してプレビュー曲線を作成
    var pStart = activeStart.dir === 'out' ? { x: sx, y: sy } : { x: tx, y: ty };
    var pEnd = activeStart.dir === 'out' ? { x: tx, y: ty } : { x: sx, y: sy };
    var previewPoly;
    if (state.cableMode === 'ortho') {
      var midX = (pStart.x + pEnd.x) * 0.5;
      previewPoly = {
        mode: 'ortho',
        points: pEnd.x >= pStart.x + 12
          ? [pStart, { x: midX, y: pStart.y }, { x: midX, y: pEnd.y }, pEnd]
          : [pStart, { x: pStart.x + 24, y: pStart.y }, { x: pStart.x + 24, y: (pStart.y + pEnd.y) * 0.5 }, { x: pEnd.x - 24, y: (pStart.y + pEnd.y) * 0.5 }, { x: pEnd.x - 24, y: pEnd.y }, pEnd]
      };
    } else {
      var cp = buildBezierControlPoints(pStart, pEnd);
      previewPoly = {
        mode: 'bezier',
        controlPoints: cp,
        points: [pStart, pEnd]
      };
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    drawWirePath(ctx, previewPoly);
    ctx.strokeStyle = hexToRgba(previewColor, isSnapped ? 0.92 : 0.65);
    ctx.lineWidth = isSnapped ? 4.2 : 3.0;
    ctx.shadowColor = previewColor;
    ctx.shadowBlur = 14;
    ctx.setLineDash([10, 7]);
    ctx.lineDashOffset = -time * 64;
    ctx.stroke();
    ctx.setLineDash([]);

    // 始点ポートの脈動リング
    ctx.strokeStyle = previewColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, 12 + Math.sin(time * 8) * 2.5, 0, Math.PI * 2);
    ctx.stroke();

    if (isSnapped) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(tx, ty, 13 + Math.sin(time * 10) * 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function renderPackets(ctx, time) {
    for (var i = 0; i < state.packets.length; i += 1) {
      var pkt = state.packets[i];
      var poly = runtime.wireCache[pkt.connId];
      if (!poly || poly.points.length < 2) {
        continue;
      }
      var res = RESOURCES[pkt.resourceId] || RESOURCES.raw_data;
      var pt = samplePointAtProgress(poly, pkt.progress);
      var r = res.particleRadius || 4.8;
      var shape = res.particleShape || 'orb';

      // 温排水は道中で湯気粒子をときおり放出
      if (res.emitSteam && Math.random() < 0.08 && uiState.vfxParticles.length < CONFIG.MAX_VFX_PARTICLES) {
        uiState.vfxParticles.push({
          kind: 'steam',
          x: pt.x + (Math.random() - 0.5) * 4,
          y: pt.y - 2,
          vx: (Math.random() - 0.5) * 10,
          vy: -18 - Math.random() * 14,
          r: 2.2 + Math.random() * 1.4,
          life: 0,
          maxLife: 0.65 + Math.random() * 0.25,
          color: '#ff965a'
        });
      }

      ctx.save();
      ctx.translate(pt.x, pt.y);

      if (shape === 'bolt') {
        // 電力：黄色い稲妻パルス
        ctx.rotate(pt.angle);
        ctx.globalCompositeOperation = 'lighter';
        ctx.shadowColor = res.color;
        ctx.shadowBlur = 14;
        ctx.strokeStyle = res.color;
        ctx.lineWidth = 2.8;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(-8.5, 0.5);
        ctx.lineTo(-2.5, -3.6);
        ctx.lineTo(1.2, 3.6);
        ctx.lineTo(7.5, -1.0);
        ctx.stroke();

        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.3;
        ctx.stroke();
      } else if (shape === 'diamond') {
        // 精製データ：マゼンタ〜シアン輝くダイヤモンド粒
        ctx.rotate(pt.angle);
        ctx.shadowColor = res.color;
        ctx.shadowBlur = 12;
        ctx.strokeStyle = hexToRgba(res.secondaryColor || '#00f0ff', 0.45);
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        ctx.moveTo(-r * 2.2, 0);
        ctx.lineTo(-r * 0.5, 0);
        ctx.stroke();

        var dg = ctx.createLinearGradient(-r, 0, r, 0);
        dg.addColorStop(0, res.secondaryColor || '#00f0ff');
        dg.addColorStop(0.55, res.color);
        dg.addColorStop(1, '#ffe6fb');
        ctx.fillStyle = dg;
        ctx.beginPath();
        ctx.moveTo(r + 2, 0);
        ctx.lineTo(0, r * 0.78);
        ctx.lineTo(-r - 2, 0);
        ctx.lineTo(0, -r * 0.78);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, 1.7, 0, Math.PI * 2);
        ctx.fill();
      } else if (shape === 'crystal') {
        // 高純度データ：黄金〜マゼンタの高速クリスタル
        ctx.rotate(pt.angle);
        ctx.globalCompositeOperation = 'lighter';
        ctx.shadowColor = '#ffb830';
        ctx.shadowBlur = 16;

        // 高速光の尾
        var tailGrad = ctx.createLinearGradient(-r * 3.2, 0, 0, 0);
        tailGrad.addColorStop(0, 'rgba(255, 85, 216, 0)');
        tailGrad.addColorStop(1, 'rgba(255, 184, 48, 0.85)');
        ctx.strokeStyle = tailGrad;
        ctx.lineWidth = 2.8;
        ctx.beginPath();
        ctx.moveTo(-r * 3.2, 0);
        ctx.lineTo(0, 0);
        ctx.stroke();

        var cg = ctx.createLinearGradient(-r, -r, r, r);
        cg.addColorStop(0, '#fff9d6');
        cg.addColorStop(0.45, '#ffb830');
        cg.addColorStop(1, '#ff55d8');
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.moveTo(r + 3, 0);
        ctx.lineTo(1.5, r * 0.82);
        ctx.lineTo(-r - 1.5, 0);
        ctx.lineTo(1.5, -r * 0.82);
        ctx.closePath();
        ctx.fill();

        // 十字キラめき
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-3.5, 0);
        ctx.lineTo(3.5, 0);
        ctx.moveTo(0, -3.5);
        ctx.lineTo(0, 3.5);
        ctx.stroke();
      } else if (shape === 'snowflake') {
        // 高純度冷却液：氷青〜白銀の結晶スター
        ctx.rotate(time * 2.8 + pkt.progress * 6.0);
        ctx.shadowColor = '#7afcff';
        ctx.shadowBlur = 13;
        ctx.strokeStyle = '#e8ffff';
        ctx.lineWidth = 1.6;
        for (var sp = 0; sp < 3; sp += 1) {
          var a = (sp * Math.PI) / 3;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * (r + 1), Math.sin(a) * (r + 1));
          ctx.lineTo(-Math.cos(a) * (r + 1), -Math.sin(a) * (r + 1));
          ctx.stroke();
        }
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, 2.2, 0, Math.PI * 2);
        ctx.fill();
      } else if (shape === 'droplet' || shape === 'steam_drop') {
        // 深層水／温排水：艶やかな流体カプセル
        ctx.rotate(pt.angle);
        ctx.shadowColor = res.color;
        ctx.shadowBlur = 11;
        var fg = ctx.createRadialGradient(-1.2, -1.2, 0.6, 0, 0, r + 1.4);
        fg.addColorStop(0, res.coreColor || '#ffffff');
        fg.addColorStop(0.55, res.color);
        fg.addColorStop(1, res.secondaryColor || res.color);
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.ellipse(0, 0, r + 1.4, r * 0.8, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.beginPath();
        ctx.arc(-1.5, -1.5, 1.3, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // 生データ等：シアンネオン粒
        ctx.rotate(pt.angle);
        ctx.shadowColor = res.color;
        ctx.shadowBlur = 12;
        ctx.strokeStyle = hexToRgba(res.color, 0.42);
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        ctx.moveTo(-r * 2.0, 0);
        ctx.lineTo(0, 0);
        ctx.stroke();

        var og = ctx.createRadialGradient(0, 0, 0.5, 0, 0, r);
        og.addColorStop(0, '#ffffff');
        og.addColorStop(0.55, res.color);
        og.addColorStop(1, hexToRgba(res.color, 0.15));
        ctx.fillStyle = og;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  }

  // -------------------------------------------------------------------------
  // D. 全7種工業計器ノードの高精細Canvas描画
  // -------------------------------------------------------------------------

  function renderNodes(ctx, time) {
    for (var i = 0; i < state.nodes.length; i += 1) {
      var node = state.nodes[i];
      var part = PARTS_MAP[node.partId];
      if (!part) {
        continue;
      }
      renderSingleNode(ctx, node, part, time);
    }
  }

  function getNodeHardwareTrim(part) {
    var pid = part && part.id ? part.id : '';
    if (pid === 'emergency_battery') {
      return {
        plateTop: '#1d2b3b',
        plateMid: '#111d2b',
        plateBot: '#070e17',
        trim: '#f0b849',
        trimDark: '#745012',
        fin: '#b88225',
        innerGlow: 'rgba(255, 198, 66, 0.16)'
      };
    }
    if (pid === 'hydrothermal_turbine') {
      return {
        plateTop: '#2b221e',
        plateMid: '#181414',
        plateBot: '#09090c',
        trim: '#ff9642',
        trimDark: '#7d3a12',
        fin: '#c46427',
        innerGlow: 'rgba(255, 138, 64, 0.18)'
      };
    }
    if (pid === 'drain_vent') {
      return {
        plateTop: '#261e24',
        plateMid: '#151218',
        plateBot: '#08080e',
        trim: '#ff7048',
        trimDark: '#782816',
        fin: '#ba4b2d',
        innerGlow: 'rgba(255, 112, 72, 0.16)'
      };
    }
    if (pid === 'deep_water_intake') {
      return {
        plateTop: '#122b40',
        plateMid: '#0b1c2d',
        plateBot: '#050d17',
        trim: '#4cc9ff',
        trimDark: '#1b5b7c',
        fin: '#2e88b5',
        innerGlow: 'rgba(76, 201, 255, 0.16)'
      };
    }
    if (pid === 'submarine_cable') {
      return {
        plateTop: '#132a42',
        plateMid: '#0b1b2e',
        plateBot: '#050d18',
        trim: '#2fe2ff',
        trimDark: '#16657d',
        fin: '#2498b8',
        innerGlow: 'rgba(47, 226, 255, 0.16)'
      };
    }
    if (pid === 'surface_uplink') {
      return {
        plateTop: '#142c39',
        plateMid: '#0b1d27',
        plateBot: '#050e15',
        trim: '#3df5b4',
        trimDark: '#176e4e',
        fin: '#279e72',
        innerGlow: 'rgba(61, 245, 180, 0.16)'
      };
    }
    return {
      plateTop: '#162f49',
      plateMid: '#0c1f34',
      plateBot: '#050d19',
      trim: '#00f0ff',
      trimDark: '#17647e',
      fin: '#267c9c',
      innerGlow: 'rgba(0, 240, 255, 0.16)'
    };
  }

  function drawSidePressureFins(ctx, node, part, trimCfg, headerH) {
    var portYsLeft = [];
    var portYsRight = [];
    var ins = (part.ports && part.ports.inputs) ? part.ports.inputs : [];
    var outs = (part.ports && part.ports.outputs) ? part.ports.outputs : [];
    for (var i = 0; i < ins.length; i += 1) {
      var ip = ins[i];
      var ipy = node.y + (ip.offset ? ip.offset.y : 0.5) * node.height;
      if (!ip.offset || ip.offset.x <= 0.5) portYsLeft.push(ipy);
      else portYsRight.push(ipy);
    }
    for (var o = 0; o < outs.length; o += 1) {
      var op = outs[o];
      var opy = node.y + (op.offset ? op.offset.y : 0.5) * node.height;
      if (op.offset && op.offset.x < 0.5) portYsLeft.push(opy);
      else portYsRight.push(opy);
    }

    var startY = node.y + headerH + 8;
    var endY = node.y + node.height - 15;
    for (var fy = startY; fy <= endY; fy += 9) {
      var leftSafe = true;
      for (var li = 0; li < portYsLeft.length; li += 1) {
        if (Math.abs((fy + 2) - portYsLeft[li]) <= 13.5) {
          leftSafe = false;
          break;
        }
      }
      if (leftSafe) {
        ctx.fillStyle = trimCfg.trimDark;
        ctx.fillRect(node.x - 3.2, fy, 3.2, 4.4);
        ctx.fillStyle = trimCfg.fin;
        ctx.fillRect(node.x - 2.6, fy + 0.6, 2.0, 1.8);
      }

      var rightSafe = true;
      for (var ri = 0; ri < portYsRight.length; ri += 1) {
        if (Math.abs((fy + 2) - portYsRight[ri]) <= 13.5) {
          rightSafe = false;
          break;
        }
      }
      if (rightSafe) {
        ctx.fillStyle = trimCfg.trimDark;
        ctx.fillRect(node.x + node.width, fy, 3.2, 4.4);
        ctx.fillStyle = trimCfg.fin;
        ctx.fillRect(node.x + node.width + 0.6, fy + 0.6, 2.0, 1.8);
      }
    }
  }

  function renderSingleNode(ctx, node, part, time) {
    var isSelected = state.selectedNodeId === node.id;
    var isHovered = uiState.hoveredNodeId === node.id;
    var theme = part.theme || {
      accent: '#00f0ff',
      bg: '#0c2033',
      border: '#1fa9c7',
      glow: 'rgba(0, 240, 255, 0.34)'
    };
    var trimCfg = getNodeHardwareTrim(part);
    var cornerR = CONFIG.NODE_CORNER_RADIUS || 12;
    var headerH = 26;

    ctx.save();

    // 1. 状態別外部オーラ（過熱赤警報／冷却120%結晶オーラ／選択リング）
    if (node.isOverheated) {
      var ohPulse = 0.5 + 0.5 * Math.sin(time * 9.5);
      roundRectPath(ctx, node.x - 5, node.y - 5, node.width + 10, node.height + 10, 15);
      ctx.strokeStyle = 'rgba(255, 59, 92, ' + (0.45 + ohPulse * 0.45).toFixed(2) + ')';
      ctx.lineWidth = 2.6;
      ctx.shadowColor = '#ff3b5c';
      ctx.shadowBlur = 18;
      ctx.stroke();
      ctx.shadowBlur = 0;
    } else if (node.isCoolBoosted) {
      var cbPulse = 0.5 + 0.5 * Math.sin(time * 4.2);
      roundRectPath(ctx, node.x - 4, node.y - 4, node.width + 8, node.height + 8, 14);
      ctx.strokeStyle = 'rgba(122, 252, 255, ' + (0.42 + cbPulse * 0.38).toFixed(2) + ')';
      ctx.lineWidth = 2.0;
      ctx.shadowColor = '#7afcff';
      ctx.shadowBlur = 15;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    if (isSelected || isHovered) {
      roundRectPath(ctx, node.x - 4, node.y - 4, node.width + 8, node.height + 8, 14);
      ctx.strokeStyle = isSelected ? '#ffd84d' : hexToRgba(theme.accent, 0.7);
      ctx.lineWidth = isSelected ? 2.2 : 1.4;
      ctx.shadowColor = isSelected ? '#ffd84d' : theme.accent;
      ctx.shadowBlur = isSelected ? 16 : 10;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    var isDraggingThis = Boolean(uiState.nodeDrag && uiState.nodeDrag.nodeId === node.id);
    if (isDraggingThis && (uiState.dragOverlapBlocked || (uiState.dragOverlapAdjusted && uiState.dragOverlapTimer > 0))) {
      var dragWarnCol = uiState.dragOverlapBlocked ? '#ff3b5c' : '#ff9e2c';
      roundRectPath(ctx, node.x - 6, node.y - 6, node.width + 12, node.height + 12, 15);
      ctx.strokeStyle = hexToRgba(dragWarnCol, 0.88);
      ctx.lineWidth = 2.4;
      ctx.shadowColor = dragWarnCol;
      ctx.shadowBlur = 16;
      ctx.stroke();
      ctx.shadowBlur = 0;

      var dragWarnLabel = uiState.dragOverlapBlocked ? '重複ブロック' : '接触回避補正';
      ctx.save();
      ctx.font = '700 10px ' + CONFIG.FONT_FAMILY;
      var warnTw = Math.max(82, ctx.measureText(dragWarnLabel).width + 16);
      var warnTx = node.x + node.width * 0.5 - warnTw * 0.5;
      var warnTy = Math.max(8, node.y - 25);
      roundRectPath(ctx, warnTx, warnTy, warnTw, 18, 5);
      ctx.fillStyle = 'rgba(18, 8, 16, 0.92)';
      ctx.fill();
      ctx.strokeStyle = dragWarnCol;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = uiState.dragOverlapBlocked ? '#ff8fa3' : '#ffd27d';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(dragWarnLabel, node.x + node.width * 0.5, warnTy + 9.5);
      ctx.restore();
    }

    // 1.5 ポート非干渉の耐圧側面ヒートシンクフィン
    drawSidePressureFins(ctx, node, part, trimCfg, headerH);

    // 2. ノード外装耐圧筐体（ドロップシャドウ＋多層金属グラデーション＋二重ベベル）
    roundRectPath(ctx, node.x, node.y, node.width, node.height, cornerR);
    var bodyGrad = ctx.createLinearGradient(node.x, node.y, node.x, node.y + node.height);
    bodyGrad.addColorStop(0, trimCfg.plateTop);
    bodyGrad.addColorStop(0.36, trimCfg.plateMid || theme.bg || '#0d2138');
    bodyGrad.addColorStop(0.84, '#081424');
    bodyGrad.addColorStop(1, trimCfg.plateBot);
    ctx.fillStyle = bodyGrad;
    ctx.shadowColor = 'rgba(0, 3, 12, 0.88)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // 稼働フラッシュオーバーレイ
    if (node.activeFlashTimer > 0) {
      ctx.fillStyle = hexToRgba(theme.accent, clamp(node.activeFlashTimer * 0.25, 0, 0.14));
      ctx.fill();
    }

    // 二重ベベル内枠＆外枠
    ctx.strokeStyle = node.isOverheated
      ? '#ff5978'
      : (isSelected ? '#ffd84d' : (theme.border || CONFIG.PALETTE.NODE_BORDER));
    ctx.lineWidth = isSelected ? 1.85 : 1.4;
    ctx.stroke();

    roundRectPath(ctx, node.x + 2.2, node.y + 2.2, node.width - 4.4, node.height - 4.4, Math.max(8, cornerR - 2));
    ctx.strokeStyle = node.isOverheated
      ? 'rgba(255, 110, 130, 0.28)'
      : hexToRgba(trimCfg.trim, 0.22);
    ctx.lineWidth = 0.9;
    ctx.stroke();

    // 上縁スペキュラーハイライト線
    ctx.strokeStyle = 'rgba(218, 248, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(node.x + 12, node.y + 1.5);
    ctx.lineTo(node.x + node.width - 12, node.y + 1.5);
    ctx.stroke();

    // 3. ヘッダープレート＆内面工業装飾（クリップ内で描画）
    ctx.save();
    roundRectPath(ctx, node.x, node.y, node.width, node.height, cornerR);
    ctx.clip();

    // 内側上部環境反射
    var innerBloom = ctx.createRadialGradient(
      node.x + node.width * 0.5,
      node.y + headerH + 14,
      8,
      node.x + node.width * 0.5,
      node.y + headerH + 22,
      node.width * 0.65
    );
    innerBloom.addColorStop(0, trimCfg.innerGlow);
    innerBloom.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = innerBloom;
    ctx.fillRect(node.x, node.y + headerH, node.width, node.height - headerH);

    // ヘッダーメタリックバー
    var hdrGrad = ctx.createLinearGradient(node.x, node.y, node.x, node.y + headerH);
    hdrGrad.addColorStop(0, 'rgba(34, 74, 118, 0.96)');
    hdrGrad.addColorStop(0.55, 'rgba(18, 42, 72, 0.96)');
    hdrGrad.addColorStop(1, 'rgba(9, 22, 42, 0.96)');
    ctx.fillStyle = hdrGrad;
    ctx.fillRect(node.x, node.y, node.width, headerH);

    // 左端斜めインダストリアル・ハッチ（タイトル文字と非干渉領域 x..x+11）
    ctx.fillStyle = hexToRgba(trimCfg.trim, 0.28);
    for (var hi = -6; hi < headerH; hi += 6) {
      ctx.beginPath();
      ctx.moveTo(node.x + 2, node.y + hi + 4);
      ctx.lineTo(node.x + 10, node.y + hi);
      ctx.lineTo(node.x + 10, node.y + hi + 2.4);
      ctx.lineTo(node.x + 2, node.y + hi + 6.4);
      ctx.closePath();
      ctx.fill();
    }

    // ヘッダー下部真鍮・カテゴリデュアルライン
    ctx.fillStyle = hexToRgba(trimCfg.trimDark, 0.8);
    ctx.fillRect(node.x, node.y + headerH - 1.5, node.width, 1.5);
    ctx.strokeStyle = hexToRgba(theme.accent, 0.68);
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(node.x, node.y + headerH + 0.5);
    ctx.lineTo(node.x + node.width, node.y + headerH + 0.5);
    ctx.stroke();

    // 4隅コーナー補強ガードプレート
    ctx.fillStyle = 'rgba(20, 42, 68, 0.72)';
    ctx.strokeStyle = hexToRgba(trimCfg.trim, 0.25);
    ctx.lineWidth = 0.8;
    var guardPts = [
      [[node.x, node.y], [node.x + 15, node.y], [node.x, node.y + 15]],
      [[node.x + node.width, node.y], [node.x + node.width - 15, node.y], [node.x + node.width, node.y + 15]],
      [[node.x, node.y + node.height], [node.x + 15, node.y + node.height], [node.x, node.y + node.height - 15]],
      [[node.x + node.width, node.y + node.height], [node.x + node.width - 15, node.y + node.height], [node.x + node.width, node.y + node.height - 15]]
    ];
    for (var gi = 0; gi < guardPts.length; gi += 1) {
      ctx.beginPath();
      ctx.moveTo(guardPts[gi][0][0], guardPts[gi][0][1]);
      ctx.lineTo(guardPts[gi][1][0], guardPts[gi][1][1]);
      ctx.lineTo(guardPts[gi][2][0], guardPts[gi][2][1]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // 耐圧ハウジング斜めガラス反射光沢（ごく微細）
    ctx.fillStyle = 'rgba(210, 245, 255, 0.032)';
    ctx.beginPath();
    ctx.moveTo(node.x + node.width * 0.14, node.y);
    ctx.lineTo(node.x + node.width * 0.34, node.y);
    ctx.lineTo(node.x + node.width * 0.16, node.y + node.height);
    ctx.lineTo(node.x - node.width * 0.04, node.y + node.height);
    ctx.closePath();
    ctx.fill();

    // 下部微細ハッチング溝
    ctx.fillStyle = 'rgba(0, 240, 255, 0.025)';
    for (var sy = node.y + headerH + 4; sy < node.y + node.height - 4; sy += 6) {
      ctx.fillRect(node.x + 5, sy, node.width - 10, 1);
    }
    ctx.restore();

    // 4. 4隅の真鍮六角ボルトリベット（位置・サイズはフッター文字非干渉を維持）
    var rivetOff = 7;
    var rivets = [
      [node.x + rivetOff, node.y + rivetOff],
      [node.x + node.width - rivetOff, node.y + rivetOff],
      [node.x + rivetOff, node.y + node.height - rivetOff],
      [node.x + node.width - rivetOff, node.y + node.height - rivetOff]
    ];
    for (var ri = 0; ri < rivets.length; ri += 1) {
      var rx = rivets[ri][0];
      var ry = rivets[ri][1];
      ctx.fillStyle = '#56380a';
      ctx.beginPath();
      ctx.arc(rx, ry, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#b48024';
      ctx.strokeStyle = '#362104';
      ctx.lineWidth = 0.65;
      ctx.beginPath();
      for (var hx = 0; hx < 6; hx += 1) {
        var ha = (hx / 6) * Math.PI * 2;
        var hpx = rx + Math.cos(ha) * 2.1;
        var hpy = ry + Math.sin(ha) * 2.1;
        if (hx === 0) ctx.moveTo(hpx, hpy);
        else ctx.lineTo(hpx, hpy);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffeab0';
      ctx.beginPath();
      ctx.arc(rx - 0.55, ry - 0.55, 0.78, 0, Math.PI * 2);
      ctx.fill();
    }

    // 5. ヘッダーテキスト＆状態LED（ベゼルリング付き）
    var ledColor = '#5d84a6';
    var ledPulse = 0.7;
    if (node.status === 'overheat' || node.status === 'bottleneck') {
      ledColor = '#ff3b5c';
      ledPulse = 0.5 + 0.5 * Math.sin(time * 12);
    } else if (node.status === 'warning') {
      ledColor = '#ff9e2c';
      ledPulse = 0.65 + 0.35 * Math.sin(time * 6);
    } else if (node.status === 'boosted') {
      ledColor = '#7afcff';
      ledPulse = 0.75 + 0.25 * Math.sin(time * 5);
    } else if (node.status === 'running') {
      ledColor = '#3df5b4';
      ledPulse = 0.8 + 0.2 * Math.sin(time * 4);
    } else if (node.status === 'no_power' || node.status === 'no_input') {
      ledColor = '#ffb830';
      ledPulse = 0.4 + 0.4 * Math.sin(time * 3);
    }

    // LEDドット＋金属ベゼル
    var ledX = node.x + node.width - 17;
    var ledY = node.y + headerH * 0.5;
    ctx.save();
    ctx.fillStyle = '#091422';
    ctx.strokeStyle = trimCfg.trimDark;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(ledX, ledY, 4.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = hexToRgba(ledColor, ledPulse);
    ctx.shadowColor = ledColor;
    ctx.shadowBlur = 9;
    ctx.beginPath();
    ctx.arc(ledX, ledY, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ledX - 0.8, ledY - 0.8, 1.0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // タイトル日本語テキスト
    ctx.font = '700 11.5px ' + CONFIG.FONT_FAMILY;
    ctx.fillStyle = '#eaf7ff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(part.shortName || part.name, node.x + 15, node.y + headerH * 0.5 + 0.5, node.width - 38);

    // 選択中ノードの4隅タクティカルブラケット
    if (isSelected) {
      drawSelectionBrackets(ctx, node.x - 4, node.y - 4, node.width + 8, node.height + 8, '#ffd84d');
    }

    // 6. パーツ別内部アニメーション描画領域（4隅リベット・ポート外枠から非干渉な安全領域）
    var ix = node.x + 12;
    var iy = node.y + headerH + 6;
    var iw = node.width - 24;
    var ih = node.height - headerH - 16;

    if (node.partId === 'emergency_battery') {
      drawEmergencyBatteryInternals(ctx, node, ix, iy, iw, ih, time);
    } else if (node.partId === 'submarine_cable') {
      drawSubmarineCableInternals(ctx, node, ix, iy, iw, ih, time);
    } else if (node.partId === 'generic_module') {
      drawGenericModuleInternals(ctx, node, ix, iy, iw, ih, time);
    } else if (node.partId === 'surface_uplink') {
      drawSurfaceUplinkInternals(ctx, node, ix, iy, iw, ih, time);
    } else if (node.partId === 'deep_water_intake') {
      drawDeepWaterIntakeInternals(ctx, node, ix, iy, iw, ih, time);
    } else if (node.partId === 'drain_vent') {
      drawDrainVentInternals(ctx, node, ix, iy, iw, ih, time);
    } else if (node.partId === 'hydrothermal_turbine') {
      drawHydrothermalTurbineInternals(ctx, node, ix, iy, iw, ih, time);
    }

    // 7. ポートソケット（方向・種別色・互換ハイライト）
    drawNodePorts(ctx, node, part, time);

    ctx.restore();
  }

  function drawSelectionBrackets(ctx, x, y, w, h, color) {
    var len = 10;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    // 左上
    ctx.moveTo(x + len, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + len);
    // 右上
    ctx.moveTo(x + w - len, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + len);
    // 右下
    ctx.moveTo(x + w - len, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w, y + h - len);
    // 左下
    ctx.moveTo(x + len, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + h - len);
    ctx.stroke();
    ctx.restore();
  }

  function drawNodeFooterBar(ctx, ix, iy, iw, ih, borderColor, leftText, leftColor, leftFont, rightText, rightColor, rightFont, leftRatio) {
    var plateH = 16;
    var plateY = iy + ih - plateH;
    var labelY = iy + ih - 8;
    var insetX = 4;
    var availW = Math.max(24, iw - insetX * 2 - 6);
    var ratio = clamp(typeof leftRatio === 'number' ? leftRatio : 0.5, 0.25, 0.78);
    var leftMaxW = Math.max(18, Math.floor(availW * ratio));
    var rightMaxW = Math.max(18, availW - leftMaxW);

    ctx.save();
    roundRectPath(ctx, ix, plateY, iw, plateH, 4);
    ctx.fillStyle = 'rgba(3, 12, 24, 0.88)';
    ctx.fill();
    ctx.strokeStyle = borderColor || 'rgba(110, 178, 220, 0.28)';
    ctx.lineWidth = 0.9;
    ctx.stroke();

    ctx.textBaseline = 'middle';
    if (leftText) {
      ctx.font = leftFont;
      ctx.fillStyle = leftColor;
      ctx.textAlign = 'left';
      ctx.fillText(leftText, ix + insetX, labelY, leftMaxW);
    }
    if (rightText) {
      ctx.font = rightFont;
      ctx.fillStyle = rightColor;
      ctx.textAlign = 'right';
      ctx.fillText(rightText, ix + iw - insetX, labelY, rightMaxW);
    }
    ctx.restore();
  }

  function drawEmergencyBatteryInternals(ctx, node, ix, iy, iw, ih, time) {
    var windowH = ih - 18;
    var activeGlow = 0.6 + 0.4 * Math.sin(time * 5.2);

    // 1. 耐圧コンデンサ収容ベイ
    roundRectPath(ctx, ix, iy, iw, windowH, 6);
    var bayBg = ctx.createLinearGradient(ix, iy, ix, iy + windowH);
    bayBg.addColorStop(0, 'rgba(6, 18, 34, 0.94)');
    bayBg.addColorStop(1, 'rgba(2, 9, 19, 0.94)');
    ctx.fillStyle = bayBg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(224, 174, 76, 0.48)';
    ctx.lineWidth = 1.05;
    ctx.stroke();

    // 上下真鍮バスバー（全セルを並列接続する電極レール）
    var busLeft = ix + 6;
    var busRight = ix + iw - 28;
    ctx.fillStyle = '#7a5416';
    ctx.fillRect(busLeft, iy + 3, busRight - busLeft, 2.2);
    ctx.fillRect(busLeft, iy + windowH - 5.2, busRight - busLeft, 2.2);
    ctx.fillStyle = 'rgba(255, 224, 130, 0.45)';
    ctx.fillRect(busLeft, iy + 3, busRight - busLeft, 0.8);

    // 2. 4本の高密度ガラス蓄電セル
    var cellCount = 4;
    var padX = 7;
    var cellAreaW = iw - padX * 2 - 25;
    var cellW = (cellAreaW - (cellCount - 1) * 4) / cellCount;
    var cellH = Math.max(12, windowH - 12);
    var chargeCycle = clamp(node.processTimer / Math.max(0.1, node.effectiveInterval), 0, 1);

    for (var c = 0; c < cellCount; c += 1) {
      var bx = ix + padX + c * (cellW + 4);
      var by = iy + 6;
      var lit = c < Math.floor(chargeCycle * cellCount) + 1;

      // セル外装ガラス管＆端子キャップ
      ctx.fillStyle = 'rgba(18, 36, 56, 0.65)';
      roundRectPath(ctx, bx, by, cellW, cellH, 3);
      ctx.fill();
      ctx.fillStyle = '#9e7020';
      ctx.fillRect(bx + 2, by - 1, cellW - 4, 2);
      ctx.fillRect(bx + 2, by + cellH - 1, cellW - 4, 2);

      if (lit) {
        var cg = ctx.createLinearGradient(bx, by, bx, by + cellH);
        cg.addColorStop(0, '#fff9c4');
        cg.addColorStop(0.45, '#ffd84d');
        cg.addColorStop(1, '#cf8516');
        ctx.fillStyle = cg;
        ctx.shadowColor = '#ffd84d';
        ctx.shadowBlur = 8;
        roundRectPath(ctx, bx + 1.2, by + 1.4, cellW - 2.4, cellH - 2.8, 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // ガラス管表面ハイライト＆容量目盛
        ctx.fillStyle = 'rgba(255, 255, 255, 0.38)';
        ctx.fillRect(bx + 2.4, by + 2.5, 1.5, cellH - 5);
      }

      ctx.strokeStyle = 'rgba(12, 24, 40, 0.68)';
      ctx.lineWidth = 0.8;
      for (var tk = 1; tk <= 2; tk += 1) {
        var tky = by + (cellH * tk) / 3;
        ctx.beginPath();
        ctx.moveTo(bx + 2, tky);
        ctx.lineTo(bx + cellW - 2, tky);
        ctx.stroke();
      }
    }

    // 3. セル〜インダクタ間の高圧放電アーク（なめらかな決定論的スパーク）
    var arcStartX = busRight - 2;
    var boltX = ix + iw - 14.5;
    var boltY = iy + windowH * 0.5;
    ctx.save();
    ctx.strokeStyle = 'rgba(122, 252, 255, ' + (0.35 + 0.45 * activeGlow).toFixed(2) + ')';
    ctx.lineWidth = 1.15;
    ctx.shadowColor = '#7afcff';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(arcStartX, iy + 8);
    ctx.lineTo(arcStartX + 4, boltY - 4 + Math.sin(time * 24) * 2.2);
    ctx.lineTo(boltX - 5, boltY + Math.cos(time * 31) * 2.0);
    ctx.stroke();
    ctx.restore();

    // 4. 右側の銅巻線コイル＋高圧稲妻インジケータ
    ctx.save();
    ctx.strokeStyle = 'rgba(216, 136, 46, 0.72)';
    ctx.lineWidth = 1.5;
    for (var cr = -7; cr <= 7; cr += 4.6) {
      ctx.beginPath();
      ctx.moveTo(boltX - 7, boltY + cr);
      ctx.lineTo(boltX + 7, boltY + cr - 1.2);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255, 224, 102, ' + (0.65 + 0.35 * Math.sin(time * 6)).toFixed(2) + ')';
    ctx.fillStyle = '#fff5ad';
    ctx.shadowColor = '#ffd84d';
    ctx.shadowBlur = 11;
    ctx.beginPath();
    ctx.moveTo(boltX + 2, boltY - 9.5);
    ctx.lineTo(boltX - 5, boltY + 1);
    ctx.lineTo(boltX, boltY + 1);
    ctx.lineTo(boltX - 3, boltY + 9.5);
    ctx.lineTo(boltX + 5, boltY - 1);
    ctx.lineTo(boltX, boltY - 1);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 下部出力プレート（左右インセット・リベット/右ポート非干渉）
    drawNodeFooterBar(
      ctx,
      ix,
      iy,
      iw,
      ih,
      'rgba(216, 166, 72, 0.32)',
      '12 MW',
      '#ffe588',
      '700 9.5px ' + CONFIG.MONO_FONT_FAMILY,
      '自己発電中',
      '#9fe8cc',
      '600 9px ' + CONFIG.FONT_FAMILY,
      0.42
    );
  }

  function drawSubmarineCableInternals(ctx, node, ix, iy, iw, ih, time) {
    var hasPower = node.status === 'running';
    var screenH = ih - 18;
    var midY = iy + screenH * 0.5;
    var midX = ix + iw * 0.5;

    // 1. 光学CRTオシロスコープ枠＆アーマー編組トリム
    ctx.save();
    roundRectPath(ctx, ix, iy, iw, screenH, 6);
    var scopeBg = ctx.createLinearGradient(ix, iy, ix, iy + screenH);
    scopeBg.addColorStop(0, 'rgba(3, 18, 34, 0.94)');
    scopeBg.addColorStop(1, 'rgba(1, 10, 22, 0.94)');
    ctx.fillStyle = scopeBg;
    ctx.fill();
    ctx.clip();

    // 上下の光ケーブル金属編組ジャケット帯
    ctx.fillStyle = 'rgba(28, 72, 106, 0.52)';
    ctx.fillRect(ix, iy, iw, 4);
    ctx.fillRect(ix, iy + screenH - 4, iw, 4);
    ctx.fillStyle = hasPower ? 'rgba(0, 240, 255, 0.25)' : 'rgba(92, 134, 166, 0.16)';
    for (var bx = ix + 3; bx < ix + iw - 3; bx += 7) {
      ctx.fillRect(bx, iy + 1, 3.5, 2);
      ctx.fillRect(bx + 2, iy + screenH - 3, 3.5, 2);
    }

    // スコープ精密方眼グリッド
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.08)';
    ctx.lineWidth = 0.8;
    for (var gx = ix + iw * 0.25; gx < ix + iw; gx += iw * 0.25) {
      ctx.beginPath();
      ctx.moveTo(gx, iy + 4);
      ctx.lineTo(gx, iy + screenH - 4);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(ix + 4, midY);
    ctx.lineTo(ix + iw - 4, midY);
    ctx.stroke();

    // 中央：ダイクロイック光集束プリズム
    ctx.save();
    ctx.translate(midX, midY);
    ctx.rotate(hasPower ? time * 0.55 : 0.2);
    ctx.fillStyle = hasPower ? 'rgba(0, 240, 255, 0.14)' : 'rgba(74, 107, 130, 0.1)';
    ctx.strokeStyle = hasPower ? 'rgba(130, 248, 255, 0.55)' : 'rgba(92, 134, 166, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(8, 0);
    ctx.lineTo(0, 8);
    ctx.lineTo(-8, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // 左右真鍮光ファイバコリメータ結合口
    ctx.fillStyle = '#9a7124';
    ctx.fillRect(ix + 1, midY - 5, 4, 10);
    ctx.fillRect(ix + iw - 5, midY - 5, 4, 10);
    ctx.fillStyle = hasPower ? '#8efcff' : '#4a6b82';
    ctx.fillRect(ix + 4.5, midY - 3, 2, 6);
    ctx.fillRect(ix + iw - 6.5, midY - 3, 2, 6);

    // 2. 二重光スペクトル波形＋波形上を走る光パルス粒
    var steps = 30;
    var amp = hasPower ? (screenH * 0.26) : 1.5;

    // 背面サブ高調波トレース
    ctx.strokeStyle = hasPower ? 'rgba(61, 245, 180, 0.28)' : 'rgba(74, 107, 130, 0.2)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (var s0 = 0; s0 <= steps; s0 += 1) {
      var u0 = s0 / steps;
      var wx0 = ix + 6 + (iw - 12) * u0;
      var wv0 = hasPower ? Math.cos(time * 6.5 - u0 * 9) * 0.55 : 0;
      var wy0 = midY + wv0 * amp;
      if (s0 === 0) ctx.moveTo(wx0, wy0);
      else ctx.lineTo(wx0, wy0);
    }
    ctx.stroke();

    // 主オシロスコープ波形
    ctx.strokeStyle = hasPower ? '#00f0ff' : '#4a6b82';
    ctx.lineWidth = hasPower ? 2.0 : 1.2;
    if (hasPower) {
      ctx.shadowColor = '#00f0ff';
      ctx.shadowBlur = 9;
    }
    ctx.beginPath();
    for (var s = 0; s <= steps; s += 1) {
      var u = s / steps;
      var wx = ix + 6 + (iw - 12) * u;
      var wave = hasPower
        ? (Math.sin(time * 8.5 + u * 12) * 0.65 + Math.sin(time * 16 - u * 21) * 0.35)
        : 0;
      var wy = midY + wave * amp;
      if (s === 0) ctx.moveTo(wx, wy);
      else ctx.lineTo(wx, wy);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 光パケット粒トレース（稼働時のみ左→右へ滑走）
    if (hasPower) {
      for (var pkt = 0; pkt < 3; pkt += 1) {
        var pu = (time * 0.72 + pkt * 0.333) % 1;
        var px = ix + 6 + (iw - 12) * pu;
        var pw = Math.sin(time * 8.5 + pu * 12) * 0.65 + Math.sin(time * 16 - pu * 21) * 0.35;
        var py = midY + pw * amp;
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = '#00f0ff';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(px, py, 2.0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }
    ctx.restore();

    // 枠線
    roundRectPath(ctx, ix, iy, iw, screenH, 6);
    ctx.strokeStyle = hasPower ? 'rgba(0, 240, 255, 0.52)' : 'rgba(92, 134, 166, 0.35)';
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // 下部ステータス＆電力バッファ表示
    drawNodeFooterBar(
      ctx,
      ix,
      iy,
      iw,
      ih,
      hasPower ? 'rgba(0, 240, 255, 0.28)' : 'rgba(92, 134, 166, 0.28)',
      node.statusLabel || '待機中',
      hasPower ? '#8efcff' : '#ffb84d',
      '600 9px ' + CONFIG.FONT_FAMILY,
      'PWR ' + Math.round(node.powerBuffer),
      '#ffd84d',
      '700 9px ' + CONFIG.MONO_FONT_FAMILY,
      0.62
    );
  }

  function drawGenericModuleInternals(ctx, node, ix, iy, iw, ih, time) {
    var isFilter = node.config && node.config.mode === 'filter';
    var precision = node.config && node.config.precision !== undefined ? node.config.precision : 20;
    var prof = isFilter ? null : getModuleDataProfile(precision);
    var isPrecision = !isFilter && precision >= 65;
    var isSpeed = !isFilter && precision < 35;

    var modeColor = isFilter ? '#3df5b4' : (isPrecision ? '#ffb830' : (isSpeed ? '#ff55b8' : '#ff4fd8'));
    var modeText = isFilter
      ? '物理濾過'
      : (isPrecision ? '精度 ' + precision + '%' : (isSpeed ? '速度 ' + precision + '%' : '均衡 ' + precision + '%'));

    // 上段：モードピル＆熱/ブースト数値
    var badgeW = Math.min(iw * 0.56, 92);
    roundRectPath(ctx, ix + 2, iy, badgeW, 17, 4);
    ctx.fillStyle = hexToRgba(modeColor, 0.18);
    ctx.fill();
    ctx.strokeStyle = hexToRgba(modeColor, 0.85);
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = '700 9.5px ' + CONFIG.FONT_FAMILY;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(modeText, ix + 2 + badgeW * 0.5, iy + 8.8, badgeW - 8);

    // 温度バッジ（右上・左右余白4px確保）
    var tempInt = Math.round(node.heat);
    var tempColor = node.isOverheated
      ? '#ff5978'
      : (node.heat >= CONFIG.HEAT_WARN_TEMP ? '#ffae42' : (node.isCoolBoosted ? '#7afcff' : '#a8e6ff'));
    ctx.font = '800 11px ' + CONFIG.MONO_FONT_FAMILY;
    ctx.fillStyle = tempColor;
    ctx.textAlign = 'right';
    ctx.fillText(tempInt + '℃', ix + iw - 4, iy + 8.8, 48);

    // 中央：回転コア / 濾過膜チャンバー
    var bayTop = iy + 21;
    var bayH = ih - 36;
    var cx = ix + iw * 0.5 - 3;
    var cy = bayTop + bayH * 0.5;
    var coreR = Math.min(19, bayH * 0.36);

    // チャンバー基板バックプレーン＆PCBパターン配線＋銅ヒートパイプ
    ctx.save();
    ctx.fillStyle = 'rgba(3, 13, 26, 0.72)';
    ctx.strokeStyle = node.isOverheated ? 'rgba(255, 59, 92, 0.42)' : 'rgba(0, 210, 240, 0.22)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR + 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 回路配線トレースと金ランドビア（左右文字領域には入らない範囲）
    ctx.strokeStyle = hexToRgba(modeColor, 0.25);
    ctx.lineWidth = 1;
    var traceDirs = [-1, 1];
    for (var td = 0; td < traceDirs.length; td += 1) {
      var sx = traceDirs[td];
      ctx.beginPath();
      ctx.moveTo(cx + sx * (coreR + 5), cy - 8);
      ctx.lineTo(cx + sx * (coreR + 12), cy - 12);
      ctx.moveTo(cx + sx * (coreR + 5), cy + 8);
      ctx.lineTo(cx + sx * (coreR + 12), cy + 12);
      ctx.stroke();
      ctx.fillStyle = '#d8a648';
      ctx.beginPath();
      ctx.arc(cx + sx * (coreR + 12), cy - 12, 1.3, 0, Math.PI * 2);
      ctx.arc(cx + sx * (coreR + 12), cy + 12, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 過熱時赤熱ヒートシンクフィン
    if (node.isOverheated) {
      var heatGlow = 0.55 + 0.45 * Math.sin(time * 11);
      ctx.strokeStyle = 'rgba(255, 72, 92, ' + heatGlow.toFixed(2) + ')';
      ctx.lineWidth = 2.0;
      for (var hf = -2; hf <= 2; hf += 1) {
        var hfy = cy + hf * 6;
        ctx.beginPath();
        ctx.moveTo(cx - coreR - 8, hfy);
        ctx.lineTo(cx - coreR - 3, hfy);
        ctx.moveTo(cx + coreR + 3, hfy);
        ctx.lineTo(cx + coreR + 8, hfy);
        ctx.stroke();
      }
    }
    ctx.restore();

    // 左側：電力・原料・冷却 ミニインジケータバー
    var bufItems = [
      { label: '電', val: node.powerBuffer, max: 6, color: '#ffd84d' },
      { label: '原', val: node.inputBuffer, max: 8, color: isFilter ? '#38d6ff' : '#00f0ff' },
      { label: '冷', val: node.coolantItems.length, max: 6, color: '#7afcff' }
    ];
    for (var bi = 0; bi < bufItems.length; bi += 1) {
      var bf = bufItems[bi];
      var bx = ix + 2;
      var by = bayTop + 5 + bi * 18;
      ctx.font = '700 8.5px ' + CONFIG.FONT_FAMILY;
      ctx.fillStyle = '#9ec6df';
      ctx.textAlign = 'left';
      ctx.fillText(bf.label, bx, by + 4);

      ctx.fillStyle = 'rgba(2, 10, 22, 0.9)';
      roundRectPath(ctx, bx + 13, by, 25, 7, 2);
      ctx.fill();
      var fillW = clamp(bf.val / bf.max, 0, 1) * 25;
      if (fillW > 0.5) {
        ctx.fillStyle = bf.color;
        roundRectPath(ctx, bx + 13, by, fillW, 7, 2);
        ctx.fill();
      }
    }

    // 中央回転リアクター
    var isWorking = node.status === 'running' || node.status === 'boosted' || node.status === 'warning' || node.status === 'overheat';
    var spinSpeed = isWorking ? (node.isOverheated ? 1.4 : (node.isCoolBoosted ? 4.8 : (isSpeed ? 4.2 : 2.5))) : 0.35;
    var spinAngle = time * spinSpeed;

    ctx.save();
    ctx.translate(cx, cy);

    // 120%冷却ブースト結晶オーラリング＋六角氷晶ファセット
    if (node.isCoolBoosted) {
      ctx.strokeStyle = 'rgba(146, 254, 255, 0.9)';
      ctx.lineWidth = 1.8;
      ctx.shadowColor = '#7afcff';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      for (var hx = 0; hx < 6; hx += 1) {
        var ang = (hx * Math.PI) / 3 - time * 0.8;
        var px = Math.cos(ang) * (coreR + 5.8);
        var py = Math.sin(ang) * (coreR + 5.8);
        if (hx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();

      ctx.fillStyle = '#e0ffff';
      for (var hxd = 0; hxd < 6; hxd += 1) {
        var angd = (hxd * Math.PI) / 3 - time * 0.8;
        ctx.beginPath();
        ctx.arc(Math.cos(angd) * (coreR + 5.8), Math.sin(angd) * (coreR + 5.8), 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    // 外輪ステーターリング＋回転リング
    ctx.strokeStyle = 'rgba(216, 166, 72, 0.36)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(0, 0, coreR + 2.5, 0, Math.PI * 2);
    ctx.stroke();

    ctx.save();
    ctx.rotate(spinAngle);
    ctx.strokeStyle = node.isOverheated ? '#ff3b5c' : modeColor;
    ctx.lineWidth = 2.4;
    ctx.shadowColor = node.isOverheated ? '#ff3b5c' : modeColor;
    ctx.shadowBlur = isWorking ? 10 : 3;
    ctx.setLineDash([8, 4]);
    ctx.beginPath();
    ctx.arc(0, 0, coreR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // 内輪（遠心濾過膜ローター or 量子演算ジャイロ）
    if (isFilter) {
      ctx.save();
      ctx.rotate(-spinAngle * 0.85);
      ctx.strokeStyle = '#9efcff';
      ctx.lineWidth = 1.4;
      for (var fb = 0; fb < 6; fb += 1) {
        ctx.rotate(Math.PI / 3);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(coreR * 0.42, -3.6, coreR * 0.72, 0);
        ctx.stroke();
      }
      ctx.restore();

      if (isWorking) {
        ctx.fillStyle = 'rgba(186, 252, 255, 0.72)';
        for (var mb = 0; mb < 4; mb += 1) {
          var ma = time * 3.4 + (mb * Math.PI) * 0.5;
          var mr = coreR * 0.54;
          ctx.beginPath();
          ctx.arc(Math.cos(ma) * mr, Math.sin(ma) * mr, 1.35, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else {
      ctx.save();
      ctx.rotate(-spinAngle * 1.2);
      var innerR = coreR * 0.62;
      ctx.strokeStyle = isPrecision ? '#ffd84d' : '#8efcff';
      ctx.lineWidth = 1.35;
      ctx.strokeRect(-innerR * 0.65, -innerR * 0.65, innerR * 1.3, innerR * 1.3);

      ctx.rotate(Math.PI * 0.25 + spinAngle * 2.1);
      ctx.strokeStyle = modeColor;
      ctx.lineWidth = 1.1;
      ctx.strokeRect(-innerR * 0.5, -innerR * 0.5, innerR, innerR);
      ctx.restore();
    }

    // 中心発光核
    var coreGrad = ctx.createRadialGradient(0, 0, 1, 0, 0, coreR * 0.46);
    coreGrad.addColorStop(0, '#ffffff');
    coreGrad.addColorStop(0.5, node.isOverheated ? '#ff3b5c' : (node.isCoolBoosted ? '#7afcff' : modeColor));
    coreGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(0, 0, coreR * 0.46, 0, Math.PI * 2);
    ctx.fill();

    // 進行アーク（処理サイクル進捗）
    if (isWorking && node.effectiveInterval > 0) {
      var procFrac = clamp(node.processTimer / node.effectiveInterval, 0, 1);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, coreR + 3.2, -Math.PI * 0.5, -Math.PI * 0.5 + procFrac * Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // 右側ステータス強調テキスト（120%冷却 or 80℃超過熱、左右余白4px・maxWidth付き）
    if (node.isOverheated) {
      ctx.font = '800 9px ' + CONFIG.FONT_FAMILY;
      ctx.fillStyle = '#ff7e96';
      ctx.textAlign = 'right';
      ctx.fillText('過熱50%', ix + iw - 4, cy - 6, 48);
    } else if (node.isCoolBoosted) {
      ctx.font = '800 9px ' + CONFIG.MONO_FONT_FAMILY;
      ctx.fillStyle = '#9efeff';
      ctx.textAlign = 'right';
      ctx.fillText('COOL 120%', ix + iw - 4, cy - 6, 52);
    } else if (prof) {
      ctx.font = '700 9.5px ' + CONFIG.MONO_FONT_FAMILY;
      ctx.fillStyle = isPrecision ? '#ffd84d' : '#e6a8ff';
      ctx.textAlign = 'right';
      ctx.fillText(prof.valueMultiplier.toFixed(1) + 'x', ix + iw - 4, cy - 6, 48);
    }

    // 効率％サブ表示
    ctx.font = '700 9.5px ' + CONFIG.MONO_FONT_FAMILY;
    ctx.fillStyle = node.efficiency > 1.01 ? '#ffd84d' : (node.efficiency < 0.99 ? '#ff7e96' : '#8ab4cc');
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(node.efficiency * 100) + '%', ix + iw - 4, cy + 8, 48);

    // 下段：熱ゲージ（左右4pxインセット・下リベットより4px以上上方）
    var barX = ix + 4;
    var barW = iw - 8;
    var barY = iy + ih - 11;
    var barH = 9;
    roundRectPath(ctx, barX, barY, barW, barH, 4);
    ctx.fillStyle = 'rgba(2, 9, 20, 0.95)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 178, 214, 0.35)';
    ctx.lineWidth = 0.9;
    ctx.stroke();

    var heatNorm = clamp((node.heat - CONFIG.BASE_TEMP) / (CONFIG.MAX_TEMP - CONFIG.BASE_TEMP), 0.04, 1);
    var barFillW = Math.max(4, barW * heatNorm);
    var heatGrad = ctx.createLinearGradient(barX, barY, barX + barW, barY);
    heatGrad.addColorStop(0, '#00f0ff');
    heatGrad.addColorStop(0.45, '#3df5b4');
    heatGrad.addColorStop(0.68, '#ff9e2c');
    heatGrad.addColorStop(1, '#ff3b5c');
    ctx.fillStyle = heatGrad;
    roundRectPath(ctx, barX + 1, barY + 1, Math.max(2, barFillW - 2), barH - 2, 3);
    ctx.fill();

    // ゲージ目盛ノッチ＆80℃警告閾値マーカー
    ctx.fillStyle = 'rgba(6, 18, 32, 0.42)';
    for (var q = 1; q <= 3; q += 1) {
      ctx.fillRect(barX + barW * (q * 0.25), barY + 1, 1, barH - 2);
    }
    var ohMarkX = barX + barW * ((CONFIG.OVERHEAT_TEMP - CONFIG.BASE_TEMP) / (CONFIG.MAX_TEMP - CONFIG.BASE_TEMP));
    ctx.fillStyle = '#ff3b5c';
    ctx.fillRect(ohMarkX - 1, barY - 1, 2, barH + 2);
  }

  function drawSurfaceUplinkInternals(ctx, node, ix, iy, iw, ih, time) {
    var hasHighPurity = state.simTime - (node.recentHighPurityTime || -999) < 2.2;
    var isBottleneck = node.bottleneckRatio > 0.35;
    var bayH = ih - 18;
    var dishX = ix + iw * 0.56;
    var dishY = iy + bayH * 0.58;
    var dishCol = hasHighPurity ? '#ffd84d' : '#6df7c4';

    // 1. 送信ビームVFX（node.beamTimer > 0 時に上空へマルチコアレーザー発射）
    if (node.beamTimer > 0) {
      var beamAlpha = clamp(node.beamTimer / 0.55, 0, 1);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      var beamTop = Math.max(0, node.y - 260);
      var beamG = ctx.createLinearGradient(dishX, node.y, dishX, beamTop);
      var beamCol = hasHighPurity ? '#ffd84d' : '#2ef2a4';
      beamG.addColorStop(0, hexToRgba(beamCol, beamAlpha * 0.82));
      beamG.addColorStop(0.45, hexToRgba('#00f0ff', beamAlpha * 0.38));
      beamG.addColorStop(1, 'rgba(0, 240, 255, 0)');
      ctx.fillStyle = beamG;
      ctx.beginPath();
      ctx.moveTo(dishX - 6, node.y + 4);
      ctx.lineTo(dishX + 6, node.y + 4);
      ctx.lineTo(dishX + 20, beamTop);
      ctx.lineTo(dishX - 20, beamTop);
      ctx.closePath();
      ctx.fill();

      // 中心レーザー軸＆上昇光粒
      ctx.strokeStyle = hexToRgba('#ffffff', beamAlpha * 0.88);
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(dishX, node.y + 6);
      ctx.lineTo(dishX, beamTop + 26);
      ctx.stroke();

      for (var bs = 0; bs < 4; bs += 1) {
        var bProg = (1 - beamAlpha + bs * 0.25) % 1;
        var bPy = node.y - bProg * Math.min(200, node.y);
        var bPx = dishX + Math.sin(bs * 2.1 + time * 10) * 5;
        ctx.fillStyle = hexToRgba('#ffffff', beamAlpha * (1 - bProg * 0.6));
        ctx.beginPath();
        ctx.arc(bPx, bPy, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // 2. 右側ベイ背景の計器グリッド＋台座＆3層ジンバルパラボラ
    ctx.save();
    roundRectPath(ctx, ix + 22, iy + 1, iw - 24, bayH - 2, 5);
    ctx.fillStyle = 'rgba(2, 12, 22, 0.68)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(61, 245, 180, 0.2)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // ジンバル土台＆ツイン油圧支柱
    ctx.fillStyle = '#6f511c';
    ctx.fillRect(dishX - 13, dishY + 12, 26, 4);
    ctx.strokeStyle = '#d8a648';
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.moveTo(dishX - 10, dishY + 12);
    ctx.lineTo(dishX - 3, dishY + 2);
    ctx.moveTo(dishX + 10, dishY + 12);
    ctx.lineTo(dishX + 3, dishY + 2);
    ctx.moveTo(dishX, dishY + 12);
    ctx.lineTo(dishX, dishY + 1);
    ctx.stroke();

    // 外側パラボラ反射皿＋内側構造リブ
    var tilt = Math.sin(time * 1.1) * 0.06;
    ctx.save();
    ctx.translate(dishX, dishY - 11);
    ctx.rotate(tilt);

    ctx.strokeStyle = dishCol;
    ctx.lineWidth = 3.0;
    ctx.shadowColor = hasHighPurity ? '#ffd84d' : '#2ef2a4';
    ctx.shadowBlur = 9;
    ctx.beginPath();
    ctx.arc(0, 0, 17, Math.PI * 0.2, Math.PI * 0.8);
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = 'rgba(205, 255, 240, 0.45)';
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.arc(0, 0, 13.5, Math.PI * 0.24, Math.PI * 0.76);
    ctx.stroke();

    // 3脚焦点トラス＆光プリズムエミッタ
    ctx.strokeStyle = '#8efcff';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(-10, 12);
    ctx.lineTo(0, -2);
    ctx.lineTo(10, 12);
    ctx.moveTo(0, 16);
    ctx.lineTo(0, -2);
    ctx.stroke();

    ctx.fillStyle = node.beamTimer > 0 ? '#ffffff' : '#00f0ff';
    ctx.shadowColor = hasHighPurity ? '#ffd84d' : '#00f0ff';
    ctx.shadowBlur = 11;
    ctx.beginPath();
    ctx.arc(0, -2, 3.0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.restore();

    // 多重送信マイクロ波リップル
    if (node.beamTimer > 0 || node.queueItems.length > 0) {
      for (var wv = 0; wv < 2; wv += 1) {
        var wave = (time * 1.75 + wv * 0.5) % 1;
        ctx.strokeStyle = hexToRgba(hasHighPurity ? '#ffd84d' : '#2ef2a4', (1 - wave) * 0.82);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(dishX, dishY - 13, 5 + wave * 16, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      }
    }

    // 3. 左側：10セグメント精密LED帯域キュー負荷ゲージ
    var gX = ix + 4;
    var gY = iy + 2;
    var gW = 14;
    var gH = Math.max(20, bayH - 4);
    roundRectPath(ctx, gX, gY, gW, gH, 4);
    ctx.fillStyle = 'rgba(2, 10, 22, 0.94)';
    ctx.fill();
    ctx.strokeStyle = isBottleneck ? '#ff3b5c' : 'rgba(46, 242, 164, 0.45)';
    ctx.lineWidth = 1.1;
    ctx.stroke();

    var qRatio = clamp(node.queueLoad / (CONFIG.UPLINK_BOTTLENECK_THRESHOLD * 1.6), 0, 1);
    var segCount = 10;
    var activeSegs = Math.round(qRatio * segCount);
    var segGap = 1.4;
    var segH = (gH - 6 - (segCount - 1) * segGap) / segCount;
    for (var sg = 0; sg < segCount; sg += 1) {
      var segLit = sg < activeSegs;
      var sy = gY + gH - 3 - (sg + 1) * segH - sg * segGap;
      var segCol = sg >= 7 ? '#ff3b5c' : (sg >= 5 ? '#ff9e2c' : '#2ef2a4');
      ctx.fillStyle = segLit ? segCol : 'rgba(22, 46, 68, 0.65)';
      ctx.fillRect(gX + 2.5, sy, gW - 5, Math.max(1.5, segH));
    }

    // 下部ステータス＆キュー件数プレート
    var qCount = node.queueItems ? node.queueItems.length : 0;
    drawNodeFooterBar(
      ctx,
      ix,
      iy,
      iw,
      ih,
      isBottleneck ? 'rgba(255, 59, 92, 0.48)' : 'rgba(46, 242, 164, 0.28)',
      node.statusLabel || '受信待機',
      isBottleneck ? '#ff7e96' : '#8ef7cf',
      '600 9px ' + CONFIG.FONT_FAMILY,
      'Q ' + qCount,
      isBottleneck ? '#ff9db0' : (hasHighPurity ? '#ffd84d' : '#9ee8d0'),
      '700 9px ' + CONFIG.MONO_FONT_FAMILY,
      0.70
    );
  }

  function drawDeepWaterIntakeInternals(ctx, node, ix, iy, iw, ih, time) {
    var running = node.status === 'running';
    var tkH = ih - 18;

    // ガラス低温水タンク
    ctx.save();
    roundRectPath(ctx, ix, iy, iw, tkH, 6);
    var tankBg = ctx.createLinearGradient(ix, iy, ix, iy + tkH);
    tankBg.addColorStop(0, 'rgba(3, 15, 30, 0.94)');
    tankBg.addColorStop(1, 'rgba(2, 10, 22, 0.94)');
    ctx.fillStyle = tankBg;
    ctx.fill();
    ctx.clip();

    // 上部ステンレス取水ストレーナー（異物除塵グリル）
    ctx.fillStyle = 'rgba(26, 62, 92, 0.72)';
    ctx.fillRect(ix, iy, iw, 5.5);
    ctx.fillStyle = 'rgba(130, 226, 255, 0.35)';
    for (var gr = ix + 8; gr < ix + iw - 8; gr += 11) {
      ctx.fillRect(gr, iy + 1.5, 6, 2.2);
    }

    // 背面冷深層波（奥行きレイヤー）
    var waveAmp = running ? 3.0 : 0.8;
    var waveFreq = running ? 4.8 : 1.5;
    var waterTop = iy + tkH * 0.34;
    ctx.fillStyle = 'rgba(16, 108, 168, 0.45)';
    ctx.beginPath();
    ctx.moveTo(ix, iy + tkH);
    for (var wbx = 0; wbx <= iw; wbx += 4) {
      var wby = waterTop - 1.8 + Math.sin(time * (waveFreq * 0.78) + wbx * 0.09 + 1.8) * (waveAmp * 0.85);
      ctx.lineTo(ix + wbx, wby);
    }
    ctx.lineTo(ix + iw, iy + tkH);
    ctx.closePath();
    ctx.fill();

    // 前面揺れる冷深層水面
    var waterGrad = ctx.createLinearGradient(ix, waterTop, ix, iy + tkH);
    waterGrad.addColorStop(0, 'rgba(56, 214, 255, 0.66)');
    waterGrad.addColorStop(0.6, 'rgba(14, 102, 164, 0.78)');
    waterGrad.addColorStop(1, 'rgba(7, 52, 96, 0.88)');
    ctx.fillStyle = waterGrad;
    ctx.beginPath();
    ctx.moveTo(ix, iy + tkH);
    for (var wx = 0; wx <= iw; wx += 4) {
      var wy = waterTop + Math.sin(time * waveFreq + wx * 0.12) * waveAmp;
      ctx.lineTo(ix + wx, wy);
    }
    ctx.lineTo(ix + iw, iy + tkH);
    ctx.closePath();
    ctx.fill();

    // 水面メニスカス光線
    ctx.strokeStyle = '#d4faff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (var wx2 = 0; wx2 <= iw; wx2 += 4) {
      var wy2 = waterTop + Math.sin(time * waveFreq + wx2 * 0.12) * waveAmp;
      if (wx2 === 0) ctx.moveTo(ix + wx2, wy2);
      else ctx.lineTo(ix + wx2, wy2);
    }
    ctx.stroke();

    // 回転渦流ライン＆低温マイクロ気泡
    var impX = ix + iw * 0.5;
    var impY = iy + tkH * 0.65;
    if (running) {
      ctx.strokeStyle = 'rgba(170, 246, 255, 0.35)';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.arc(impX, impY, 14.5, -time * 3.5, -time * 3.5 + Math.PI * 1.25);
      ctx.stroke();

      for (var cb = 0; cb < 6; cb += 1) {
        var bProg = (time * 0.72 + cb * 0.167) % 1;
        var bX = ix + 14 + ((cb * 23) % Math.max(24, iw - 28)) + Math.sin(time * 4 + cb) * 2.5;
        var bY = iy + tkH - 3 - bProg * (tkH - waterTop + 8);
        ctx.fillStyle = 'rgba(214, 252, 255, ' + (0.68 * (1 - bProg)).toFixed(2) + ')';
        ctx.beginPath();
        ctx.arc(bX, bY, 1.35, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 6枚羽根・遠心クライオポンプインペラ（タンク中央下）
    var impSpeed = running ? 5.6 : 0.25;
    ctx.save();
    ctx.translate(impX, impY);
    ctx.strokeStyle = 'rgba(72, 188, 232, 0.48)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(0, 0, 12.2, 0, Math.PI * 2);
    ctx.stroke();

    ctx.rotate(time * impSpeed);
    ctx.strokeStyle = 'rgba(224, 254, 255, 0.92)';
    ctx.lineWidth = 1.65;
    for (var bl = 0; bl < 6; bl += 1) {
      ctx.rotate(Math.PI / 3);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(5.6, -4.4, 10.6, 0);
      ctx.stroke();
    }
    ctx.fillStyle = '#e0ae48';
    ctx.strokeStyle = '#63410b';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(0, 0, 3.0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // 水位目盛ライン（左右端・数値なし）＆ガラス光沢
    ctx.strokeStyle = 'rgba(164, 238, 255, 0.32)';
    ctx.lineWidth = 0.9;
    for (var m = 1; m <= 3; m += 1) {
      var my = iy + (tkH * m) / 4;
      ctx.beginPath();
      ctx.moveTo(ix + 2, my);
      ctx.lineTo(ix + 6, my);
      ctx.moveTo(ix + iw - 6, my);
      ctx.lineTo(ix + iw - 2, my);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillRect(ix + 3, iy + 6, 3, tkH - 12);

    ctx.restore();

    // タンク外枠
    roundRectPath(ctx, ix, iy, iw, tkH, 6);
    ctx.strokeStyle = running ? 'rgba(56, 214, 255, 0.7)' : 'rgba(92, 134, 166, 0.35)';
    ctx.lineWidth = 1.15;
    ctx.stroke();

    // 下部ステータス＆電力バッファプレート
    drawNodeFooterBar(
      ctx,
      ix,
      iy,
      iw,
      ih,
      running ? 'rgba(56, 214, 255, 0.30)' : 'rgba(92, 134, 166, 0.28)',
      node.statusLabel || '電力待機',
      running ? '#9ef4ff' : '#ffb84d',
      '600 9px ' + CONFIG.FONT_FAMILY,
      'PWR ' + Math.round(node.powerBuffer),
      '#ffd84d',
      '700 9px ' + CONFIG.MONO_FONT_FAMILY,
      0.62
    );
  }

  function drawDrainVentInternals(ctx, node, ix, iy, iw, ih, time) {
    var active = node.status === 'running' || node.activeFlashTimer > 0;
    var bayH = ih - 18;

    ctx.save();
    roundRectPath(ctx, ix, iy, iw, bayH, 6);
    var bayBg = ctx.createLinearGradient(ix, iy, ix, iy + bayH);
    bayBg.addColorStop(0, 'rgba(30, 16, 22, 0.94)');
    bayBg.addColorStop(1, 'rgba(14, 8, 14, 0.94)');
    ctx.fillStyle = bayBg;
    ctx.fill();
    ctx.clip();

    // 内部排熱コアの赤熱放射
    if (active) {
      var coreGlow = 0.26 + 0.16 * Math.sin(time * 7.5);
      var heatCore = ctx.createRadialGradient(
        ix + iw * 0.5,
        iy + bayH * 0.55,
        3,
        ix + iw * 0.5,
        iy + bayH * 0.55,
        iw * 0.52
      );
      heatCore.addColorStop(0, 'rgba(255, 138, 66, ' + coreGlow.toFixed(2) + ')');
      heatCore.addColorStop(1, 'rgba(255, 70, 28, 0)');
      ctx.fillStyle = heatCore;
      ctx.fillRect(ix, iy, iw, bayH);
    }

    // 左右油圧ダンパーアクチュエータ（稼働時にストローク駆動）
    var strokeOffset = active ? Math.sin(time * 5.2) * 1.6 : 0;
    ctx.fillStyle = '#7c5328';
    ctx.fillRect(ix + 2.5, iy + 4, 3.6, bayH - 8);
    ctx.fillRect(ix + iw - 6.1, iy + 4, 3.6, bayH - 8);
    ctx.fillStyle = '#e5b97d';
    ctx.fillRect(ix + 3.4, iy + 7 + strokeOffset, 1.8, bayH - 14);
    ctx.fillRect(ix + iw - 5.2, iy + 7 + strokeOffset, 1.8, bayH - 14);

    // 3段の断熱チタンスリットルーバー
    for (var s = 0; s < 3; s += 1) {
      var sy = iy + 5 + s * ((bayH - 10) / 3);
      var glow = active ? (0.55 + 0.45 * Math.sin(time * 7 + s * 1.4)) : 0.20;
      var slotH = active ? (7.2 + Math.sin(time * 5.2) * 0.6) : 6.4;
      roundRectPath(ctx, ix + 9, sy, iw - 18, slotH, 3);
      var slotGrad = ctx.createLinearGradient(ix + 9, sy, ix + iw - 9, sy);
      slotGrad.addColorStop(0, 'rgba(230, 88, 36, ' + (glow * 0.85).toFixed(2) + ')');
      slotGrad.addColorStop(0.5, 'rgba(255, 166, 94, ' + glow.toFixed(2) + ')');
      slotGrad.addColorStop(1, 'rgba(230, 88, 36, ' + (glow * 0.85).toFixed(2) + ')');
      ctx.fillStyle = slotGrad;
      if (active) {
        ctx.shadowColor = '#ff6b2b';
        ctx.shadowBlur = 9;
      }
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.strokeStyle = active ? '#ffdec2' : '#966b5a';
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }

    // 上昇する熱気揺らぎ＆排熱バブルプルーム
    if (active) {
      for (var hb = 0; hb < 5; hb += 1) {
        var hp = (time * 0.85 + hb * 0.2) % 1;
        var hbx = ix + 16 + ((hb * 24) % Math.max(20, iw - 32)) + Math.sin(time * 5 + hb * 1.7) * 2.4;
        var hby = iy + bayH - 4 - hp * (bayH - 6);
        ctx.fillStyle = 'rgba(255, 206, 152, ' + ((1 - hp) * 0.72).toFixed(2) + ')';
        ctx.beginPath();
        ctx.arc(hbx, hby, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    roundRectPath(ctx, ix, iy, iw, bayH, 6);
    ctx.strokeStyle = active ? 'rgba(255, 122, 69, 0.76)' : 'rgba(180, 108, 76, 0.42)';
    ctx.lineWidth = 1.15;
    ctx.stroke();

    drawNodeFooterBar(
      ctx,
      ix,
      iy,
      iw,
      ih,
      active ? 'rgba(255, 122, 69, 0.36)' : 'rgba(180, 108, 76, 0.28)',
      node.statusLabel || '排水待機',
      active ? '#ffb085' : '#8ab4cc',
      '600 9px ' + CONFIG.FONT_FAMILY,
      'IN ' + Math.round(node.inputBuffer),
      '#ff8b52',
      '700 9px ' + CONFIG.MONO_FONT_FAMILY,
      0.64
    );
  }

  function drawHydrothermalTurbineInternals(ctx, node, ix, iy, iw, ih, time) {
    var bayH = ih - 18;
    var cx = ix + (iw - 24) * 0.5;
    var cy = iy + bayH * 0.5;
    var r = Math.min((iw - 28) * 0.39, bayH * 0.40);
    var rpmRatio = clamp((node.turbineRpm || 0) / 360, 0, 1);

    // タービン外輪ケーシング＆8極銅誘導ステーターコイル
    ctx.save();
    ctx.translate(cx, cy);

    // ステーターコイルブロック（8極）
    for (var sc = 0; sc < 8; sc += 1) {
      var sa = (sc / 8) * Math.PI * 2;
      ctx.save();
      ctx.rotate(sa);
      ctx.fillStyle = rpmRatio > 0.2 ? '#c47228' : '#6e4522';
      ctx.fillRect(r + 1.8, -2.6, 4.2, 5.2);
      ctx.fillStyle = rpmRatio > 0.2 ? '#ffd98a' : '#9c6838';
      ctx.fillRect(r + 2.4, -1.6, 1.4, 3.2);
      ctx.restore();
    }

    ctx.fillStyle = 'rgba(18, 12, 22, 0.94)';
    ctx.strokeStyle = rpmRatio > 0.1 ? '#ff9436' : '#8d5b34';
    ctx.lineWidth = 2.2;
    if (rpmRatio > 0.2) {
      ctx.shadowColor = '#ff9436';
      ctx.shadowBlur = 12;
    }
    ctx.beginPath();
    ctx.arc(0, 0, r + 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 内部地熱コア放射光
    var magGlow = ctx.createRadialGradient(0, 0, 1, 0, 0, r);
    magGlow.addColorStop(0, 'rgba(255, 168, 72, ' + (0.14 + rpmRatio * 0.42).toFixed(2) + ')');
    magGlow.addColorStop(0.7, 'rgba(255, 92, 34, ' + (0.06 + rpmRatio * 0.18).toFixed(2) + ')');
    magGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = magGlow;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // 高速回転時の残像光リング＋誘導発電スパーク
    if (rpmRatio > 0.25) {
      ctx.strokeStyle = 'rgba(255, 216, 77, ' + (rpmRatio * 0.58).toFixed(2) + ')';
      ctx.lineWidth = 2.0;
      ctx.setLineDash([10, 8]);
      ctx.beginPath();
      ctx.arc(0, 0, r - 1, -time * 12, -time * 12 + Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (rpmRatio > 0.35) {
      var sparkA = time * 9.5;
      var spX = Math.cos(sparkA) * (r - 1);
      var spY = Math.sin(sparkA) * (r - 1);
      ctx.strokeStyle = 'rgba(255, 245, 168, ' + (rpmRatio * 0.8).toFixed(2) + ')';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(spX * 0.72, spY * 0.72);
      ctx.lineTo(spX * 0.9 + Math.sin(time * 27) * 2.5, spY * 0.9 + Math.cos(time * 23) * 2.5);
      ctx.lineTo(spX * 1.05, spY * 1.05);
      ctx.stroke();
    }

    // 8枚の曲面真鍮タービン羽根
    ctx.rotate(node.turbineAngle || 0);
    for (var b = 0; b < 8; b += 1) {
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = b % 2 === 0 ? '#ffd84d' : '#f29838';
      ctx.beginPath();
      ctx.moveTo(0, -1.6);
      ctx.quadraticCurveTo(r * 0.56, -5.8, r - 1.2, -1.3);
      ctx.lineTo(r - 1.2, 1.3);
      ctx.quadraticCurveTo(r * 0.56, -1.8, 0, 1.6);
      ctx.closePath();
      ctx.fill();
    }

    // 中心真鍮ハブボルト＋ピンディテール
    ctx.fillStyle = '#fff3bf';
    ctx.strokeStyle = '#734a10';
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.arc(0, 0, 4.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#8a5812';
    ctx.beginPath();
    ctx.arc(0, 0, 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 右側銅フレーム垂直発電ゲージ
    var gx = ix + iw - 15;
    var gy = iy + 2;
    var gh = Math.max(20, bayH - 4);
    roundRectPath(ctx, gx, gy, 11, gh, 3);
    ctx.fillStyle = 'rgba(2, 10, 22, 0.94)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 216, 77, 0.46)';
    ctx.lineWidth = 1.05;
    ctx.stroke();

    if (rpmRatio > 0.02) {
      var fillH = (gh - 4) * rpmRatio;
      var gg = ctx.createLinearGradient(gx, gy + gh, gx, gy);
      gg.addColorStop(0, '#ff6b2b');
      gg.addColorStop(0.55, '#ffd84d');
      gg.addColorStop(1, '#fff8c4');
      ctx.fillStyle = gg;
      roundRectPath(ctx, gx + 2, gy + gh - 2 - fillH, 7, fillH, 2);
      ctx.fill();
    }

    // 目盛ノッチ
    ctx.fillStyle = 'rgba(255, 232, 164, 0.45)';
    for (var gt = 1; gt <= 3; gt += 1) {
      ctx.fillRect(gx + 1.5, gy + (gh * gt) / 4, 2.5, 1);
    }

    // 下部RPM＆出力プレート
    drawNodeFooterBar(
      ctx,
      ix,
      iy,
      iw,
      ih,
      rpmRatio > 0.1 ? 'rgba(255, 216, 77, 0.34)' : 'rgba(141, 91, 52, 0.28)',
      Math.round(node.turbineRpm || 0) + ' RPM',
      rpmRatio > 0.1 ? '#ffd84d' : '#8ab4cc',
      '700 9px ' + CONFIG.MONO_FONT_FAMILY,
      '18 MW',
      rpmRatio > 0.1 ? '#fff2a8' : '#688ca7',
      '700 9px ' + CONFIG.MONO_FONT_FAMILY,
      0.58
    );
  }

  function drawNodePorts(ctx, node, part, time) {
    var allPorts = [];
    var inputs = (part.ports && part.ports.inputs) || [];
    var outputs = (part.ports && part.ports.outputs) || [];
    for (var i = 0; i < inputs.length; i += 1) {
      allPorts.push({ dir: 'in', def: inputs[i] });
    }
    for (var j = 0; j < outputs.length; j += 1) {
      allPorts.push({ dir: 'out', def: outputs[j] });
    }

    var activeDrag = uiState.wiringDrag || uiState.pendingWirePort;

    for (var p = 0; p < allPorts.length; p += 1) {
      var item = allPorts[p];
      var portDef = item.def;
      var pos = getPortPosition(node, portDef.id);
      if (!pos) {
        continue;
      }

      // 汎用モジュール等、現在のモード/設定に応じた実効色を反映
      var portColor = portDef.color || '#00f0ff';
      if (item.dir === 'out') {
        var outRes = getEffectiveOutputType(node, portDef.id);
        if (outRes && RESOURCES[outRes]) {
          portColor = RESOURCES[outRes].color;
        }
      } else if (node.partId === 'generic_module' && portDef.id === 'in_primary') {
        var mode = node.config && node.config.mode === 'filter' ? 'filter' : 'data';
        portColor = mode === 'filter' ? RESOURCES.deep_water.color : RESOURCES.raw_data.color;
      }

      var isHovered =
        uiState.hoveredPort &&
        uiState.hoveredPort.node.id === node.id &&
        uiState.hoveredPort.portDef.id === portDef.id;

      var isPendingOrigin =
        activeDrag &&
        activeDrag.fromNodeId === node.id &&
        activeDrag.fromPortId === portDef.id;

      var isCompatibleTarget = false;
      var isDimmedTarget = false;
      if (activeDrag && !isPendingOrigin) {
        var pair = resolvePortPair(activeDrag.fromNodeId, activeDrag.fromPortId, node.id, portDef.id);
        if (pair.ok && canConnect(pair.fromNodeId, pair.fromPortId, pair.toNodeId, pair.toPortId).ok) {
          isCompatibleTarget = true;
        } else {
          isDimmedTarget = true;
        }
      }

      var baseR = CONFIG.PORT_RADIUS || 7;
      var scale = isHovered || isPendingOrigin ? 1.32 : (isCompatibleTarget ? 1.22 : 1.0);
      var r = baseR * scale;

      ctx.save();
      if (isDimmedTarget) {
        ctx.globalAlpha = 0.42;
      }

      // 互換ポートの磁気誘導パルスリング
      if (isCompatibleTarget) {
        var magPulse = 0.5 + 0.5 * Math.sin(time * 8);
        ctx.strokeStyle = hexToRgba(portColor, 0.55 + magPulse * 0.4);
        ctx.lineWidth = 2.0;
        ctx.shadowColor = portColor;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 4.5 + magPulse * 3.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // ポート外枠真鍮ソケット
      ctx.fillStyle = '#071424';
      ctx.strokeStyle = isHovered || isCompatibleTarget ? '#ffffff' : '#d8a648';
      ctx.lineWidth = isHovered || isCompatibleTarget ? 2.0 : 1.5;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r + 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // ポート発光コア
      ctx.fillStyle = portColor;
      ctx.shadowColor = portColor;
      ctx.shadowBlur = isHovered || isCompatibleTarget || isPendingOrigin ? 13 : 7;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r * 0.65, 0, Math.PI * 2);
      ctx.fill();

      // 出力ポートの小さな方向シェブロン（右向き）
      ctx.shadowBlur = 0;
      if (item.dir === 'out') {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(pos.x + r * 0.35, pos.y);
        ctx.lineTo(pos.x - r * 0.25, pos.y - r * 0.32);
        ctx.lineTo(pos.x - r * 0.25, pos.y + r * 0.32);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  }

  function renderPlacementGhost(ctx, time) {
    if (!uiState.placingPartId || !uiState.pointer.inside) {
      return;
    }
    var part = PARTS_MAP[uiState.placingPartId];
    if (!part) {
      return;
    }

    var rawX = uiState.pointer.x - part.width * 0.5;
    var rawY = uiState.pointer.y - part.height * 0.5;
    var clamped = clampNodePosition(rawX, rawY, part.width, part.height, state.viewport);
    var canAfford = state.funds >= part.cost && isPartUnlocked(part.id);

    var overlapsExisting = hasNodeOverlap(clamped.x, clamped.y, part.width, part.height, null, NODE_CLEARANCE);

    var accent = canAfford && !overlapsExisting
      ? ((part.theme && part.theme.accent) || '#00f0ff')
      : '#ff3b5c';

    ctx.save();
    // 他ノードとの整列ガイド線
    for (var j = 0; j < state.nodes.length; j += 1) {
      var other = state.nodes[j];
      if (Math.abs(other.y - clamped.y) < 12) {
        ctx.strokeStyle = 'rgba(0, 240, 255, 0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(other.x + other.width * 0.5, other.y);
        ctx.lineTo(clamped.x + part.width * 0.5, clamped.y);
        ctx.stroke();
      }
      if (Math.abs(other.x - clamped.x) < 12) {
        ctx.strokeStyle = 'rgba(255, 216, 77, 0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(other.x, other.y + other.height * 0.5);
        ctx.lineTo(clamped.x, clamped.y + part.height * 0.5);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    // ゴースト筐体
    roundRectPath(ctx, clamped.x, clamped.y, part.width, part.height, CONFIG.NODE_CORNER_RADIUS || 12);
    ctx.fillStyle = hexToRgba(accent, 0.14);
    ctx.fill();
    ctx.strokeStyle = hexToRgba(accent, 0.72 + 0.25 * Math.sin(time * 6));
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.lineDashOffset = -time * 28;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    // 中央ラベル
    ctx.font = '700 12px ' + CONFIG.FONT_FAMILY;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(part.name, clamped.x + part.width * 0.5, clamped.y + part.height * 0.5 - 8);

    ctx.font = '700 10.5px ' + CONFIG.FONT_FAMILY;
    ctx.fillStyle = !canAfford || overlapsExisting ? '#ff7e96' : '#ffd84d';
    var subText = !canAfford
      ? '資金不足 ($' + part.cost + ')'
      : (overlapsExisting ? '設置不可（他の装置と重複）' : 'クリックで配置 (-$' + part.cost + ')');
    ctx.fillText(subText, clamped.x + part.width * 0.5, clamped.y + part.height * 0.5 + 11);

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // E. VFXパーティクル＆サウンド完全連動（consumeFxEvents）
  // -------------------------------------------------------------------------

  function addVfxParticle(p) {
    if (uiState.vfxParticles.length >= (CONFIG.MAX_VFX_PARTICLES || 140)) {
      uiState.vfxParticles.shift();
    }
    uiState.vfxParticles.push(p);
  }

  function addVfxRipple(x, y, maxR, color, maxLife) {
    if (uiState.vfxRipples.length >= 28) {
      uiState.vfxRipples.shift();
    }
    uiState.vfxRipples.push({
      x: x,
      y: y,
      r: 8,
      maxR: maxR || 56,
      color: color || '#00f0ff',
      life: 0,
      maxLife: maxLife || 0.65
    });
  }

  function addVfxPopup(x, y, text, color, maxLife) {
    if (uiState.vfxPopups.length >= 26) {
      uiState.vfxPopups.shift();
    }
    uiState.vfxPopups.push({
      x: x,
      y: y,
      vy: -32,
      text: text,
      color: color || '#ffd84d',
      life: 0,
      maxLife: maxLife || 1.15
    });
  }

  function processFxEvents() {
    var events = consumeFxEvents();
    if (!events || events.length === 0) {
      return;
    }

    for (var i = 0; i < events.length; i += 1) {
      var evt = events[i];
      if (!evt || !evt.type) {
        continue;
      }

      if (evt.type === 'cash') {
        var res = RESOURCES[evt.resourceId];
        var cashCol = evt.resourceId === 'high_purity_data'
          ? '#ffd84d'
          : (evt.resourceId === 'refined_data' ? '#ff7ce8' : '#7afcff');
        addVfxPopup(evt.x + (Math.random() - 0.5) * 14, evt.y - 6, '+$' + Number(evt.amount || 0).toFixed(1), cashCol, 1.05);
        addVfxRipple(evt.x, evt.y + 8, 34, res ? res.color : cashCol, 0.52);
        for (var c = 0; c < 4; c += 1) {
          var ang = -Math.PI * 0.5 + (c - 1.5) * 0.45;
          addVfxParticle({
            kind: 'spark',
            x: evt.x,
            y: evt.y + 6,
            vx: Math.cos(ang) * 34,
            vy: Math.sin(ang) * 42 - 12,
            r: 2.2,
            life: 0,
            maxLife: 0.48,
            color: cashCol
          });
        }
      } else if (evt.type === 'node_placed') {
        addVfxRipple(evt.x, evt.y, 76, evt.color || '#00f0ff', 0.68);
        addVfxRipple(evt.x, evt.y, 44, '#ffd84d', 0.45);
        for (var np = 0; np < 10; np += 1) {
          var nAng = (np / 10) * Math.PI * 2;
          addVfxParticle({
            kind: np % 2 === 0 ? 'bubble' : 'spark',
            x: evt.x + Math.cos(nAng) * 18,
            y: evt.y + Math.sin(nAng) * 12,
            vx: Math.cos(nAng) * 48,
            vy: Math.sin(nAng) * 34 - 16,
            r: 2.6,
            life: 0,
            maxLife: 0.7,
            color: evt.color || '#00f0ff'
          });
        }
      } else if (evt.type === 'node_removed') {
        addVfxRipple(evt.x, evt.y, 60, '#ff8e53', 0.55);
        if (evt.refund > 0) {
          addVfxPopup(evt.x, evt.y - 10, '+$' + Math.round(evt.refund) + ' 回収', '#ffd84d', 1.25);
        }
        for (var nr = 0; nr < 8; nr += 1) {
          var rAng = (nr / 8) * Math.PI * 2;
          addVfxParticle({
            kind: 'bubble',
            x: evt.x,
            y: evt.y,
            vx: Math.cos(rAng) * 38,
            vy: Math.sin(rAng) * 28 - 22,
            r: 2.8,
            life: 0,
            maxLife: 0.78,
            color: '#9ef4ff'
          });
        }
      } else if (evt.type === 'wire_connected') {
        var wRes = RESOURCES[evt.resourceId];
        var wCol = wRes ? wRes.color : '#00f0ff';
        addVfxRipple(evt.fromX, evt.fromY, 26, wCol, 0.45);
        addVfxRipple(evt.toX, evt.toY, 28, evt.isTidy ? '#ffd84d' : wCol, 0.5);
        uiState.vfxWireFlashes.push({
          connId: evt.connId,
          color: evt.isTidy ? '#ffd84d' : wCol,
          life: 0,
          maxLife: 0.42
        });
      } else if (evt.type === 'tidy_sync_on') {
        uiState.tidyBannerTimer = 2.8;
        spawnSonarWave(uiState.cssW * 0.5, uiState.cssH * 0.5, Math.max(uiState.cssW, uiState.cssH) * 0.65, '#ffd84d');
      } else if (evt.type === 'cool_boost') {
        addVfxRipple(evt.x, evt.y, 68, '#7afcff', 0.72);
        addVfxPopup(evt.x, evt.y - 42, '❄ 冷却ブースト 120%', '#7afcff', 1.35);
        for (var cb = 0; cb < 10; cb += 1) {
          var cAng = (cb / 10) * Math.PI * 2;
          addVfxParticle({
            kind: 'cryo',
            x: evt.x,
            y: evt.y,
            vx: Math.cos(cAng) * 44,
            vy: Math.sin(cAng) * 36 - 10,
            r: 3.0,
            life: 0,
            maxLife: 0.78,
            color: '#b8ffff'
          });
        }
      } else if (evt.type === 'overheat') {
        addVfxRipple(evt.x, evt.y, 72, '#ff3b5c', 0.75);
        addVfxPopup(evt.x, evt.y - 44, '⚠ 過熱警報 80℃超!', '#ff5978', 1.5);
        for (var oh = 0; oh < 12; oh += 1) {
          var oAng = (oh / 12) * Math.PI * 2;
          addVfxParticle({
            kind: 'spark',
            x: evt.x,
            y: evt.y,
            vx: Math.cos(oAng) * 58,
            vy: Math.sin(oAng) * 44 - 20,
            r: 2.5,
            life: 0,
            maxLife: 0.62,
            color: oh % 2 === 0 ? '#ff3b5c' : '#ff9e2c'
          });
        }
      } else if (evt.type === 'bottleneck') {
        addVfxRipple(evt.x, evt.y, 52, '#ff3b5c', 0.7);
        addVfxPopup(evt.x - 10, evt.y - 34, '⚠ 帯域渋滞!', '#ff5978', 1.45);
      } else if (evt.type === 'vent_steam') {
        var burst = evt.count || 6;
        for (var vs = 0; vs < burst; vs += 1) {
          addVfxParticle({
            kind: vs % 2 === 0 ? 'steam' : 'bubble',
            x: evt.x + (Math.random() - 0.5) * 44,
            y: evt.y + 4,
            vx: (Math.random() - 0.5) * 22,
            vy: -28 - Math.random() * 26,
            r: 2.8 + Math.random() * 2.2,
            life: 0,
            maxLife: 0.95 + Math.random() * 0.45,
            color: vs % 2 === 0 ? '#ff9b6a' : '#b8f4ff'
          });
        }
      } else if (evt.type === 'turbine_start') {
        addVfxRipple(evt.x, evt.y, 76, '#ffd84d', 0.8);
        addVfxPopup(evt.x, evt.y - 46, '⚡ 熱水発電始動!', '#ffd84d', 1.6);
        safeAudio('playSonar');
      } else if (evt.type === 'step_unlock') {
        spawnSonarWave(uiState.cssW * 0.5, uiState.cssH * 0.5, Math.max(uiState.cssW, uiState.cssH) * 0.7, '#ffd84d');
        uiState.unlockBanner = {
          text: '✦ STEP ' + evt.step + ' 解放' + (evt.grantFunds > 0 ? '（助成金 +$' + evt.grantFunds + '）' : ''),
          life: 0,
          maxLife: 3.4
        };
        // 新規アンロックされたパーツに NEW バッジ付与
        if (Array.isArray(evt.unlocks)) {
          for (var u = 0; u < evt.unlocks.length; u += 1) {
            var uid = evt.unlocks[u];
            if (uiState.lastUnlockedList.indexOf(uid) === -1) {
              uiState.newlyUnlockedSet[uid] = true;
            }
          }
          uiState.lastUnlockedList = state.unlockedParts.slice();
        }
      } else if (evt.type === 'autosave') {
        uiState.autosaveFlashTimer = 1.1;
      } else if (evt.type === 'game_reset') {
        uiState.vfxParticles = [];
        uiState.vfxRipples = [];
        uiState.vfxPopups = [];
        uiState.vfxWireFlashes = [];
        uiState.newlyUnlockedSet = {};
        uiState.lastUnlockedList = state.unlockedParts.slice();
        uiState.placingPartId = null;
        uiState.nodeDrag = null;
        uiState.dragOverlapBlocked = false;
        uiState.dragOverlapAdjusted = false;
        uiState.dragOverlapTimer = 0;
        uiState.wiringDrag = null;
        uiState.pendingWirePort = null;
      }
    }
  }

  function updateVfx(dt) {
    var w = uiState.cssW || 1280;
    var h = uiState.cssH || 720;

    if (!uiState.ambientInitialized) {
      initAmbientField(w, h);
    }

    // マリンスノー＆気泡移動
    for (var i = 0; i < uiState.ambientSnow.length; i += 1) {
      var sn = uiState.ambientSnow[i];
      sn.y += sn.speedY * dt;
      if (sn.y > h + 8) {
        sn.y = -8;
        sn.x = Math.random() * w;
      }
    }
    for (var b = 0; b < uiState.ambientBubbles.length; b += 1) {
      var bb = uiState.ambientBubbles[b];
      bb.y -= bb.speedY * dt;
      if (bb.y < -10) {
        bb.y = h + 10;
        bb.x = Math.random() * w;
      }
    }

    // 定期深海ソナー
    uiState.sonarCooldown -= dt;
    if (uiState.sonarCooldown <= 0) {
      uiState.sonarCooldown = 14 + Math.random() * 6;
      spawnSonarWave(w * (0.25 + Math.random() * 0.5), h * (0.25 + Math.random() * 0.45), Math.max(w, h) * 0.62, '#00f0ff');
      if (uiState.audioUnlocked && !state.muted) {
        safeAudio('playSonar');
      }
    }

    for (var si = uiState.sonarWaves.length - 1; si >= 0; si -= 1) {
      var sw = uiState.sonarWaves[si];
      sw.life += dt;
      sw.radius += (sw.maxRadius / sw.maxLife) * dt;
      if (sw.life >= sw.maxLife) {
        uiState.sonarWaves.splice(si, 1);
      }
    }

    // 稼働中ノードの継続的環境パーティクル（過熱火花／冷却ミスト／タービン湯気）
    for (var ni = 0; ni < state.nodes.length; ni += 1) {
      var n = state.nodes[ni];
      if (n.isOverheated && Math.random() < dt * 7.5) {
        addVfxParticle({
          kind: 'spark',
          x: n.x + Math.random() * n.width,
          y: n.y + n.height * 0.35 + Math.random() * (n.height * 0.45),
          vx: (Math.random() - 0.5) * 36,
          vy: -28 - Math.random() * 34,
          r: 2.0,
          life: 0,
          maxLife: 0.52,
          color: Math.random() < 0.6 ? '#ff3b5c' : '#ff9e2c'
        });
      } else if (n.isCoolBoosted && Math.random() < dt * 4.5) {
        addVfxParticle({
          kind: 'cryo',
          x: n.x + Math.random() * n.width,
          y: n.y + n.height * 0.25 + Math.random() * (n.height * 0.5),
          vx: (Math.random() - 0.5) * 14,
          vy: -14 - Math.random() * 14,
          r: 2.2,
          life: 0,
          maxLife: 0.72,
          color: '#a8ffff'
        });
      }
      if (n.partId === 'hydrothermal_turbine' && n.turbineRpm > 45 && Math.random() < dt * 3.5) {
        addVfxParticle({
          kind: 'steam',
          x: n.x + n.width * 0.5 + (Math.random() - 0.5) * 28,
          y: n.y + 2,
          vx: (Math.random() - 0.5) * 12,
          vy: -22 - Math.random() * 14,
          r: 2.4,
          life: 0,
          maxLife: 0.75,
          color: '#ffb078'
        });
      }
    }

    for (var pi = uiState.vfxParticles.length - 1; pi >= 0; pi -= 1) {
      var vp = uiState.vfxParticles[pi];
      vp.life += dt;
      if (vp.life >= vp.maxLife) {
        uiState.vfxParticles.splice(pi, 1);
        continue;
      }
      vp.x += (vp.vx || 0) * dt;
      vp.y += (vp.vy || 0) * dt;
      if (vp.kind === 'spark') {
        vp.vy += 28 * dt;
      }
    }

    for (var ri = uiState.vfxRipples.length - 1; ri >= 0; ri -= 1) {
      var rp = uiState.vfxRipples[ri];
      rp.life += dt;
      if (rp.life >= rp.maxLife) {
        uiState.vfxRipples.splice(ri, 1);
        continue;
      }
      var prog = rp.life / rp.maxLife;
      rp.r = 8 + (rp.maxR - 8) * (1 - Math.pow(1 - prog, 2));
    }

    for (var fi = uiState.vfxWireFlashes.length - 1; fi >= 0; fi -= 1) {
      var wf = uiState.vfxWireFlashes[fi];
      wf.life += dt;
      if (wf.life >= wf.maxLife) {
        uiState.vfxWireFlashes.splice(fi, 1);
      }
    }

    for (var ti = uiState.vfxPopups.length - 1; ti >= 0; ti -= 1) {
      var pop = uiState.vfxPopups[ti];
      pop.life += dt;
      if (pop.life >= pop.maxLife) {
        uiState.vfxPopups.splice(ti, 1);
        continue;
      }
      pop.y += pop.vy * dt;
      pop.vy *= 0.96;
    }

    if (uiState.tidyBannerTimer > 0) {
      uiState.tidyBannerTimer = Math.max(0, uiState.tidyBannerTimer - dt);
    }
    if (uiState.autosaveFlashTimer > 0) {
      uiState.autosaveFlashTimer = Math.max(0, uiState.autosaveFlashTimer - dt);
    }
    if (uiState.dragOverlapTimer > 0) {
      uiState.dragOverlapTimer = Math.max(0, uiState.dragOverlapTimer - dt);
      if (uiState.dragOverlapTimer === 0 && !uiState.nodeDrag) {
        uiState.dragOverlapBlocked = false;
        uiState.dragOverlapAdjusted = false;
      }
    }
    if (uiState.unlockBanner) {
      uiState.unlockBanner.life += dt;
      if (uiState.unlockBanner.life >= uiState.unlockBanner.maxLife) {
        uiState.unlockBanner = null;
      }
    }
  }

  function renderFx(ctx, w, h, time) {
    // 1. 衝撃波リング
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var ri = 0; ri < uiState.vfxRipples.length; ri += 1) {
      var rp = uiState.vfxRipples[ri];
      var alpha = clamp(1 - rp.life / rp.maxLife, 0, 1);
      ctx.strokeStyle = hexToRgba(rp.color, alpha * 0.78);
      ctx.lineWidth = 2.2 * alpha + 0.6;
      ctx.shadowColor = rp.color;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, rp.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // 2. 火花・冷却ミスト・湯気・気泡パーティクル
    for (var pi = 0; pi < uiState.vfxParticles.length; pi += 1) {
      var vp = uiState.vfxParticles[pi];
      var prog = clamp(vp.life / vp.maxLife, 0, 1);
      var alpha = 1 - prog;

      ctx.save();
      if (vp.kind === 'steam') {
        ctx.fillStyle = hexToRgba(vp.color, alpha * 0.36);
        ctx.strokeStyle = hexToRgba('#ffd8be', alpha * 0.55);
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.arc(vp.x, vp.y, vp.r + prog * 4.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (vp.kind === 'bubble') {
        ctx.fillStyle = hexToRgba('#9ef4ff', alpha * 0.22);
        ctx.strokeStyle = hexToRgba('#dffcff', alpha * 0.78);
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.arc(vp.x, vp.y, vp.r + prog * 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (vp.kind === 'cryo') {
        ctx.translate(vp.x, vp.y);
        ctx.rotate(time * 3 + pi);
        ctx.strokeStyle = hexToRgba(vp.color, alpha * 0.9);
        ctx.shadowColor = '#7afcff';
        ctx.shadowBlur = 8;
        ctx.lineWidth = 1.3;
        var cr = vp.r * (1 - prog * 0.3);
        ctx.beginPath();
        ctx.moveTo(-cr, 0);
        ctx.lineTo(cr, 0);
        ctx.moveTo(0, -cr);
        ctx.lineTo(0, cr);
        ctx.stroke();
      } else {
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = hexToRgba(vp.color, alpha);
        ctx.shadowColor = vp.color;
        ctx.shadowBlur = 9;
        ctx.beginPath();
        ctx.arc(vp.x, vp.y, vp.r * (1 - prog * 0.45), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // 3. 浮遊テキストポップアップ（+$X.X 等）
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var ti = 0; ti < uiState.vfxPopups.length; ti += 1) {
      var pop = uiState.vfxPopups[ti];
      var tProg = clamp(pop.life / pop.maxLife, 0, 1);
      var tAlpha = tProg < 0.15 ? tProg / 0.15 : clamp(1 - (tProg - 0.15) / 0.85, 0, 1);
      ctx.font = '800 13.5px ' + CONFIG.FONT_FAMILY;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
      ctx.shadowBlur = 6;
      ctx.fillStyle = hexToRgba('#020814', tAlpha * 0.7);
      ctx.fillText(pop.text, pop.x + 1, pop.y + 1.5);
      ctx.shadowColor = pop.color;
      ctx.shadowBlur = 10;
      ctx.fillStyle = hexToRgba(pop.color, tAlpha);
      ctx.fillText(pop.text, pop.x, pop.y);
    }
    ctx.restore();

    // 4. 整頓シンクロ発動／ステップ解放バナー
    var bannerText = null;
    var bannerAlpha = 0;
    var bannerColor = '#ffd84d';
    if (uiState.unlockBanner) {
      var ub = uiState.unlockBanner;
      var uProg = ub.life / ub.maxLife;
      bannerAlpha = uProg < 0.12 ? uProg / 0.12 : clamp(1 - (uProg - 0.65) / 0.35, 0, 1);
      bannerText = ub.text;
      bannerColor = '#ffd84d';
    } else if (uiState.tidyBannerTimer > 0) {
      bannerAlpha = clamp(uiState.tidyBannerTimer / 0.6, 0, 1);
      bannerText = '✦ 整頓シンクロ発動！全通信・流速 +20% ✦';
      bannerColor = '#4cf3ff';
    }

    if (bannerText && bannerAlpha > 0.01) {
      ctx.save();
      ctx.font = '800 14px ' + CONFIG.FONT_FAMILY;
      var tw = ctx.measureText(bannerText).width;
      var bw = tw + 36;
      var bh = 32;
      var bx = w * 0.5 - bw * 0.5;
      var by = 82;
      chamferRectPath(ctx, bx, by, bw, bh, 8);
      ctx.fillStyle = hexToRgba('#05182d', 0.9 * bannerAlpha);
      ctx.shadowColor = bannerColor;
      ctx.shadowBlur = 18;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = hexToRgba(bannerColor, 0.9 * bannerAlpha);
      ctx.lineWidth = 1.6;
      ctx.stroke();

      ctx.fillStyle = hexToRgba('#ffffff', bannerAlpha);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(bannerText, w * 0.5, by + bh * 0.5 + 0.5);
      ctx.restore();
    }
  }

  // -------------------------------------------------------------------------
  // F. ブギー ホログラム誘導レーザー連携
  // -------------------------------------------------------------------------

  function resolveBoogieDockAnchor(w, h) {
    var canvas = runtime.uiRefs.canvas;
    var doc = global.document;
    if (canvas && doc && typeof canvas.getBoundingClientRect === 'function') {
      var cRect = canvas.getBoundingClientRect();
      var avatarEl = doc.getElementById('boogie-avatar-wrap') || doc.getElementById('boogie-dock');
      if (avatarEl && typeof avatarEl.getBoundingClientRect === 'function') {
        var aRect = avatarEl.getBoundingClientRect();
        if (aRect.width > 0 && aRect.height > 0 && cRect.width > 0) {
          return {
            x: aRect.left - cRect.left + aRect.width * 0.45,
            y: aRect.top - cRect.top + aRect.height * 0.35
          };
        }
      }
    }
    return {
      x: Math.max(40, w - 180),
      y: Math.max(40, h - 140)
    };
  }

  function renderGuideLasers(ctx, w, h) {
    var links = getGuideLinks();
    if (!links || links.length === 0) {
      return;
    }
    if (!runtime.boogieController || typeof runtime.boogieController.drawHologramGuides !== 'function') {
      return;
    }
    var dockAnchor = resolveBoogieDockAnchor(w, h);
    runtime.boogieController.drawHologramGuides(ctx, links, dockAnchor, state.simTime);
  }

  // -------------------------------------------------------------------------
  // G. ヒットテスト＆ホバーツールチップ
  // -------------------------------------------------------------------------

  function hitTestPort(px, py, radiusOverride, filterCompatibleFrom) {
    var hitR = radiusOverride || CONFIG.PORT_HIT_RADIUS || 18;
    var best = null;
    var bestDist = hitR;

    for (var i = state.nodes.length - 1; i >= 0; i -= 1) {
      var node = state.nodes[i];
      var part = PARTS_MAP[node.partId];
      if (!part || !part.ports) {
        continue;
      }
      var list = [];
      var ins = part.ports.inputs || [];
      var outs = part.ports.outputs || [];
      for (var a = 0; a < ins.length; a += 1) {
        list.push({ dir: 'in', portDef: ins[a] });
      }
      for (var b = 0; b < outs.length; b += 1) {
        list.push({ dir: 'out', portDef: outs[b] });
      }

      for (var p = 0; p < list.length; p += 1) {
        var entry = list[p];
        var pos = getPortPosition(node, entry.portDef.id);
        if (!pos) {
          continue;
        }
        var d = Math.hypot(px - pos.x, py - pos.y);
        if (d <= bestDist) {
          if (filterCompatibleFrom) {
            var pair = resolvePortPair(filterCompatibleFrom.fromNodeId, filterCompatibleFrom.fromPortId, node.id, entry.portDef.id);
            if (!pair.ok || !canConnect(pair.fromNodeId, pair.fromPortId, pair.toNodeId, pair.toPortId).ok) {
              continue;
            }
          }
          bestDist = d;
          best = {
            node: node,
            part: part,
            dir: entry.dir,
            portDef: entry.portDef,
            x: pos.x,
            y: pos.y
          };
        }
      }
    }
    return best;
  }

  function hitTestNode(px, py) {
    for (var i = state.nodes.length - 1; i >= 0; i -= 1) {
      var n = state.nodes[i];
      if (px >= n.x && px <= n.x + n.width && py >= n.y && py <= n.y + n.height) {
        return { node: n, part: PARTS_MAP[n.partId] };
      }
    }
    return null;
  }

  function hitTestWire(px, py) {
    var maxDist = CONFIG.CABLE_HIT_DISTANCE || 12;
    var best = null;
    var bestDist = maxDist;

    for (var i = state.connections.length - 1; i >= 0; i -= 1) {
      var conn = state.connections[i];
      var poly = runtime.wireCache[conn.id] || getWirePolyline(conn, state.cableMode);
      if (!poly || !Array.isArray(poly.points) || poly.points.length < 2) {
        continue;
      }
      var pts = poly.points;
      for (var s = 1; s < pts.length; s += 1) {
        var d = pointToSegmentDistance(px, py, pts[s - 1].x, pts[s - 1].y, pts[s].x, pts[s].y);
        if (d < bestDist) {
          bestDist = d;
          best = conn;
        }
      }
    }
    return best;
  }

  function updateHoverState(px, py) {
    if (!uiState.pointer.inside || uiState.placingPartId || uiState.nodeDrag || uiState.wiringDrag) {
      uiState.hoveredPort = null;
      uiState.hoveredNodeId = null;
      uiState.hoveredWireId = null;
      return;
    }

    var portHit = hitTestPort(px, py);
    if (portHit) {
      uiState.hoveredPort = portHit;
      uiState.hoveredNodeId = portHit.node.id;
      uiState.hoveredWireId = null;
      return;
    }

    uiState.hoveredPort = null;
    var nodeHit = hitTestNode(px, py);
    if (nodeHit) {
      uiState.hoveredNodeId = nodeHit.node.id;
      uiState.hoveredWireId = null;
      return;
    }

    uiState.hoveredNodeId = null;
    var wireHit = hitTestWire(px, py);
    uiState.hoveredWireId = wireHit ? wireHit.id : null;
  }

  function hideTooltip() {
    var doc = global.document;
    if (!doc) {
      return;
    }
    var tip = doc.getElementById('canvas-tooltip');
    if (tip) {
      tip.classList.add('is-hidden');
    }
  }

  function buildTooltipRow(labelText, valText) {
    var doc = global.document;
    var row = doc.createElement('div');
    row.className = 'tooltip-row';
    var l = doc.createElement('span');
    l.textContent = labelText;
    var v = doc.createElement('span');
    v.className = 'tooltip-val';
    v.textContent = valText;
    row.appendChild(l);
    row.appendChild(v);
    return row;
  }

  function updateTooltip() {
    var doc = global.document;
    if (!doc) {
      return;
    }
    var tip = doc.getElementById('canvas-tooltip');
    if (!tip) {
      return;
    }

    if (!uiState.pointer.inside || uiState.nodeDrag || uiState.wiringDrag || uiState.placingPartId) {
      tip.classList.add('is-hidden');
      return;
    }

    var hasPort = Boolean(uiState.hoveredPort);
    var hasNode = !hasPort && Boolean(uiState.hoveredNodeId);
    var hasWire = !hasPort && !hasNode && Boolean(uiState.hoveredWireId);

    if (!hasPort && !hasNode && !hasWire) {
      tip.classList.add('is-hidden');
      return;
    }

    tip.innerHTML = '';

    if (hasPort) {
      var hp = uiState.hoveredPort;
      var titleEl = doc.createElement('div');
      titleEl.className = 'tooltip-title';
      titleEl.textContent = hp.portDef.label;
      tip.appendChild(titleEl);

      var subEl = doc.createElement('div');
      subEl.className = 'tooltip-sub';
      subEl.textContent = (hp.part ? hp.part.shortName : '') + ' / ' + (hp.dir === 'out' ? '出力ポート' : '入力ポート');
      tip.appendChild(subEl);

      if (hp.dir === 'out') {
        var outType = getEffectiveOutputType(hp.node, hp.portDef.id);
        var outRes = RESOURCES[outType];
        if (outRes) {
          tip.appendChild(buildTooltipRow('出力リソース', outRes.name));
          if (outRes.baseValue > 0) {
            tip.appendChild(buildTooltipRow('帯域負荷', outRes.bandwidthLoad.toFixed(2)));
          }
        }
      } else {
        var acc = getEffectiveAcceptedTypes(hp.node, hp.portDef.id);
        var accNames = [];
        for (var i = 0; i < acc.length; i += 1) {
          accNames.push(RESOURCES[acc[i]] ? RESOURCES[acc[i]].shortName : acc[i]);
        }
        tip.appendChild(buildTooltipRow('受入対象', accNames.join(' / ')));
      }

      var hint = doc.createElement('div');
      hint.className = 'tooltip-hint';
      hint.textContent = 'ドラッグまたはクリックで別のポートへ配線 ／ 右クリックで解除';
      tip.appendChild(hint);
    } else if (hasNode) {
      var ins = getNodeInspectorSnapshot(uiState.hoveredNodeId);
      if (!ins) {
        tip.classList.add('is-hidden');
        return;
      }
      var nTitle = doc.createElement('div');
      nTitle.className = 'tooltip-title';
      nTitle.textContent = ins.name;
      tip.appendChild(nTitle);

      var nSub = doc.createElement('div');
      nSub.className = 'tooltip-sub';
      nSub.textContent = ins.category + ' ・ ' + ins.statusLabel;
      tip.appendChild(nSub);

      tip.appendChild(buildTooltipRow('総合効率', ins.efficiencyPct + '%'));
      if (ins.hasHeat) {
        tip.appendChild(buildTooltipRow('コア温度', ins.heat.toFixed(1) + '℃' + (ins.isOverheated ? ' (過熱!)' : '')));
      }
      if (ins.hybrid) {
        tip.appendChild(buildTooltipRow('出力', ins.hybrid.outputResourceName));
      }

      var nHint = doc.createElement('div');
      nHint.className = 'tooltip-hint';
      nHint.textContent = 'クリックで詳細設定 ／ ドラッグで移動';
      tip.appendChild(nHint);
    } else if (hasWire) {
      var conn = findConnection(uiState.hoveredWireId);
      if (!conn) {
        tip.classList.add('is-hidden');
        return;
      }
      var res = RESOURCES[conn.resourceId];
      var fromN = findNode(conn.fromNodeId);
      var toN = findNode(conn.toNodeId);
      var fromP = fromN ? PARTS_MAP[fromN.partId] : null;
      var toP = toN ? PARTS_MAP[toN.partId] : null;

      var wTitle = doc.createElement('div');
      wTitle.className = 'tooltip-title';
      wTitle.textContent = (res ? res.name : conn.resourceId) + ' ライン';
      tip.appendChild(wTitle);

      var wSub = doc.createElement('div');
      wSub.className = 'tooltip-sub';
      wSub.textContent = (fromP ? fromP.shortName : '') + ' ➔ ' + (toP ? toP.shortName : '');
      tip.appendChild(wSub);

      var bn = Math.round((conn.bottleneckRatio || 0) * 100);
      tip.appendChild(buildTooltipRow('帯域負荷状態', bn > 35 ? '渋滞発生 (' + bn + '%)' : '快適 (順調)'));
      if (state.isTidySync) {
        tip.appendChild(buildTooltipRow('整頓シンクロ', '+20% 加速中'));
      }

      var wHint = doc.createElement('div');
      wHint.className = 'tooltip-hint';
      wHint.textContent = 'クリックまたは右クリックで配線を切断';
      tip.appendChild(wHint);
    }

    tip.classList.remove('is-hidden');

    var vw = global.innerWidth || uiState.cssW || 1280;
    var vh = global.innerHeight || uiState.cssH || 720;
    var tipW = tip.offsetWidth || 220;
    var tipH = tip.offsetHeight || 110;
    var tx = Math.min(vw - tipW - 12, uiState.pointer.clientX + 16);
    var ty = Math.min(vh - tipH - 12, uiState.pointer.clientY + 16);
    tx = Math.max(10, tx);
    ty = Math.max(10, ty);
    tip.style.left = tx + 'px';
    tip.style.top = ty + 'px';
  }

  // -------------------------------------------------------------------------
  // H. Pointer Events（ドラッグ移動・双方向ポート配線・クリック切断・ドック配置）
  // -------------------------------------------------------------------------

  function getCanvasLocalCoords(clientX, clientY) {
    var canvas = runtime.uiRefs.canvas;
    if (!canvas || typeof canvas.getBoundingClientRect !== 'function') {
      return { x: clientX, y: clientY };
    }
    var rect = canvas.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  function completePortConnection(nodeA, portA, nodeB, portB) {
    var pair = resolvePortPair(nodeA, portA, nodeB, portB);
    if (!pair.ok) {
      safeAudio('playWarning');
      return { ok: false };
    }
    var res = connectPorts(pair.fromNodeId, pair.fromPortId, pair.toNodeId, pair.toPortId);
    if (!res.ok) {
      if (res.message) {
        setBoogieOverride(res.message, 'alert', 3.8);
      }
      safeAudio('playWarning');
    }
    return res;
  }

  function updateCanvasCursorClass() {
    var canvas = runtime.uiRefs.canvas;
    if (!canvas) {
      return;
    }
    canvas.classList.toggle('is-placing-mode', Boolean(uiState.placingPartId));
    canvas.classList.toggle('is-wiring', Boolean(uiState.wiringDrag || uiState.pendingWirePort));
    canvas.classList.toggle('is-panning', Boolean(uiState.nodeDrag));
  }

  function bindCanvasEvents(canvas) {
    if (!canvas) {
      return;
    }

    canvas.addEventListener('contextmenu', function (e) {
      e.preventDefault();
    });

    canvas.addEventListener('pointerdown', function (e) {
      unlockAudioOnGesture();
      var pt = getCanvasLocalCoords(e.clientX, e.clientY);
      uiState.pointer.inside = true;
      uiState.pointer.x = pt.x;
      uiState.pointer.y = pt.y;
      uiState.pointer.clientX = e.clientX;
      uiState.pointer.clientY = e.clientY;

      // 右クリック：キャンセルまたは即切断
      if (e.button === 2) {
        if (uiState.placingPartId) {
          uiState.placingPartId = null;
          safeAudio('playClick', 'ui');
          updateCanvasCursorClass();
          syncUI();
          return;
        }
        if (uiState.pendingWirePort) {
          uiState.pendingWirePort = null;
          safeAudio('playClick', 'ui');
          updateCanvasCursorClass();
          return;
        }
        var rightPort = hitTestPort(pt.x, pt.y);
        if (rightPort) {
          disconnectPort(rightPort.node.id, rightPort.portDef.id);
          syncUI();
          return;
        }
        var rightWire = hitTestWire(pt.x, pt.y);
        if (rightWire) {
          disconnectWire(rightWire.id);
          syncUI();
          return;
        }
        return;
      }

      if (e.button !== 0) {
        return;
      }

      // 1. パーツ配置モード中のクリック配置
      if (uiState.placingPartId) {
        var placePart = PARTS_MAP[uiState.placingPartId];
        if (placePart) {
          var addRes = addNode(uiState.placingPartId, pt.x - placePart.width * 0.5, pt.y - placePart.height * 0.5);
          if (addRes.ok) {
            if (!e.shiftKey) {
              uiState.placingPartId = null;
            }
          } else {
            if (addRes.message) {
              setBoogieOverride(addRes.message, 'alert', 4.0);
              safeAudio('playWarning');
            }
            // 重なり拒否時は配置モードを維持して即座に位置をずらして再設置できるようにする
            if (addRes.reason !== 'NODE_OVERLAP') {
              uiState.placingPartId = null;
            }
          }
          updateCanvasCursorClass();
          syncUI();
          return;
        }
      }

      // 2. ポートクリック／ドラッグ配線
      var portHit = hitTestPort(pt.x, pt.y);
      if (portHit) {
        if (uiState.pendingWirePort) {
          var pStart = uiState.pendingWirePort;
          uiState.pendingWirePort = null;
          if (pStart.fromNodeId !== portHit.node.id || pStart.fromPortId !== portHit.portDef.id) {
            completePortConnection(pStart.fromNodeId, pStart.fromPortId, portHit.node.id, portHit.portDef.id);
            updateCanvasCursorClass();
            syncUI();
            return;
          }
          updateCanvasCursorClass();
          return;
        }

        uiState.wiringDrag = {
          fromNodeId: portHit.node.id,
          fromPortId: portHit.portDef.id,
          dir: portHit.dir,
          pointerId: e.pointerId,
          startX: portHit.x,
          startY: portHit.y,
          currX: pt.x,
          currY: pt.y,
          moved: false,
          snapTarget: null,
          incompatibleHover: false
        };
        if (typeof canvas.setPointerCapture === 'function') {
          try {
            canvas.setPointerCapture(e.pointerId);
          } catch (_) {
            // 非対応時は無視
          }
        }
        safeAudio('playClick', 'ui');
        updateCanvasCursorClass();
        hideTooltip();
        return;
      }

      if (uiState.pendingWirePort) {
        uiState.pendingWirePort = null;
        updateCanvasCursorClass();
      }

      // 3. ノードクリック選択＆ドラッグ移動
      var nodeHit = hitTestNode(pt.x, pt.y);
      if (nodeHit) {
        selectNode(nodeHit.node.id);
        uiState.nodeDrag = {
          nodeId: nodeHit.node.id,
          pointerId: e.pointerId,
          offsetX: pt.x - nodeHit.node.x,
          offsetY: pt.y - nodeHit.node.y,
          moved: false,
          overlapBlocked: false
        };
        uiState.dragOverlapBlocked = false;
        uiState.dragOverlapAdjusted = false;
        uiState.dragOverlapTimer = 0;
        if (typeof canvas.setPointerCapture === 'function') {
          try {
            canvas.setPointerCapture(e.pointerId);
          } catch (_) {
            // 非対応時は無視
          }
        }
        updateCanvasCursorClass();
        hideTooltip();
        syncUI();
        return;
      }

      // 4. 配線クリック解除
      var wireHit = hitTestWire(pt.x, pt.y);
      if (wireHit) {
        disconnectWire(wireHit.id);
        hideTooltip();
        syncUI();
        return;
      }

      // 5. 空き地クリックでノード選択解除
      selectNode(null);
      updateCanvasCursorClass();
      syncUI();
    });

    canvas.addEventListener('pointermove', function (e) {
      var pt = getCanvasLocalCoords(e.clientX, e.clientY);
      uiState.pointer.inside = true;
      uiState.pointer.x = pt.x;
      uiState.pointer.y = pt.y;
      uiState.pointer.clientX = e.clientX;
      uiState.pointer.clientY = e.clientY;

      if (uiState.wiringDrag && uiState.wiringDrag.pointerId === e.pointerId) {
        var wd = uiState.wiringDrag;
        wd.currX = pt.x;
        wd.currY = pt.y;
        if (Math.hypot(pt.x - wd.startX, pt.y - wd.startY) > 7) {
          wd.moved = true;
        }
        // マグネットスナップ：互換ポートに吸い付く
        var compat = hitTestPort(pt.x, pt.y, 24, wd);
        wd.snapTarget = compat;
        if (!compat) {
          var anyPort = hitTestPort(pt.x, pt.y, 18, null);
          wd.incompatibleHover = Boolean(
            anyPort && (anyPort.node.id !== wd.fromNodeId || anyPort.portDef.id !== wd.fromPortId)
          );
        } else {
          wd.incompatibleHover = false;
        }
        return;
      }

      if (uiState.nodeDrag && uiState.nodeDrag.pointerId === e.pointerId) {
        var nd = uiState.nodeDrag;
        nd.moved = true;
        var moveRes = moveNode(nd.nodeId, pt.x - nd.offsetX, pt.y - nd.offsetY);
        if (!moveRes.ok && moveRes.reason === 'NODE_OVERLAP') {
          uiState.dragOverlapBlocked = true;
          uiState.dragOverlapAdjusted = false;
          uiState.dragOverlapTimer = 0.35;
          nd.overlapBlocked = true;
        } else {
          uiState.dragOverlapBlocked = false;
          uiState.dragOverlapAdjusted = Boolean(moveRes.adjusted);
          if (moveRes.adjusted) {
            uiState.dragOverlapTimer = 0.25;
          }
          nd.overlapBlocked = false;
        }
        return;
      }

      updateHoverState(pt.x, pt.y);
      updateTooltip();
    });

    function finishCanvasPointer(e) {
      var pt = getCanvasLocalCoords(e.clientX, e.clientY);
      uiState.pointer.x = pt.x;
      uiState.pointer.y = pt.y;

      if (uiState.wiringDrag && uiState.wiringDrag.pointerId === e.pointerId) {
        var wd = uiState.wiringDrag;
        uiState.wiringDrag = null;
        var targetPort = wd.snapTarget || hitTestPort(pt.x, pt.y, 22, wd);

        if (targetPort && (targetPort.node.id !== wd.fromNodeId || targetPort.portDef.id !== wd.fromPortId)) {
          completePortConnection(wd.fromNodeId, wd.fromPortId, targetPort.node.id, targetPort.portDef.id);
        } else if (!wd.moved) {
          // ドラッグせず同ポートで離した場合はクリック連続配線待機にする
          uiState.pendingWirePort = {
            fromNodeId: wd.fromNodeId,
            fromPortId: wd.fromPortId,
            dir: wd.dir
          };
        }
        updateCanvasCursorClass();
        syncUI();
      }

      if (uiState.nodeDrag && uiState.nodeDrag.pointerId === e.pointerId) {
        uiState.nodeDrag = null;
        uiState.dragOverlapBlocked = false;
        uiState.dragOverlapAdjusted = false;
        uiState.dragOverlapTimer = 0;
        updateCanvasCursorClass();
        syncUI();
      }
    }

    canvas.addEventListener('pointerup', finishCanvasPointer);
    canvas.addEventListener('pointercancel', finishCanvasPointer);
    canvas.addEventListener('pointerleave', function () {
      if (!uiState.nodeDrag && !uiState.wiringDrag) {
        uiState.pointer.inside = false;
        uiState.hoveredNodeId = null;
        uiState.hoveredPort = null;
        uiState.hoveredWireId = null;
        hideTooltip();
      }
    });
  }

  // -------------------------------------------------------------------------
  // I. DOM UIバインディング＆同期（#top-hud, #parts-dock, #node-inspector, #boogie-dock, #encyclopedia-modal, #reset-modal）
  // -------------------------------------------------------------------------

  function buildPartsDock() {
    var doc = global.document;
    if (!doc) {
      return;
    }
    var listEl = doc.getElementById('parts-dock-list');
    if (!listEl) {
      return;
    }
    listEl.innerHTML = '';

    for (var i = 0; i < CONFIG.PART_ORDER.length; i += 1) {
      var partId = CONFIG.PART_ORDER[i];
      var part = PARTS_MAP[partId];
      if (!part) {
        continue;
      }

      var card = doc.createElement('button');
      card.type = 'button';
      card.className = 'part-card';
      card.setAttribute('data-part-id', partId);
      card.title = part.name + '（$' + part.cost + '）\n' + part.summary;

      var topRow = doc.createElement('div');
      topRow.className = 'part-card-top';

      var iconWrap = doc.createElement('span');
      iconWrap.className = 'part-icon';
      iconWrap.innerHTML = createPartMiniSvgIcon(partId);
      topRow.appendChild(iconWrap);

      var costEl = doc.createElement('span');
      costEl.className = 'part-cost';
      costEl.textContent = CONFIG.CURRENCY_SYMBOL + part.cost;
      topRow.appendChild(costEl);

      var infoEl = doc.createElement('div');
      infoEl.className = 'part-card-info';

      var nameEl = doc.createElement('span');
      nameEl.className = 'part-name';
      nameEl.textContent = part.name;
      infoEl.appendChild(nameEl);

      var roleEl = doc.createElement('span');
      roleEl.className = 'part-role';
      roleEl.textContent = part.category;
      infoEl.appendChild(roleEl);

      var badgeEl = doc.createElement('span');
      badgeEl.className = 'part-badge is-hidden';

      card.appendChild(topRow);
      card.appendChild(infoEl);
      card.appendChild(badgeEl);

      (function (pid) {
        card.addEventListener('pointerdown', function (e) {
          if (e.pointerType === 'mouse' && e.button !== 0) {
            return;
          }
          unlockAudioOnGesture();
          delete uiState.newlyUnlockedSet[pid];

          if (!isPartUnlocked(pid)) {
            safeAudio('playWarning');
            var lockedPart = PARTS_MAP[pid];
            if (lockedPart) {
              setBoogieOverride(lockedPart.name + ' は STEP ' + lockedPart.unlockStep + ' で解放されます！', 'curious', 3.5);
            }
            return;
          }

          uiState.dockDrag = {
            partId: pid,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            dragging: false
          };
        });
      })(partId);

      listEl.appendChild(card);
    }
  }

  function buildEncyclopediaTabs() {
    var doc = global.document;
    if (!doc) {
      return;
    }
    var tabsEl = doc.getElementById('encyclopedia-tabs');
    if (!tabsEl) {
      return;
    }
    tabsEl.innerHTML = '';

    for (var i = 0; i < CONFIG.PART_ORDER.length; i += 1) {
      var partId = CONFIG.PART_ORDER[i];
      var part = PARTS_MAP[partId];
      var enc = ENCYCLOPEDIA[partId];
      if (!part || !enc) {
        continue;
      }

      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'enc-tab';
      btn.setAttribute('data-part-id', partId);

      var left = doc.createElement('span');
      left.className = 'enc-tab-left';

      var iconSpan = doc.createElement('span');
      iconSpan.innerHTML = createPartMiniSvgIcon(partId);
      iconSpan.style.display = 'inline-flex';
      left.appendChild(iconSpan);

      var titleSpan = doc.createElement('span');
      titleSpan.className = 'enc-tab-title';
      titleSpan.textContent = enc.title;
      left.appendChild(titleSpan);

      var tagSpan = doc.createElement('span');
      tagSpan.className = 'enc-tab-tag';
      tagSpan.textContent = part.category;

      btn.appendChild(left);
      btn.appendChild(tagSpan);

      (function (pid) {
        btn.addEventListener('click', function () {
          unlockAudioOnGesture();
          safeAudio('playClick', 'tab');
          openEncyclopedia(pid);
        });
      })(partId);

      tabsEl.appendChild(btn);
    }
  }

  function renderEncyclopediaDetail(partId, variantKey) {
    var doc = global.document;
    if (!doc) {
      return;
    }
    var entry = ENCYCLOPEDIA[partId];
    if (!entry) {
      return;
    }

    uiState.encPartId = partId;
    var tabs = doc.querySelectorAll('#encyclopedia-tabs .enc-tab');
    for (var t = 0; t < tabs.length; t += 1) {
      var tabEl = tabs[t];
      var tid = tabEl.getAttribute('data-part-id');
      tabEl.classList.toggle('is-active', tid === partId);
      tabEl.classList.toggle('is-locked', !isPartUnlocked(tid));
    }

    var badgeEl = doc.getElementById('enc-badge');
    if (badgeEl) badgeEl.textContent = entry.badge;

    var titleEl = doc.getElementById('enc-title');
    if (titleEl) titleEl.textContent = entry.title;

    var unlockEl = doc.getElementById('enc-unlock-tag');
    if (unlockEl) {
      var unlocked = isPartUnlocked(partId);
      unlockEl.textContent = unlocked ? '解放済み' : entry.unlockTag;
      unlockEl.classList.toggle('is-locked', !unlocked);
    }

    var summaryEl = doc.getElementById('enc-summary');
    if (summaryEl) summaryEl.textContent = entry.summary;

    var modeBar = doc.getElementById('enc-sim-mode-bar');
    var captionEl = doc.getElementById('enc-anim-caption');

    if (modeBar) {
      if (Array.isArray(entry.variants) && entry.variants.length > 0) {
        modeBar.classList.remove('is-hidden');
        modeBar.innerHTML = '';
        var activeKey = variantKey || entry.variants[0].key;
        var matchedVariant = entry.variants[0];
        for (var v = 0; v < entry.variants.length; v += 1) {
          var vr = entry.variants[v];
          if (vr.key === activeKey) {
            matchedVariant = vr;
          }
          var vBtn = doc.createElement('button');
          vBtn.type = 'button';
          vBtn.textContent = vr.label;
          vBtn.classList.toggle('is-active', vr.key === activeKey);
          (function (vObj) {
            vBtn.addEventListener('click', function () {
              unlockAudioOnGesture();
              safeAudio('playClick', 'tab');
              uiState.encVariantKey = vObj.key;
              if (runtime.encyclopediaPreview && typeof runtime.encyclopediaPreview.setVariant === 'function') {
                runtime.encyclopediaPreview.setVariant(vObj.key);
              }
              renderEncyclopediaDetail(partId, vObj.key);
            });
          })(vr);
          modeBar.appendChild(vBtn);
        }
        uiState.encVariantKey = matchedVariant.key;
        if (captionEl) captionEl.textContent = matchedVariant.caption || '';
      } else {
        modeBar.classList.add('is-hidden');
        modeBar.innerHTML = '';
        uiState.encVariantKey = null;
        if (captionEl) captionEl.textContent = entry.diagram ? entry.diagram.caption : '';
      }
    }

    var specsEl = doc.getElementById('enc-specs');
    if (specsEl) {
      specsEl.innerHTML = '';
      if (Array.isArray(entry.specs)) {
        for (var s = 0; s < entry.specs.length; s += 1) {
          var sp = entry.specs[s];
          var item = doc.createElement('div');
          item.className = 'enc-spec-item';
          var lbl = doc.createElement('span');
          lbl.className = 'spec-label';
          lbl.textContent = sp.label;
          var val = doc.createElement('span');
          val.className = 'spec-value';
          val.textContent = sp.value;
          item.appendChild(lbl);
          item.appendChild(val);
          specsEl.appendChild(item);
        }
      }
    }

    var tipEl = doc.getElementById('enc-boogie-tip');
    if (tipEl) tipEl.textContent = entry.boogieTip || '';
  }

  function bindUI() {
    var doc = global.document;
    if (!doc || uiState.domBound) {
      return;
    }
    uiState.domBound = true;

    buildPartsDock();
    buildEncyclopediaTabs();

    bindCanvasEvents(runtime.uiRefs.canvas);

    // 上部HUDボタン群
    var btnCable = doc.getElementById('btn-cable-mode');
    if (btnCable) {
      btnCable.addEventListener('click', function () {
        unlockAudioOnGesture();
        toggleCableMode();
        syncUI();
      });
    }

    var btnEnc = doc.getElementById('btn-encyclopedia');
    if (btnEnc) {
      btnEnc.addEventListener('click', function () {
        unlockAudioOnGesture();
        safeAudio('playClick', 'ui');
        var selNode = state.selectedNodeId ? findNode(state.selectedNodeId) : null;
        openEncyclopedia(selNode ? selNode.partId : uiState.encPartId);
      });
    }

    var btnMute = doc.getElementById('btn-audio-mute');
    if (btnMute) {
      btnMute.addEventListener('click', function () {
        var wasMuted = state.muted;
        unlockAudioOnGesture();
        var nextMuted = toggleMute();
        if (wasMuted && !nextMuted) {
          safeAudio('init');
          safeAudio('startAmbient');
        }
        safeAudio('playClick', 'ui');
        syncUI();
      });
    }

    var btnResetOpen = doc.getElementById('btn-reset-save');
    var resetModal = doc.getElementById('reset-modal');
    if (btnResetOpen && resetModal) {
      btnResetOpen.addEventListener('click', function () {
        unlockAudioOnGesture();
        safeAudio('playClick', 'ui');
        resetModal.classList.remove('is-hidden');
      });
    }

    var btnResetCancel = doc.getElementById('btn-reset-cancel');
    if (btnResetCancel && resetModal) {
      btnResetCancel.addEventListener('click', function () {
        safeAudio('playClick', 'ui');
        resetModal.classList.add('is-hidden');
      });
    }

    var btnResetConfirm = doc.getElementById('btn-reset-confirm');
    if (btnResetConfirm && resetModal) {
      btnResetConfirm.addEventListener('click', function () {
        unlockAudioOnGesture();
        resetSave();
        safeAudio('playSonar');
        resetModal.classList.add('is-hidden');
        updateCanvasCursorClass();
        syncUI();
      });
    }

    if (resetModal) {
      resetModal.addEventListener('click', function (e) {
        if (e.target === resetModal || (e.target && e.target.classList && e.target.classList.contains('modal-backdrop'))) {
          safeAudio('playClick', 'ui');
          resetModal.classList.add('is-hidden');
        }
      });
    }

    // ノード詳細設定パネル (#node-inspector)
    var btnInsClose = doc.getElementById('btn-inspector-close');
    if (btnInsClose) {
      btnInsClose.addEventListener('click', function () {
        safeAudio('playClick', 'ui');
        selectNode(null);
        syncUI();
      });
    }

    var btnModeData = doc.getElementById('btn-mode-data');
    if (btnModeData) {
      btnModeData.addEventListener('click', function () {
        unlockAudioOnGesture();
        if (state.selectedNodeId) {
          setNodeMode(state.selectedNodeId, 'data');
          syncUI();
        }
      });
    }

    var btnModeFilter = doc.getElementById('btn-mode-filter');
    if (btnModeFilter) {
      btnModeFilter.addEventListener('click', function () {
        unlockAudioOnGesture();
        if (state.selectedNodeId) {
          setNodeMode(state.selectedNodeId, 'filter');
          syncUI();
        }
      });
    }

    var sliderPrec = doc.getElementById('slider-precision');
    if (sliderPrec) {
      sliderPrec.addEventListener('pointerdown', function () {
        uiState.isSliderDragging = true;
      });
      sliderPrec.addEventListener('pointerup', function () {
        uiState.isSliderDragging = false;
      });
      sliderPrec.addEventListener('change', function () {
        uiState.isSliderDragging = false;
      });
      sliderPrec.addEventListener('input', function () {
        unlockAudioOnGesture();
        if (state.selectedNodeId) {
          setNodePrecision(state.selectedNodeId, Number(sliderPrec.value));
          syncInspector();
        }
      });
    }

    var btnNodeGuide = doc.getElementById('btn-node-guide');
    if (btnNodeGuide) {
      btnNodeGuide.addEventListener('click', function () {
        unlockAudioOnGesture();
        safeAudio('playClick', 'ui');
        var node = state.selectedNodeId ? findNode(state.selectedNodeId) : null;
        openEncyclopedia(node ? node.partId : uiState.encPartId);
      });
    }

    var btnNodeDelete = doc.getElementById('btn-node-delete');
    if (btnNodeDelete) {
      btnNodeDelete.addEventListener('click', function () {
        unlockAudioOnGesture();
        if (!state.selectedNodeId) {
          return;
        }
        var res = removeNode(state.selectedNodeId);
        if (!res.ok && res.message) {
          setBoogieOverride(res.message, 'alert', 3.5);
          safeAudio('playWarning');
        }
        syncUI();
      });
    }

    // ブギー通信ドック (#boogie-dock)
    var btnBoogieToggle = doc.getElementById('btn-boogie-toggle');
    var boogieDock = doc.getElementById('boogie-dock');
    var boogieBody = doc.getElementById('boogie-body');
    if (btnBoogieToggle && boogieDock && boogieBody) {
      btnBoogieToggle.addEventListener('click', function () {
        unlockAudioOnGesture();
        safeAudio('playClick', 'ui');
        uiState.boogieCollapsed = !uiState.boogieCollapsed;
        boogieDock.classList.toggle('is-collapsed', uiState.boogieCollapsed);
        boogieBody.classList.toggle('is-collapsed', uiState.boogieCollapsed);
        btnBoogieToggle.textContent = uiState.boogieCollapsed ? '□' : '＿';
      });
    }

    var btnGuideLaser = doc.getElementById('btn-guide-laser');
    if (btnGuideLaser) {
      btnGuideLaser.addEventListener('click', function () {
        unlockAudioOnGesture();
        // 図鑑のお手本ガイド表示中に押された場合は、図鑑ガイドを解除して光線もOFFにする
        if (state.activeEncyclopediaGuidePartId) {
          setGuidePart(null);
          setGuideLaserEnabled(false);
        } else {
          toggleGuideLaser();
        }
        syncUI();
      });
    }

    var boogieAvatar = doc.getElementById('boogie-avatar-wrap');
    if (boogieAvatar) {
      boogieAvatar.addEventListener('click', function () {
        unlockAudioOnGesture();
        pokeBoogie();
        if (runtime.boogieController) {
          runtime.boogieController.setExpression(state.boogieMood);
          runtime.boogieController.triggerTalk(2000);
        }
        syncUI();
      });
    }

    var btnBoogieHint = doc.getElementById('btn-boogie-hint');
    if (btnBoogieHint) {
      btnBoogieHint.addEventListener('click', function () {
        unlockAudioOnGesture();
        setGuideLaserEnabled(true);
        var links = computeGuideLinks();
        if (links.length > 0 && links[0].hintText) {
          setBoogieOverride(links[0].hintText, 'curious', 5.0);
        } else if (state.tidyStats && state.tidyStats.crossingCount > 0) {
          setBoogieOverride('現在 ' + state.tidyStats.crossingCount + ' 箇所の配線交差があります。ノードを動かして交差をなくすと +20% 加速します！', 'curious', 5.0);
        } else {
          setBoogieOverride('順調に稼働しています、所長！下部ドックから設備を増設したり、「物理濾過モード」に挑戦してみましょう！', 'happy', 4.5);
        }
        safeAudio('playBoogieTalk', state.boogieMood);
        syncUI();
      });
    }

    // 技術図鑑モーダル (#encyclopedia-modal)
    var btnEncClose = doc.getElementById('btn-encyclopedia-close');
    if (btnEncClose) {
      btnEncClose.addEventListener('click', function () {
        safeAudio('playClick', 'ui');
        closeEncyclopedia();
      });
    }

    var encBackdrop = doc.getElementById('encyclopedia-backdrop');
    if (encBackdrop) {
      encBackdrop.addEventListener('click', function () {
        safeAudio('playClick', 'ui');
        closeEncyclopedia();
      });
    }

    var btnEncApplyGuide = doc.getElementById('btn-enc-apply-guide');
    if (btnEncApplyGuide) {
      btnEncApplyGuide.addEventListener('click', function () {
        unlockAudioOnGesture();
        var pid = uiState.encPartId || CONFIG.PART_ORDER[0];
        var entry = ENCYCLOPEDIA[pid];
        setGuidePart(pid);
        closeEncyclopedia();
        var appliedLinks = getGuideLinks();
        if (appliedLinks.length > 0 && appliedLinks[0].isFallbackPlace && appliedLinks[0].hintText) {
          setBoogieOverride(
            appliedLinks[0].hintText,
            appliedLinks[0].isUnlocked ? 'curious' : 'happy',
            6.0
          );
        } else if (entry) {
          setBoogieOverride('「' + entry.title + '」のお手本接続をメイン画面へホログラム投影しました！', 'excited', 5.5);
        }
        safeAudio('playBoogieTalk', 'excited');
        syncUI();
      });
    }

    // グローバルドックドラッグ・リサイズ・キーボード操作
    global.addEventListener('pointermove', function (e) {
      if (!uiState.dockDrag || uiState.dockDrag.pointerId !== e.pointerId) {
        return;
      }
      var dd = uiState.dockDrag;
      var pt = getCanvasLocalCoords(e.clientX, e.clientY);
      uiState.pointer.x = pt.x;
      uiState.pointer.y = pt.y;
      uiState.pointer.clientX = e.clientX;
      uiState.pointer.clientY = e.clientY;
      uiState.pointer.inside = true;

      if (!dd.dragging && Math.hypot(e.clientX - dd.startX, e.clientY - dd.startY) > 10) {
        dd.dragging = true;
        uiState.placingPartId = dd.partId;
        updateCanvasCursorClass();
        syncPartsDock();
      }
    });

    global.addEventListener('pointerup', function (e) {
      if (!uiState.dockDrag || uiState.dockDrag.pointerId !== e.pointerId) {
        return;
      }
      var dd = uiState.dockDrag;
      uiState.dockDrag = null;

      if (dd.dragging) {
        // キャンバス上（ドック以外の領域）で離された場合は即配置
        var dockEl = doc.getElementById('parts-dock');
        var dockRect = dockEl && dockEl.getBoundingClientRect ? dockEl.getBoundingClientRect() : null;
        var overDock = dockRect && e.clientY >= dockRect.top - 4;
        var part = PARTS_MAP[dd.partId];
        if (!overDock && part) {
          var pt = getCanvasLocalCoords(e.clientX, e.clientY);
          var res = addNode(dd.partId, pt.x - part.width * 0.5, pt.y - part.height * 0.5);
          if (!res.ok && res.message) {
            setBoogieOverride(res.message, 'alert', 4.0);
            safeAudio('playWarning');
          }
          uiState.placingPartId = res.reason === 'NODE_OVERLAP' ? dd.partId : null;
        } else {
          uiState.placingPartId = null;
        }
      } else {
        // クリック時は配置モードのトグル切替
        safeAudio('playClick', 'ui');
        uiState.placingPartId = uiState.placingPartId === dd.partId ? null : dd.partId;
        uiState.pendingWirePort = null;
      }

      updateCanvasCursorClass();
      syncUI();
    });

    global.addEventListener('pointercancel', function (e) {
      if (!uiState.dockDrag || uiState.dockDrag.pointerId !== e.pointerId) {
        return;
      }
      uiState.dockDrag = null;
      uiState.placingPartId = null;
      updateCanvasCursorClass();
      syncPartsDock();
    });

    global.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var encModal = doc.getElementById('encyclopedia-modal');
        if (encModal && !encModal.classList.contains('is-hidden')) {
          closeEncyclopedia();
          return;
        }
        if (resetModal && !resetModal.classList.contains('is-hidden')) {
          resetModal.classList.add('is-hidden');
          return;
        }
        if (uiState.placingPartId || uiState.pendingWirePort) {
          uiState.placingPartId = null;
          uiState.pendingWirePort = null;
          updateCanvasCursorClass();
          syncUI();
          return;
        }
        if (state.selectedNodeId) {
          selectNode(null);
          syncUI();
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedNodeId) {
        var activeTag = doc.activeElement ? doc.activeElement.tagName : '';
        if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') {
          return;
        }
        var delRes = removeNode(state.selectedNodeId);
        if (!delRes.ok && delRes.message) {
          setBoogieOverride(delRes.message, 'alert', 3.5);
          safeAudio('playWarning');
        }
        syncUI();
      }
    });

    global.addEventListener('resize', function () {
      syncCanvasResolution();
    });

    if (typeof global.ResizeObserver === 'function' && runtime.uiRefs.canvas && !uiState.resizeObserver) {
      uiState.resizeObserver = new global.ResizeObserver(function () {
        syncCanvasResolution();
      });
      uiState.resizeObserver.observe(runtime.uiRefs.canvas);
    }
  }

  function syncTopHud(snap) {
    var doc = global.document;
    if (!doc) {
      return;
    }

    var fundsEl = doc.getElementById('stat-funds');
    if (fundsEl) fundsEl.textContent = CONFIG.CURRENCY_SYMBOL + Math.floor(snap.funds);

    var incomeEl = doc.getElementById('stat-income');
    if (incomeEl) incomeEl.textContent = '+$' + snap.incomeRate.toFixed(1) + '/s';

    var powerEl = doc.getElementById('stat-power');
    if (powerEl) powerEl.textContent = snap.powerMetrics.totalGeneration + ' MW';

    var heatWrap = doc.getElementById('pill-heat-wrap');
    var heatEl = doc.getElementById('stat-heat');
    var heatInt = Math.round(snap.maxHeat);
    if (heatEl) heatEl.textContent = heatInt + '℃';
    if (heatWrap) {
      heatWrap.classList.toggle('is-cool', heatInt < CONFIG.COOL_BOOST_TEMP);
      heatWrap.classList.toggle('is-warm', heatInt >= CONFIG.COOL_BOOST_TEMP && heatInt <= CONFIG.OVERHEAT_TEMP);
      heatWrap.classList.toggle('is-overheat', heatInt > CONFIG.OVERHEAT_TEMP);
    }

    var tidyWrap = doc.getElementById('stat-tidy');
    if (tidyWrap) {
      tidyWrap.classList.toggle('is-active', snap.isTidySync);
      tidyWrap.title = snap.tidyStats.reason || '';
      var tidyVal = tidyWrap.querySelector('.pill-value');
      if (tidyVal) {
        if (snap.isTidySync) {
          tidyVal.textContent = '整頓 +20%';
        } else if (snap.tidyStats.linkCount < CONFIG.TIDY_MIN_LINKS) {
          tidyVal.textContent = '整頓待機';
        } else if (snap.tidyStats.crossingCount > 0) {
          tidyVal.textContent = '交差 ' + snap.tidyStats.crossingCount;
        } else {
          tidyVal.textContent = '重なり修正';
        }
      }
    }

    var stepEl = doc.getElementById('stat-step');
    if (stepEl) stepEl.textContent = snap.stepBadge;

    var cableLabel = doc.getElementById('cable-mode-label');
    if (cableLabel) {
      cableLabel.textContent = snap.cableMode === 'ortho' ? '直交パイプ' : '曲線ベジェ';
    }

    var muteBtn = doc.getElementById('btn-audio-mute');
    var muteLabel = doc.getElementById('audio-mute-label');
    if (muteBtn) {
      muteBtn.classList.toggle('is-muted', snap.muted);
      var mIcon = muteBtn.querySelector('.btn-icon');
      if (mIcon) mIcon.textContent = snap.muted ? '🔇' : '🔊';
    }
    if (muteLabel) {
      muteLabel.textContent = snap.muted ? '音響 OFF' : '音響 ON';
    }

    var saveBadge = doc.getElementById('autosave-indicator');
    if (saveBadge) {
      var saving = uiState.autosaveFlashTimer > 0;
      saveBadge.classList.toggle('is-saving', saving);
      saveBadge.textContent = saving ? '自動保存中...' : '自動保存済み';
    }
  }

  function syncPartsDock(snap) {
    var doc = global.document;
    if (!doc) {
      return;
    }
    var currentSnap = snap || getSnapshot();
    var listEl = doc.getElementById('parts-dock-list');
    if (!listEl) {
      return;
    }

    var counts = {};
    for (var n = 0; n < state.nodes.length; n += 1) {
      var pid = state.nodes[n].partId;
      counts[pid] = (counts[pid] || 0) + 1;
    }

    var cards = listEl.querySelectorAll('.part-card');
    for (var i = 0; i < cards.length; i += 1) {
      var card = cards[i];
      var partId = card.getAttribute('data-part-id');
      var part = PARTS_MAP[partId];
      if (!part) {
        continue;
      }

      var unlocked = currentSnap.unlockedParts.indexOf(partId) !== -1;
      var affordable = currentSnap.funds >= part.cost;
      var isPlacing = uiState.placingPartId === partId;
      var isNew = unlocked && Boolean(uiState.newlyUnlockedSet[partId]);

      card.classList.toggle('is-locked', !unlocked);
      card.classList.toggle('is-unaffordable', unlocked && !affordable);
      card.classList.toggle('is-placing', isPlacing);
      card.classList.toggle('is-new', isNew);

      var roleEl = card.querySelector('.part-role');
      if (roleEl) {
        roleEl.textContent = part.category + ' · ' + (counts[partId] || 0) + '基';
      }

      var badgeEl = card.querySelector('.part-badge');
      if (badgeEl) {
        if (!unlocked) {
          badgeEl.className = 'part-badge badge-lock';
          badgeEl.textContent = 'STEP ' + part.unlockStep;
        } else if (isNew) {
          badgeEl.className = 'part-badge badge-new';
          badgeEl.textContent = 'NEW';
        } else {
          badgeEl.className = 'part-badge is-hidden';
          badgeEl.textContent = '';
        }
      }
    }

    var hintEl = doc.getElementById('dock-hint');
    if (hintEl) {
      if (uiState.placingPartId && PARTS_MAP[uiState.placingPartId]) {
        hintEl.textContent =
          '【配置モード: ' + PARTS_MAP[uiState.placingPartId].name + '】海中の好きな場所をクリックして設置 ／ 右クリックまたは ESC でキャンセル';
      } else if (uiState.wiringDrag || uiState.pendingWirePort) {
        hintEl.textContent =
          '【配線中】光っている互換ポートへ接続してください ／ 右クリックまたは ESC でキャンセル';
      } else {
        hintEl.textContent =
          '設備カードをクリックして配置（またはドラッグ） ／ 出力ポート●から入力ポート●へドラッグで配線 ／ 配線クリック・右クリックで解除';
      }
    }
  }

  function syncInspector() {
    var doc = global.document;
    if (!doc) {
      return;
    }
    var panel = doc.getElementById('node-inspector');
    if (!panel) {
      return;
    }

    if (!state.selectedNodeId) {
      panel.classList.add('is-hidden');
      uiState.lastPortsSig = '';
      return;
    }

    var ins = getNodeInspectorSnapshot(state.selectedNodeId);
    if (!ins) {
      panel.classList.add('is-hidden');
      uiState.lastPortsSig = '';
      return;
    }

    panel.classList.remove('is-hidden');

    var catEl = doc.getElementById('inspector-category');
    if (catEl) catEl.textContent = ins.category;

    var titleEl = doc.getElementById('inspector-title');
    if (titleEl) titleEl.textContent = ins.name;

    var statusEl = doc.getElementById('inspector-status');
    if (statusEl) {
      statusEl.textContent = ins.statusLabel;
      statusEl.className = 'status-chip';
      if (ins.status === 'overheat' || ins.status === 'bottleneck') {
        statusEl.classList.add('is-overheat');
      } else if (ins.status === 'warning') {
        statusEl.classList.add('is-warning');
      } else if (ins.status === 'boosted') {
        statusEl.classList.add('is-boost');
      } else if (ins.status === 'running') {
        statusEl.classList.add('is-running');
      } else {
        statusEl.classList.add('is-idle');
      }
    }

    var heatRow = doc.getElementById('inspector-heat-row');
    if (heatRow) {
      heatRow.classList.toggle('is-hidden', !ins.hasHeat);
      if (ins.hasHeat) {
        var heatValEl = doc.getElementById('inspector-heat-value');
        var heatBarEl = doc.getElementById('inspector-heat-bar');
        var isWarm = ins.heat >= CONFIG.COOL_BOOST_TEMP && ins.heat <= CONFIG.OVERHEAT_TEMP;
        var isOh = ins.isOverheated || ins.heat > CONFIG.OVERHEAT_TEMP;
        if (heatValEl) {
          heatValEl.textContent = Math.round(ins.heat) + '℃' + (ins.isCoolBoosted ? ' (冷却中)' : '');
          heatValEl.classList.toggle('is-warm', isWarm && !isOh);
          heatValEl.classList.toggle('is-overheat', isOh);
        }
        if (heatBarEl) {
          var pct = clamp(((ins.heat - CONFIG.BASE_TEMP) / (ins.maxTemp - CONFIG.BASE_TEMP)) * 100, 4, 100);
          heatBarEl.style.width = pct.toFixed(1) + '%';
          heatBarEl.classList.toggle('is-warm', isWarm && !isOh);
          heatBarEl.classList.toggle('is-overheat', isOh);
        }
      }
    }

    var effEl = doc.getElementById('inspector-efficiency');
    if (effEl) {
      var tags = [];
      for (var b = 1; b < ins.efficiencyBreakdown.length; b += 1) {
        tags.push(ins.efficiencyBreakdown[b].label + '×' + ins.efficiencyBreakdown[b].multiplier.toFixed(1));
      }
      effEl.textContent = ins.efficiencyPct + '%' + (tags.length > 0 ? ' (' + tags.join(' / ') + ')' : '');
      effEl.className = 'eff-readout';
      if (ins.efficiencyPct > 100) effEl.classList.add('is-boost');
      else if (ins.efficiencyPct < 100) effEl.classList.add('is-penalty');
    }

    var hybridWrap = doc.getElementById('inspector-hybrid-controls');
    if (hybridWrap) {
      hybridWrap.classList.toggle('is-hidden', !ins.hybrid);
      if (ins.hybrid) {
        var btnData = doc.getElementById('btn-mode-data');
        var btnFilter = doc.getElementById('btn-mode-filter');
        if (btnData) btnData.classList.toggle('is-active', ins.hybrid.mode === 'data');
        if (btnFilter) btnFilter.classList.toggle('is-active', ins.hybrid.mode === 'filter');

        var sliderWrap = doc.getElementById('slider-precision-wrap');
        if (sliderWrap) {
          sliderWrap.classList.toggle('is-hidden', ins.hybrid.mode !== 'data');
        }
        var slider = doc.getElementById('slider-precision');
        if (slider && !uiState.isSliderDragging) {
          slider.value = String(ins.hybrid.precision);
        }
        var pctEl = doc.getElementById('slider-precision-pct');
        if (pctEl) pctEl.textContent = ins.hybrid.precision + '%';

        var readoutEl = doc.getElementById('slider-readout');
        if (readoutEl) readoutEl.textContent = ins.hybrid.readoutText;
      }
    }

    var delBtn = doc.getElementById('btn-node-delete');
    if (delBtn) {
      delBtn.disabled = !ins.allowDelete;
      delBtn.style.opacity = ins.allowDelete ? '1' : '0.42';
      delBtn.style.cursor = ins.allowDelete ? 'pointer' : 'not-allowed';
      delBtn.title = ins.allowDelete ? 'この設備を解体しコストの80%を回収します' : '初期基幹設備は解体できません';
    }

    // ポート＆接続リスト（変更時のみDOM再構築してクリックの取りこぼしを防止）
    var portsSigParts = [ins.id, ins.hybrid ? ins.hybrid.mode + ':' + ins.hybrid.precision : 'std'];
    for (var ps = 0; ps < ins.ports.length; ps += 1) {
      var prt = ins.ports[ps];
      var connIds = [];
      for (var cs = 0; cs < prt.connections.length; cs += 1) {
        connIds.push(prt.connections[cs].connId + ':' + prt.connections[cs].resourceId);
      }
      portsSigParts.push(prt.id + '=' + connIds.join(','));
    }
    var nextPortsSig = portsSigParts.join('|');
    if (nextPortsSig !== uiState.lastPortsSig) {
      uiState.lastPortsSig = nextPortsSig;
      var portsEl = doc.getElementById('inspector-ports');
      if (portsEl) {
        portsEl.innerHTML = '';
        for (var p = 0; p < ins.ports.length; p += 1) {
          var port = ins.ports[p];
          var row = doc.createElement('div');
          row.className = 'port-row' + (port.connections.length > 0 ? ' is-connected' : '');

          var head = doc.createElement('div');
          head.className = 'port-row-head';

          var info = doc.createElement('div');
          info.className = 'port-info';

          var dot = doc.createElement('span');
          dot.className = 'port-dot';
          var pCol = port.color || '#00f0ff';
          if (port.dir === 'out' && port.type && RESOURCES[port.type]) {
            pCol = RESOURCES[port.type].color;
          }
          dot.style.background = pCol;
          dot.style.color = pCol;
          info.appendChild(dot);

          var nameSpan = doc.createElement('span');
          nameSpan.className = 'port-name';
          nameSpan.textContent = port.label;
          info.appendChild(nameSpan);

          var dirSpan = doc.createElement('span');
          dirSpan.className = 'port-dir';
          dirSpan.textContent = port.dir === 'in' ? '入力' : '出力';

          head.appendChild(info);
          head.appendChild(dirSpan);
          row.appendChild(head);

          if (port.connections.length > 0) {
            var connsWrap = doc.createElement('div');
            connsWrap.className = 'port-connections';
            for (var c = 0; c < port.connections.length; c += 1) {
              var cn = port.connections[c];
              var cItem = doc.createElement('div');
              cItem.className = 'port-conn-item';
              var cLabel = doc.createElement('span');
              var cRes = RESOURCES[cn.resourceId];
              cLabel.textContent = (port.dir === 'out' ? '➔ ' : '← ') + cn.peerNodeName + (cRes ? ' (' + cRes.shortName + ')' : '');
              cItem.appendChild(cLabel);

              var cutBtn = doc.createElement('button');
              cutBtn.type = 'button';
              cutBtn.className = 'port-cut-btn';
              cutBtn.textContent = '切断';
              (function (cid) {
                cutBtn.addEventListener('click', function () {
                  unlockAudioOnGesture();
                  disconnectWire(cid);
                  syncUI();
                });
              })(cn.connId);
              cItem.appendChild(cutBtn);
              connsWrap.appendChild(cItem);
            }
            row.appendChild(connsWrap);
          } else {
            var emptyEl = doc.createElement('div');
            emptyEl.className = 'port-empty';
            emptyEl.textContent = '未接続（キャンバスでポート間をドラッグ）';
            row.appendChild(emptyEl);
          }

          portsEl.appendChild(row);
        }
      }
    }
  }

  function syncBoogieDock(snap) {
    var doc = global.document;
    if (!doc) {
      return;
    }

    var stepLabel = doc.getElementById('boogie-step-label');
    if (stepLabel) stepLabel.textContent = snap.boogieStepLabel;

    var btnLaser = doc.getElementById('btn-guide-laser');
    if (btnLaser) {
      var laserOn = snap.guideLaserEnabled || Boolean(state.activeEncyclopediaGuidePartId);
      btnLaser.classList.toggle('is-active', laserOn);
      btnLaser.textContent = laserOn ? '光線ON' : '光線OFF';
    }

    var msgEl = doc.getElementById('boogie-message');
    if (msgEl && msgEl.textContent !== snap.boogieMessage) {
      msgEl.textContent = snap.boogieMessage;
    }

    if (snap.boogieMessage !== uiState.lastBoogieMessage) {
      var wasInitialized = uiState.lastBoogieMessage !== '';
      uiState.lastBoogieMessage = snap.boogieMessage;
      if (runtime.boogieController) {
        if (typeof runtime.boogieController.setExpression === 'function') {
          runtime.boogieController.setExpression(snap.boogieMood);
        }
        if (wasInitialized && typeof runtime.boogieController.triggerTalk === 'function') {
          runtime.boogieController.triggerTalk(1800);
        }
      }
      if (wasInitialized && uiState.audioUnlocked) {
        safeAudio('playBoogieTalk', snap.boogieMood);
      }
    }

    var listParts = [];
    for (var i = 0; i < snap.checklist.length; i += 1) {
      listParts.push(snap.checklist[i].id + ':' + (snap.checklist[i].done ? '1' : '0'));
    }
    var sig = listParts.join('|');
    if (sig !== uiState.lastChecklistSig) {
      uiState.lastChecklistSig = sig;
      var clEl = doc.getElementById('boogie-checklist');
      if (clEl) {
        clEl.innerHTML = '';
        for (var j = 0; j < snap.checklist.length; j += 1) {
          var item = snap.checklist[j];
          var li = doc.createElement('li');
          li.textContent = item.label;
          if (item.done) {
            li.classList.add('is-done');
          }
          clEl.appendChild(li);
        }
      }
    }
  }

  function initUI() {
    if (typeof global.document === 'undefined') {
      return;
    }
    var doc = global.document;
    var canvas = doc.getElementById('abyss-canvas');
    if (canvas) {
      runtime.uiRefs.canvas = canvas;
      runtime.uiRefs.ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      syncCanvasResolution();
    }

    if (!runtime.boogieController && typeof global.BoogieController === 'function') {
      var svgHost = doc.getElementById('boogie-svg-host');
      var waveHost = doc.getElementById('boogie-waveform');
      if (svgHost) {
        runtime.boogieController = new global.BoogieController(svgHost, waveHost);
        runtime.boogieController.setExpression(state.boogieMood);
      }
    }
    if (!runtime.encyclopediaPreview && typeof global.EncyclopediaPreview === 'function') {
      var encCanvas = doc.getElementById('encyclopedia-canvas');
      if (encCanvas) {
        runtime.encyclopediaPreview = new global.EncyclopediaPreview(encCanvas);
      }
    }

    uiState.lastUnlockedList = state.unlockedParts.slice();
    bindUI();
    syncUI();
  }

  function syncUI() {
    if (typeof global.document === 'undefined') {
      return;
    }
    var snap = getSnapshot();
    syncTopHud(snap);
    syncPartsDock(snap);
    syncInspector();
    syncBoogieDock(snap);
  }

  function render() {
    var ctx = runtime.uiRefs.ctx;
    var canvas = runtime.uiRefs.canvas;
    if (!ctx || !canvas) {
      return;
    }

    syncCanvasResolution();
    var w = uiState.cssW || state.viewport.width || 1280;
    var h = uiState.cssH || state.viewport.height || 720;

    if (state.fxEvents.length > 0) {
      processFxEvents();
    }

    var nowMs = global.performance ? global.performance.now() : Date.now();
    if (uiState.lastRenderMs === 0) {
      uiState.lastRenderMs = nowMs;
    }
    var renderDt = clamp((nowMs - uiState.lastRenderMs) / 1000, 0, MAX_DT);
    uiState.lastRenderMs = nowMs;
    uiState.renderTime += renderDt;

    var time = state.simTime > 0 ? state.simTime : uiState.renderTime;

    ctx.save();
    ctx.setTransform(uiState.dpr, 0, 0, uiState.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    renderBackground(ctx, w, h, time);
    renderConnections(ctx, time);
    renderWiringPreview(ctx, time);
    renderPackets(ctx, time);
    renderNodes(ctx, time);
    renderPlacementGhost(ctx, time);
    renderGuideLasers(ctx, w, h);
    renderFx(ctx, w, h, time);

    ctx.restore();
  }

  function startLoop() {
    if (runtime.running || typeof global.requestAnimationFrame !== 'function') {
      return;
    }
    runtime.running = true;
    runtime.lastFrameMs = global.performance ? global.performance.now() : Date.now();

    function frame(nowMs) {
      if (!runtime.running) {
        return;
      }
      var dt = Math.max(0, (nowMs - runtime.lastFrameMs) / 1000);
      runtime.lastFrameMs = nowMs;
      var safeDt = Math.min(dt, MAX_DT);

      stepSimulation(dt);
      processFxEvents();
      updateVfx(safeDt);

      if (runtime.boogieController && typeof runtime.boogieController.update === 'function') {
        runtime.boogieController.update(safeDt);
      }
      render();
      syncUI();

      runtime.rafId = global.requestAnimationFrame(frame);
    }

    runtime.rafId = global.requestAnimationFrame(frame);
  }

  function stopLoop() {
    runtime.running = false;
    if (runtime.rafId !== null && typeof global.cancelAnimationFrame === 'function') {
      global.cancelAnimationFrame(runtime.rafId);
      runtime.rafId = null;
    }
  }

  function openEncyclopedia(partId) {
    var targetId = partId && PARTS_MAP[partId] ? partId : CONFIG.PART_ORDER[0];
    if (typeof global.document !== 'undefined') {
      var modal = global.document.getElementById('encyclopedia-modal');
      if (modal) {
        modal.classList.remove('is-hidden');
      }
      renderEncyclopediaDetail(targetId, null);
    }
    if (runtime.encyclopediaPreview) {
      if (typeof runtime.encyclopediaPreview.setPart === 'function') {
        runtime.encyclopediaPreview.setPart(targetId);
      }
      if (typeof runtime.encyclopediaPreview.start === 'function') {
        runtime.encyclopediaPreview.start();
      }
    }
    return { ok: true, partId: targetId };
  }

  function closeEncyclopedia() {
    if (typeof global.document !== 'undefined') {
      var modal = global.document.getElementById('encyclopedia-modal');
      if (modal) {
        modal.classList.add('is-hidden');
      }
    }
    if (runtime.encyclopediaPreview && typeof runtime.encyclopediaPreview.stop === 'function') {
      runtime.encyclopediaPreview.stop();
    }
    return { ok: true };
  }

  function init(options) {
    var opts = options || {};
    if (opts.viewport) {
      state.viewport.width = opts.viewport.width || state.viewport.width;
      state.viewport.height = opts.viewport.height || state.viewport.height;
    } else if (typeof global.innerWidth === 'number' && typeof global.innerHeight === 'number') {
      state.viewport.width = global.innerWidth || state.viewport.width;
      state.viewport.height = global.innerHeight || state.viewport.height;
    }

    var loadRes = loadGame({ viewport: state.viewport });
    initUI();
    runtime.initialized = true;
    if (!opts.skipLoop) {
      startLoop();
    }
    return loadRes;
  }

  // =========================================================================
  // 12. 公開 API (window.AbyssGame) & 自動起動フック
  // =========================================================================

  var AbyssGame = {
    get state() {
      return state;
    },
    init: init,
    initUI: initUI,
    bindUI: bindUI,
    syncUI: syncUI,
    render: render,
    startLoop: startLoop,
    stopLoop: stopLoop,
    stepSimulation: stepSimulation,
    updateViewportSize: updateViewportSize,
    NODE_CLEARANCE: NODE_CLEARANCE,
    getSafePlayArea: getSafePlayArea,
    clampNodePosition: clampNodePosition,
    hasNodeOverlap: hasNodeOverlap,

    // セーブ／ロード／初期化
    loadGame: loadGame,
    saveGame: saveGame,
    resetGame: resetGame,
    resetSave: resetSave,
    newGame: resetGame,
    exportSaveJSON: exportSaveJSON,
    importSaveJSON: importSaveJSON,

    // ノード＆配線操作
    addNode: addNode,
    removeNode: removeNode,
    moveNode: moveNode,
    selectNode: selectNode,
    canConnect: canConnect,
    resolvePortPair: resolvePortPair,
    connectPorts: connectPorts,
    disconnectWire: disconnectWire,
    disconnectPort: disconnectPort,
    setNodeMode: setNodeMode,
    setNodePrecision: setNodePrecision,
    setCableMode: setCableMode,
    toggleCableMode: toggleCableMode,
    setMuted: setMuted,
    toggleMute: toggleMute,
    setGuideLaserEnabled: setGuideLaserEnabled,
    toggleGuideLaser: toggleGuideLaser,
    setGuidePart: setGuidePart,

    // 幾何・計算・進行・ガイド
    getPortPosition: getPortPosition,
    getEffectiveOutputType: getEffectiveOutputType,
    getEffectiveAcceptedTypes: getEffectiveAcceptedTypes,
    getModuleDataProfile: getModuleDataProfile,
    getWirePolyline: getWirePolyline,
    samplePointAtProgress: samplePointAtProgress,
    evaluateTidySync: evaluateTidySync,
    evaluateTutorialProgress: evaluateTutorialProgress,
    computeGuideLinks: computeGuideLinks,
    getGuideLinks: getGuideLinks,
    pokeBoogie: pokeBoogie,

    // スナップショット＆イベント
    getNodeInspectorSnapshot: getNodeInspectorSnapshot,
    getSnapshot: getSnapshot,
    consumeFxEvents: consumeFxEvents,

    // 図鑑モーダル制御
    openEncyclopedia: openEncyclopedia,
    closeEncyclopedia: closeEncyclopedia
  };

  global.AbyssGame = AbyssGame;

  if (typeof global.document !== 'undefined' && typeof global.document.addEventListener === 'function') {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', function () {
        if (!runtime.initialized) {
          init();
        }
      });
    } else {
      init();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
