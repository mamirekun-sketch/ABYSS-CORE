/**
 * ABYSS CORE（アビス・コア）Phase 1 ― マスターデータ定義（data.js）
 * 公開グローバル契約: window.ABYSS_DATA
 *
 * すべてのUI文字列・図鑑解説・セリフは日本のJIS標準漢字のみを使用し、
 * 外部ファイルに依存せず単体で完結する不変マスターデータとして構築する。
 */
(function (global) {
  'use strict';

  /**
   * オブジェクトと配列を再帰的に凍結し、実行時の不慮の書き換えを防止する。
   * @template T
   * @param {T} obj
   * @returns {T}
   */
  function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    Object.freeze(obj);
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i += 1) {
      var val = obj[keys[i]];
      if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
        deepFreeze(val);
      }
    }
    return obj;
  }

  // =========================================================================
  // 1. CONFIG ― ゲーム全体定数・熱力学閾値・帯域容量・美観ボーナス定義
  // =========================================================================
  var CONFIG = {
    GAME_TITLE: 'ABYSS CORE',
    PHASE_LABEL: 'Phase 1',
    SAVE_KEY: 'abyss_core_phase1_save_v1',
    AUTOSAVE_INTERVAL_MS: 5000,

    // キャンバス・グリッド・インタラクション基準
    GRID_SIZE: 24,
    SNAP_TO_GRID: false,
    WORLD_PADDING: 28,
    SAFE_MARGIN_TOP: 84,
    SAFE_MARGIN_BOTTOM: 136,
    SAFE_MARGIN_SIDE: 24,
    NODE_CORNER_RADIUS: 12,
    PORT_RADIUS: 7,
    PORT_HIT_RADIUS: 18,
    CABLE_HIT_DISTANCE: 12,
    MAX_PARTICLES_ON_CABLE: 28,
    MAX_AMBIENT_BUBBLES: 42,
    MAX_VFX_PARTICLES: 140,

    // 初期経済・資金回収バランス
    INITIAL_FUNDS: 80,
    REFUND_RATE: 0.80,
    CURRENCY_SYMBOL: '$',

    // 熱力学・オーバーヒート・冷却ブーストパラメータ（単位: ℃）
    // 深海周囲水温は年間を通じて 4℃（天然ヒートシンク）として設定
    BASE_TEMP: 4,
    COOL_BOOST_TEMP: 65,
    HEAT_WARN_TEMP: 72,
    OVERHEAT_TEMP: 80,
    MAX_TEMP: 110,
    AMBIENT_COOLING_RATE: 1.5,
    COOL_BOOST_MULTIPLIER: 1.20,
    OVERHEAT_MULTIPLIER: 0.50,
    COOL_BOOST_DURATION_SEC: 5.0,
    PURIFIED_COOLANT_MULTIPLIER: 2.0,

    // 地上アップリンク帯域容量＆ボトルネック（赤い脈動膨張）閾値
    // 速度特化(負荷1.0)の汎用モジュール1台(約1.18負荷/s)では快適稼働し、
    // 2台直結(約2.35負荷/s)で確実に詰まりが発生し、精度65%以上(負荷0.35)で即解消する設計。
    UPLINK_BANDWIDTH_CAPACITY: 1.85,
    UPLINK_BOTTLENECK_THRESHOLD: 2.50,
    UPLINK_QUEUE_MAX: 16.0,
    BOTTLENECK_BULGE_MAX_PX: 11.0,

    // 整頓シンクロボーナス（美観＝性能）
    TIDY_BONUS_MULTIPLIER: 1.20,
    TIDY_MIN_LINKS: 2,
    TIDY_MAX_CROSSINGS: 0,

    // 配線トポロジ仕様（1対多の分岐複製、多対1の合流受入）
    ALLOW_MULTI_OUTPUT: true,
    ALLOW_MULTI_INPUT: true,
    OUTPUT_SPLIT_MODE: 'broadcast',
    CABLE_STYLES: ['bezier', 'ortho'],
    DEFAULT_CABLE_STYLE: 'bezier',
    ORTHO_CORNER_RADIUS: 14,

    // 日本語標準フォント規約（JIS標準字体・中華フォントへのフォールバック防止）
    FONT_FAMILY: "'Noto Sans JP', 'Yu Gothic', 'Yu Gothic UI', 'Hiragino Kaku Gothic ProN', 'Meiryo', sans-serif",
    MONO_FONT_FAMILY: "'JetBrains Mono', 'Consolas', 'Noto Sans JP', monospace",

    // 表示順序キー
    RESOURCE_ORDER: [
      'power',
      'raw_data',
      'refined_data',
      'high_purity_data',
      'deep_water',
      'hot_water',
      'purified_coolant'
    ],
    PART_ORDER: [
      'emergency_battery',
      'submarine_cable',
      'generic_module',
      'surface_uplink',
      'deep_water_intake',
      'drain_vent',
      'hydrothermal_turbine'
    ],

    // 共通色パレット（Canvas描画＆VFX連携用）
    PALETTE: {
      ABYSS_TOP: '#041322',
      ABYSS_MID: '#030d19',
      ABYSS_DEEP: '#02070f',
      GRID_LINE: 'rgba(56, 214, 255, 0.06)',
      GRID_ACCENT: 'rgba(56, 214, 255, 0.14)',
      NODE_BG: 'rgba(10, 25, 42, 0.90)',
      NODE_HEADER_BG: 'rgba(16, 40, 64, 0.95)',
      NODE_BORDER: 'rgba(76, 243, 255, 0.32)',
      BRASS_GOLD: '#d8a648',
      CYAN_NEON: '#00f0ff',
      MAGENTA_NEON: '#ff4fd8',
      TIDY_GLOW: '#4cf3ff',
      TIDY_GOLD: '#ffd84d',
      ALERT_RED: '#ff3b5c',
      WARNING_AMBER: '#ff9e2c',
      COOL_ICE: '#7afcff',
      TEXT_PRIMARY: '#e8f7ff',
      TEXT_MUTED: '#8ab4cc'
    }
  };

  // =========================================================================
  // 2. RESOURCES ― 全7種リソース（流れる粒）の物理・視覚パラメータ
  // =========================================================================
  var RESOURCES = {
    power: {
      id: 'power',
      name: '電力',
      shortName: '電力',
      category: 'energy',
      description: '全稼働装置のエネルギー源。細い高圧電線を黄色い稲妻状パルスとして超高速に駆け抜けます。',
      color: '#ffd84d',
      secondaryColor: '#fff4a8',
      coreColor: '#ffffff',
      glowColor: 'rgba(255, 216, 77, 0.88)',
      pipeColor: '#7a6320',
      pipeBorderColor: 'rgba(255, 216, 77, 0.45)',
      pipeWidth: 2.5,
      pipeStyle: 'electric',
      speed: 260,
      particleShape: 'bolt',
      particleRadius: 4.5,
      pulseTrail: true,
      emitSteam: false,
      baseValue: 0,
      valueMultiplier: 0,
      bandwidthLoad: 0,
      coolingPower: 0,
      coolingAmount: 0,
      thermalEnergy: 0
    },
    raw_data: {
      id: 'raw_data',
      name: '生データ',
      shortName: '生データ',
      category: 'data',
      description: '海底光ケーブルから届く未加工パケット。基本単価 $3 で換金可能ですが、帯域負荷 1.0 を消費します。',
      color: '#00f0ff',
      secondaryColor: '#9ef8ff',
      coreColor: '#e6feff',
      glowColor: 'rgba(0, 240, 255, 0.82)',
      pipeColor: '#0e4c61',
      pipeBorderColor: 'rgba(0, 240, 255, 0.50)',
      pipeWidth: 3.5,
      pipeStyle: 'fiber',
      speed: 145,
      particleShape: 'orb',
      particleRadius: 4.8,
      pulseTrail: true,
      emitSteam: false,
      baseValue: 3.0,
      valueMultiplier: 1.0,
      bandwidthLoad: 1.0,
      coolingPower: 0,
      coolingAmount: 0,
      thermalEnergy: 0
    },
    refined_data: {
      id: 'refined_data',
      name: '精製データ',
      shortName: '精製データ',
      category: 'data',
      description: '汎用モジュールで標準加工されたパケット。基準単価 $6（2.0倍）、帯域負荷 0.75 に最適化されます。',
      color: '#ff4fd8',
      secondaryColor: '#00f0ff',
      coreColor: '#ffe8fb',
      glowColor: 'rgba(255, 79, 216, 0.86)',
      pipeColor: '#541a52',
      pipeBorderColor: 'rgba(255, 79, 216, 0.55)',
      pipeWidth: 4.0,
      pipeStyle: 'fiber_dense',
      speed: 165,
      particleShape: 'diamond',
      particleRadius: 5.5,
      pulseTrail: true,
      emitSteam: false,
      baseValue: 6.0,
      valueMultiplier: 2.0,
      bandwidthLoad: 0.75,
      coolingPower: 0,
      coolingAmount: 0,
      thermalEnergy: 0
    },
    high_purity_data: {
      id: 'high_purity_data',
      name: '高純度データ',
      shortName: '高純度データ',
      category: 'data',
      description: '精度設定（65%以上）で高密度圧縮された黄金パケット。単価 $7.5（2.5倍）かつ帯域負荷 0.35 で詰まりを解消します。',
      color: '#ffb830',
      secondaryColor: '#ff55d8',
      coreColor: '#fff9d6',
      glowColor: 'rgba(255, 184, 48, 0.94)',
      pipeColor: '#5c4213',
      pipeBorderColor: 'rgba(255, 184, 48, 0.68)',
      pipeWidth: 4.0,
      pipeStyle: 'fiber_gold',
      speed: 215,
      particleShape: 'crystal',
      particleRadius: 6.0,
      pulseTrail: true,
      emitSteam: false,
      baseValue: 7.5,
      valueMultiplier: 2.5,
      bandwidthLoad: 0.35,
      coolingPower: 0,
      coolingAmount: 0,
      thermalEnergy: 0
    },
    deep_water: {
      id: 'deep_water',
      name: '深層水',
      shortName: '深層水',
      category: 'fluid',
      description: '水温4℃の極低温な深海水。周囲の天然ヒートシンクとしても機能し、装置へ送ると冷却力 1.0 でコア温度を再び4℃帯へ急冷します。物理濾過モードの原料にもなります。',
      color: '#38d6ff',
      secondaryColor: '#b8f2ff',
      coreColor: '#ebfbff',
      glowColor: 'rgba(56, 214, 255, 0.74)',
      pipeColor: '#124663',
      pipeBorderColor: 'rgba(56, 214, 255, 0.45)',
      pipeWidth: 7.0,
      pipeStyle: 'pipe_cool',
      speed: 105,
      particleShape: 'droplet',
      particleRadius: 5.8,
      pulseTrail: false,
      emitSteam: false,
      baseValue: 0,
      valueMultiplier: 0,
      bandwidthLoad: 0,
      coolingPower: 1.0,
      coolingAmount: 16,
      thermalEnergy: 0
    },
    hot_water: {
      id: 'hot_water',
      name: '温排水',
      shortName: '温排水',
      category: 'fluid',
      description: '冷却時の排熱を帯びた高温流体。排水ベントで安全放出するほか、熱水タービンの貴重な燃料になります。',
      color: '#ff6b2b',
      secondaryColor: '#ff3838',
      coreColor: '#ffd4b8',
      glowColor: 'rgba(255, 92, 43, 0.86)',
      pipeColor: '#592318',
      pipeBorderColor: 'rgba(255, 107, 43, 0.55)',
      pipeWidth: 7.0,
      pipeStyle: 'pipe_hot',
      speed: 115,
      particleShape: 'steam_drop',
      particleRadius: 6.0,
      pulseTrail: false,
      emitSteam: true,
      baseValue: 0,
      valueMultiplier: 0,
      bandwidthLoad: 0,
      coolingPower: 0,
      coolingAmount: 0,
      thermalEnergy: 1.0
    },
    purified_coolant: {
      id: 'purified_coolant',
      name: '高純度冷却液',
      shortName: '高純度冷却液',
      category: 'fluid',
      description: '物理濾過モードで精製された極冷結晶流体。深層水の 2.0倍 の冷却性能で高負荷ノードを一気に冷却します。',
      color: '#7afcff',
      secondaryColor: '#d4ffff',
      coreColor: '#ffffff',
      glowColor: 'rgba(122, 252, 255, 0.92)',
      pipeColor: '#1a5a69',
      pipeBorderColor: 'rgba(212, 255, 255, 0.65)',
      pipeWidth: 7.0,
      pipeStyle: 'pipe_cryo',
      speed: 130,
      particleShape: 'snowflake',
      particleRadius: 6.2,
      pulseTrail: true,
      emitSteam: false,
      baseValue: 0,
      valueMultiplier: 0,
      bandwidthLoad: 0,
      coolingPower: 2.0,
      coolingAmount: 32,
      thermalEnergy: 0
    }
  };

  // =========================================================================
  // 3. PARTS & PARTS_MAP ― Phase 1 全7種パーツの完全仕様
  // =========================================================================
  var PARTS = [
    {
      id: 'emergency_battery',
      name: '非常用バッテリー',
      shortName: 'バッテリー',
      category: 'エネルギー',
      categoryId: 'energy',
      cost: 40,
      unlockStep: 1,
      isHybrid: false,
      width: 156,
      height: 100,
      iconSymbol: '⚡',
      summary: '非常用リチウム深海電池セル。外部入力なしで一定間隔ごとに電力パルスを自動供給します。',
      theme: {
        accent: '#ffd84d',
        bg: '#132133',
        border: '#c79b36',
        glow: 'rgba(255, 216, 77, 0.36)'
      },
      ports: {
        inputs: [],
        outputs: [
          {
            id: 'out_power',
            label: '電力出力',
            type: 'power',
            offset: { x: 1, y: 0.5 },
            color: '#ffd84d',
            role: 'power'
          }
        ]
      },
      process: {
        autoGenerate: true,
        processInterval: 0.90,
        powerCostPerCycle: 0,
        powerGeneration: 12,
        outputCount: 1
      },
      heat: {
        hasHeat: false,
        baseHeat: 4,
        heatPerCycle: 0
      },
      visual: {
        style: 'battery',
        hasGauge: true,
        hasTurbineBlades: false,
        hasDish: false
      }
    },
    {
      id: 'submarine_cable',
      name: '海底光ケーブル',
      shortName: '海底ケーブル',
      category: '通信インフラ',
      categoryId: 'data',
      cost: 45,
      unlockStep: 1,
      isHybrid: false,
      width: 162,
      height: 102,
      iconSymbol: '◈',
      summary: '大陸間光ファイバー幹線から生データを受信する海底中継ケーブル。電力を供給するとシアン色の生データを出力します。',
      theme: {
        accent: '#00f0ff',
        bg: '#0c2033',
        border: '#1fa9c7',
        glow: 'rgba(0, 240, 255, 0.34)'
      },
      ports: {
        inputs: [
          {
            id: 'in_power',
            label: '電力入力',
            accepts: ['power'],
            offset: { x: 0, y: 0.5 },
            color: '#ffd84d',
            role: 'power'
          }
        ],
        outputs: [
          {
            id: 'out_raw',
            label: '生データ出力',
            type: 'raw_data',
            offset: { x: 1, y: 0.5 },
            color: '#00f0ff',
            role: 'data'
          }
        ]
      },
      process: {
        autoGenerate: false,
        processInterval: 0.85,
        powerCostPerCycle: 1,
        powerBufferMax: 4,
        outputCount: 1
      },
      heat: {
        hasHeat: false,
        baseHeat: 4,
        heatPerCycle: 0
      },
      visual: {
        style: 'cable_terminal',
        hasGauge: false,
        hasTurbineBlades: false,
        hasDish: false
      }
    },
    {
      id: 'generic_module',
      name: '汎用モジュール',
      shortName: '汎用モジュール',
      category: '汎用ハイブリッド',
      categoryId: 'hybrid',
      cost: 60,
      unlockStep: 1,
      isHybrid: true,
      width: 188,
      height: 148,
      iconSymbol: '❖',
      summary: 'モード切替とクロック調整スライダーを備えた中核ハイブリッド装置。データ加工・圧縮と深層水濾過の両方を担います。',
      theme: {
        accent: '#ff4fd8',
        secondaryAccent: '#7afcff',
        bg: '#131d36',
        border: '#b848b8',
        glow: 'rgba(255, 79, 216, 0.38)'
      },
      ports: {
        inputs: [
          {
            id: 'in_power',
            label: '電力入力',
            accepts: ['power'],
            offset: { x: 0, y: 0.22 },
            color: '#ffd84d',
            role: 'power'
          },
          {
            id: 'in_primary',
            label: '主原料入力（生データ／深層水）',
            accepts: ['raw_data', 'deep_water'],
            acceptsByMode: {
              data: ['raw_data'],
              filter: ['deep_water']
            },
            offset: { x: 0, y: 0.50 },
            color: '#00f0ff',
            role: 'primary'
          },
          {
            id: 'in_coolant',
            label: '冷却入力（深層水／高純度冷却液）',
            accepts: ['deep_water', 'purified_coolant'],
            offset: { x: 0, y: 0.78 },
            color: '#38d6ff',
            role: 'coolant',
            dualPurposeInFilter: true
          }
        ],
        outputs: [
          {
            id: 'out_main',
            label: '主出力（精製データ／高純度／冷却液）',
            type: 'refined_data',
            dynamicTypes: ['refined_data', 'high_purity_data', 'purified_coolant'],
            offset: { x: 1, y: 0.34 },
            color: '#ff4fd8',
            role: 'main'
          },
          {
            id: 'out_waste',
            label: '排熱出力（温排水）',
            type: 'hot_water',
            offset: { x: 1, y: 0.74 },
            color: '#ff6b2b',
            role: 'waste'
          }
        ]
      },
      process: {
        autoGenerate: false,
        powerCostPerCycle: 1,
        powerBufferMax: 6,
        inputBufferMax: 8,
        coolantBufferMax: 6,
        hybridConfig: {
          defaultMode: 'data',
          defaultPrecision: 20,
          modes: {
            data: {
              id: 'data',
              label: 'データ処理モード',
              shortLabel: 'DATA',
              inputResource: 'raw_data',
              powerCost: 1,
              sliderBands: {
                speed: {
                  id: 'speed',
                  label: '速度特化',
                  min: 0,
                  max: 34,
                  outputResource: 'refined_data',
                  intervalStart: 0.45,
                  intervalEnd: 0.62,
                  valueMultStart: 1.40,
                  valueMultEnd: 1.80,
                  bandwidthLoad: 1.00,
                  heatStart: 4.2,
                  heatEnd: 3.2
                },
                balanced: {
                  id: 'balanced',
                  label: 'バランス',
                  min: 35,
                  max: 64,
                  outputResource: 'refined_data',
                  intervalStart: 0.65,
                  intervalEnd: 0.84,
                  valueMultStart: 1.85,
                  valueMultEnd: 2.15,
                  bandwidthLoad: 0.75,
                  heatStart: 3.0,
                  heatEnd: 2.4
                },
                precision: {
                  id: 'precision',
                  label: '精度特化',
                  min: 65,
                  max: 100,
                  outputResource: 'high_purity_data',
                  intervalStart: 0.88,
                  intervalEnd: 1.05,
                  valueMultStart: 2.50,
                  valueMultEnd: 2.65,
                  bandwidthLoad: 0.35,
                  heatStart: 2.2,
                  heatEnd: 1.8
                }
              }
            },
            filter: {
              id: 'filter',
              label: '物理濾過モード',
              shortLabel: 'FILTER',
              inputResource: 'deep_water',
              acceptsCoolantPortAsRaw: true,
              outputResource: 'purified_coolant',
              powerCost: 1,
              processInterval: 0.90,
              outputCount: 1,
              valueMultiplier: 0,
              heatPerCycle: 1.8
            }
          }
        }
      },
      heat: {
        hasHeat: true,
        baseHeat: 4,
        coolBoostTemp: 65,
        overheatTemp: 80,
        maxTemp: 110,
        ambientCoolRate: 1.5,
        coolBoostDurationSec: 5.0,
        coolBoostMultiplier: 1.20,
        overheatMultiplier: 0.50,
        coolantCoolingAmount: {
          deep_water: 16,
          purified_coolant: 32
        },
        wastePerCooling: 1
      },
      visual: {
        style: 'hybrid_core',
        hasGauge: true,
        hasTurbineBlades: false,
        hasDish: false
      }
    },
    {
      id: 'surface_uplink',
      name: '地上アップリンク',
      shortName: 'アップリンク',
      category: '換金出力',
      categoryId: 'uplink',
      cost: 75,
      unlockStep: 1,
      isHybrid: false,
      width: 168,
      height: 112,
      iconSymbol: '📡',
      summary: '精製されたデータを海上中継ブイへ送信して資金（$）へ換金します。帯域容量を超えるとケーブルが赤く膨張して詰まります。',
      theme: {
        accent: '#2ef2a4',
        bg: '#0c242b',
        border: '#25b884',
        glow: 'rgba(46, 242, 164, 0.36)'
      },
      ports: {
        inputs: [
          {
            id: 'in_data',
            label: 'データ入力',
            accepts: ['raw_data', 'refined_data', 'high_purity_data'],
            offset: { x: 0, y: 0.5 },
            color: '#ff4fd8',
            role: 'data'
          }
        ],
        outputs: []
      },
      process: {
        autoGenerate: false,
        processInterval: 0.35,
        bandwidthCapacityPerSec: 1.85,
        bottleneckQueueThreshold: 2.50,
        maxQueueLoad: 16.0,
        beamDurationSec: 0.55
      },
      heat: {
        hasHeat: false,
        baseHeat: 4,
        heatPerCycle: 0
      },
      visual: {
        style: 'uplink_dish',
        hasGauge: true,
        hasTurbineBlades: false,
        hasDish: true
      }
    },
    {
      id: 'deep_water_intake',
      name: '深層水インテーク',
      shortName: '深層水ポンプ',
      category: '流体・冷却',
      categoryId: 'fluid',
      cost: 50,
      unlockStep: 3,
      isHybrid: false,
      width: 158,
      height: 102,
      iconSymbol: '🌊',
      summary: '電力を使って冷たい深層水を連続汲み上げする取水ポンプ。モジュールの冷却や濾過原料に不可欠です。',
      theme: {
        accent: '#38d6ff',
        bg: '#0b2238',
        border: '#2e9ec9',
        glow: 'rgba(56, 214, 255, 0.35)'
      },
      ports: {
        inputs: [
          {
            id: 'in_power',
            label: '電力入力',
            accepts: ['power'],
            offset: { x: 0, y: 0.5 },
            color: '#ffd84d',
            role: 'power'
          }
        ],
        outputs: [
          {
            id: 'out_water',
            label: '深層水出力',
            type: 'deep_water',
            offset: { x: 1, y: 0.5 },
            color: '#38d6ff',
            role: 'coolant'
          }
        ]
      },
      process: {
        autoGenerate: false,
        processInterval: 0.90,
        powerCostPerCycle: 1,
        powerBufferMax: 4,
        outputCount: 1
      },
      heat: {
        hasHeat: false,
        baseHeat: 4,
        heatPerCycle: 0
      },
      visual: {
        style: 'water_pump',
        hasGauge: false,
        hasTurbineBlades: false,
        hasDish: false
      }
    },
    {
      id: 'drain_vent',
      name: '排水ベント',
      shortName: '排水ベント',
      category: '流体・冷却',
      categoryId: 'fluid',
      cost: 30,
      unlockStep: 3,
      isHybrid: false,
      width: 148,
      height: 98,
      iconSymbol: '♨',
      summary: '冷却で生じた温排水を海中へ安全に拡散放出する排出口。泡と湯気を上げて配管内の背圧を解消します。',
      theme: {
        accent: '#ff7a45',
        bg: '#231c29',
        border: '#c76138',
        glow: 'rgba(255, 122, 69, 0.32)'
      },
      ports: {
        inputs: [
          {
            id: 'in_hot',
            label: '温排水入力',
            accepts: ['hot_water'],
            offset: { x: 0, y: 0.5 },
            color: '#ff6b2b',
            role: 'waste'
          }
        ],
        outputs: []
      },
      process: {
        autoGenerate: false,
        processInterval: 0.45,
        ventBurstCount: 6,
        inputBufferMax: 8
      },
      heat: {
        hasHeat: false,
        baseHeat: 4,
        heatPerCycle: 0
      },
      visual: {
        style: 'drain_vent',
        hasGauge: false,
        hasTurbineBlades: false,
        hasDish: false
      }
    },
    {
      id: 'hydrothermal_turbine',
      name: '熱水タービン',
      shortName: '熱水タービン',
      category: 'エネルギー',
      categoryId: 'energy',
      cost: 80,
      unlockStep: 4,
      isHybrid: false,
      width: 170,
      height: 122,
      iconSymbol: '⚙',
      summary: '捨てられるはずの温排水の熱エネルギーで羽根を回し、高出力電力をリサイクル発電する深海エネルギーの要です。',
      theme: {
        accent: '#ff9436',
        secondaryAccent: '#ffd84d',
        bg: '#261b26',
        border: '#d48835',
        glow: 'rgba(255, 148, 54, 0.38)'
      },
      ports: {
        inputs: [
          {
            id: 'in_hot',
            label: '温排水入力',
            accepts: ['hot_water'],
            offset: { x: 0, y: 0.5 },
            color: '#ff6b2b',
            role: 'waste'
          }
        ],
        outputs: [
          {
            id: 'out_power',
            label: '電力出力',
            type: 'power',
            offset: { x: 1, y: 0.5 },
            color: '#ffd84d',
            role: 'power'
          }
        ]
      },
      process: {
        autoGenerate: false,
        processInterval: 0.65,
        powerGeneration: 18,
        outputPerHotWater: 2,
        inputBufferMax: 8,
        maxTurbineRpm: 360
      },
      heat: {
        hasHeat: false,
        baseHeat: 4,
        heatPerCycle: 0
      },
      visual: {
        style: 'turbine',
        hasGauge: true,
        hasTurbineBlades: true,
        hasDish: false
      }
    }
  ];

  /**
   * パーツIDをキーにした高速参照マップ
   */
  var PARTS_MAP = {};
  for (var pIdx = 0; pIdx < PARTS.length; pIdx += 1) {
    PARTS_MAP[PARTS[pIdx].id] = PARTS[pIdx];
  }

  // =========================================================================
  // 4. INITIAL_LAYOUT ― New Game開始時の整然とした初期配置4ノード
  // =========================================================================
  // 交差ゼロの一直線〜平行レイアウトにより、Step 1接続完了時に自然と
  // 「整頓シンクロ（+20%）」の気持ち良さを体験できるよう座標を計算済み。
  var INITIAL_LAYOUT = {
    referenceViewport: {
      width: 1280,
      height: 720
    },
    nodes: [
      {
        id: 'init_battery',
        partId: 'emergency_battery',
        x: 130,
        y: 145,
        isStarter: true,
        allowDelete: false,
        config: {}
      },
      {
        id: 'init_cable',
        partId: 'submarine_cable',
        x: 340,
        y: 265,
        isStarter: true,
        allowDelete: false,
        config: {}
      },
      {
        id: 'init_module_1',
        partId: 'generic_module',
        x: 595,
        y: 215,
        isStarter: true,
        allowDelete: false,
        config: {
          mode: 'data',
          precision: 20
        }
      },
      {
        id: 'init_uplink',
        partId: 'surface_uplink',
        x: 880,
        y: 210,
        isStarter: true,
        allowDelete: false,
        config: {}
      }
    ],
    cables: []
  };

  // =========================================================================
  // 5. TUTORIAL_STEPS ― Step 1〜Step 4＋Step 5（完全解放・フリープレイ）
  // =========================================================================
  var TUTORIAL_STEPS = [
    {
      step: 1,
      id: 'step_1',
      badge: 'STEP 1/4',
      boogieStepLabel: 'STEP 1',
      title: '第1段階：海底回線の火入れ',
      mood: 'curious',
      message: 'システム起動完了です、所長！私の溶接アームがうずいています。まずは「非常用バッテリー」の電力ポート●からケーブルを引いて、データ処理を立ち上げましょう！',
      subMessages: {
        powerReady: 'おお、電気が通りました！次は「海底光ケーブル」の生データ出力●を「汎用モジュール」へ繋いでください。',
        dataReady: 'いい配線ですね、所長！仕上げに「汎用モジュール」の右上の出力●から「地上アップリンク」へ接続すれば収益化開始です！'
      },
      unlocks: [
        'emergency_battery',
        'submarine_cable',
        'generic_module',
        'surface_uplink'
      ],
      grantFunds: 0,
      checklist: [
        {
          id: 's1_power_cable',
          label: '非常用バッテリー ➔ 海底光ケーブルへ給電',
          type: 'connection',
          fromPart: 'emergency_battery',
          fromPort: 'out_power',
          toPart: 'submarine_cable',
          toPort: 'in_power'
        },
        {
          id: 's1_power_module',
          label: '非常用バッテリー ➔ 汎用モジュールへ給電',
          type: 'connection',
          fromPart: 'emergency_battery',
          fromPort: 'out_power',
          toPart: 'generic_module',
          toPort: 'in_power'
        },
        {
          id: 's1_raw_to_module',
          label: '海底光ケーブル ➔ 汎用モジュールへ生データ送信',
          type: 'connection',
          fromPart: 'submarine_cable',
          fromPort: 'out_raw',
          toPart: 'generic_module',
          toPort: 'in_primary'
        },
        {
          id: 's1_module_to_uplink',
          label: '汎用モジュール ➔ 地上アップリンクへ接続',
          type: 'connection',
          fromPart: 'generic_module',
          fromPort: 'out_main',
          toPart: 'surface_uplink',
          toPort: 'in_data'
        },
        {
          id: 's1_earn_30',
          label: '初回収益を達成（累計稼得 $30 以上）',
          type: 'metric',
          metric: 'totalEarned',
          target: 30
        }
      ],
      guideTargets: [
        {
          checklistId: 's1_power_cable',
          type: 'connect',
          fromPart: 'emergency_battery',
          fromPort: 'out_power',
          toPart: 'submarine_cable',
          toPort: 'in_power',
          hintText: 'バッテリーの黄色ポートから海底光ケーブルへ給電してください'
        },
        {
          checklistId: 's1_power_module',
          type: 'connect',
          fromPart: 'emergency_battery',
          fromPort: 'out_power',
          toPart: 'generic_module',
          toPort: 'in_power',
          hintText: 'バッテリーから汎用モジュールの左上ポートへも給電してください（分岐OK）'
        },
        {
          checklistId: 's1_raw_to_module',
          type: 'connect',
          fromPart: 'submarine_cable',
          fromPort: 'out_raw',
          toPart: 'generic_module',
          toPort: 'in_primary',
          hintText: '海底光ケーブルから汎用モジュールの中段ポートへ生データを送ります'
        },
        {
          checklistId: 's1_module_to_uplink',
          type: 'connect',
          fromPart: 'generic_module',
          fromPort: 'out_main',
          toPart: 'surface_uplink',
          toPort: 'in_data',
          hintText: '汎用モジュールの右上出力から地上アップリンクへ繋ぎましょう！'
        }
      ]
    },
    {
      step: 2,
      id: 'step_2',
      badge: 'STEP 2/4',
      boogieStepLabel: 'STEP 2',
      title: '第2段階：帯域渋滞と圧縮チューニング',
      mood: 'happy',
      message: '初収益おめでとうございます、所長！投資を拡大しましょう。下のドックから2台目の「汎用モジュール」（$60）を追加し、1台目と同じく稼働させて地上アップリンクへ繋いでみてください！',
      subMessages: {
        bottleneckDetected: 'おっと所長、地上アップリンクの手前がぷっくり赤く膨らんでいます！速度振りのままでは帯域がパンクしてしまいます。モジュールをクリックして、スライダーを「精度 65%以上」へ振ってデータを圧縮しましょう！',
        precisionReady: '黄金の高純度データが流れ始めました！帯域負荷が 0.35 まで圧縮され、単価も 2.5倍 です。詰まりがスッと解消するのを見ていてください！'
      },
      unlocks: [
        'emergency_battery',
        'submarine_cable',
        'generic_module',
        'surface_uplink'
      ],
      grantFunds: 0,
      checklist: [
        {
          id: 's2_place_second_module',
          label: '2台目の汎用モジュールを購入・配置（計2台以上）',
          type: 'count',
          partId: 'generic_module',
          target: 2
        },
        {
          id: 's2_connect_second_module',
          label: '2台目の汎用モジュールに電力と生データを繋ぎ、地上アップリンクへ接続',
          type: 'active_connected_count',
          partId: 'generic_module',
          targetPartId: 'surface_uplink',
          target: 2
        },
        {
          id: 's2_set_precision',
          label: '汎用モジュールのスライダーを「精度 65%以上」に設定',
          type: 'module_precision',
          minPrecision: 65,
          targetCount: 1
        },
        {
          id: 's2_clear_bottleneck',
          label: '高純度データを送り届け、地上アップリンクの詰まりを解消',
          type: 'clear_bottleneck_with_purity'
        }
      ],
      guideTargets: [
        {
          checklistId: 's2_place_second_module',
          type: 'place',
          partId: 'generic_module',
          hintText: '下部ドックの「汎用モジュール（$60）」をクリックして海中へ配置してください'
        },
        {
          checklistId: 's2_connect_second_module',
          type: 'connect',
          fromPart: 'generic_module',
          fromPort: 'out_main',
          toPart: 'surface_uplink',
          toPort: 'in_data',
          hintText: '2台目の汎用モジュールにも電力・生データを分岐接続し、地上アップリンクへ合流させましょう'
        },
        {
          checklistId: 's2_set_precision',
          type: 'inspect_slider',
          partId: 'generic_module',
          minPrecision: 65,
          hintText: '汎用モジュールをクリックし、設定パネルのスライダーを右（65%以上）へ動かして高純度圧縮を有効化してください'
        }
      ]
    },
    {
      step: 3,
      id: 'step_3',
      badge: 'STEP 3/4',
      boogieStepLabel: 'STEP 3',
      title: '第3段階：深層水冷却システムの構築',
      mood: 'alert',
      message: '研究助成金 +$60 を確保しました、所長！ただ、汎用モジュールのコア温度がじわじわ上昇しています。80℃を超えると処理速度が半減してしまいます。新解放の「深層水インテーク」と「排水ベント」で冷却ラインを組みましょう！',
      subMessages: {
        waterConnected: '冷たい深層水が流れ込みました！あとはモジュール右下の赤い排熱ポート●から「排水ベント」へ温排水を逃がしてあげてください。'
      },
      unlocks: [
        'emergency_battery',
        'submarine_cable',
        'generic_module',
        'surface_uplink',
        'deep_water_intake',
        'drain_vent'
      ],
      grantFunds: 60,
      checklist: [
        {
          id: 's3_place_intake',
          label: '「深層水インテーク」と「排水ベント」を配置する',
          type: 'parts_present',
          partIds: ['deep_water_intake', 'drain_vent']
        },
        {
          id: 's3_power_intake',
          label: '非常用バッテリー ➔ 深層水インテークへ給電',
          type: 'connection',
          fromPart: 'emergency_battery',
          fromPort: 'out_power',
          toPart: 'deep_water_intake',
          toPort: 'in_power'
        },
        {
          id: 's3_cool_module',
          label: '深層水インテーク ➔ 汎用モジュールの冷却ポートへ接続',
          type: 'connection',
          fromPart: 'deep_water_intake',
          fromPort: 'out_water',
          toPart: 'generic_module',
          toPort: 'in_coolant'
        },
        {
          id: 's3_drain_waste',
          label: '汎用モジュールの温排水出力 ➔ 排水ベントへ接続',
          type: 'connection',
          fromPart: 'generic_module',
          fromPort: 'out_waste',
          toPart: 'drain_vent',
          toPort: 'in_hot'
        }
      ],
      guideTargets: [
        {
          checklistId: 's3_place_intake',
          type: 'place',
          partId: 'deep_water_intake',
          hintText: '下部ドックから「深層水インテーク（$50）」と「排水ベント（$30）」を配置してください'
        },
        {
          checklistId: 's3_power_intake',
          type: 'connect',
          fromPart: 'emergency_battery',
          fromPort: 'out_power',
          toPart: 'deep_water_intake',
          toPort: 'in_power',
          hintText: '非常用バッテリーから深層水インテークへ電力を供給しましょう'
        },
        {
          checklistId: 's3_cool_module',
          type: 'connect',
          fromPart: 'deep_water_intake',
          fromPort: 'out_water',
          toPart: 'generic_module',
          toPort: 'in_coolant',
          hintText: '深層水インテークから汎用モジュールの左下（冷却ポート）へパイプを接続してください'
        },
        {
          checklistId: 's3_drain_waste',
          type: 'connect',
          fromPart: 'generic_module',
          fromPort: 'out_waste',
          toPart: 'drain_vent',
          toPort: 'in_hot',
          hintText: '汎用モジュールの右下（温排水ポート）から排水ベントへ接続して排熱を逃がします'
        }
      ]
    },
    {
      step: 4,
      id: 'step_4',
      badge: 'STEP 4/4',
      boogieStepLabel: 'STEP 4',
      title: '第4段階：熱水タービンによる廃熱リサイクル',
      mood: 'excited',
      message: '素晴らしい冷却効率です！そして今こそ「熱の錬金術」の出番です、所長！研究助成金 +$80 とともに「熱水タービン」を解放しました。捨てていた温排水で発電し、真の3すくみ循環回路を完成させましょう！',
      subMessages: {
        turbineSpinning: 'タービン羽根が唸りを上げています！その発電出力をプラント内のいずれかの装置へ繋げば、循環回路の完成です！'
      },
      unlocks: [
        'emergency_battery',
        'submarine_cable',
        'generic_module',
        'surface_uplink',
        'deep_water_intake',
        'drain_vent',
        'hydrothermal_turbine'
      ],
      grantFunds: 80,
      checklist: [
        {
          id: 's4_place_turbine',
          label: '「熱水タービン（$80）」を購入・設置する',
          type: 'count',
          partId: 'hydrothermal_turbine',
          target: 1
        },
        {
          id: 's4_hot_to_turbine',
          label: '汎用モジュールの温排水 ➔ 熱水タービンへ接続',
          type: 'connection',
          fromPart: 'generic_module',
          fromPort: 'out_waste',
          toPart: 'hydrothermal_turbine',
          toPort: 'in_hot'
        },
        {
          id: 's4_turbine_power',
          label: '熱水タービンの電力出力をプラント内の任意ノードへ接続',
          type: 'connection_from_part',
          fromPart: 'hydrothermal_turbine',
          fromPort: 'out_power'
        }
      ],
      guideTargets: [
        {
          checklistId: 's4_place_turbine',
          type: 'place',
          partId: 'hydrothermal_turbine',
          hintText: '下部ドックの「熱水タービン（$80）」を配置してください'
        },
        {
          checklistId: 's4_hot_to_turbine',
          type: 'connect',
          fromPart: 'generic_module',
          fromPort: 'out_waste',
          toPart: 'hydrothermal_turbine',
          toPort: 'in_hot',
          hintText: '汎用モジュールの右下（温排水）を熱水タービンの入力ポートへ接続しましょう（排水ベントは外しても並列でもOKです）'
        },
        {
          checklistId: 's4_turbine_power',
          type: 'connect',
          fromPart: 'hydrothermal_turbine',
          fromPort: 'out_power',
          toPart: 'generic_module',
          toPort: 'in_power',
          hintText: '熱水タービンが生み出した電力を汎用モジュールや深層水インテークへ還元接続しましょう！'
        }
      ]
    },
    {
      step: 5,
      id: 'step_5',
      badge: 'FREE PLAY',
      boogieStepLabel: 'FREE PLAY',
      title: '深海自律プラント稼働中（フリープレイ）',
      mood: 'happy',
      message: 'おめでとうございます、所長！物理・エネルギー・デジタルの3すくみ循環が完成しました！記念の追加研究費 +$100 をどうぞ。ここからは配線の「整頓シンクロ（+20%）」や「物理濾過モード」を駆使して理想の海底メガプラントを築きましょう！',
      subMessages: {
        tidyAchieved: '交差ゼロの完璧な配線美！整頓シンクロ（+20%）が輝いています。見惚れてしまいますね！'
      },
      unlocks: [
        'emergency_battery',
        'submarine_cable',
        'generic_module',
        'surface_uplink',
        'deep_water_intake',
        'drain_vent',
        'hydrothermal_turbine'
      ],
      grantFunds: 100,
      checklist: [
        {
          id: 's5_tidy_sync',
          label: '配線の交差をゼロにして「整頓シンクロ（+20%）」を発動',
          type: 'metric_bool',
          metric: 'isTidySync'
        },
        {
          id: 's5_filter_coolant',
          label: '汎用モジュールを「物理濾過モード」で稼働し高純度冷却液を精製',
          type: 'filter_mode_active'
        },
        {
          id: 's5_income_rate',
          label: '収益速度 +$25.0/s 以上、または保有資金 $500 達成',
          type: 'metric_or',
          checks: [
            { metric: 'incomePerSec', target: 25 },
            { metric: 'funds', target: 500 }
          ]
        }
      ],
      guideTargets: [
        {
          checklistId: 's5_tidy_sync',
          type: 'tidy_hint',
          hintText: 'ノードをドラッグで並べ替えたり、右上の「直交パイプ」モードを試したりして、配線が互いに交差しない美しいレイアウトを目指しましょう'
        },
        {
          checklistId: 's5_filter_coolant',
          type: 'mode_filter',
          partId: 'generic_module',
          hintText: '追加の汎用モジュールを「物理濾過モード」に切り替え、深層水を入力すると冷却性能2倍の「高純度冷却液」を作れます！'
        }
      ]
    }
  ];

  // =========================================================================
  // 6. ENCYCLOPEDIA ― 全7種パーツの技術図鑑＋400x180ミニCanvas動的図解スクリプト
  // =========================================================================
  var ENCYCLOPEDIA = {
    emergency_battery: {
      id: 'emergency_battery',
      title: '非常用バッテリー',
      badge: 'エネルギー',
      unlockTag: '初期解放済み',
      summary: '高圧深海仕様の自律型蓄電ユニット。外部からの入力を一切必要とせず、接続されたすべての設備へ黄色い電力パルスを自動供給します。',
      specs: [
        { label: '入力ポート', value: 'なし（自己発電セル）', tone: 'neutral' },
        { label: '出力ポート', value: '電力出力（黄色稲妻パルス / 12 MW相当）', tone: 'energy' },
        { label: '分岐仕様', value: '1対多の分岐出力に対応（1台で複数装置へ給電可能）', tone: 'accent' },
        { label: '購入コスト', value: '$40（解体時は80%の $32 回収）', tone: 'neutral' }
      ],
      boogieTip: '「出力ポートは1本だけでなく何本でも引き出せますよ、所長！線が交差しないように上下に振り分けるのが整頓ボーナスのコツです。」',
      guidePreset: [
        { fromPart: 'emergency_battery', fromPort: 'out_power', toPart: 'submarine_cable', toPort: 'in_power' },
        { fromPart: 'emergency_battery', fromPort: 'out_power', toPart: 'generic_module', toPort: 'in_power' }
      ],
      variants: null,
      diagram: {
        caption: '入力不要で電力を連続供給。1つの出力ポートから複数ノードへ並列給電できます。',
        nodes: [
          { id: 'd_bat', partId: 'emergency_battery', label: '非常用バッテリー', x: 26, y: 54, w: 122, h: 72, isFocus: true },
          { id: 'd_cab', partId: 'submarine_cable', label: '海底光ケーブル', x: 238, y: 20, w: 132, h: 58 },
          { id: 'd_mod', partId: 'generic_module', label: '汎用モジュール', x: 238, y: 100, w: 132, h: 62 }
        ],
        links: [
          { fromNode: 'd_bat', fromPort: 'out_power', toNode: 'd_cab', toPort: 'in_power', resource: 'power' },
          { fromNode: 'd_bat', fromPort: 'out_power', toNode: 'd_mod', toPort: 'in_power', resource: 'power' }
        ]
      }
    },
    submarine_cable: {
      id: 'submarine_cable',
      title: '海底光ケーブル',
      badge: '通信インフラ',
      unlockTag: '初期解放済み',
      summary: '海底幹線光ファイバーから膨大な未処理データを引き込む海底中継ケーブル。電力を供給すると、シアン色に輝く「生データ」を連続出力します。',
      specs: [
        { label: '入力ポート', value: '電力入力（電力パルスを受信して稼働）', tone: 'energy' },
        { label: '出力ポート', value: '生データ出力（基本単価 $3 / 帯域負荷 1.0）', tone: 'data' },
        { label: '運用特性', value: '直接アップリンクにも流せるが、汎用モジュール加工で利益倍増', tone: 'accent' },
        { label: '購入コスト', value: '$45', tone: 'neutral' }
      ],
      boogieTip: '「生データのまま売るより、汎用モジュールに通して精製・圧縮する方がずっと儲かります。海底光ケーブル1台から複数モジュールへ分岐させることも可能です！」',
      guidePreset: [
        { fromPart: 'emergency_battery', fromPort: 'out_power', toPart: 'submarine_cable', toPort: 'in_power' },
        { fromPart: 'submarine_cable', fromPort: 'out_raw', toPart: 'generic_module', toPort: 'in_primary' }
      ],
      variants: null,
      diagram: {
        caption: '電力パルスを受けてシアン色の生データを出力。複数系統へ並列送信することも可能です。',
        nodes: [
          { id: 'd_bat', partId: 'emergency_battery', label: 'バッテリー', x: 18, y: 58, w: 96, h: 64 },
          { id: 'd_cab', partId: 'submarine_cable', label: '海底光ケーブル', x: 146, y: 54, w: 118, h: 72, isFocus: true },
          { id: 'd_mod', partId: 'generic_module', label: '汎用モジュール', x: 292, y: 54, w: 94, h: 72 }
        ],
        links: [
          { fromNode: 'd_bat', fromPort: 'out_power', toNode: 'd_cab', toPort: 'in_power', resource: 'power' },
          { fromNode: 'd_cab', fromPort: 'out_raw', toNode: 'd_mod', toPort: 'in_primary', resource: 'raw_data' }
        ]
      }
    },
    generic_module: {
      id: 'generic_module',
      title: '汎用モジュール',
      badge: '汎用ハイブリッド',
      unlockTag: '初期解放済み',
      summary: '『ABYSS CORE』の中核となるレゴ型ハイブリッド装置。クリックして開く設定パネルから「データ処理モード（速度⇔精度スライダー）」と「物理濾過モード」を自在に切り替えられます。',
      specs: [
        { label: '入力ポート', value: '左上: 電力 ／ 左中: 主原料(データ・深層水) ／ 左下: 冷却入力', tone: 'accent' },
        { label: '出力ポート', value: '右上: 加工出力(データ・冷却液) ／ 右下: 温排水(排熱)', tone: 'data' },
        { label: 'データ処理', value: '速度振り: 速いが低単価&高負荷 ／ 精度65%以上: 高純度データ(2.5倍・負荷0.35)', tone: 'accent' },
        { label: '物理濾過', value: '深層水を高純度冷却液(冷却力2倍)へ精製し、他モジュールを超冷却', tone: 'fluid' },
        { label: '熱力学管理', value: '周囲の深海水温は4℃。稼働コアは発熱で上昇し、80℃超で半減／深層水冷却で4℃帯へ急冷＆速度120%', tone: 'heat' }
      ],
      boogieTip: '「最初は速度寄りで渋滞しやすい設定になっています。2台目以降はスライダーを右（精度65%以上）へ振るのが私のイチオシです、所長！」',
      guidePreset: [
        { fromPart: 'emergency_battery', fromPort: 'out_power', toPart: 'generic_module', toPort: 'in_power' },
        { fromPart: 'submarine_cable', fromPort: 'out_raw', toPart: 'generic_module', toPort: 'in_primary' },
        { fromPart: 'generic_module', fromPort: 'out_main', toPart: 'surface_uplink', toPort: 'in_data' }
      ],
      variants: [
        {
          key: 'data_speed',
          label: 'データ速度重視',
          caption: '【速度特化 (0〜34%)】高速で精製データを量産しますが発熱が大きく、帯域負荷 1.0 のため複数台直結するとアップリンクが詰まりやすくなります。',
          nodes: [
            { id: 'd_cab', partId: 'submarine_cable', label: '海底ケーブル', x: 18, y: 54, w: 92, h: 66 },
            { id: 'd_mod', partId: 'generic_module', label: '汎用(速度特化)', x: 142, y: 46, w: 118, h: 82, mode: 'data', precision: 15, isFocus: true },
            { id: 'd_up', partId: 'surface_uplink', label: 'アップリンク', x: 292, y: 54, w: 92, h: 66 }
          ],
          links: [
            { fromNode: 'd_cab', fromPort: 'out_raw', toNode: 'd_mod', toPort: 'in_primary', resource: 'raw_data' },
            { fromNode: 'd_mod', fromPort: 'out_main', toNode: 'd_up', toPort: 'in_data', resource: 'refined_data', bottleneckDemo: true }
          ]
        },
        {
          key: 'data_precision',
          label: 'データ精度重視',
          caption: '【精度特化 (65〜100%)】黄金の高純度データを生成！単価 2.5倍（$7.5）に跳ね上がり、帯域負荷 0.35 で詰まりを即座に解消します。',
          nodes: [
            { id: 'd_cab', partId: 'submarine_cable', label: '海底ケーブル', x: 18, y: 54, w: 92, h: 66 },
            { id: 'd_mod', partId: 'generic_module', label: '汎用(精度85%)', x: 142, y: 46, w: 118, h: 82, mode: 'data', precision: 85, isFocus: true },
            { id: 'd_up', partId: 'surface_uplink', label: 'アップリンク', x: 292, y: 54, w: 92, h: 66 }
          ],
          links: [
            { fromNode: 'd_cab', fromPort: 'out_raw', toNode: 'd_mod', toPort: 'in_primary', resource: 'raw_data' },
            { fromNode: 'd_mod', fromPort: 'out_main', toNode: 'd_up', toPort: 'in_data', resource: 'high_purity_data' }
          ]
        },
        {
          key: 'filter_coolant',
          label: '物理濾過モード',
          caption: '【物理濾過モード】深層水から氷青結晶の「高純度冷却液」を精製！通常深層水の2倍の冷却力で、主力データモジュールを常時120%ブーストさせます。',
          nodes: [
            { id: 'd_int', partId: 'deep_water_intake', label: '深層水ポンプ', x: 16, y: 56, w: 96, h: 64 },
            { id: 'd_flt', partId: 'generic_module', label: '汎用(濾過)', x: 144, y: 46, w: 108, h: 82, mode: 'filter', isFocus: true },
            { id: 'd_hot', partId: 'generic_module', label: '主力演算機', x: 284, y: 46, w: 100, h: 82, mode: 'data', precision: 80 }
          ],
          links: [
            { fromNode: 'd_int', fromPort: 'out_water', toNode: 'd_flt', toPort: 'in_primary', resource: 'deep_water' },
            { fromNode: 'd_flt', fromPort: 'out_main', toNode: 'd_hot', toPort: 'in_coolant', resource: 'purified_coolant' }
          ]
        }
      ],
      diagram: null
    },
    surface_uplink: {
      id: 'surface_uplink',
      title: '地上アップリンク',
      badge: '換金出力',
      unlockTag: '初期解放済み',
      summary: '処理済みデータを海上中継ブイへレーザー送信して研究資金（$）に換金する最終出力装置。受入帯域（1.85負荷/s）を超えるとケーブルが赤く膨張します。',
      specs: [
        { label: '入力ポート', value: 'データ入力（生データ／精製データ／高純度データ）', tone: 'data' },
        { label: '出力ポート', value: 'なし（海上へ送信し即時換金）', tone: 'neutral' },
        { label: '帯域容量', value: '1.85 負荷/s（超過時は赤い脈動膨張＝ボトルネック発生）', tone: 'heat' },
        { label: '購入コスト', value: '$75（増設して複数本で分散受信することも可能）', tone: 'neutral' }
      ],
      boogieTip: '「ケーブルが赤くぷっくり膨らんだら『消化不良』のサインです！高純度データに圧縮するか、アップリンク自体をもう1基増設しましょう。」',
      guidePreset: [
        { fromPart: 'generic_module', fromPort: 'out_main', toPart: 'surface_uplink', toPort: 'in_data' }
      ],
      variants: null,
      diagram: {
        caption: '高純度データを送り込むことで、帯域圧迫を起こさず最高の資金効率を発揮します。',
        nodes: [
          { id: 'd_mod1', partId: 'generic_module', label: '汎用(精度80%)', x: 24, y: 20, w: 122, h: 62, mode: 'data', precision: 80 },
          { id: 'd_mod2', partId: 'generic_module', label: '汎用(精度80%)', x: 24, y: 98, w: 122, h: 62, mode: 'data', precision: 80 },
          { id: 'd_up', partId: 'surface_uplink', label: '地上アップリンク', x: 246, y: 54, w: 128, h: 72, isFocus: true }
        ],
        links: [
          { fromNode: 'd_mod1', fromPort: 'out_main', toNode: 'd_up', toPort: 'in_data', resource: 'high_purity_data' },
          { fromNode: 'd_mod2', fromPort: 'out_main', toNode: 'd_up', toPort: 'in_data', resource: 'high_purity_data' }
        ]
      }
    },
    deep_water_intake: {
      id: 'deep_water_intake',
      title: '深層水インテーク',
      badge: '流体・冷却',
      unlockTag: 'STEP 3 で解放',
      summary: '水深3,000m・周囲水温4℃の極低温海水を圧送する大型取水ポンプ。天然ヒートシンクである深層水を供給し、稼働で高温化した装置コアを再び4℃帯へ冷却するほか濾過原料にもなります。',
      specs: [
        { label: '入力ポート', value: '電力入力（バッテリーやタービンから供給）', tone: 'energy' },
        { label: '出力ポート', value: '深層水出力（水温4℃・冷却力 1.0 ／ 太い工業パイプ）', tone: 'fluid' },
        { label: 'シナジー', value: '冷却接続で過熱コアを4℃帯へ引き下げ、速度120%ブーストを誘発', tone: 'accent' },
        { label: '購入コスト', value: '$50', tone: 'neutral' }
      ],
      boogieTip: '「周囲の深海は一年中4℃の天然ヒートシンク！稼働して熱くなったコアだけに深層水を当てれば、一気に4℃帯まで冷え冷えになりますよ。」',
      guidePreset: [
        { fromPart: 'emergency_battery', fromPort: 'out_power', toPart: 'deep_water_intake', toPort: 'in_power' },
        { fromPart: 'deep_water_intake', fromPort: 'out_water', toPart: 'generic_module', toPort: 'in_coolant' }
      ],
      variants: null,
      diagram: {
        caption: '電力を受けて冷たい深層水を汲み上げ、汎用モジュールの左下冷却ポートへ供給します。',
        nodes: [
          { id: 'd_bat', partId: 'emergency_battery', label: 'バッテリー', x: 18, y: 58, w: 94, h: 64 },
          { id: 'd_int', partId: 'deep_water_intake', label: '深層水インテーク', x: 142, y: 54, w: 120, h: 72, isFocus: true },
          { id: 'd_mod', partId: 'generic_module', label: '汎用モジュール', x: 290, y: 50, w: 96, h: 80 }
        ],
        links: [
          { fromNode: 'd_bat', fromPort: 'out_power', toNode: 'd_int', toPort: 'in_power', resource: 'power' },
          { fromNode: 'd_int', fromPort: 'out_water', toNode: 'd_mod', toPort: 'in_coolant', resource: 'deep_water' }
        ]
      }
    },
    drain_vent: {
      id: 'drain_vent',
      title: '排水ベント',
      badge: '流体・冷却',
      unlockTag: 'STEP 3 で解放',
      summary: '冷却工程で熱を奪った後の「温排水」を、海中へ安全な低温拡散放出する排気バルブ。安価でコンパクトな排熱終端装置です。',
      specs: [
        { label: '入力ポート', value: '温排水入力（汎用モジュールの右下ポートと接続）', tone: 'heat' },
        { label: '出力ポート', value: 'なし（海中へ気泡と湯気を伴い安全放出）', tone: 'neutral' },
        { label: '運用ヒント', value: '熱水タービンが解放されるまでは必須。解放後は熱回収へ切り替え可能', tone: 'accent' },
        { label: '購入コスト', value: '$30', tone: 'neutral' }
      ],
      boogieTip: '「モクモク上がる泡はちょっと温泉気分ですね。でも熱水タービンが手に入ったら、その熱エネルギーも電気に変えちゃいましょう！」',
      guidePreset: [
        { fromPart: 'generic_module', fromPort: 'out_waste', toPart: 'drain_vent', toPort: 'in_hot' }
      ],
      variants: null,
      diagram: {
        caption: '汎用モジュールから排出される温排水を受け取り、海中へ泡とともに放出します。',
        nodes: [
          { id: 'd_mod', partId: 'generic_module', label: '汎用モジュール', x: 34, y: 48, w: 126, h: 82 },
          { id: 'd_drn', partId: 'drain_vent', label: '排水ベント', x: 248, y: 54, w: 122, h: 70, isFocus: true }
        ],
        links: [
          { fromNode: 'd_mod', fromPort: 'out_waste', toNode: 'd_drn', toPort: 'in_hot', resource: 'hot_water' }
        ]
      }
    },
    hydrothermal_turbine: {
      id: 'hydrothermal_turbine',
      title: '熱水タービン',
      badge: 'エネルギー',
      unlockTag: 'STEP 4 で解放',
      summary: '温排水の熱落差で内部の真鍮タービン羽根を高速回転させ、18 MW相当の高出力電力をリサイクル生成する3すくみ循環の最終兵器です。',
      specs: [
        { label: '入力ポート', value: '温排水入力（流量に応じて回転羽根が加速）', tone: 'heat' },
        { label: '出力ポート', value: '電力出力（18 MW相当／バッテリー1.5倍の高出力パルス）', tone: 'energy' },
        { label: '3すくみ循環', value: 'データ演算の排熱 → タービン発電 → 再び演算やポンプの動力へ！', tone: 'accent' },
        { label: '購入コスト', value: '$80', tone: 'neutral' }
      ],
      boogieTip: '「これぞ熱の錬金術です、所長！コンピューターが出した熱で電気を作って、さらにコンピューターを回す……美しい永久機関（風のループ）ですね！」',
      guidePreset: [
        { fromPart: 'generic_module', fromPort: 'out_waste', toPart: 'hydrothermal_turbine', toPort: 'in_hot' },
        { fromPart: 'hydrothermal_turbine', fromPort: 'out_power', toPart: 'generic_module', toPort: 'in_power' }
      ],
      variants: null,
      diagram: {
        caption: '温排水の流入でタービンが高速回転し、高出力な電力をプラントへ還元します。',
        nodes: [
          { id: 'd_mod', partId: 'generic_module', label: '汎用モジュール', x: 20, y: 48, w: 112, h: 82 },
          { id: 'd_trb', partId: 'hydrothermal_turbine', label: '熱水タービン', x: 162, y: 48, w: 116, h: 82, isFocus: true },
          { id: 'd_int', partId: 'deep_water_intake', label: '深層水ポンプ', x: 304, y: 56, w: 82, h: 66 }
        ],
        links: [
          { fromNode: 'd_mod', fromPort: 'out_waste', toNode: 'd_trb', toPort: 'in_hot', resource: 'hot_water' },
          { fromNode: 'd_trb', fromPort: 'out_power', toNode: 'd_int', toPort: 'in_power', resource: 'power' }
        ]
      }
    }
  };

  // =========================================================================
  // 7. BOOGIE_QUIPS ― イベント別セリフ＆表情辞書（ブギー "B.U.G.-01"）
  // =========================================================================
  var BOOGIE_QUIPS = {
    place: {
      default: [
        { mood: 'happy', text: '新しい設備の海底アンカーを固定しました、所長！配管はお任せあれ。' },
        { mood: 'excited', text: '私の溶接アームが鳴りますね！素晴らしい配置センスです。' }
      ],
      emergency_battery: [
        { mood: 'happy', text: '非常用バッテリーを追加設置しました。深海の電源は多ければ多いほど安心ですね！' }
      ],
      submarine_cable: [
        { mood: 'curious', text: '海底光ケーブルを増設しました、所長！生データの蛇口がまた1つ増えましたね。' }
      ],
      generic_module: [
        { mood: 'excited', text: '汎用モジュールが増えました！速度で攻めるか精度で圧縮するか、所長の腕の見せ所です。' }
      ],
      surface_uplink: [
        { mood: 'happy', text: '地上アップリンクを増設！これでデータの大渋滞もかなり緩和できますね。' }
      ],
      deep_water_intake: [
        { mood: 'curious', text: '深層水インテークが着底しました。冷た〜い深海水、いつでも汲み上げ可能です！' }
      ],
      drain_vent: [
        { mood: 'happy', text: '排水ベント設置完了！湯気を上げて安全に海へ逃がす準備が整いました。' }
      ],
      hydrothermal_turbine: [
        { mood: 'excited', text: 'ついに熱水タービンの登場ですね、所長！廃熱を電力に変える瞬間が待ちきれません！' }
      ]
    },
    connect: {
      default: [
        { mood: 'happy', text: '配管ジョイントの気密チェック完了！きれいな接続です、所長。' },
        { mood: 'curious', text: 'ライン接続OK！粒が気持ちよく流れ出しましたよ。' }
      ],
      power: [
        { mood: 'excited', text: '高圧電線接続！バチバチっと黄色い稲妻パルスが走り抜けました！' }
      ],
      data: [
        { mood: 'happy', text: '光ファイバー接続完了です。データの波がアップリンクへ押し寄せますね！' }
      ],
      coolant: [
        { mood: 'happy', text: '冷却ライン接続！冷たい水流がモジュールの火照りを冷ましてくれます。' }
      ],
      waste: [
        { mood: 'curious', text: '温排水パイプを接続しました。これで熱の逃げ道もバッチリです！' }
      ]
    },
    bottleneck: [
      { mood: 'alert', text: '警告です、所長！地上アップリンクの手前でケーブルが赤く膨らんでいます！モジュールのスライダーを「精度 65%以上」に振って圧縮しましょう！' },
      { mood: 'alert', text: '通信渋滞（ボトルネック）を検知しました！生データや速度寄りデータが溜まっています。精度側へチューニングするかアップリンク増設が効果的です。' }
    ],
    overheat: [
      { mood: 'alert', text: 'あっついです、所長！モジュールのコアが80℃を超えて処理速度が半減しています！「深層水インテーク」で早急に冷却しましょう！' },
      { mood: 'alert', text: 'オーバーヒート警報！金属フレームが悲鳴を上げています。深層水か高純度冷却液を冷却ポートへ繋いでください！' }
    ],
    cooled: [
      { mood: 'excited', text: 'おおっ、一気に4℃帯までひんやり冷却〜！冷却ブースト発動で処理速度が120%に加速しました、所長！' },
      { mood: 'happy', text: '熱暴走を完璧に鎮圧しました！深海冷却が効いて最高効率で回っています。' }
    ],
    tidySync: [
      { mood: 'excited', text: '素晴らしい配線美です、所長！交差ゼロの「整頓シンクロ」発動で、全ラインの速度が +20% 向上しました！' },
      { mood: 'happy', text: 'うっとりするほど美しい配管ですね！整頓シンクロ（+20%）の黄金の輝き、私のセンサーも喜んでいます。' }
    ],
    tidyBroken: [
      { mood: 'curious', text: 'おっと、配線が交差して整頓シンクロが解除されました。少しノードを動かすか「直交パイプ」モードを試すと元に戻せますよ！' }
    ],
    modeSwitch: {
      toData: [
        { mood: 'happy', text: '汎用モジュールを「データ処理モード」に切り替えました。演算コア、再起動します！' }
      ],
      toFilter: [
        { mood: 'curious', text: '「物理濾過モード」へ換装！深層水を入力すれば、冷却性能2倍の「高純度冷却液」を精製できますよ。' }
      ],
      toSpeedBand: [
        { mood: 'curious', text: '速度特化セッティングですね！処理は爆速ですが、発熱とアップリンクの詰まりにはご注意を。' }
      ],
      toBalancedBand: [
        { mood: 'happy', text: 'バランス重視の安定調整です。2倍単価の精製データを手堅く出力しますね。' }
      ],
      toPrecisionBand: [
        { mood: 'excited', text: '精度特化モード突入！単価2.5倍＆超低負荷の「高純度データ」が生成されますよ、所長！' }
      ]
    },
    turbineStart: [
      { mood: 'excited', text: '見ましたか所長！温排水の熱でタービン羽根が高速回転を始めました！まさに熱の錬金術です！' },
      { mood: 'happy', text: '熱水タービンが安定した電力を吐き出しています！排熱さえ無駄にしない完璧な深海エコシステムですね。' }
    ],
    cashMilestone: [
      { mood: 'excited', text: '資金が順調に増えていますね、所長！次の設備投資や増設プランを検討しましょうか？' },
      { mood: 'happy', text: '地上アップリンクからの入金確認！深海データセンターの評判、うなぎ登りです！' }
    ],
    poke: [
      { mood: 'happy', text: 'はいっ、B.U.G.-01（ブギー）ただいま待機中です、所長！何かお困りですか？' },
      { mood: 'curious', text: 'くすぐったいですよ、所長！外装の耐圧チタン合金はピカピカに磨いてあります。' },
      { mood: 'excited', text: '周囲の深海水温は一年中4℃の天然ヒートシンク！私の内部コアも4℃帯でひんやり快調ですよ、所長！' },
      { mood: 'happy', text: '豆知識です！上部の「直交パイプ」ボタンを使うと、工場の基板みたいな美しい90度配線が楽しめますよ。' },
      { mood: 'curious', text: '深海3,000メートルは静かで落ち着きますね……。ときどきソナーが遠くのクジラの声を拾うんですよ。' },
      { mood: 'excited', text: '汎用モジュールを2台並べて、片方を「物理濾過モード」でもう片方を冷やす連携、やってみるとすごく気持ちいいですよ！' },
      { mood: 'happy', text: 'あっ、溶接アームに小さな深海プランクトンが……ふぅ、そっと海へ戻しておきました。' },
      { mood: 'curious', text: '配線が交差していないと「整頓シンクロ」で全速度が +20% 上がります。綺麗は正義、なのです！' },
      { mood: 'alert', text: 'ちょっと驚きました！……なーんて、緊急事態はケーブルが赤く膨らんだ時と80℃超えの時だけですね。' },
      { mood: 'excited', text: '技術図鑑はもうご覧になりましたか？あちらのミニシミュレーション、実は私が裏で一生懸命動かしているんです！' }
    ]
  };

  // =========================================================================
  // window.ABYSS_DATA への公開（完全凍結）
  // =========================================================================
  global.ABYSS_DATA = deepFreeze({
    CONFIG: CONFIG,
    RESOURCES: RESOURCES,
    PARTS: PARTS,
    PARTS_MAP: PARTS_MAP,
    INITIAL_LAYOUT: INITIAL_LAYOUT,
    TUTORIAL_STEPS: TUTORIAL_STEPS,
    ENCYCLOPEDIA: ENCYCLOPEDIA,
    BOOGIE_QUIPS: BOOGIE_QUIPS
  });
})(window);
