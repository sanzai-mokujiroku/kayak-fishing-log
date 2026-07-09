import { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { TIDE_STATIONS } from "./tideStations.js";

const TRIPS_KEY = "kayak-fishing-trips";
const JIGS_KEY = "kayak-jig-inventory";
const SPECIES_KEY = "kayak-species-list";

// --- 保存はこの端末のブラウザ内(localStorage)のみ。サーバーには一切送らない ---
const storage = {
  async get(key) {
    const v = localStorage.getItem(key);
    return v == null ? null : { value: v };
  },
  async set(key, value) {
    localStorage.setItem(key, value);
    return true;
  },
};

const DEFAULT_SPECIES = [
  "キジハタ", "フクラギ", "アジ", "サバ", "カサゴ",
  "マダイ", "ヒラメ", "サワラ", "カマス",
];

const TIDE_OPTIONS = ["大潮", "中潮", "小潮", "長潮", "若潮", "不明"];
const MOOD_OPTIONS = [
  { v: 5, label: "最高" },
  { v: 4, label: "良い" },
  { v: 3, label: "普通" },
  { v: 2, label: "微妙" },
  { v: 1, label: "ボウズ" },
];

const emptyCatch = () => ({
  id: cuid(),
  time: "",
  jig: "",
  action: "",
  responseLayer: "",
  species: "",
  size: "",
  note: "",
});

const emptyTrip = () => ({
  date: new Date().toISOString().slice(0, 10),
  locationTag: "",
  tide: "不明",
  tideDetail: "",
  weather: "",
  wind: "",
  waveHeight: "",
  waterTemp: "",
  reflection: "",
  mood: 3,
  catches: [emptyCatch()],
});

function cuid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ===== 気象・潮の自動取得（Open-Meteo + tide736） =====
const COMPASS = ["北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東", "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西"];
const dirText = (deg) => COMPASS[Math.round(deg / 22.5) % 16];

// WMO天気コード → 日本語
const WMO_TEXT = {
  0: "快晴", 1: "晴れ", 2: "晴れ時々曇り", 3: "曇り",
  45: "霧", 48: "霧氷",
  51: "弱い霧雨", 53: "霧雨", 55: "強い霧雨", 56: "着氷性の霧雨", 57: "着氷性の霧雨",
  61: "弱い雨", 63: "雨", 65: "強い雨", 66: "みぞれ", 67: "みぞれ",
  71: "弱い雪", 73: "雪", 75: "強い雪", 77: "霧雪",
  80: "にわか雨", 81: "にわか雨", 82: "激しいにわか雨", 85: "にわか雪", 86: "にわか雪",
  95: "雷雨", 96: "雷雨(ひょう)", 99: "雷雨(ひょう)",
};
const weatherText = (code) => WMO_TEXT[code] ?? `天気コード${code}`;

function haversine(a, b, c, d) {
  const R = 6371, toR = (x) => x * Math.PI / 180;
  const dLat = toR(c - a), dLon = toR(d - b);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a)) * Math.cos(toR(c)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function nearestStation(lat, lon) {
  let best = null, bd = Infinity;
  for (const s of TIDE_STATIONS) {
    const d = haversine(lat, lon, s[2], s[3]);
    if (d < bd) { bd = d; best = s; }
  }
  return { pc: best[0], hc: best[1], name: best[4], dist: bd };
}
function getJSON(url) {
  return fetch(url).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
}
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("no geolocation")); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => reject(e),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

// 指定日付(YYYY-MM-DD)の、現在時刻に近い時間の気象・海況・潮をまとめて取得
async function fetchConditions(lat, lon, dateStr) {
  const tz = "Asia/Tokyo";
  const base = `latitude=${lat}&longitude=${lon}&timezone=${encodeURIComponent(tz)}&forecast_days=3`;
  const wxUrl = `https://api.open-meteo.com/v1/forecast?${base}&hourly=weather_code,wind_speed_10m,wind_direction_10m&wind_speed_unit=ms`;
  const marUrl = `https://marine-api.open-meteo.com/v1/marine?${base}&hourly=wave_height,sea_surface_temperature`;
  const st = nearestStation(lat, lon);
  const [y, m, d] = dateStr.split("-");
  const tideUrl = `https://tide736.net/api/get_tide.php?pc=${st.pc}&hc=${st.hc}&yr=${+y}&mn=${+m}&dy=${+d}&rg=day`;

  const [wx, mar, tide] = await Promise.all([
    getJSON(wxUrl).catch(() => null),
    getJSON(marUrl).catch(() => null),
    getJSON(tideUrl).catch(() => null),
  ]);

  // 対象時刻: 今日なら現在の時、それ以外は12時
  const now = new Date();
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  let hour = 12;
  if (dateStr === todayStr) {
    hour = +new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(now);
  }
  const target = `${dateStr}T${String(hour).padStart(2, "0")}:00`;
  const findIdx = (times) => {
    if (!times) return -1;
    const exact = times.indexOf(target);
    if (exact >= 0) return exact;
    for (let i = 0; i < times.length; i++) if (times[i].slice(0, 10) === dateStr) return i;
    return -1;
  };

  const out = {};
  const wi = findIdx(wx?.hourly?.time);
  if (wi >= 0) {
    const code = wx.hourly.weather_code[wi];
    const ws = wx.hourly.wind_speed_10m[wi];
    const wd = wx.hourly.wind_direction_10m[wi];
    if (code != null) out.weather = weatherText(code);
    if (ws != null && wd != null) out.wind = `${dirText(wd)} ${Number(ws).toFixed(1)}m/s`;
  }
  const mi = findIdx(mar?.hourly?.time);
  if (mi >= 0) {
    const wave = mar.hourly.wave_height[mi];
    const sst = mar.hourly.sea_surface_temperature[mi];
    if (wave != null) out.waveHeight = `${Number(wave).toFixed(1)}m`;
    if (sst != null) out.waterTemp = `${Number(sst).toFixed(1)}℃`;
  }
  const chart = tide?.tide?.chart;
  let gotTide = false;
  if (chart) {
    const day = chart[Object.keys(chart)[0]];
    if (day) {
      gotTide = true;
      const title = day.moon?.title;
      if (title && TIDE_OPTIONS.includes(title)) out.tide = title;
      const flood = (day.flood || []).map((x) => x.time.slice(0, 5));
      const edd = (day.edd || []).map((x) => x.time.slice(0, 5));
      const parts = [];
      if (flood.length) parts.push(`満潮 ${flood.join("/")}`);
      if (edd.length) parts.push(`干潮 ${edd.join("/")}`);
      if (parts.length) out.tideDetail = parts.join("、");
    }
  }
  return { out, station: st.name, gotWx: wi >= 0, gotMar: mi >= 0, gotTide };
}

function FishingLog() {
  const [trips, setTrips] = useState([]);
  const [jigs, setJigs] = useState([]);
  const [species, setSpecies] = useState(DEFAULT_SPECIES);
  const [form, setForm] = useState(emptyTrip());
  const [newJig, setNewJig] = useState("");
  const [showJigManager, setShowJigManager] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [autoLoading, setAutoLoading] = useState(false);
  const [toast, setToast] = useState("");
  const [openId, setOpenId] = useState(null);
  const importRef = useRef(null);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2000);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [tripsRes, jigsRes, speciesRes] = await Promise.allSettled([
          storage.get(TRIPS_KEY, false),
          storage.get(JIGS_KEY, false),
          storage.get(SPECIES_KEY, false),
        ]);
        if (tripsRes.status === "fulfilled" && tripsRes.value) {
          const parsed = JSON.parse(tripsRes.value.value);
          setTrips(Array.isArray(parsed) ? parsed : []);
        }
        if (jigsRes.status === "fulfilled" && jigsRes.value) {
          const parsed = JSON.parse(jigsRes.value.value);
          setJigs(Array.isArray(parsed) ? parsed : []);
        }
        if (speciesRes.status === "fulfilled" && speciesRes.value) {
          const parsed = JSON.parse(speciesRes.value.value);
          if (Array.isArray(parsed) && parsed.length > 0) setSpecies(parsed);
        }
      } catch (e) {
        // 初回はキー未作成のためエラーになるが無視してよい
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const persistTrips = useCallback(async (next) => {
    setSaving(true);
    try {
      const result = await storage.set(TRIPS_KEY, JSON.stringify(next), false);
      if (!result) throw new Error("no result");
    } catch (e) {
      showToast("保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }, [showToast]);

  const persistJigs = useCallback(async (next) => {
    try {
      const result = await storage.set(JIGS_KEY, JSON.stringify(next), false);
      if (!result) throw new Error("no result");
    } catch (e) {
      showToast("ジグ在庫の保存に失敗しました");
    }
  }, [showToast]);

  const persistSpecies = useCallback(async (next) => {
    try {
      const result = await storage.set(SPECIES_KEY, JSON.stringify(next), false);
      if (!result) throw new Error("no result");
    } catch (e) {
      showToast("魚種リストの保存に失敗しました");
    }
  }, [showToast]);

  const addSpecies = async (name) => {
    const trimmed = name.trim();
    if (!trimmed || species.includes(trimmed)) return;
    const next = [...species, trimmed];
    setSpecies(next);
    await persistSpecies(next);
    showToast("魚種を追加しました");
  };

  const handleChange = (key) => (e) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  // 現在地の気象・海況・潮を取得して、その日の条件欄を自動で埋める
  const autofill = async () => {
    setAutoLoading(true);
    try {
      const { lat, lon } = await getPosition();
      const { out, station, gotWx, gotMar, gotTide } = await fetchConditions(lat, lon, form.date);
      setForm((f) => ({
        ...f,
        ...out,
        locationTag: f.locationTag || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
      }));
      const miss = [];
      if (!gotWx) miss.push("天気/風");
      if (!gotMar) miss.push("波/水温");
      if (!gotTide) miss.push("潮");
      showToast(miss.length ? `一部取得できず(${miss.join("・")})は手入力を` : `自動入力しました(潮:${station})`);
    } catch (e) {
      const msg = e && e.code === 1 ? "位置情報が許可されていません"
        : (!navigator.onLine ? "オフラインのため取得できません。電波のある場所で" : "取得に失敗しました。手入力してください");
      showToast(msg);
    } finally {
      setAutoLoading(false);
    }
  };

  const handleCatchChange = (id, key) => (e) => {
    const val = e.target.value;
    setForm((f) => ({
      ...f,
      catches: f.catches.map((c) => (c.id === id ? { ...c, [key]: val } : c)),
    }));
  };

  const addCatchRow = () => {
    setForm((f) => ({ ...f, catches: [...f.catches, emptyCatch()] }));
  };

  const removeCatchRow = (id) => {
    setForm((f) => ({ ...f, catches: f.catches.filter((c) => c.id !== id) }));
  };

  const addJig = async (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (jigs.includes(trimmed)) {
      showToast("すでに登録済みです");
      return;
    }
    const next = [...jigs, trimmed];
    setJigs(next);
    await persistJigs(next);
    showToast("在庫に追加しました");
  };

  const removeJig = async (name) => {
    const next = jigs.filter((j) => j !== name);
    setJigs(next);
    await persistJigs(next);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.date) {
      showToast("日付を入力してください");
      return;
    }
    const cleanedCatches = form.catches.filter(
      (c) => c.time || c.jig || c.action || c.responseLayer || c.species || c.size || c.note
    );
    const trip = { id: cuid(), ...form, catches: cleanedCatches, createdAt: Date.now() };
    const next = [trip, ...trips];
    setTrips(next);
    setForm(emptyTrip());
    await persistTrips(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
    showToast("記録しました");
  };

  const handleDelete = async (id) => {
    if (!window.confirm("この釣行を削除します。よろしいですか？")) return;
    const next = trips.filter((t) => t.id !== id);
    setTrips(next);
    await persistTrips(next);
    showToast("削除しました");
  };

  const catchLabel = (c) => {
    if (c.species && c.size) return `${c.species} ${c.size}`;
    if (c.species) return c.species;
    if (c.size) return c.size;
    return "";
  };

  const catchSummary = (trip) => {
    if (!trip.catches || trip.catches.length === 0) return "ボウズ";
    const named = trip.catches.map(catchLabel).filter(Boolean);
    if (named.length === 0) return `反応 ${trip.catches.length}件`;
    return named.length <= 2 ? named.join("、") : `${named[0]} 他${named.length - 1}件`;
  };

  const toMarkdown = (trip) => {
    const lines = [
      `### ${trip.date} ${trip.locationTag || "(場所未記入)"}`,
      `- 潮回り: ${trip.tide}${trip.tideDetail ? `(${trip.tideDetail})` : ""}／天気: ${trip.weather || "-"}／風: ${trip.wind || "-"}／波高: ${trip.waveHeight || "-"}／水温: ${trip.waterTemp || "-"}`,
    ];
    if (trip.catches && trip.catches.length > 0) {
      lines.push(`- 釣果(${trip.catches.length}件):`);
      trip.catches.forEach((c, i) => {
        lines.push(
          `  ${i + 1}. ${c.time ? `[${c.time}] ` : ""}${catchLabel(c) || "反応のみ"}／ジグ:${c.jig || "-"}／アクション:${c.action || "-"}／層:${c.responseLayer || "-"}${c.note ? `／メモ:${c.note}` : ""}`
        );
      });
    } else {
      lines.push(`- 釣果: ボウズ`);
    }
    lines.push(`- 考察: ${trip.reflection || "-"}`);
    lines.push(`- 満足度: ${MOOD_OPTIONS.find((m) => m.v == trip.mood)?.label || trip.mood}`);
    return lines.join("\n");
  };

  const copyOne = async (trip) => {
    try {
      await navigator.clipboard.writeText(toMarkdown(trip));
      showToast("コピーしました");
    } catch {
      showToast("コピーに失敗しました");
    }
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(trips.map(toMarkdown).join("\n\n"));
      showToast("全件コピーしました");
    } catch {
      showToast("コピーに失敗しました");
    }
  };

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportCSV = () => {
    if (trips.length === 0) {
      showToast("記録がありません");
      return;
    }
    const headers = [
      "日付", "場所", "潮回り", "潮汐メモ", "天気", "風", "波高", "水温",
      "ヒット時刻", "魚種", "サイズ", "ジグ", "アクション", "反応層", "1匹メモ",
      "釣行の考察", "満足度",
    ];
    const esc = (v) => {
      const s = (v == null ? "" : String(v));
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [headers.join(",")];
    trips.forEach((trip) => {
      const moodLabel = MOOD_OPTIONS.find((m) => m.v == trip.mood)?.label || trip.mood;
      const base = [trip.date, trip.locationTag, trip.tide, trip.tideDetail, trip.weather, trip.wind, trip.waveHeight, trip.waterTemp];
      if (trip.catches && trip.catches.length > 0) {
        trip.catches.forEach((c) => {
          rows.push([...base, c.time, c.species, c.size, c.jig, c.action, c.responseLayer, c.note, trip.reflection, moodLabel].map(esc).join(","));
        });
      } else {
        rows.push([...base, "", "ボウズ", "", "", "", "", "", trip.reflection, moodLabel].map(esc).join(","));
      }
    });
    // BOM付きUTF-8(Excelで文字化けしないように)
    const blob = new Blob(["﻿" + rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    downloadBlob(blob, `釣行記録_${new Date().toISOString().slice(0, 10)}.csv`);
    showToast("CSVを書き出しました");
  };

  // 全データ(釣行・ジグ・魚種)をまとめて書き出す。端末を変える/データ消去に備えるバックアップ
  const exportBackup = () => {
    const payload = {
      app: "kayak-fishing-log",
      version: 1,
      exportedAt: new Date().toISOString(),
      trips,
      jigs,
      species,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    downloadBlob(blob, `釣行ログ_バックアップ_${new Date().toISOString().slice(0, 10)}.json`);
    showToast("バックアップを書き出しました");
  };

  const importBackup = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const nextTrips = Array.isArray(data.trips) ? data.trips : null;
      if (!nextTrips) {
        showToast("このファイルは読み込めません");
        return;
      }
      const msg = `バックアップを取り込みます。\n釣行 ${nextTrips.length}件で今のデータを置き換えます。よろしいですか？`;
      if (!window.confirm(msg)) return;
      setTrips(nextTrips);
      await persistTrips(nextTrips);
      if (Array.isArray(data.jigs)) { setJigs(data.jigs); await persistJigs(data.jigs); }
      if (Array.isArray(data.species) && data.species.length > 0) { setSpecies(data.species); await persistSpecies(data.species); }
      showToast("バックアップを取り込みました");
    } catch (e) {
      showToast("読み込みに失敗しました");
    }
  };

  const label = { fontSize: "12px", color: "#555", marginBottom: "4px", display: "block" };
  const input = {
    width: "100%",
    border: "1px solid #ccc",
    borderRadius: "4px",
    padding: "8px 10px",
    fontSize: "16px",
    outline: "none",
    boxSizing: "border-box",
  };
  const sectionLabel = { fontSize: "11px", color: "#888", marginBottom: "10px", fontWeight: 600 };

  return (
    <div style={{ minHeight: "100vh", background: "#fafafa", color: "#222", fontFamily: "-apple-system, 'Hiragino Sans', sans-serif", padding: "20px 16px 80px" }}>
      <style>{`
        input:focus, select:focus, textarea:focus { border-color: #4a7dbd !important; }
      `}</style>

      <div style={{ maxWidth: "700px", margin: "0 auto" }}>
        <header style={{ marginBottom: "16px" }}>
          <h1 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 4px" }}>釣行記録</h1>
          <div style={{ fontSize: "13px", color: "#777" }}>1回の釣行につき1レコード、釣果はその中に複数追加できます</div>
        </header>

        {/* 使い方・注意 */}
        <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: "6px", marginBottom: "16px", overflow: "hidden" }}>
          <button
            onClick={() => setShowHelp((s) => !s)}
            style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: "transparent", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 600 }}
          >
            <span>使い方・データの注意</span>
            <span style={{ color: "#999", fontWeight: 400 }}>{showHelp ? "閉じる" : "開く"}</span>
          </button>
          {showHelp && (
            <div style={{ padding: "0 14px 14px", fontSize: "12.5px", color: "#555", lineHeight: 1.75 }}>
              <p style={{ margin: "0 0 8px" }}>・記録は<b>この端末のブラウザ内だけ</b>に保存されます。サーバーには一切送られません。</p>
              <p style={{ margin: "0 0 8px" }}>・<b>ホーム画面に追加</b>すると、アプリのように起動でき、電波が無い海の上でも開けます（iPhoneはSafariの共有ボタン→「ホーム画面に追加」）。</p>
              <p style={{ margin: "0 0 8px", color: "#b57a2c" }}>・⚠ ブラウザの履歴・データ消去や、機種変更でデータは<b>消えます</b>。大事な記録は下の<b>「バックアップ書き出し」</b>で時々ファイルに保存してください。取り込みで復元できます。</p>
              <p style={{ margin: "0 0 8px", color: "#b57a2c" }}>・⚠ 場所を緯度経度で記録できますが、コピーやCSVには<b>そのまま含まれます</b>。ブログ・SNSに載せる時は必ず削除・ぼかしてください。</p>
              <p style={{ margin: 0 }}>・満潮/干潮の時刻を「潮汐メモ」に、各釣果に「ヒット時刻」を入れておくと、後で「潮のどのタイミングで釣れたか」を振り返れます。</p>
            </div>
          )}
        </div>

        {/* ジグ在庫管理 */}
        <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: "6px", marginBottom: "16px", overflow: "hidden" }}>
          <button
            onClick={() => setShowJigManager((s) => !s)}
            style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: "transparent", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 600 }}
          >
            <span>持っているジグの管理 {jigs.length > 0 && `(${jigs.length}個)`}</span>
            <span style={{ color: "#999", fontWeight: 400 }}>{showJigManager ? "閉じる" : "開く"}</span>
          </button>
          {showJigManager && (
            <div style={{ padding: "0 14px 14px" }}>
              <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
                <input
                  type="text"
                  style={input}
                  placeholder="例: ダイソージグ 60g 赤金"
                  value={newJig}
                  onChange={(e) => setNewJig(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addJig(newJig);
                      setNewJig("");
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => { addJig(newJig); setNewJig(""); }}
                  style={{ padding: "0 16px", background: "#333", color: "#fff", border: "none", borderRadius: "4px", fontSize: "13px", cursor: "pointer", whiteSpace: "nowrap" }}
                >
                  追加
                </button>
              </div>
              {jigs.length === 0 ? (
                <div style={{ fontSize: "12px", color: "#999" }}>まだ登録されていません</div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  {jigs.map((j) => (
                    <span key={j} style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "#f0f0f0", borderRadius: "999px", padding: "4px 6px 4px 10px", fontSize: "12px" }}>
                      {j}
                      <button
                        onClick={() => removeJig(j)}
                        style={{ background: "#ddd", border: "none", borderRadius: "50%", width: "16px", height: "16px", fontSize: "10px", lineHeight: "16px", cursor: "pointer", color: "#666" }}
                        aria-label={`${j}を削除`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: "6px", padding: "20px", marginBottom: "24px" }}>
          <div style={sectionLabel}>その日の条件(釣行全体で共通)</div>

          <button
            type="button"
            onClick={autofill}
            disabled={autoLoading}
            style={{
              width: "100%", padding: "11px", marginBottom: "6px",
              background: autoLoading ? "#eef3fa" : "#eaf1fb", color: "#2c5a9e",
              border: "1px solid #4a7dbd", borderRadius: "6px",
              fontSize: "14px", fontWeight: 600, cursor: autoLoading ? "default" : "pointer",
            }}
          >
            {autoLoading ? "取得中…" : "📍 現在地から自動入力（天気・風・波・水温・潮）"}
          </button>
          <div style={{ fontSize: "11px", color: "#999", marginBottom: "16px" }}>
            電波のある出艇地点で押すと、いまの気象・海況と今日の潮を自動で埋めます（各欄は後から手直しできます）
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
            <div>
              <label style={label}>日付</label>
              <input type="date" style={input} value={form.date} onChange={handleChange("date")} />
            </div>
            <div>
              <label style={label}>場所(緯度経度・自分用メモなど)</label>
              <input type="text" style={input} placeholder="例: 36.7123, 137.2456 または魚探のウェイポイント名" value={form.locationTag} onChange={handleChange("locationTag")} />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginBottom: "12px" }}>
            <div>
              <label style={label}>潮回り</label>
              <select style={input} value={form.tide} onChange={handleChange("tide")}>
                {TIDE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={label}>天気</label>
              <input type="text" style={input} placeholder="晴れ/曇り" value={form.weather} onChange={handleChange("weather")} />
            </div>
            <div>
              <label style={label}>風向・風速</label>
              <input type="text" style={input} placeholder="例: 北西2m" value={form.wind} onChange={handleChange("wind")} />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "20px" }}>
            <div>
              <label style={label}>波高</label>
              <input type="text" style={input} placeholder="例: 0.3m" value={form.waveHeight} onChange={handleChange("waveHeight")} />
            </div>
            <div>
              <label style={label}>水温</label>
              <input type="text" style={input} placeholder="例: 22℃" value={form.waterTemp} onChange={handleChange("waterTemp")} />
            </div>
          </div>

          <div style={{ marginBottom: "20px" }}>
            <label style={label}>潮汐メモ(満潮・干潮の時刻など。潮汐アプリを見て書き写す)</label>
            <input type="text" style={input} placeholder="例: 満潮 5:30/17:20、干潮 11:00" value={form.tideDetail} onChange={handleChange("tideDetail")} />
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            <div style={sectionLabel}>釣果・反応(匹ごとに追加できます)</div>
            <button
              type="button"
              onClick={addCatchRow}
              style={{ fontSize: "12px", color: "#2c5a9e", background: "#eaf1fb", border: "1px solid #4a7dbd", borderRadius: "4px", padding: "4px 10px", cursor: "pointer" }}
            >
              ＋ 追加
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "20px" }}>
            {form.catches.map((c, i) => {
              const notInInventory = c.jig.trim() && !jigs.includes(c.jig.trim());
              return (
                <div key={c.id} style={{ border: "1px solid #eee", borderRadius: "6px", padding: "12px", background: "#fcfcfc" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontSize: "12px", fontWeight: 600, color: "#666" }}>{i + 1}匹目 / 反応{i + 1}</span>
                      <input
                        type="time"
                        style={{ border: "1px solid #ccc", borderRadius: "4px", padding: "4px 6px", fontSize: "16px", outline: "none" }}
                        value={c.time}
                        onChange={handleCatchChange(c.id, "time")}
                        aria-label="ヒット時刻"
                      />
                    </div>
                    {form.catches.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeCatchRow(c.id)}
                        style={{ fontSize: "11px", color: "#c0392b", background: "transparent", border: "none", cursor: "pointer" }}
                      >
                        削除
                      </button>
                    )}
                  </div>

                  <div style={{ marginBottom: "8px" }}>
                    <label style={label}>ジグ(在庫から選ぶ、または下の欄に直接入力)</label>
                    {jigs.length > 0 && (
                      <select
                        style={{ ...input, marginBottom: "6px" }}
                        value={jigs.includes(c.jig) ? c.jig : ""}
                        onChange={handleCatchChange(c.id, "jig")}
                      >
                        <option value="">-- 在庫から選ぶ --</option>
                        {jigs.map((j) => <option key={j} value={j}>{j}</option>)}
                      </select>
                    )}
                    <div style={{ display: "flex", gap: "8px" }}>
                      <input
                        type="text"
                        style={input}
                        placeholder="直接入力もできます"
                        value={c.jig}
                        onChange={handleCatchChange(c.id, "jig")}
                      />
                      {notInInventory && (
                        <button
                          type="button"
                          onClick={() => addJig(c.jig)}
                          style={{ padding: "0 12px", background: "#eaf1fb", color: "#2c5a9e", border: "1px solid #4a7dbd", borderRadius: "4px", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap" }}
                        >
                          在庫に追加
                        </button>
                      )}
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "8px" }}>
                    <div>
                      <label style={label}>アクション</label>
                      <input type="text" style={input} placeholder="例: ワンピッチジャーク" value={c.action} onChange={handleCatchChange(c.id, "action")} />
                    </div>
                    <div>
                      <label style={label}>反応があった層</label>
                      <input type="text" style={input} placeholder="例: ボトムから3m" value={c.responseLayer} onChange={handleCatchChange(c.id, "responseLayer")} />
                    </div>
                  </div>

                  <div style={{ marginBottom: "8px" }}>
                    <label style={label}>魚種</label>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                      <div>
                        <select
                          style={input}
                          value={species.includes(c.species) ? c.species : (c.species ? "__other__" : "")}
                          onChange={(e) => {
                            if (e.target.value === "__other__") return;
                            handleCatchChange(c.id, "species")(e);
                          }}
                        >
                          <option value="">-- 選ぶ --</option>
                          {species.map((s) => <option key={s} value={s}>{s}</option>)}
                          <option value="__other__">その他(下に入力)</option>
                        </select>
                      </div>
                      <div>
                        <input type="text" style={input} placeholder="サイズ 例: 35cm" value={c.size} onChange={handleCatchChange(c.id, "size")} />
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                      <input
                        type="text"
                        style={input}
                        placeholder="リストにない魚はここに入力(例: マゴチ)"
                        value={species.includes(c.species) ? "" : c.species}
                        onChange={handleCatchChange(c.id, "species")}
                      />
                      {c.species.trim() && !species.includes(c.species.trim()) && (
                        <button
                          type="button"
                          onClick={() => addSpecies(c.species)}
                          style={{ padding: "0 12px", background: "#eaf1fb", color: "#2c5a9e", border: "1px solid #4a7dbd", borderRadius: "4px", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap" }}
                        >
                          リストに追加
                        </button>
                      )}
                    </div>
                  </div>

                  <div>
                    <label style={label}>この1匹についてのメモ</label>
                    <input type="text" style={input} placeholder="任意" value={c.note} onChange={handleCatchChange(c.id, "note")} />
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginBottom: "12px" }}>
            <label style={label}>釣行全体の考察・気づき</label>
            <textarea style={{ ...input, minHeight: "72px", resize: "vertical" }} placeholder="今日全体を通しての気づき。次回試したいこと。" value={form.reflection} onChange={handleChange("reflection")} />
          </div>

          <div style={{ marginBottom: "18px" }}>
            <label style={label}>満足度</label>
            <div style={{ display: "flex", gap: "8px" }}>
              {MOOD_OPTIONS.map((m) => (
                <button
                  type="button"
                  key={m.v}
                  onClick={() => setForm((f) => ({ ...f, mood: m.v }))}
                  style={{
                    flex: 1,
                    padding: "8px 4px",
                    fontSize: "12px",
                    borderRadius: "4px",
                    border: form.mood == m.v ? "1px solid #4a7dbd" : "1px solid #ccc",
                    background: form.mood == m.v ? "#eaf1fb" : "#fff",
                    color: form.mood == m.v ? "#2c5a9e" : "#666",
                    cursor: "pointer",
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <button
            type="submit"
            disabled={saving}
            style={{
              width: "100%",
              padding: "11px",
              background: "#333",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: saving ? "default" : "pointer",
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? "保存中…" : "この釣行を記録する"}
          </button>
        </form>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
          <h2 style={{ fontSize: "16px", fontWeight: 700 }}>
            釣行一覧 {trips.length > 0 && `(${trips.length}件)`}
          </h2>
          {trips.length > 0 && (
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={copyAll}
                style={{ fontSize: "12px", color: "#4a7dbd", background: "transparent", border: "1px solid #4a7dbd", borderRadius: "4px", padding: "6px 12px", cursor: "pointer" }}
              >
                全件コピー
              </button>
              <button
                onClick={exportCSV}
                style={{ fontSize: "12px", color: "#2e7d5b", background: "transparent", border: "1px solid #2e7d5b", borderRadius: "4px", padding: "6px 12px", cursor: "pointer" }}
              >
                CSV書き出し
              </button>
            </div>
          )}
        </div>

        {/* バックアップ(端末内データの命綱) */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginBottom: "8px" }}>
          <button
            onClick={exportBackup}
            style={{ fontSize: "12px", color: "#555", background: "#f2f2f2", border: "1px solid #ccc", borderRadius: "4px", padding: "6px 12px", cursor: "pointer" }}
          >
            バックアップ書き出し
          </button>
          <button
            onClick={() => importRef.current && importRef.current.click()}
            style={{ fontSize: "12px", color: "#555", background: "#f2f2f2", border: "1px solid #ccc", borderRadius: "4px", padding: "6px 12px", cursor: "pointer" }}
          >
            バックアップ取り込み
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => { importBackup(e.target.files[0]); e.target.value = ""; }}
          />
        </div>

        {trips.length > 0 && (
          <div style={{ fontSize: "11px", color: "#b57a2c", marginBottom: "12px" }}>
            ⚠ コピー・CSVには場所(緯度経度)がそのまま含まれます。ブログ等で使う際は削除・ぼかしてください。
          </div>
        )}

        {loading ? (
          <div style={{ color: "#999", fontSize: "13px" }}>読み込み中…</div>
        ) : trips.length === 0 ? (
          <div style={{ border: "1px dashed #ccc", borderRadius: "6px", padding: "28px 16px", textAlign: "center", color: "#999", fontSize: "13px" }}>
            まだ記録がありません
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {trips.map((trip) => {
              const isOpen = openId === trip.id;
              const moodLabel = MOOD_OPTIONS.find((m) => m.v == trip.mood)?.label;
              return (
                <div key={trip.id} style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: "6px", overflow: "hidden" }}>
                  <button
                    onClick={() => setOpenId(isOpen ? null : trip.id)}
                    style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}
                  >
                    <div>
                      <div style={{ fontSize: "14px", fontWeight: 600 }}>
                        {trip.date} {trip.locationTag && `／ ${trip.locationTag}`}
                      </div>
                      <div style={{ fontSize: "12px", color: "#888" }}>
                        {catchSummary(trip)}{moodLabel && ` ・ ${moodLabel}`}
                      </div>
                    </div>
                    <span style={{ color: "#999", fontSize: "12px" }}>{isOpen ? "閉じる" : "詳細"}</span>
                  </button>

                  {isOpen && (
                    <div style={{ padding: "0 14px 16px", fontSize: "13px", lineHeight: 1.7 }}>
                      <div style={{ borderTop: "1px solid #eee", paddingTop: "12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px", marginBottom: "12px", color: "#555" }}>
                        <span>潮回り: {trip.tide}</span>
                        <span>天気: {trip.weather || "-"}</span>
                        <span>風: {trip.wind || "-"}</span>
                        <span>波高: {trip.waveHeight || "-"}</span>
                        <span>水温: {trip.waterTemp || "-"}</span>
                        {trip.tideDetail && <span style={{ gridColumn: "1 / -1" }}>潮汐: {trip.tideDetail}</span>}
                      </div>

                      {trip.catches && trip.catches.length > 0 ? (
                        <div style={{ marginBottom: "10px" }}>
                          <b>釣果({trip.catches.length}件):</b>
                          <ol style={{ margin: "6px 0 0", paddingLeft: "20px" }}>
                            {trip.catches.map((c) => (
                              <li key={c.id} style={{ marginBottom: "4px" }}>
                                {c.time && <b>{c.time} </b>}
                                {catchLabel(c) || "反応のみ"}
                                {(c.jig || c.action || c.responseLayer) && (
                                  <span style={{ color: "#888" }}>
                                    {" "}(ジグ:{c.jig || "-"}／アクション:{c.action || "-"}／層:{c.responseLayer || "-"})
                                  </span>
                                )}
                                {c.note && <span style={{ color: "#888" }}> ／{c.note}</span>}
                              </li>
                            ))}
                          </ol>
                        </div>
                      ) : (
                        <div style={{ marginBottom: "10px", color: "#888" }}>釣果: ボウズ</div>
                      )}

                      <div style={{ marginBottom: "10px" }}><b>考察: </b>{trip.reflection || "-"}</div>
                      <div style={{ display: "flex", gap: "10px" }}>
                        <button onClick={() => copyOne(trip)} style={{ fontSize: "12px", color: "#4a7dbd", background: "transparent", border: "1px solid #4a7dbd", borderRadius: "4px", padding: "6px 12px", cursor: "pointer" }}>コピー</button>
                        <button onClick={() => handleDelete(trip.id)} style={{ fontSize: "12px", color: "#c0392b", background: "transparent", border: "1px solid #c0392b", borderRadius: "4px", padding: "6px 12px", cursor: "pointer" }}>削除</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <footer style={{ marginTop: "28px", fontSize: "11px", color: "#aaa", textAlign: "center", lineHeight: 1.7 }}>
          記録はこの端末のブラウザにのみ保存されます(個人用ツール)。<br />
          気象・海況: Open-Meteo（CC BY 4.0）／潮汐: tide736.net（気象庁 潮位表をもとに算出）
        </footer>
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: "20px", left: "50%", transform: "translateX(-50%)", background: "#333", color: "#fff", padding: "9px 18px", borderRadius: "999px", fontSize: "13px", zIndex: 50 }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// --- オフライン対応(サービスワーカー)の登録。海の上でも開けるように ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
// データが消えにくいよう永続化を要求(対応ブラウザのみ)
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

createRoot(document.getElementById("root")).render(<FishingLog />);
